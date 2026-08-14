import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const ANALYTICS_SCHEMA_VERSION = 1
export const ANALYTICS_MIGRATION_NAME = '0001_sanitized_usage_analytics'
export const ANALYTICS_BUSY_TIMEOUT_MS = 5_000

export const MIGRATION_0001_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  checksum TEXT NOT NULL
) STRICT;

CREATE TABLE collector_state (
  target_key TEXT PRIMARY KEY,
  collector_mode TEXT NOT NULL CHECK (collector_mode IN ('disabled', 'managed', 'external')),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  last_successful_poll_at_ms INTEGER,
  last_quota_observed_at_ms INTEGER,
  last_health_observed_at_ms INTEGER,
  last_error_kind TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  queue_delivery TEXT NOT NULL DEFAULT 'at_most_once' CHECK (queue_delivery = 'at_most_once'),
  queue_completeness TEXT NOT NULL DEFAULT 'unknown' CHECK (queue_completeness IN ('unknown', 'sole_consumer', 'competition_possible', 'crash_loss_possible')),
  collector_status TEXT NOT NULL DEFAULT 'healthy' CHECK (collector_status IN ('healthy', 'degraded', 'unavailable', 'disabled')),
  popped_count INTEGER NOT NULL DEFAULT 0,
  committed_count INTEGER NOT NULL DEFAULT 0,
  dead_letter_count INTEGER NOT NULL DEFAULT 0,
  loss_possible_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE ingest_receipts (
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('gateway_request', 'cpa_http_usage', 'quota_snapshot', 'account_health_snapshot')),
  source_event_key_hash TEXT NOT NULL CHECK (length(source_event_key_hash) = 64),
  request_id_hash TEXT CHECK (request_id_hash IS NULL OR length(request_id_hash) = 64),
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64),
  first_received_at_ms INTEGER NOT NULL,
  last_received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (observation_kind, source_event_key_hash)
) STRICT;

CREATE TABLE pricing_rules (
  pricing_snapshot_version TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  account_id_hash TEXT NOT NULL,
  api_key_id_hash TEXT NOT NULL,
  currency TEXT NOT NULL,
  request_unit_price_micros INTEGER,
  input_token_price_micros_per_million INTEGER,
  output_token_price_micros_per_million INTEGER,
  cache_read_token_price_micros_per_million INTEGER,
  cache_write_token_price_micros_per_million INTEGER,
  reasoning_token_price_micros_per_million INTEGER,
  effective_from_ms INTEGER NOT NULL,
  effective_to_ms INTEGER,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  generated_at_ms INTEGER NOT NULL,
  release_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled = 1),
  PRIMARY KEY (pricing_snapshot_version, rule_id)
) STRICT;

CREATE TABLE raw_request_events (
  request_id_hash TEXT PRIMARY KEY CHECK (length(request_id_hash) = 64),
  occurred_at_ms INTEGER NOT NULL,
  hour_start_ms INTEGER NOT NULL,
  day_start_ms INTEGER NOT NULL,
  route_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  account_id_hash TEXT,
  api_key_id_hash TEXT,
  hash_key_version INTEGER NOT NULL,
  source_gateway_seen INTEGER NOT NULL DEFAULT 0 CHECK (source_gateway_seen IN (0, 1)),
  source_cpa_http_usage_seen INTEGER NOT NULL DEFAULT 0 CHECK (source_cpa_http_usage_seen IN (0, 1)),
  gateway_source_fingerprint TEXT,
  cpa_source_fingerprint TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'aborted')),
  error_kind TEXT NOT NULL CHECK (error_kind IN ('none', 'authentication', 'authorization', 'rate_limit', 'upstream', 'timeout', 'cancelled', 'invalid_request', 'unknown')),
  http_status INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  time_to_first_token_ms INTEGER,
  duration_ms INTEGER,
  request_units INTEGER NOT NULL,
  pricing_snapshot_version TEXT,
  price_rule_id TEXT,
  pricing_source_name TEXT,
  pricing_source_url TEXT,
  pricing_source_version TEXT,
  pricing_source_sha256 TEXT,
  currency TEXT,
  request_unit_price_micros INTEGER,
  input_token_price_micros_per_million INTEGER,
  output_token_price_micros_per_million INTEGER,
  cache_read_token_price_micros_per_million INTEGER,
  cache_write_token_price_micros_per_million INTEGER,
  reasoning_token_price_micros_per_million INTEGER,
  request_unit_cost_micros INTEGER,
  input_token_cost_micros INTEGER,
  output_token_cost_micros INTEGER,
  cache_read_token_cost_micros INTEGER,
  cache_write_token_cost_micros INTEGER,
  reasoning_token_cost_micros INTEGER,
  known_cost_micros INTEGER NOT NULL,
  estimated_cost_micros INTEGER,
  pricing_state TEXT NOT NULL CHECK (pricing_state IN ('priced', 'partial', 'unpriced')),
  first_received_at_ms INTEGER NOT NULL,
  last_received_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE usage_hourly (
  bucket_start_ms INTEGER NOT NULL,
  route_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  account_id_hash TEXT NOT NULL,
  api_key_id_hash TEXT NOT NULL,
  hash_key_version INTEGER NOT NULL,
  currency TEXT NOT NULL,
  requests INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  aborted INTEGER NOT NULL,
  request_units_sum INTEGER NOT NULL,
  input_tokens_sum INTEGER NOT NULL,
  output_tokens_sum INTEGER NOT NULL,
  cache_read_tokens_sum INTEGER NOT NULL,
  cache_write_tokens_sum INTEGER NOT NULL,
  reasoning_tokens_sum INTEGER NOT NULL,
  input_tokens_known_count INTEGER NOT NULL,
  output_tokens_known_count INTEGER NOT NULL,
  cache_read_tokens_known_count INTEGER NOT NULL,
  cache_write_tokens_known_count INTEGER NOT NULL,
  reasoning_tokens_known_count INTEGER NOT NULL,
  time_to_first_token_known_count INTEGER NOT NULL,
  time_to_first_token_sum INTEGER NOT NULL,
  duration_known_count INTEGER NOT NULL,
  duration_sum INTEGER NOT NULL,
  priced_requests INTEGER NOT NULL,
  partial_requests INTEGER NOT NULL,
  unpriced_requests INTEGER NOT NULL,
  known_cost_micros_sum INTEGER NOT NULL,
  estimated_cost_micros_sum INTEGER NOT NULL,
  first_request_at_ms INTEGER NOT NULL,
  last_request_at_ms INTEGER NOT NULL,
  PRIMARY KEY (bucket_start_ms, route_id, provider_id, model_id, account_id_hash, api_key_id_hash, hash_key_version, currency)
) STRICT;

CREATE TABLE usage_daily AS SELECT * FROM usage_hourly WHERE 0;
CREATE UNIQUE INDEX usage_daily_pk ON usage_daily (bucket_start_ms, route_id, provider_id, model_id, account_id_hash, api_key_id_hash, hash_key_version, currency);

CREATE TABLE latency_hourly_buckets (
  bucket_start_ms INTEGER NOT NULL,
  route_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  account_id_hash TEXT NOT NULL,
  api_key_id_hash TEXT NOT NULL,
  hash_key_version INTEGER NOT NULL,
  currency TEXT NOT NULL,
  metric_kind TEXT NOT NULL CHECK (metric_kind IN ('time_to_first_token', 'duration')),
  upper_bound_ms INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (bucket_start_ms, route_id, provider_id, model_id, account_id_hash, api_key_id_hash, hash_key_version, currency, metric_kind, upper_bound_ms)
) STRICT;

CREATE TABLE latency_daily_buckets AS SELECT * FROM latency_hourly_buckets WHERE 0;
CREATE UNIQUE INDEX latency_daily_pk ON latency_daily_buckets (bucket_start_ms, route_id, provider_id, model_id, account_id_hash, api_key_id_hash, hash_key_version, currency, metric_kind, upper_bound_ms);

CREATE TABLE quota_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_key_hash TEXT NOT NULL CHECK (length(source_event_key_hash) = 64),
  observed_at_ms INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  account_id_hash TEXT,
  quota_kind TEXT NOT NULL,
  unit TEXT NOT NULL,
  limit_value REAL,
  used_value REAL,
  remaining_value REAL,
  reset_at_ms INTEGER,
  source_status TEXT NOT NULL CHECK (source_status IN ('available', 'unavailable', 'unsupported')),
  projection_version INTEGER NOT NULL CHECK (projection_version = 1),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  hash_key_version INTEGER NOT NULL
) STRICT;

CREATE TABLE account_health_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_key_hash TEXT NOT NULL CHECK (length(source_event_key_hash) = 64),
  observed_at_ms INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  account_id_hash TEXT,
  health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'degraded', 'unavailable', 'unsupported')),
  reason_code TEXT NOT NULL,
  hash_key_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64)
) STRICT;

CREATE TABLE dead_letter_events (
  dead_letter_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('gateway', 'cpa_http_usage', 'quota', 'account_health')),
  source_event_key_hash TEXT CHECK (source_event_key_hash IS NULL OR length(source_event_key_hash) = 64),
  request_id_hash TEXT CHECK (request_id_hash IS NULL OR length(request_id_hash) = 64),
  sanitized_projection_json TEXT NOT NULL,
  error_kind TEXT NOT NULL CHECK (error_kind IN ('none', 'authentication', 'authorization', 'rate_limit', 'upstream', 'timeout', 'cancelled', 'invalid_request', 'unknown')),
  error_code TEXT NOT NULL,
  first_failed_at_ms INTEGER NOT NULL,
  last_failed_at_ms INTEGER NOT NULL,
  retry_state TEXT NOT NULL CHECK (retry_state IN ('pending', 'terminal', 'resolved')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64)
) STRICT;

CREATE INDEX raw_request_events_occurred_idx ON raw_request_events (occurred_at_ms DESC);
CREATE INDEX raw_request_events_route_idx ON raw_request_events (route_id, occurred_at_ms DESC);
CREATE INDEX raw_request_events_provider_model_idx ON raw_request_events (provider_id, model_id, occurred_at_ms DESC);
CREATE INDEX raw_request_events_account_idx ON raw_request_events (account_id_hash, occurred_at_ms DESC);
CREATE INDEX raw_request_events_api_key_idx ON raw_request_events (api_key_id_hash, occurred_at_ms DESC);
CREATE INDEX usage_hourly_bucket_provider_idx ON usage_hourly (bucket_start_ms, provider_id, model_id);
CREATE INDEX usage_hourly_account_idx ON usage_hourly (account_id_hash, bucket_start_ms);
CREATE INDEX usage_hourly_api_key_idx ON usage_hourly (api_key_id_hash, bucket_start_ms);
CREATE INDEX usage_daily_bucket_provider_idx ON usage_daily (bucket_start_ms, provider_id, model_id);
CREATE INDEX usage_daily_account_idx ON usage_daily (account_id_hash, bucket_start_ms);
CREATE INDEX usage_daily_api_key_idx ON usage_daily (api_key_id_hash, bucket_start_ms);
CREATE INDEX latency_hourly_bucket_idx ON latency_hourly_buckets (bucket_start_ms, provider_id, model_id, metric_kind, upper_bound_ms);
CREATE INDEX latency_daily_bucket_idx ON latency_daily_buckets (bucket_start_ms, provider_id, model_id, metric_kind, upper_bound_ms);
CREATE INDEX quota_snapshots_account_idx ON quota_snapshots (account_id_hash, observed_at_ms DESC);
CREATE INDEX quota_snapshots_provider_idx ON quota_snapshots (provider_id, observed_at_ms DESC);
CREATE INDEX account_health_snapshots_account_idx ON account_health_snapshots (account_id_hash, observed_at_ms DESC);
CREATE INDEX dead_letter_retry_idx ON dead_letter_events (retry_state, next_retry_at_ms);
CREATE INDEX dead_letter_source_idx ON dead_letter_events (source_kind, source_event_key_hash);
CREATE UNIQUE INDEX ingest_receipts_kind_source_idx ON ingest_receipts (observation_kind, source_event_key_hash);
`

export const MIGRATION_0001_CHECKSUM = createHash('sha256').update(MIGRATION_0001_SQL).digest('hex')

export interface DatabaseOptions {
  readonly databasePath: string
  readonly nowMs: number
}

export function openAndMigrateDatabase(options: DatabaseOptions): DatabaseSync {
  mkdirSync(dirname(options.databasePath), { recursive: true })
  const db = new DatabaseSync(options.databasePath, { timeout: ANALYTICS_BUSY_TIMEOUT_MS })
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    applyMigrations(db, options.nowMs)
    return db
  } catch (error) {
    try { db.close() } catch { /* preserve the original startup failure */ }
    throw error
  }
}

export function applyMigrations(db: DatabaseSync, nowMs: number): void {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL, checksum TEXT NOT NULL) STRICT;')

  const userVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
  if (!Number.isSafeInteger(userVersion) || userVersion < 0 || userVersion > ANALYTICS_SCHEMA_VERSION) {
    throw new Error(`unsupported analytics schema version: ${String(userVersion)}`)
  }

  const ledger = db.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version = ?').get(ANALYTICS_SCHEMA_VERSION) as { version?: number; name?: string; checksum?: string } | undefined
  if (ledger && (ledger.name !== ANALYTICS_MIGRATION_NAME || ledger.checksum !== MIGRATION_0001_CHECKSUM)) {
    throw new Error('analytics migration checksum mismatch')
  }

  const newer = db.prepare('SELECT version FROM schema_migrations WHERE version > ? LIMIT 1').get(ANALYTICS_SCHEMA_VERSION) as { version?: number } | undefined
  if (newer) throw new Error(`unsupported analytics migration version: ${String(newer.version)}`)

  if (!ledger) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(MIGRATION_0001_SQL)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at_ms, checksum) VALUES (?, ?, ?, ?)').run(ANALYTICS_SCHEMA_VERSION, ANALYTICS_MIGRATION_NAME, nowMs, MIGRATION_0001_CHECKSUM)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve migration failure */ }
      throw error
    }
  }

  if (userVersion !== ANALYTICS_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${ANALYTICS_SCHEMA_VERSION}`)
}

export function ensureCollectorState(db: DatabaseSync, targetKey: string, mode: 'disabled' | 'managed' | 'external'): void {
  db.prepare(`
    INSERT INTO collector_state (target_key, collector_mode, collector_status)
    VALUES (?, ?, ?)
    ON CONFLICT(target_key) DO UPDATE SET collector_mode = excluded.collector_mode
  `).run(targetKey, mode, mode === 'disabled' ? 'disabled' : 'healthy')
}

/** Acquire the one live collector lease for a target and return its generation. */
export function acquireCollectorLease(db: DatabaseSync, targetKey: string, owner: string): number {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare(`
      UPDATE collector_state
      SET lease_owner = ?, lease_generation = lease_generation + 1
      WHERE target_key = ? AND lease_owner IS NULL
    `).run(owner, targetKey)
    if (Number(result.changes) !== 1) throw new Error('analytics collector lease is already held')
    const row = db.prepare('SELECT lease_generation FROM collector_state WHERE target_key = ? AND lease_owner = ?').get(targetKey, owner) as { lease_generation?: number | bigint } | undefined
    if (row?.lease_generation === undefined) throw new Error('analytics collector lease was not recorded')
    db.exec('COMMIT')
    return Number(row.lease_generation)
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original lease failure */ }
    throw error
  }
}

/** Release only the generation owned by this engine instance. */
export function releaseCollectorLease(db: DatabaseSync, targetKey: string, owner: string, generation: number): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      UPDATE collector_state
      SET lease_owner = NULL
      WHERE target_key = ? AND lease_owner = ? AND lease_generation = ?
    `).run(targetKey, owner, generation)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original lease failure */ }
    throw error
  }
}
