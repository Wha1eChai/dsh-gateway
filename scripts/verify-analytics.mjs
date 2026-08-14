import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const analytics = await import(pathToFileURL(path.join(root, 'packages', 'analytics', 'lib', 'index.js')).href)
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-gateway-analytics-'))
const databasePath = path.join(tempRoot, 'usage.sqlite3')
const hash = 'a'.repeat(64)

try {
  const store = analytics.createAnalyticsWorkerStore({
    databasePath,
    targetKey: 'b'.repeat(64),
    mode: 'managed',
    queueCompleteness: 'sole_consumer',
    pricingRules: [],
  })
  const now = Date.now()
  const status = await store.status()
  if (status.availability !== 'ready' || status.mode !== 'managed') throw new Error('analytics worker did not become ready')
  const inserted = await store.ingestRequest({
    schemaVersion: 1,
    sourceKind: 'cpa_http_usage',
    sourceEventKeyHash: hash,
    requestIdHash: 'c'.repeat(64),
    payloadFingerprint: 'd'.repeat(64),
    occurredAtMs: now,
    routeId: '/v1/chat/completions',
    providerId: 'cpa',
    modelId: 'fixture-model',
    accountIdHash: null,
    apiKeyIdHash: null,
    hashKeyVersion: 1,
    outcome: 'success',
    errorKind: 'none',
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    timeToFirstTokenMs: 12,
    durationMs: 40,
    requestUnits: 1,
  })
  if (inserted.disposition !== 'inserted') throw new Error(`unexpected analytics disposition: ${inserted.disposition}`)
  const duplicate = await store.ingestRequest({
    schemaVersion: 1,
    sourceKind: 'cpa_http_usage',
    sourceEventKeyHash: hash,
    requestIdHash: 'c'.repeat(64),
    payloadFingerprint: 'd'.repeat(64),
    occurredAtMs: now,
    routeId: '/v1/chat/completions',
    providerId: 'cpa',
    modelId: 'fixture-model',
    accountIdHash: null,
    apiKeyIdHash: null,
    hashKeyVersion: 1,
    outcome: 'success',
    errorKind: 'none',
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    timeToFirstTokenMs: 12,
    durationMs: 40,
    requestUnits: 1,
  })
  if (duplicate.disposition !== 'duplicate') throw new Error('analytics worker did not deduplicate')
  const summary = await store.summary({ fromMs: now - 1, toMs: now + 1 })
  if (summary.requests !== 1 || summary.inputTokens !== 10 || summary.unpricedRequests !== 1) {
    throw new Error('analytics worker summary is incorrect')
  }
  await store.close()

  const database = new DatabaseSync(databasePath, { readOnly: true })
  const columns = database.prepare("SELECT name FROM pragma_table_info('raw_request_events') ORDER BY name").all().map((row) => String(row.name))
  database.close()
  if (columns.some((name) => /prompt|image|output_content|authorization|credential|token_value|auth_file/u.test(name))) {
    throw new Error(`analytics schema contains a forbidden content/secret column: ${columns.join(',')}`)
  }
  process.stdout.write(`${JSON.stringify({ result: 'PASS', worker: 'built-entry', requests: 1, unpriced: 1, schemaColumns: columns.length })}\n`)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
