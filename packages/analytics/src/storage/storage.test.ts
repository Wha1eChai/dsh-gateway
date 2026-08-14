import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PricingRule, RequestObservation } from '../contracts.js'
import { InstallationHasher } from '../pipeline/hashing.js'
import { projectQuota } from '../pipeline/management-projectors.js'
import { AnalyticsWorkerClient } from './client.js'
import { SQLiteAnalyticsEngine } from './engine.js'
import type { WorkerData } from './protocol.js'
import { applyMigrations, MIGRATION_0001_CHECKSUM, openAndMigrateDatabase } from './schema.js'
import {
  validateAccountHealthObservation,
  validateDeadLetterObservation,
  validateFilters,
  validateQuotaObservation,
  validateRequestObservation,
} from './validation.js'

const HASH = 'a'.repeat(64)
const FINGERPRINT = 'b'.repeat(64)
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-analytics-storage-'))
  tempRoots.push(root)
  return join(root, 'usage.sqlite3')
}

function requestObservation(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceKind: 'gateway',
    sourceEventKeyHash: HASH,
    requestIdHash: HASH,
    payloadFingerprint: FINGERPRINT,
    occurredAtMs: 1_700_000_000_000,
    routeId: 'default',
    providerId: 'provider',
    modelId: 'model',
    accountIdHash: null,
    apiKeyIdHash: null,
    hashKeyVersion: 1,
    outcome: 'success',
    errorKind: 'none',
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    timeToFirstTokenMs: 30,
    durationMs: 100,
    requestUnits: 1,
  }
}

function workerData(path: string, pricingRules: readonly PricingRule[] = []): WorkerData {
  return {
    databasePath: path,
    targetKey: 'test-target',
    mode: 'managed',
    queueCompleteness: 'unknown',
    pricingRules,
  }
}

function observedRequest(occurredAtMs: number, overrides: Partial<RequestObservation> = {}): RequestObservation {
  return {
    ...(requestObservation() as unknown as RequestObservation),
    occurredAtMs,
    ...overrides,
  }
}

function pricingRule(): PricingRule {
  return {
    snapshotVersion: 'test-1',
    ruleId: 'provider-model',
    routeId: 'default',
    providerId: 'provider',
    modelId: 'model',
    accountIdHash: '*',
    apiKeyIdHash: '*',
    currency: 'USD',
    requestUnitPriceMicros: 100,
    inputTokenPriceMicrosPerMillion: 1_000_000,
    outputTokenPriceMicrosPerMillion: 2_000_000,
    cacheReadTokenPriceMicrosPerMillion: null,
    cacheWriteTokenPriceMicrosPerMillion: null,
    reasoningTokenPriceMicrosPerMillion: null,
    effectiveFromMs: 0,
    effectiveToMs: null,
    sourceName: 'test-source',
    sourceUrl: 'https://example.test/pricing',
    sourceVersion: '1',
    sourceSha256: 'c'.repeat(64),
    generatedAtMs: 1,
    releaseVersion: '0.1.0-test',
  }
}

describe('SQLite migration boundary', () => {
  it('is idempotent and enables the required pragmas', () => {
    const path = databasePath()
    const first = openAndMigrateDatabase({ databasePath: path, nowMs: 1_700_000_000_000 })
    expect((first.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((first.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    expect((first.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect((first.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1)
    expect((first.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5_000)
    expect((first.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get() as { checksum: string }).checksum).toBe(MIGRATION_0001_CHECKSUM)
    const tableCount = (first.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('collector_state', 'ingest_receipts', 'pricing_rules', 'raw_request_events', 'usage_hourly', 'usage_daily', 'quota_snapshots', 'account_health_snapshots', 'dead_letter_events')").get() as { count: number }).count
    expect(tableCount).toBe(9)
    first.close()

    const second = openAndMigrateDatabase({ databasePath: path, nowMs: 1_700_000_000_001 })
    expect((second.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count).toBe(1)
    expect((second.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    second.close()
  })

  it('rejects a changed migration ledger checksum', () => {
    const path = databasePath()
    const db = openAndMigrateDatabase({ databasePath: path, nowMs: 1_700_000_000_000 })
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('c'.repeat(64))
    db.close()
    expect(() => openAndMigrateDatabase({ databasePath: path, nowMs: 1_700_000_000_001 })).toThrow(/checksum mismatch/)
  })
})

describe('worker-boundary observation validation', () => {
  it('accepts bounded sanitized observations and the added dead-letter contract', () => {
    expect(validateRequestObservation(requestObservation()).requestUnits).toBe(1)
    expect(validateQuotaObservation({
      sourceEventKeyHash: HASH,
      providerId: 'provider',
      accountIdHash: null,
      quotaKind: 'tokens',
      unit: 'tokens',
      limit: 100,
      used: 20,
      remaining: 80,
      resetAtMs: 1_700_000_000_100,
      sourceStatus: 'available',
      projectionVersion: 1,
      observedAtMs: 1_700_000_000_000,
      fingerprint: FINGERPRINT,
      hashKeyVersion: 1,
    }).remaining).toBe(80)
    expect(validateQuotaObservation({
      sourceEventKeyHash: HASH,
      providerId: 'openai-codex',
      accountIdHash: null,
      quotaKind: 'primary',
      unit: 'percent',
      limit: 100,
      used: 25.5,
      remaining: 74.5,
      resetAtMs: 1_700_000_000_100,
      sourceStatus: 'available',
      projectionVersion: 1,
      observedAtMs: 1_700_000_000_000,
      fingerprint: FINGERPRINT,
      hashKeyVersion: 1,
    }).used).toBe(25.5)
    expect(validateAccountHealthObservation({
      sourceEventKeyHash: HASH,
      providerId: 'provider',
      accountIdHash: null,
      healthStatus: 'healthy',
      reasonCode: 'ok',
      observedAtMs: 1_700_000_000_000,
      hashKeyVersion: 1,
    }).healthStatus).toBe('healthy')
    expect(validateDeadLetterObservation({
      sourceKind: 'cpa_http_usage',
      sourceEventKeyHash: HASH,
      payloadFingerprint: FINGERPRINT,
      occurredAtMs: 1_700_000_000_000,
      reasonCode: 'conflicting_source_receipt',
      retryable: false,
      retryCount: 0,
      nextRetryAtMs: null,
    }).retryable).toBe(false)
  })

  it('rejects unknown fields, non-hashes, and closed-enum violations', () => {
    const invalid = { ...requestObservation(), prompt: 'must never cross the boundary' }
    expect(() => validateRequestObservation(invalid)).toThrow(/unknown field/)
    expect(() => validateRequestObservation({ ...requestObservation(), requestIdHash: 'not-a-hash' })).toThrow(/64-hex hash/)
    expect(() => validateRequestObservation({ ...requestObservation(), outcome: 'pending' })).toThrow(/not supported/)
    expect(() => validateDeadLetterObservation({
      sourceKind: 'gateway',
      sourceEventKeyHash: HASH,
      payloadFingerprint: FINGERPRINT,
      occurredAtMs: 1_700_000_000_000,
      reasonCode: 'bad',
      retryable: false,
      retryCount: 0,
      nextRetryAtMs: null,
    })).toThrow(/not supported/)
  })

  it('bounds read filters and validates their irreversible dimensions', () => {
    expect(validateFilters({ fromMs: 10, toMs: 20, providerId: 'provider', accountIdHash: HASH }).accountIdHash).toBe(HASH)
    expect(() => validateFilters({ fromMs: 20, toMs: 10 })).toThrow(/toMs/)
    expect(() => validateFilters({ fromMs: 0, toMs: 367 * 24 * 60 * 60 * 1_000 })).toThrow(/too large/)
    expect(() => validateFilters({ fromMs: 0, toMs: 1, accountIdHash: 'raw-account' })).toThrow(/64-hex hash/)
  })
})

describe('SQLite analytics engine', () => {
  it('holds one target lease, releases its generation, and permits the next owner', async () => {
    const path = databasePath()
    const data = workerData(path)
    const first = new SQLiteAnalyticsEngine(data)
    try {
      expect(() => new SQLiteAnalyticsEngine(data)).toThrow(/lease is already held/)
      const held = new DatabaseSync(path, { readOnly: true })
      expect(held.prepare('SELECT lease_owner, lease_generation FROM collector_state WHERE target_key = ?').get(data.targetKey)).toMatchObject({ lease_generation: 1 })
      held.close()
    } finally {
      await first.close()
    }

    const released = new DatabaseSync(path, { readOnly: true })
    expect(released.prepare('SELECT lease_owner, lease_generation FROM collector_state WHERE target_key = ?').get(data.targetKey)).toMatchObject({ lease_owner: null, lease_generation: 1 })
    released.close()

    const second = new SQLiteAnalyticsEngine(data)
    const reacquired = new DatabaseSync(path, { readOnly: true })
    expect(reacquired.prepare('SELECT lease_owner, lease_generation FROM collector_state WHERE target_key = ?').get(data.targetKey)).toMatchObject({ lease_generation: 2 })
    reacquired.close()
    await second.close()
  })

  it('ingests real projected fractional Codex quota through the worker engine', async () => {
    const path = databasePath()
    const now = Date.now()
    const projected = projectQuota({
      providerId: 'openai-codex',
      windows: [{ kind: 'primary', unit: 'percent', limit: 100, used: 25.5, remaining: 74.5, resetAtMs: now + 60_000 }],
    }, new InstallationHasher(new Uint8Array(32).fill(9), 1, 'test-target'), { nowMs: now })
    expect(projected[0]).toMatchObject({ quotaKind: 'primary', unit: 'percent', used: 25.5, remaining: 74.5 })

    const engine = new SQLiteAnalyticsEngine(workerData(path))
    expect(await engine.ingestQuota(projected[0]!)).toEqual({ disposition: 'inserted' })
    expect(await engine.quota({ fromMs: now - 1, toMs: now + 1 })).toMatchObject([
      expect.objectContaining({ quotaKind: 'primary', unit: 'percent', used: 25.5, remaining: 74.5 }),
    ])
    await engine.close()
  })

  it('deduplicates, dead-letters conflicts, enriches one request, and reads aggregates after restart', async () => {
    const path = databasePath()
    const now = Date.now()
    const data = workerData(path, [pricingRule()])
    const engine = new SQLiteAnalyticsEngine(data)
    const gateway = observedRequest(now, {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    })
    expect(await engine.ingestRequest(gateway)).toEqual({ disposition: 'inserted', requestIdHash: HASH })
    expect(await engine.ingestRequest(gateway)).toEqual({ disposition: 'duplicate', requestIdHash: HASH })
    expect((await engine.ingestRequest({ ...gateway, payloadFingerprint: 'd'.repeat(64), requestUnits: 2 })).disposition).toBe('dead_letter')

    const usage = observedRequest(now, {
      sourceKind: 'cpa_http_usage',
      sourceEventKeyHash: 'e'.repeat(64),
      payloadFingerprint: 'f'.repeat(64),
      accountIdHash: 'c'.repeat(64),
      inputTokens: 10,
      outputTokens: 20,
      timeToFirstTokenMs: null,
    })
    expect(await engine.ingestRequest(usage)).toEqual({ disposition: 'enriched', requestIdHash: HASH })
    const filters = { fromMs: now - 1, toMs: now + 1 }
    expect(await engine.summary(filters)).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 20, knownCostMicros: 150, pricedRequests: 1, currency: 'USD', p50DurationMs: 100 })
    expect((await engine.trend({ ...filters, bucket: 'hour' }))).toHaveLength(1)
    const recent = await engine.recent({ ...filters, limit: 10 })
    expect(recent.items).toHaveLength(1)
    expect(recent.items[0]).toMatchObject({ requestIdHash: HASH, accountIdHash: 'c'.repeat(64), estimatedCostMicros: 150 })
    expect((await engine.status()).availability).toBe('ready')
    await engine.close()

    const restarted = new SQLiteAnalyticsEngine(data)
    expect((await restarted.summary(filters)).requests).toBe(1)
    await restarted.close()
  })

  it('stores quota and health snapshots and applies bounded retention', async () => {
    const path = databasePath()
    const now = Date.now()
    const engine = new SQLiteAnalyticsEngine(workerData(path))
    expect((await engine.ingestRequest(observedRequest(now))).disposition).toBe('inserted')
    expect((await engine.ingestQuota({
      sourceEventKeyHash: 'c'.repeat(64), providerId: 'provider', accountIdHash: null, quotaKind: 'tokens', unit: 'tokens',
      limit: 100, used: 20, remaining: 80, resetAtMs: now + 1_000, sourceStatus: 'available', projectionVersion: 1,
      observedAtMs: now, fingerprint: 'd'.repeat(64), hashKeyVersion: 1,
    })).disposition).toBe('inserted')
    expect((await engine.ingestAccountHealth({
      sourceEventKeyHash: 'e'.repeat(64), providerId: 'provider', accountIdHash: null, healthStatus: 'healthy',
      reasonCode: 'ok', observedAtMs: now, hashKeyVersion: 1,
    })).disposition).toBe('inserted')
    expect((await engine.ingestDeadLetter({
      sourceKind: 'cpa_http_usage', sourceEventKeyHash: 'f'.repeat(64), payloadFingerprint: 'c'.repeat(64),
      occurredAtMs: now, reasonCode: 'missing_stable_request_id', retryable: false, retryCount: 0, nextRetryAtMs: null,
    })).disposition).toBe('dead_letter')
    expect(await engine.quota({ fromMs: now - 1, toMs: now + 1 })).toHaveLength(1)
    expect(await engine.accountHealth({ fromMs: now - 1, toMs: now + 1 })).toHaveLength(1)

    await engine.maintain(now + 31 * 24 * 60 * 60 * 1_000)
    expect((await engine.summary({ fromMs: now - 1, toMs: now + 1 })).requests).toBe(1)
    expect((await engine.recent({ fromMs: now - 1, toMs: now + 1, limit: 10 })).items).toHaveLength(0)
    expect(await engine.quota({ fromMs: now - 1, toMs: now + 1 })).toHaveLength(1)
    expect(await engine.accountHealth({ fromMs: now - 1, toMs: now + 1 })).toHaveLength(1)

    await engine.maintain(now + 366 * 24 * 60 * 60 * 1_000)
    expect((await engine.summary({ fromMs: now - 1, toMs: now + 1 })).requests).toBe(0)
    expect(await engine.quota({ fromMs: now - 1, toMs: now + 1 })).toHaveLength(0)
    expect(await engine.accountHealth({ fromMs: now - 1, toMs: now + 1 })).toHaveLength(0)
    await engine.close()

    const inspected = new DatabaseSync(path, { readOnly: true })
    expect((inspected.prepare('SELECT count(*) AS count FROM dead_letter_events').get() as { count: number }).count).toBe(0)
    inspected.close()
  })
})

describe('worker client protocol seam', () => {
  it('waits for ready and closes idempotently without leaking a worker', async () => {
    const source = `
      import { parentPort, workerData } from 'node:worker_threads';
      parentPort.on('message', (message) => {
        if (message.operation.op === 'status') parentPort.postMessage({ type: 'response', id: message.id, ok: true, result: { availability: 'ready', mode: workerData.mode, databasePath: workerData.databasePath, queueCompleteness: 'unknown', lossPossibleCount: 0 } });
        if (message.operation.op === 'close') { parentPort.postMessage({ type: 'response', id: message.id, ok: true, result: undefined }); parentPort.close(); }
      });
      parentPort.postMessage({ type: 'ready' });
    `
    const url = new URL(`data:text/javascript,${encodeURIComponent(source)}`)
    const client = new AnalyticsWorkerClient(workerData(databasePath()), { workerUrl: url, requestTimeoutMs: 2_000, maxPending: 4 })
    expect((await client.status()).availability).toBe('ready')
    const firstClose = client.close()
    expect(client.close()).toBe(firstClose)
    await firstClose
    await expect(client.status()).rejects.toThrow(/closed/)

    const immediate = new AnalyticsWorkerClient(workerData(databasePath()), { workerUrl: url, requestTimeoutMs: 2_000, maxPending: 4 })
    await expect(immediate.close()).resolves.toBeUndefined()
  })

  it('maps a worker failure during status to typed unavailable', async () => {
    const source = `
      import { parentPort } from 'node:worker_threads';
      parentPort.postMessage({ type: 'fatal', error: { name: 'Error', message: 'private worker detail' } });
    `
    const url = new URL(`data:text/javascript,${encodeURIComponent(source)}`)
    const client = new AnalyticsWorkerClient(workerData(databasePath()), { workerUrl: url, requestTimeoutMs: 2_000, maxPending: 4 })
    await expect(client.status()).resolves.toMatchObject({ availability: 'unavailable', lastErrorKind: 'worker_unavailable' })
    await client.close()
  })
})
