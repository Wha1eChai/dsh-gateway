import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  AccountHealthObservation,
  AnalyticsFilters,
  AnalyticsStatus,
  AnalyticsStore,
  AnalyticsSummary,
  AnalyticsTimeRange,
  AnalyticsTrendPoint,
  DeadLetterObservation,
  IngestResult,
  PricingRule,
  QuotaObservation,
  RecentRequestPage,
  RequestObservation,
} from '../contracts.js'
import type { WorkerData, WorkerOperation, WorkerResult } from './protocol.js'
import { acquireCollectorLease, ensureCollectorState, openAndMigrateDatabase, releaseCollectorLease } from './schema.js'
import {
  MAX_DEAD_LETTER_PROJECTION,
  MAX_QUERY_ROWS,
  MAX_RECENT_LIMIT,
  healthFingerprint,
  healthProjection,
  observationKind,
  quotaProjection,
  requestProjection,
  validateAccountHealthObservation,
  validateDeadLetterObservation,
  validateFilters,
  validatePricingRules,
  validateQuotaObservation,
  validateRequestObservation,
} from './validation.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const RAW_DAYS = 30
const ROLLUP_DAYS = 365
const DELETE_BATCH = 500
const MAX_DELETE_BATCHES = 20
const INFINITY_BUCKET = 2_147_483_647
const LATENCY_BOUNDS = [25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000]

type SqlValue = string | number | bigint | null | Uint8Array
type SqlParams = Record<string, SqlValue>
type DbRow = Record<string, SqlValue>
type ReceiptKind = 'gateway_request' | 'cpa_http_usage' | 'quota_snapshot' | 'account_health_snapshot'
type DeadLetterSource = 'gateway' | 'cpa_http_usage' | 'quota' | 'account_health'

const RAW_COLUMNS = [
  'request_id_hash', 'occurred_at_ms', 'hour_start_ms', 'day_start_ms', 'route_id', 'provider_id', 'model_id',
  'account_id_hash', 'api_key_id_hash', 'hash_key_version', 'source_gateway_seen', 'source_cpa_http_usage_seen',
  'gateway_source_fingerprint', 'cpa_source_fingerprint', 'outcome', 'error_kind', 'http_status', 'input_tokens',
  'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'time_to_first_token_ms',
  'duration_ms', 'request_units', 'pricing_snapshot_version', 'price_rule_id', 'pricing_source_name',
  'pricing_source_url', 'pricing_source_version', 'pricing_source_sha256', 'currency', 'request_unit_price_micros',
  'input_token_price_micros_per_million', 'output_token_price_micros_per_million',
  'cache_read_token_price_micros_per_million', 'cache_write_token_price_micros_per_million',
  'reasoning_token_price_micros_per_million', 'request_unit_cost_micros', 'input_token_cost_micros',
  'output_token_cost_micros', 'cache_read_token_cost_micros', 'cache_write_token_cost_micros',
  'reasoning_token_cost_micros', 'known_cost_micros', 'estimated_cost_micros', 'pricing_state',
  'first_received_at_ms', 'last_received_at_ms',
] as const

const UPSERT_RAW_SQL = `
  INSERT INTO raw_request_events (${RAW_COLUMNS.join(', ')})
  VALUES (${RAW_COLUMNS.map((column) => `$${column}`).join(', ')})
  ON CONFLICT(request_id_hash) DO UPDATE SET
  ${RAW_COLUMNS.slice(1).map((column) => `${column} = excluded.${column}`).join(', ')}
`

function number(value: SqlValue | undefined): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0
}

function nullableNumber(value: SqlValue | undefined): number | null {
  return value === null || value === undefined ? null : number(value)
}

function string(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function nullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : string(value)
}

function utcBucket(value: number, size: number): number {
  return Math.floor(value / size) * size
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
}

function safeCost(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('analytics cost exceeds the safe integer range')
  return Number(value)
}

function tokenCost(count: number, rate: number): number {
  return safeCost((BigInt(count) * BigInt(rate) + 500_000n) / 1_000_000n)
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null
  values.sort((left, right) => left - right)
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null
}

function sanitizeReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.replace(/[\r\n\t]/g, ' ').slice(0, 256) || 'analytics_error'
}

export class SQLiteAnalyticsEngine implements AnalyticsStore {
  readonly databasePath: string
  private readonly db: DatabaseSync
  private readonly data: WorkerData
  private readonly pricingRules: PricingRule[]
  private readonly leaseOwner = randomUUID()
  private leaseGeneration = 0
  private leaseAcquired = false
  private closed = false

  constructor(data: WorkerData) {
    this.data = data
    this.databasePath = data.databasePath
    this.pricingRules = validatePricingRules(data.pricingRules)
    this.db = openAndMigrateDatabase({ databasePath: data.databasePath, nowMs: Date.now() })
    try {
      ensureCollectorState(this.db, data.targetKey, data.mode)
      this.leaseGeneration = acquireCollectorLease(this.db, data.targetKey, this.leaseOwner)
      this.leaseAcquired = true
      this.db.prepare('UPDATE collector_state SET queue_completeness = ? WHERE target_key = ?').run(data.queueCompleteness, data.targetKey)
      this.installPricingRules()
    } catch (error) {
      if (this.leaseAcquired) {
        try { releaseCollectorLease(this.db, data.targetKey, this.leaseOwner, this.leaseGeneration) } catch { /* preserve the original startup failure */ }
      }
      this.db.close()
      throw error
    }
  }

  async dispatch(operation: WorkerOperation): Promise<WorkerResult> {
    switch (operation.op) {
      case 'status': return this.status()
      case 'summary': return this.summary(operation.filters)
      case 'trend': return this.trend(operation.filters)
      case 'recent': return this.recent(operation.filters)
      case 'quota': return this.quota(operation.filters)
      case 'accountHealth': return this.accountHealth(operation.filters)
      case 'ingestRequest': return this.ingestRequest(operation.observation)
      case 'ingestQuota': return this.ingestQuota(operation.observation)
      case 'ingestAccountHealth': return this.ingestAccountHealth(operation.observation)
      case 'ingestDeadLetter': return this.ingestDeadLetter(operation.observation)
      case 'maintain': await this.maintain(operation.nowMs); return undefined
      case 'close': await this.close(); return undefined
    }
  }

  async status(): Promise<AnalyticsStatus> {
    this.assertOpen()
    const row = this.db.prepare('SELECT collector_status, queue_completeness, loss_possible_count, last_error_kind FROM collector_state WHERE target_key = ?').get(this.data.targetKey) as DbRow | undefined
    const collectorStatus = string(row?.collector_status)
    const availability = collectorStatus === 'disabled' ? 'disabled' : collectorStatus === 'degraded' ? 'degraded' : collectorStatus === 'unavailable' ? 'unavailable' : 'ready'
    const result: AnalyticsStatus = {
      availability,
      mode: this.data.mode,
      databasePath: this.databasePath,
      queueCompleteness: (string(row?.queue_completeness) || 'unknown') as AnalyticsStatus['queueCompleteness'],
      lossPossibleCount: number(row?.loss_possible_count),
    }
    const lastErrorKind = nullableString(row?.last_error_kind)
    return lastErrorKind === null ? result : { ...result, lastErrorKind }
  }

  async ingestRequest(input: RequestObservation): Promise<IngestResult> {
    this.assertOpen()
    const observation = validateRequestObservation(input)
    if (observation.occurredAtMs < Date.now() - ROLLUP_DAYS * DAY_MS) return { disposition: 'outside_retention', requestIdHash: observation.requestIdHash }
    const nowMs = Date.now()
    return transaction(this.db, () => {
      const receipt = this.findReceipt(observationKind(observation.sourceKind), observation.sourceEventKeyHash)
      if (receipt) {
        if (string(receipt.payload_fingerprint) === observation.payloadFingerprint) {
          this.touchReceipt(observationKind(observation.sourceKind), observation.sourceEventKeyHash, nowMs)
          return { disposition: 'duplicate', requestIdHash: observation.requestIdHash }
        }
        this.recordDeadLetter(observation.sourceKind, observation.sourceEventKeyHash, observation.requestIdHash, requestProjection(observation), 'conflicting_source_receipt', observation.payloadFingerprint, nowMs, false, 0, null)
        this.bump('dead_letter_count')
        return { disposition: 'dead_letter', requestIdHash: observation.requestIdHash }
      }

      this.insertReceipt(observationKind(observation.sourceKind), observation.sourceEventKeyHash, observation.requestIdHash, observation.payloadFingerprint, nowMs)
      const previous = this.db.prepare('SELECT * FROM raw_request_events WHERE request_id_hash = ?').get(observation.requestIdHash) as DbRow | undefined
      let merged: SqlParams
      try {
        merged = previous ? this.mergeRequest(previous, observation, nowMs) : this.newRequest(observation, nowMs)
      } catch (error) {
        this.recordDeadLetter(observation.sourceKind, observation.sourceEventKeyHash, observation.requestIdHash, requestProjection(observation), 'conflicting_request_projection', observation.payloadFingerprint, nowMs, false, 0, null)
        this.bump('dead_letter_count')
        return { disposition: 'dead_letter', requestIdHash: observation.requestIdHash }
      }

      const priced = this.applyPricing(merged)
      this.db.prepare(UPSERT_RAW_SQL).run(priced)
      const oldHour = previous ? number(previous.hour_start_ms) : null
      const oldDay = previous ? number(previous.day_start_ms) : null
      this.recomputeBuckets('hour', new Set([oldHour, number(priced.hour_start_ms)].filter((value): value is number => value !== null)))
      this.recomputeBuckets('day', new Set([oldDay, number(priced.day_start_ms)].filter((value): value is number => value !== null)))
      this.bump('committed_count')
      return { disposition: previous ? 'enriched' : 'inserted', requestIdHash: observation.requestIdHash }
    })
  }

  async ingestQuota(input: QuotaObservation): Promise<IngestResult> {
    this.assertOpen()
    const observation = validateQuotaObservation(input)
    if (observation.observedAtMs < Date.now() - ROLLUP_DAYS * DAY_MS) return { disposition: 'outside_retention' }
    return transaction(this.db, () => this.ingestSnapshot('quota_snapshot', observation.sourceEventKeyHash, observation.fingerprint, observation.observedAtMs, quotaProjection(observation), 'quota', () => {
      this.db.prepare(`INSERT INTO quota_snapshots (source_event_key_hash, observed_at_ms, provider_id, account_id_hash, quota_kind, unit, limit_value, used_value, remaining_value, reset_at_ms, source_status, projection_version, fingerprint, hash_key_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(observation.sourceEventKeyHash, observation.observedAtMs, observation.providerId, observation.accountIdHash, observation.quotaKind, observation.unit, observation.limit, observation.used, observation.remaining, observation.resetAtMs, observation.sourceStatus, observation.projectionVersion, observation.fingerprint, observation.hashKeyVersion)
      this.db.prepare('UPDATE collector_state SET last_quota_observed_at_ms = ? WHERE target_key = ?').run(observation.observedAtMs, this.data.targetKey)
    }))
  }

  async ingestAccountHealth(input: AccountHealthObservation): Promise<IngestResult> {
    this.assertOpen()
    const observation = validateAccountHealthObservation(input)
    if (observation.observedAtMs < Date.now() - ROLLUP_DAYS * DAY_MS) return { disposition: 'outside_retention' }
    const fingerprint = healthFingerprint(observation)
    return transaction(this.db, () => this.ingestSnapshot('account_health_snapshot', observation.sourceEventKeyHash, fingerprint, observation.observedAtMs, healthProjection(observation), 'account_health', () => {
      this.db.prepare(`INSERT INTO account_health_snapshots (source_event_key_hash, observed_at_ms, provider_id, account_id_hash, health_status, reason_code, hash_key_version, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(observation.sourceEventKeyHash, observation.observedAtMs, observation.providerId, observation.accountIdHash, observation.healthStatus, observation.reasonCode, observation.hashKeyVersion, fingerprint)
      this.db.prepare('UPDATE collector_state SET last_health_observed_at_ms = ? WHERE target_key = ?').run(observation.observedAtMs, this.data.targetKey)
    }))
  }

  async ingestDeadLetter(input: DeadLetterObservation): Promise<IngestResult> {
    this.assertOpen()
    const observation = validateDeadLetterObservation(input)
    if (observation.occurredAtMs < utcBucket(Date.now(), DAY_MS) - RAW_DAYS * DAY_MS) return { disposition: 'outside_retention' }
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT payload_fingerprint FROM dead_letter_events WHERE source_kind = ? AND source_event_key_hash = ? ORDER BY dead_letter_id DESC LIMIT 1').get(observation.sourceKind, observation.sourceEventKeyHash) as DbRow | undefined
      if (existing && string(existing.payload_fingerprint) === observation.payloadFingerprint) return { disposition: 'duplicate' }
      this.recordDeadLetter(observation.sourceKind, observation.sourceEventKeyHash, null, { ...observation }, observation.reasonCode, observation.payloadFingerprint, observation.occurredAtMs, observation.retryable, observation.retryCount, observation.nextRetryAtMs)
      this.bump('dead_letter_count')
      return { disposition: 'dead_letter' }
    })
  }

  async summary(input: AnalyticsFilters): Promise<AnalyticsSummary> {
    this.assertOpen()
    const filters = validateFilters(input)
    const raw = this.rawWhere(filters)
    const conditions = ['last_request_at_ms >= ?', 'first_request_at_ms < ?']
    const params: SqlValue[] = [filters.fromMs, filters.toMs]
    this.addDimensionFilters(filters, conditions, params)
    const row = this.db.prepare(`
      SELECT SUM(requests) requests, SUM(successes) successes, SUM(errors) errors, SUM(aborted) aborted,
        SUM(input_tokens_sum) input_tokens, SUM(output_tokens_sum) output_tokens,
        SUM(cache_read_tokens_sum) cache_read_tokens, SUM(cache_write_tokens_sum) cache_write_tokens,
        SUM(reasoning_tokens_sum) reasoning_tokens, SUM(known_cost_micros_sum) known_cost_micros,
        SUM(priced_requests) priced_requests, SUM(partial_requests) partial_requests, SUM(unpriced_requests) unpriced_requests,
        CASE WHEN COUNT(DISTINCT NULLIF(currency, '')) = 1 THEN MIN(NULLIF(currency, '')) ELSE NULL END currency
      FROM usage_daily WHERE ${conditions.join(' AND ')}
    `).get(...params) as DbRow
    return this.summaryRow(row, this.rawPercentiles(raw.sql, raw.params))
  }

  async trend(input: AnalyticsFilters & { readonly bucket: 'hour' | 'day' }): Promise<readonly AnalyticsTrendPoint[]> {
    this.assertOpen()
    if (input.bucket !== 'hour' && input.bucket !== 'day') throw new Error('analytics trend bucket is not supported')
    const { bucket, ...filterInput } = input
    const filters = validateFilters(filterInput)
    const table = bucket === 'hour' ? 'usage_hourly' : 'usage_daily'
    const size = bucket === 'hour' ? HOUR_MS : DAY_MS
    const conditions = ['bucket_start_ms >= ?', 'bucket_start_ms < ?']
    const params: SqlValue[] = [utcBucket(filters.fromMs, size), filters.toMs]
    this.addDimensionFilters(filters, conditions, params)
    const rows = this.db.prepare(`
      SELECT bucket_start_ms,
        SUM(requests) requests, SUM(successes) successes, SUM(errors) errors, SUM(aborted) aborted,
        SUM(input_tokens_sum) input_tokens, SUM(output_tokens_sum) output_tokens,
        SUM(cache_read_tokens_sum) cache_read_tokens, SUM(cache_write_tokens_sum) cache_write_tokens,
        SUM(reasoning_tokens_sum) reasoning_tokens, SUM(known_cost_micros_sum) known_cost_micros,
        SUM(priced_requests) priced_requests, SUM(partial_requests) partial_requests, SUM(unpriced_requests) unpriced_requests,
        CASE WHEN COUNT(DISTINCT NULLIF(currency, '')) = 1 THEN MIN(NULLIF(currency, '')) ELSE NULL END currency
      FROM ${table} WHERE ${conditions.join(' AND ')} GROUP BY bucket_start_ms ORDER BY bucket_start_ms ASC LIMIT ${MAX_QUERY_ROWS}
    `).all(...params) as DbRow[]
    return rows.map((row) => {
      const bucketStartMs = number(row.bucket_start_ms)
      const raw = this.rawWhere({ ...filters, fromMs: Math.max(filters.fromMs, bucketStartMs), toMs: Math.min(filters.toMs, bucketStartMs + size) })
      const latencies = this.rawPercentiles(raw.sql, raw.params)
      return { ...this.summaryRow(row, latencies), bucketStartMs }
    })
  }

  async recent(input: AnalyticsFilters & { readonly limit: number; readonly cursor?: string }): Promise<RecentRequestPage> {
    this.assertOpen()
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_RECENT_LIMIT) throw new Error(`analytics recent limit must be within 1..${MAX_RECENT_LIMIT}`)
    const { limit, cursor, ...filterInput } = input
    const filters = validateFilters(filterInput)
    const query = this.rawWhere(filters)
    if (cursor !== undefined) {
      const decoded = this.decodeCursor(cursor)
      query.sql += ' AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND request_id_hash < ?))'
      query.params.push(decoded.occurredAtMs, decoded.occurredAtMs, decoded.requestIdHash)
    }
    const rows = this.db.prepare(`SELECT request_id_hash, occurred_at_ms, route_id, provider_id, model_id, account_id_hash, api_key_id_hash, outcome, error_kind, input_tokens, output_tokens, duration_ms, estimated_cost_micros, currency, pricing_state FROM raw_request_events WHERE ${query.sql} ORDER BY occurred_at_ms DESC, request_id_hash DESC LIMIT ?`).all(...query.params, limit + 1) as DbRow[]
    const hasMore = rows.length > limit
    const visible = hasMore ? rows.slice(0, limit) : rows
    const items = visible.map((row) => ({
      requestIdHash: string(row.request_id_hash), occurredAtMs: number(row.occurred_at_ms), routeId: string(row.route_id),
      providerId: string(row.provider_id), modelId: string(row.model_id), accountIdHash: nullableString(row.account_id_hash),
      apiKeyIdHash: nullableString(row.api_key_id_hash), outcome: string(row.outcome) as 'success' | 'error' | 'aborted',
      errorKind: string(row.error_kind) as import('../contracts.js').RequestErrorKind, inputTokens: nullableNumber(row.input_tokens),
      outputTokens: nullableNumber(row.output_tokens), durationMs: nullableNumber(row.duration_ms),
      estimatedCostMicros: nullableNumber(row.estimated_cost_micros), currency: nullableString(row.currency),
      pricingState: string(row.pricing_state) as 'priced' | 'partial' | 'unpriced',
    }))
    const last = items.at(-1)
    return hasMore && last ? { items, nextCursor: Buffer.from(JSON.stringify([last.occurredAtMs, last.requestIdHash])).toString('base64url') } : { items }
  }

  async quota(input: AnalyticsTimeRange): Promise<readonly QuotaObservation[]> {
    this.assertOpen()
    const filters = validateFilters(input)
    const rows = this.db.prepare(`SELECT source_event_key_hash, provider_id, account_id_hash, quota_kind, unit, limit_value, used_value, remaining_value, reset_at_ms, source_status, projection_version, observed_at_ms, fingerprint, hash_key_version FROM quota_snapshots WHERE observed_at_ms >= ? AND observed_at_ms < ? ORDER BY observed_at_ms DESC LIMIT ${MAX_QUERY_ROWS}`).all(filters.fromMs, filters.toMs) as DbRow[]
    return rows.map((row) => ({
      sourceEventKeyHash: string(row.source_event_key_hash), providerId: string(row.provider_id), accountIdHash: nullableString(row.account_id_hash),
      quotaKind: string(row.quota_kind), unit: string(row.unit), limit: nullableNumber(row.limit_value), used: nullableNumber(row.used_value),
      remaining: nullableNumber(row.remaining_value), resetAtMs: nullableNumber(row.reset_at_ms),
      sourceStatus: string(row.source_status) as QuotaObservation['sourceStatus'], projectionVersion: 1,
      observedAtMs: number(row.observed_at_ms), fingerprint: string(row.fingerprint), hashKeyVersion: number(row.hash_key_version),
    }))
  }

  async accountHealth(input: AnalyticsTimeRange): Promise<readonly AccountHealthObservation[]> {
    this.assertOpen()
    const filters = validateFilters(input)
    const rows = this.db.prepare(`SELECT source_event_key_hash, provider_id, account_id_hash, health_status, reason_code, observed_at_ms, hash_key_version FROM account_health_snapshots WHERE observed_at_ms >= ? AND observed_at_ms < ? ORDER BY observed_at_ms DESC LIMIT ${MAX_QUERY_ROWS}`).all(filters.fromMs, filters.toMs) as DbRow[]
    return rows.map((row) => ({
      sourceEventKeyHash: string(row.source_event_key_hash), providerId: string(row.provider_id), accountIdHash: nullableString(row.account_id_hash),
      healthStatus: string(row.health_status) as AccountHealthObservation['healthStatus'], reasonCode: string(row.reason_code),
      observedAtMs: number(row.observed_at_ms), hashKeyVersion: number(row.hash_key_version),
    }))
  }

  async maintain(nowMs = Date.now()): Promise<void> {
    this.assertOpen()
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('analytics maintenance time must be a non-negative safe integer')
    const rawCutoff = utcBucket(nowMs, DAY_MS) - RAW_DAYS * DAY_MS
    const rollupCutoff = utcBucket(nowMs, DAY_MS) - ROLLUP_DAYS * DAY_MS
    transaction(this.db, () => {
      this.deleteBatches('DELETE FROM raw_request_events WHERE request_id_hash IN (SELECT request_id_hash FROM raw_request_events WHERE occurred_at_ms < ? LIMIT ?)', rawCutoff)
      this.deleteBatches('DELETE FROM dead_letter_events WHERE dead_letter_id IN (SELECT dead_letter_id FROM dead_letter_events WHERE last_failed_at_ms < ? LIMIT ?)', rawCutoff)
      for (const table of ['usage_hourly', 'usage_daily', 'latency_hourly_buckets', 'latency_daily_buckets']) this.deleteBatches(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE bucket_start_ms < ? LIMIT ?)`, rollupCutoff)
      this.deleteBatches('DELETE FROM ingest_receipts WHERE rowid IN (SELECT rowid FROM ingest_receipts WHERE last_received_at_ms < ? LIMIT ?)', rollupCutoff)
      this.deleteBatches('DELETE FROM quota_snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM quota_snapshots WHERE observed_at_ms < ? LIMIT ?)', rollupCutoff)
      this.deleteBatches('DELETE FROM account_health_snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM account_health_snapshots WHERE observed_at_ms < ? LIMIT ?)', rollupCutoff)
    })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (this.leaseAcquired) {
        releaseCollectorLease(this.db, this.data.targetKey, this.leaseOwner, this.leaseGeneration)
        this.leaseAcquired = false
      }
    } finally {
      this.db.close()
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('analytics store is closed')
  }

  private installPricingRules(): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO pricing_rules (pricing_snapshot_version, rule_id, route_id, provider_id, model_id, account_id_hash, api_key_id_hash, currency, request_unit_price_micros, input_token_price_micros_per_million, output_token_price_micros_per_million, cache_read_token_price_micros_per_million, cache_write_token_price_micros_per_million, reasoning_token_price_micros_per_million, effective_from_ms, effective_to_ms, source_name, source_url, source_version, source_sha256, generated_at_ms, release_version, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    transaction(this.db, () => {
      for (const rule of this.pricingRules) {
        insert.run(rule.snapshotVersion, rule.ruleId, rule.routeId, rule.providerId, rule.modelId, rule.accountIdHash, rule.apiKeyIdHash, rule.currency, rule.requestUnitPriceMicros, rule.inputTokenPriceMicrosPerMillion, rule.outputTokenPriceMicrosPerMillion, rule.cacheReadTokenPriceMicrosPerMillion, rule.cacheWriteTokenPriceMicrosPerMillion, rule.reasoningTokenPriceMicrosPerMillion, rule.effectiveFromMs, rule.effectiveToMs, rule.sourceName, rule.sourceUrl, rule.sourceVersion, rule.sourceSha256, rule.generatedAtMs, rule.releaseVersion)
        const row = this.db.prepare('SELECT * FROM pricing_rules WHERE pricing_snapshot_version = ? AND rule_id = ?').get(rule.snapshotVersion, rule.ruleId) as DbRow
        const expected: SqlParams = {
          pricing_snapshot_version: rule.snapshotVersion, rule_id: rule.ruleId, route_id: rule.routeId,
          provider_id: rule.providerId, model_id: rule.modelId, account_id_hash: rule.accountIdHash,
          api_key_id_hash: rule.apiKeyIdHash, currency: rule.currency, request_unit_price_micros: rule.requestUnitPriceMicros,
          input_token_price_micros_per_million: rule.inputTokenPriceMicrosPerMillion,
          output_token_price_micros_per_million: rule.outputTokenPriceMicrosPerMillion,
          cache_read_token_price_micros_per_million: rule.cacheReadTokenPriceMicrosPerMillion,
          cache_write_token_price_micros_per_million: rule.cacheWriteTokenPriceMicrosPerMillion,
          reasoning_token_price_micros_per_million: rule.reasoningTokenPriceMicrosPerMillion,
          effective_from_ms: rule.effectiveFromMs, effective_to_ms: rule.effectiveToMs, source_name: rule.sourceName,
          source_url: rule.sourceUrl, source_version: rule.sourceVersion, source_sha256: rule.sourceSha256,
          generated_at_ms: rule.generatedAtMs, release_version: rule.releaseVersion, enabled: 1,
        }
        if (Object.entries(expected).some(([column, value]) => row[column] !== value)) throw new Error('bundled pricing rule is immutable')
      }
    })
  }

  private findReceipt(kind: ReceiptKind, sourceHash: string): DbRow | undefined {
    return this.db.prepare('SELECT payload_fingerprint FROM ingest_receipts WHERE observation_kind = ? AND source_event_key_hash = ?').get(kind, sourceHash) as DbRow | undefined
  }

  private insertReceipt(kind: ReceiptKind, sourceHash: string, requestHash: string | null, fingerprint: string, nowMs: number): void {
    this.db.prepare('INSERT INTO ingest_receipts (observation_kind, source_event_key_hash, request_id_hash, payload_fingerprint, first_received_at_ms, last_received_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(kind, sourceHash, requestHash, fingerprint, nowMs, nowMs)
  }

  private touchReceipt(kind: ReceiptKind, sourceHash: string, nowMs: number): void {
    this.db.prepare('UPDATE ingest_receipts SET last_received_at_ms = ? WHERE observation_kind = ? AND source_event_key_hash = ?').run(nowMs, kind, sourceHash)
  }

  private ingestSnapshot(kind: ReceiptKind, sourceHash: string, fingerprint: string, occurredAtMs: number, projection: Record<string, unknown>, source: DeadLetterSource, insert: () => void): IngestResult {
    const nowMs = Date.now()
    const receipt = this.findReceipt(kind, sourceHash)
    if (receipt) {
      if (string(receipt.payload_fingerprint) === fingerprint) {
        this.touchReceipt(kind, sourceHash, nowMs)
        return { disposition: 'duplicate' }
      }
      this.recordDeadLetter(source, sourceHash, null, projection, 'conflicting_source_receipt', fingerprint, nowMs, false, 0, null)
      this.bump('dead_letter_count')
      return { disposition: 'dead_letter' }
    }
    this.insertReceipt(kind, sourceHash, null, fingerprint, nowMs)
    insert()
    this.bump('committed_count')
    return { disposition: 'inserted' }
  }

  private recordDeadLetter(source: DeadLetterSource, sourceHash: string, requestHash: string | null, projection: Record<string, unknown>, code: string, fingerprint: string, atMs: number, retryable: boolean, retryCount: number, nextRetryAtMs: number | null): void {
    const json = JSON.stringify(projection)
    if (json.length > MAX_DEAD_LETTER_PROJECTION) throw new Error('dead-letter projection is too large')
    this.db.prepare(`INSERT INTO dead_letter_events (source_kind, source_event_key_hash, request_id_hash, sanitized_projection_json, error_kind, error_code, first_failed_at_ms, last_failed_at_ms, retry_state, retry_count, next_retry_at_ms, payload_fingerprint) VALUES (?, ?, ?, ?, 'invalid_request', ?, ?, ?, ?, ?, ?, ?)`)
      .run(source, sourceHash, requestHash, json, code.slice(0, 256), atMs, atMs, retryable ? 'pending' : 'terminal', retryCount, nextRetryAtMs, fingerprint)
  }

  private newRequest(observation: RequestObservation, nowMs: number): SqlParams {
    const row: SqlParams = {
      request_id_hash: observation.requestIdHash, occurred_at_ms: observation.occurredAtMs,
      hour_start_ms: utcBucket(observation.occurredAtMs, HOUR_MS), day_start_ms: utcBucket(observation.occurredAtMs, DAY_MS),
      route_id: observation.routeId, provider_id: observation.providerId, model_id: observation.modelId,
      account_id_hash: observation.accountIdHash, api_key_id_hash: observation.apiKeyIdHash, hash_key_version: observation.hashKeyVersion,
      source_gateway_seen: observation.sourceKind === 'gateway' ? 1 : 0, source_cpa_http_usage_seen: observation.sourceKind === 'cpa_http_usage' ? 1 : 0,
      gateway_source_fingerprint: observation.sourceKind === 'gateway' ? observation.payloadFingerprint : null,
      cpa_source_fingerprint: observation.sourceKind === 'cpa_http_usage' ? observation.payloadFingerprint : null,
      outcome: observation.outcome, error_kind: observation.errorKind, http_status: observation.httpStatus,
      input_tokens: observation.inputTokens, output_tokens: observation.outputTokens, cache_read_tokens: observation.cacheReadTokens,
      cache_write_tokens: observation.cacheWriteTokens, reasoning_tokens: observation.reasoningTokens,
      time_to_first_token_ms: observation.timeToFirstTokenMs, duration_ms: observation.durationMs, request_units: observation.requestUnits,
      first_received_at_ms: nowMs, last_received_at_ms: nowMs,
    }
    return row
  }

  private mergeRequest(previous: DbRow, observation: RequestObservation, nowMs: number): SqlParams {
    const sameSource = observation.sourceKind === 'gateway' ? number(previous.source_gateway_seen) === 1 : number(previous.source_cpa_http_usage_seen) === 1
    if (sameSource) throw new Error('request source already exists')
    const merged: SqlParams = { ...previous, last_received_at_ms: nowMs }
    const mergeText = (column: string, incoming: string): void => {
      const current = string(previous[column])
      if (current && incoming && current !== incoming) throw new Error(`conflicting ${column}`)
      merged[column] = current || incoming
    }
    const mergeNullable = (column: string, incoming: number | string | null): void => {
      const current = previous[column] ?? null
      if (current !== null && incoming !== null && current !== incoming) throw new Error(`conflicting ${column}`)
      merged[column] = current ?? incoming
    }
    if (number(previous.occurred_at_ms) !== observation.occurredAtMs) throw new Error('conflicting occurred_at_ms')
    if (number(previous.hash_key_version) !== observation.hashKeyVersion || string(previous.outcome) !== observation.outcome || string(previous.error_kind) !== observation.errorKind || number(previous.request_units) !== observation.requestUnits) throw new Error('conflicting request identity fields')
    mergeText('route_id', observation.routeId); mergeText('provider_id', observation.providerId); mergeText('model_id', observation.modelId)
    mergeNullable('account_id_hash', observation.accountIdHash); mergeNullable('api_key_id_hash', observation.apiKeyIdHash)
    mergeNullable('http_status', observation.httpStatus); mergeNullable('input_tokens', observation.inputTokens); mergeNullable('output_tokens', observation.outputTokens)
    mergeNullable('cache_read_tokens', observation.cacheReadTokens); mergeNullable('cache_write_tokens', observation.cacheWriteTokens); mergeNullable('reasoning_tokens', observation.reasoningTokens)
    mergeNullable('time_to_first_token_ms', observation.timeToFirstTokenMs); mergeNullable('duration_ms', observation.durationMs)
    if (observation.sourceKind === 'gateway') { merged.source_gateway_seen = 1; merged.gateway_source_fingerprint = observation.payloadFingerprint }
    else { merged.source_cpa_http_usage_seen = 1; merged.cpa_source_fingerprint = observation.payloadFingerprint }
    return merged
  }

  private applyPricing(row: SqlParams): SqlParams {
    const values = [string(row.route_id), string(row.provider_id), string(row.model_id), nullableString(row.account_id_hash) ?? '', nullableString(row.api_key_id_hash) ?? '']
    const rule = this.pricingRules
      .filter((candidate) => candidate.effectiveFromMs <= number(row.occurred_at_ms) && (candidate.effectiveToMs === null || candidate.effectiveToMs > number(row.occurred_at_ms)))
      .filter((candidate) => [candidate.routeId, candidate.providerId, candidate.modelId, candidate.accountIdHash, candidate.apiKeyIdHash].every((dimension, index) => dimension === '*' || dimension === values[index]))
      .sort((left, right) => this.specificity(right) - this.specificity(left) || right.effectiveFromMs - left.effectiveFromMs || left.ruleId.localeCompare(right.ruleId))[0]
    const empty: SqlParams = {
      pricing_snapshot_version: null, price_rule_id: null, pricing_source_name: null, pricing_source_url: null,
      pricing_source_version: null, pricing_source_sha256: null, currency: null, request_unit_price_micros: null,
      input_token_price_micros_per_million: null, output_token_price_micros_per_million: null,
      cache_read_token_price_micros_per_million: null, cache_write_token_price_micros_per_million: null,
      reasoning_token_price_micros_per_million: null, request_unit_cost_micros: null, input_token_cost_micros: null,
      output_token_cost_micros: null, cache_read_token_cost_micros: null, cache_write_token_cost_micros: null,
      reasoning_token_cost_micros: null, known_cost_micros: 0, estimated_cost_micros: null, pricing_state: 'unpriced',
    }
    if (!rule) return { ...row, ...empty }

    let knownCost = 0n
    let knownParts = 0
    let unknown = false
    const priced: SqlParams = {
      ...row,
      pricing_snapshot_version: rule.snapshotVersion, price_rule_id: rule.ruleId, pricing_source_name: rule.sourceName,
      pricing_source_url: rule.sourceUrl, pricing_source_version: rule.sourceVersion, pricing_source_sha256: rule.sourceSha256,
      currency: rule.currency, request_unit_price_micros: rule.requestUnitPriceMicros,
      input_token_price_micros_per_million: rule.inputTokenPriceMicrosPerMillion,
      output_token_price_micros_per_million: rule.outputTokenPriceMicrosPerMillion,
      cache_read_token_price_micros_per_million: rule.cacheReadTokenPriceMicrosPerMillion,
      cache_write_token_price_micros_per_million: rule.cacheWriteTokenPriceMicrosPerMillion,
      reasoning_token_price_micros_per_million: rule.reasoningTokenPriceMicrosPerMillion,
    }
    const add = (column: string, count: number | null, rate: number | null, perMillion: boolean): void => {
      if (rate !== null && count !== null) {
        const cost = perMillion ? tokenCost(count, rate) : safeCost(BigInt(count) * BigInt(rate))
        priced[column] = cost; knownCost += BigInt(cost); knownParts += 1
      } else {
        priced[column] = null
        if ((rate !== null && count === null) || (rate === null && count !== null && count > 0)) unknown = true
      }
    }
    add('request_unit_cost_micros', number(row.request_units), rule.requestUnitPriceMicros, false)
    add('input_token_cost_micros', nullableNumber(row.input_tokens), rule.inputTokenPriceMicrosPerMillion, true)
    add('output_token_cost_micros', nullableNumber(row.output_tokens), rule.outputTokenPriceMicrosPerMillion, true)
    add('cache_read_token_cost_micros', nullableNumber(row.cache_read_tokens), rule.cacheReadTokenPriceMicrosPerMillion, true)
    add('cache_write_token_cost_micros', nullableNumber(row.cache_write_tokens), rule.cacheWriteTokenPriceMicrosPerMillion, true)
    add('reasoning_token_cost_micros', nullableNumber(row.reasoning_tokens), rule.reasoningTokenPriceMicrosPerMillion, true)
    const known = safeCost(knownCost)
    const state = !unknown && knownParts > 0 ? 'priced' : knownParts > 0 ? 'partial' : 'unpriced'
    return { ...priced, known_cost_micros: known, estimated_cost_micros: state === 'priced' ? known : null, pricing_state: state }
  }

  private specificity(rule: PricingRule): number {
    return [rule.routeId, rule.providerId, rule.modelId, rule.accountIdHash, rule.apiKeyIdHash].filter((value) => value !== '*').length
  }

  private recomputeBuckets(kind: 'hour' | 'day', buckets: Set<number>): void {
    const usage = kind === 'hour' ? 'usage_hourly' : 'usage_daily'
    const latency = kind === 'hour' ? 'latency_hourly_buckets' : 'latency_daily_buckets'
    const sourceBucket = kind === 'hour' ? 'hour_start_ms' : 'day_start_ms'
    for (const bucket of buckets) {
      this.db.prepare(`DELETE FROM ${usage} WHERE bucket_start_ms = ?`).run(bucket)
      this.db.prepare(`
        INSERT INTO ${usage}
        SELECT ${sourceBucket}, route_id, provider_id, model_id, COALESCE(account_id_hash, ''), COALESCE(api_key_id_hash, ''), hash_key_version, COALESCE(currency, ''),
          COUNT(*), SUM(outcome = 'success'), SUM(outcome = 'error'), SUM(outcome = 'aborted'), SUM(request_units),
          SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)), SUM(COALESCE(cache_read_tokens, 0)), SUM(COALESCE(cache_write_tokens, 0)), SUM(COALESCE(reasoning_tokens, 0)),
          SUM(input_tokens IS NOT NULL), SUM(output_tokens IS NOT NULL), SUM(cache_read_tokens IS NOT NULL), SUM(cache_write_tokens IS NOT NULL), SUM(reasoning_tokens IS NOT NULL),
          SUM(time_to_first_token_ms IS NOT NULL), SUM(COALESCE(time_to_first_token_ms, 0)), SUM(duration_ms IS NOT NULL), SUM(COALESCE(duration_ms, 0)),
          SUM(pricing_state = 'priced'), SUM(pricing_state = 'partial'), SUM(pricing_state = 'unpriced'), SUM(known_cost_micros), SUM(COALESCE(estimated_cost_micros, 0)),
          MIN(occurred_at_ms), MAX(occurred_at_ms)
        FROM raw_request_events WHERE ${sourceBucket} = ?
        GROUP BY ${sourceBucket}, route_id, provider_id, model_id, COALESCE(account_id_hash, ''), COALESCE(api_key_id_hash, ''), hash_key_version, COALESCE(currency, '')
      `).run(bucket)
      this.db.prepare(`DELETE FROM ${latency} WHERE bucket_start_ms = ?`).run(bucket)
      for (const [column, metric] of [['time_to_first_token_ms', 'time_to_first_token'], ['duration_ms', 'duration']] as const) {
        const bucketCase = `CASE ${LATENCY_BOUNDS.map((bound) => `WHEN ${column} <= ${bound} THEN ${bound}`).join(' ')} ELSE ${INFINITY_BUCKET} END`
        this.db.prepare(`
          INSERT INTO ${latency}
          SELECT ${sourceBucket}, route_id, provider_id, model_id, COALESCE(account_id_hash, ''), COALESCE(api_key_id_hash, ''), hash_key_version, COALESCE(currency, ''), '${metric}', ${bucketCase}, COUNT(*)
          FROM raw_request_events WHERE ${sourceBucket} = ? AND ${column} IS NOT NULL
          GROUP BY ${sourceBucket}, route_id, provider_id, model_id, COALESCE(account_id_hash, ''), COALESCE(api_key_id_hash, ''), hash_key_version, COALESCE(currency, ''), ${bucketCase}
        `).run(bucket)
      }
    }
  }

  private rawWhere(filters: AnalyticsFilters): { sql: string; params: SqlValue[] } {
    const conditions = ['occurred_at_ms >= ?', 'occurred_at_ms < ?']
    const params: SqlValue[] = [filters.fromMs, filters.toMs]
    this.addDimensionFilters(filters, conditions, params)
    return { sql: conditions.join(' AND '), params }
  }

  private addDimensionFilters(filters: AnalyticsFilters, conditions: string[], params: SqlValue[]): void {
    for (const [property, column] of [['routeId', 'route_id'], ['providerId', 'provider_id'], ['modelId', 'model_id'], ['accountIdHash', 'account_id_hash'], ['apiKeyIdHash', 'api_key_id_hash']] as const) {
      const value = filters[property]
      if (value !== undefined) { conditions.push(`${column} = ?`); params.push(value) }
    }
  }

  private summaryRow(row: DbRow, latency: Pick<AnalyticsSummary, 'p50DurationMs' | 'p95DurationMs' | 'p50TimeToFirstTokenMs' | 'p95TimeToFirstTokenMs'>): AnalyticsSummary {
    return {
      requests: number(row.requests), successes: number(row.successes), errors: number(row.errors), aborted: number(row.aborted),
      inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), cacheReadTokens: number(row.cache_read_tokens),
      cacheWriteTokens: number(row.cache_write_tokens), reasoningTokens: number(row.reasoning_tokens), knownCostMicros: number(row.known_cost_micros),
      pricedRequests: number(row.priced_requests), partialRequests: number(row.partial_requests), unpricedRequests: number(row.unpriced_requests),
      currency: nullableString(row.currency), ...latency,
    }
  }

  private rawPercentiles(where: string, params: SqlValue[]): Pick<AnalyticsSummary, 'p50DurationMs' | 'p95DurationMs' | 'p50TimeToFirstTokenMs' | 'p95TimeToFirstTokenMs'> {
    const rows = this.db.prepare(`SELECT duration_ms, time_to_first_token_ms FROM raw_request_events WHERE ${where} AND (duration_ms IS NOT NULL OR time_to_first_token_ms IS NOT NULL) ORDER BY occurred_at_ms DESC LIMIT 10000`).all(...params) as DbRow[]
    const durations = rows.flatMap((row) => row.duration_ms === null ? [] : [number(row.duration_ms)])
    const firstTokens = rows.flatMap((row) => row.time_to_first_token_ms === null ? [] : [number(row.time_to_first_token_ms)])
    return { p50DurationMs: percentile(durations, 0.5), p95DurationMs: percentile(durations, 0.95), p50TimeToFirstTokenMs: percentile(firstTokens, 0.5), p95TimeToFirstTokenMs: percentile(firstTokens, 0.95) }
  }

  private decodeCursor(cursor: string): { occurredAtMs: number; requestIdHash: string } {
    if (cursor.length > 512) throw new Error('analytics recent cursor is too long')
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== 'string' || !/^[0-9a-f]{64}$/.test(parsed[1])) throw new Error('invalid')
      return { occurredAtMs: parsed[0] as number, requestIdHash: parsed[1] }
    } catch {
      throw new Error('analytics recent cursor is invalid')
    }
  }

  private deleteBatches(sql: string, cutoff: number): void {
    const statement = this.db.prepare(sql)
    for (let batch = 0; batch < MAX_DELETE_BATCHES; batch += 1) {
      const result = statement.run(cutoff, DELETE_BATCH)
      if (number(result.changes) < DELETE_BATCH) break
    }
  }

  private bump(column: 'committed_count' | 'dead_letter_count'): void {
    this.db.prepare(`UPDATE collector_state SET ${column} = ${column} + 1 WHERE target_key = ?`).run(this.data.targetKey)
  }
}

export function sanitizeWorkerError(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name.slice(0, 64) : 'Error', message: sanitizeReason(error) }
}
