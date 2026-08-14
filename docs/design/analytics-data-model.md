# dsh-gateway analytics data model

Status: Phase 0 schema and operational freeze.

Analytics is an optional, local observer of sanitized gateway usage. It is not
required for model traffic and is not a provider invoice. In this document,
**raw detail** means one row per request after redaction and irreversible
identifier hashing; it never means a raw model request, model response, or CPA
Management API response.

The approved privacy boundary retains operational metrics and dimensions:
provider, model, route, irreversible account/API-key hashes, request outcome,
token-category counts when supplied, time to first token, total duration,
request units, pricing snapshots, estimated cost, account health, and quota
history. It excludes prompts, images, model output, tool content, credentials,
auth files, refresh tokens, authorization headers, raw keys, raw auth indices,
and full upstream responses.

## Invariants

1. `analytics` is optional. Removing or disabling it must not change model
   delivery, provider selection, retries, or the external/managed gateway
   modes.
2. One worker thread owns one `node:sqlite` `DatabaseSync` connection. The
   Host, browser, runtime, collector client, and test process never open the
   SQLite file directly.
3. The worker enables WAL and foreign keys. All database writes, dedupe,
   enrichment, rollup deltas, snapshots, and dead-letter transitions are
   serialized by that worker.
4. Raw sanitized request detail is retained for 30 days. Hourly usage
   rollups, daily usage rollups, quota snapshots, and account-health history
   are retained for one year.
5. Token counts remain visible when provided even if pricing is absent.
   Unknown or incomplete pricing produces an unknown estimated cost, never a
   fabricated zero.
6. Account and API-key dimensions are persisted only as installation-scoped,
   irreversible hashes. Raw keys, key fragments, auth indices, account
   identifiers, and tokens are never stored.
7. Analytics and the Dashboard are read-only with respect to CPA accounts.
   They do not rotate accounts, change routing, reset quota, clear cooldowns,
   enable credentials, or retry model requests.

## Collection modes and source boundary

Version 0.1 accepts usage records through CPA's documented HTTP usage queue
only. Redis RESP access to that queue is unsupported and must not be added as
a fallback.

The collector modes are explicit:

- **Managed CPA:** the analytics collector is the sole HTTP usage-queue
  consumer for the DSH-owned CPA instance. CPA `GET /usage-queue` destructively
  pops each item and exposes no acknowledgement operation. The collector is
  therefore at-most-once and pop-before-commit: a crash after the pop and
  before the normalized observation or dead-letter transaction commits loses
  that item. A second panel, script, or external collector must not consume the
  queue.
- **External CPA:** queue collection is disabled by default. Enabling it is an
  explicit operator opt-in that presents and records acceptance of a warning:
  HTTP queue consumers compete, so another consumer can make DSH history
  incomplete. DSH cannot claim complete usage while another consumer runs.
- **Disabled:** no queue polling or database creation occurs. Gateway traffic
  continues normally.

At most one managed collector may hold the collector lease for one analytics
state directory. Collector state records the selected mode, destructive-pop
delivery semantics, completeness/degraded status, and sanitized poll status,
not a management key or upstream body. No collector status may claim
exactly-once or complete queue history.

The normalized analytics model combines three Host-side sources:

1. `gateway/request-completed` supplies the DSH route, terminal result,
   `time_to_first_token_ms`, `duration_ms`, and a stable request correlation
   identity.
2. The CPA HTTP usage queue supplies request outcome, provider/model,
   account/API-key source identities, token categories, and duration fields
   where the selected release provides them.
3. Host-only, allowlisted, read-only management projections supply quota and
   account health snapshots. Account health has one source, `GET
   /v0/management/auth-files`, and is accepted only through a strict redacted
   projection. Quota has one v0.1 source: the fixed Host-internal Codex read
   adapter may call CPA `POST /v0/management/api-call` with `authIndex`
   selected from an internal allowlisted auth-file inventory, `method: GET`,
   URL exactly `https://chatgpt.com/backend-api/wham/usage`, and headers
   `Authorization: Bearer $TOKEN$`, `Content-Type: application/json`, a fixed
   Gateway User-Agent, and an optional selected internal
   `Chatgpt-Account-Id`. The client cannot parameterize any part of this
   payload and there is no generic client `/api-call` remote. Each response is
   bounded and projected into the strict typed fields below in Host memory;
   the raw response is discarded before a worker message or database write.
   Other providers are `unsupported` or `unavailable`, never fabricated.

The gateway-generated request identity is forwarded to CPA when the selected
release supports request-ID propagation. A gateway event and an HTTP usage
event with the same identity enrich one request row rather than count twice.
An upstream event without a stable dedupe identity is dead-lettered; timestamp
and model heuristics are never used because two legitimate requests can share
those values.

The strict `/v0/management/auth-files` health projection contains only
`provider_id`, installation-scoped `account_id_hash` when an account identity
is safely available, `health_status`, bounded `reason_code`, and
`observed_at_ms`. It contains no auth index, filename/path, credential state
body, authorization value, token, key, or arbitrary source field. A missing,
unsupported, malformed, oversized, or unauthorized source produces
`unsupported` or `unavailable`, never a fabricated healthy result.

The fixed Codex quota projection contains only bounded quota-window records:
`provider_id`, optional `account_id_hash`, normalized quota kind/unit, nullable
limit/used/remaining/reset-at values, source status, projection version, and
observation/fingerprint fields. It cannot contain the management request,
authIndex, URL, headers, token, or raw `wham/usage` response. A source failure
produces `unsupported` or `unavailable`; missing numeric values remain null
and are never coerced to zero.

## Irreversible identifiers

The analytics package provisions a random 256-bit installation key in DSH
credentials. It is resolved only in Host/collector memory and is never stored
in SQLite, logs, browser state, or a release artifact.

Persistent identifier dimensions use lowercase hexadecimal HMAC-SHA-256:

```text
hash = HMAC-SHA-256(installationKey, namespace + "\0" + canonicalIdentifier)
```

Namespaces separate `request`, `account`, `api-key`, and source-event values;
the canonical identifier also includes the configured gateway target identity
so equal upstream-local indices on two targets do not collide.
The database stores `hash_key_version` with hashed dimensions so a deliberate
key rotation starts new dimension identities without attempting to reidentify
old rows. From the database alone, `account_id_hash` and `api_key_id_hash`
cannot be reversed to a CPA auth index, account identifier, API-key ID, key
fragment, or credential value.

The Host-side source projector computes these hashes in the same bounded step
that parses the allowlisted response fields. The normalized collector event,
worker message, database, logs, and Dashboard receive only hashes—never a raw
account identifier, auth index, API-key identifier, key fragment, or key. An
authorization value, OAuth access token, or refresh token is rejected outright
and is not retained even in dead-letter storage.

## Normalized request observation

The worker accepts a versioned, bounded observation after source-specific
normalization. Nullable means the source did not supply that metric; nullable
never means zero.

| Field | Type/rule | Meaning |
| --- | --- | --- |
| `schema_version` | integer, currently `1` | analytics wire version |
| `source_kind` | `gateway` or `cpa_http_usage` | normalized source |
| `source_event_key_hash` | required HMAC-SHA-256 | delivery dedupe identity |
| `request_id_hash` | required HMAC-SHA-256 | cross-source request identity |
| `payload_fingerprint` | required SHA-256 | canonical fingerprint of sanitized fields |
| `occurred_at_ms` | non-negative integer | request terminal time in UTC |
| `route_id` | bounded string or empty sentinel | configured DSH route |
| `provider_id` | bounded string or empty sentinel | normalized provider |
| `model_id` | bounded string or empty sentinel | normalized model |
| `account_id_hash` | nullable HMAC-SHA-256 | irreversible account dimension |
| `api_key_id_hash` | nullable HMAC-SHA-256 | irreversible API-key dimension |
| `hash_key_version` | positive integer | installation hash-key generation |
| `outcome` | `success`, `error`, or `aborted` | terminal result |
| `error_kind` | bounded enum or `none` | sanitized failure class |
| `http_status` | nullable integer 100–599 | sanitized status only |
| `input_tokens` | nullable integer >= 0 | reported input tokens |
| `output_tokens` | nullable integer >= 0 | reported output tokens |
| `cache_read_tokens` | nullable integer >= 0 | reported cache-read tokens |
| `cache_write_tokens` | nullable integer >= 0 | reported cache-write tokens |
| `reasoning_tokens` | nullable integer >= 0 | reported reasoning tokens |
| `time_to_first_token_ms` | nullable integer >= 0 | first normalized output latency |
| `duration_ms` | nullable integer >= 0 | total request duration |
| `request_units` | integer >= 0 | request-priced units, normally `1` after dispatch |

The fingerprint covers only these normalized fields. It never covers or
retains prompt text, content blocks, image bytes/URLs, output text, tool
arguments/results, headers, credentials, auth files, refresh tokens, or a raw
Management API response.

Before the transaction, the worker attaches the immutable pricing snapshot
version and provenance selected for this event. The event/raw-row snapshot is
never resolved again from the network or a later pricing rule; historical
events therefore preserve the pricing version, source, and rates that were
available when they were ingested.

## State and worker protocol

The Host resolves one state root and passes this explicit path to analytics:

```text
<DSH_HOME>/dsh-gateway/v1/analytics/usage.sqlite3
```

The analytics package creates the directory only when activated. The worker
opens the database with `node:sqlite` `DatabaseSync` and applies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

The main thread sends typed observations or bounded read-query messages. All
read results are typed sanitized projections. The worker queue is bounded;
queue pressure or worker failure marks analytics degraded and increments a
sanitized in-memory loss counter without changing the model request result.

The worker checkpoints WAL during maintenance, never on the model request
path. A second process opening the database read/write is a state-ownership
violation and disables analytics for that contender.

## Schema version 1

`schema_migrations` is the migration ledger. The worker runs
`0001_sanitized_usage_analytics` in one transaction and sets
`PRAGMA user_version = 1` only after the ledger row commits. The ledger stores
`version`, `name`, `applied_at_ms`, and the embedded migration checksum.

### `collector_state`

One row per configured gateway target records:

- `target_key`, `collector_mode`, and lease owner/generation;
- last successful HTTP poll and last sanitized quota/health observation time;
- bounded `last_error_kind`, `retry_count`, and `next_retry_at_ms`;
- queue delivery: `at_most_once` (fixed for CPA HTTP usage queue);
- queue completeness state: `unknown`, `sole_consumer`,
  `competition_possible`, or `crash_loss_possible`;
- collector status: `healthy`, `degraded`, `unavailable`, or `disabled`;
- destructive-pop counters/status: bounded `popped_count`, `committed_count`,
  `dead_letter_count`, and `loss_possible_count`, with no raw queue item.

It stores no endpoint credential, raw URL query, management response, cursor
body, or account identifier.

### `ingest_receipts`

This one-year dedupe ledger has primary key
`(observation_kind, source_event_key_hash)`. Observation kinds are
`gateway_request`, `cpa_http_usage`, `quota_snapshot`, and
`account_health_snapshot`. It stores nullable `request_id_hash`,
`payload_fingerprint`, `first_received_at_ms`, and `last_received_at_ms`.
Keeping receipts beyond the 30-day raw-detail window prevents a replay from
incrementing retained rollups after its raw row has expired.

### `pricing_rules`

`pricing_rules` is a read-only copy of the immutable pricing snapshot bundled
with the Gateway release. The build/release generator is CPAMP-inspired and
uses this fixed source priority: `models.dev` → `LiteLLM` → `OpenRouter`.
The generator records the actual source URL, source version/revision,
retrieval time, source SHA-256, snapshot version, and generation release in
the artifact provenance. It is not a runtime pricing service and does not
make a network request after installation.

Rules match exact or `*` fallback dimensions for `route_id`, `provider_id`,
`model_id`, `account_id_hash`, and `api_key_id_hash`. The most specific match
wins; equal-specificity overlaps are rejected at build time. The latest
`effective_from_ms` breaks non-overlapping historical matches. There is no
manual pricing editor or runtime rule update in v0.1.

Each rule contains:

| Column | Rule |
| --- | --- |
| `pricing_snapshot_version` | immutable bundled snapshot identifier |
| `rule_id` | stable primary key |
| five dimension keys | exact value or `*` fallback |
| `source_name`, `source_url`, `source_version` | provenance for the selected source |
| `source_sha256`, `generated_at_ms`, `release_version` | immutable provenance and build identity |
| `currency` | uppercase ISO-4217 code |
| `request_unit_price_micros` | nullable non-negative price per request unit |
| `input_token_price_micros_per_million` | nullable non-negative rate |
| `output_token_price_micros_per_million` | nullable non-negative rate |
| `cache_read_token_price_micros_per_million` | nullable non-negative rate |
| `cache_write_token_price_micros_per_million` | nullable non-negative rate |
| `reasoning_token_price_micros_per_million` | nullable non-negative rate |
| `effective_from_ms`, `effective_to_ms` | inclusive start, nullable exclusive end |
| `enabled` | always true for a bundled rule; no runtime toggle |

Rates are nullable independently. A request can therefore have known input
pricing and unknown reasoning pricing without losing either token count.

### `raw_request_events`

This is the 30-day sanitized request-detail table. `request_id_hash` is its
primary key so gateway and usage observations enrich one row. It stores:

- source-presence flags and source fingerprints;
- `occurred_at_ms`, normalized UTC hour/day keys, route, provider, model,
  `account_id_hash`, `api_key_id_hash`, and `hash_key_version`;
- outcome, sanitized error kind, nullable HTTP status;
- all five nullable token-category counts;
- nullable `time_to_first_token_ms` and `duration_ms`;
- `request_units`;
- the matched `pricing_snapshot_version`, `price_rule_id`, pricing source
  name/URL/version/SHA-256, currency, and snapshots of all six rates;
- request-unit and per-token-category cost components;
- `known_cost_micros`, nullable `estimated_cost_micros`, and
  `pricing_state` (`priced`, `partial`, or `unpriced`);
- first/last ingestion timestamps.

No column can hold a prompt, image, model output, tool content, raw account,
raw auth index, API key/key fragment, auth file, refresh token, header, raw
Management response, or arbitrary upstream JSON.

### `usage_hourly` and `usage_daily`

Both rollup tables retain one year and have the same aggregate columns. Their
primary key is the UTC bucket plus route, provider, model,
`account_id_hash`, `api_key_id_hash`, `hash_key_version`, and currency. Empty
sentinels represent an unavailable dimension; null is not used in the key.

Each row stores:

- request, success, error, and aborted counts;
- `request_units_sum`;
- sums for input, output, cache-read, cache-write, and reasoning tokens;
- a known-value count for each token category so “not reported” remains
  distinguishable from zero;
- known counts and sums for time-to-first-token and total duration;
- fully priced, partially priced, and unpriced request counts;
- `known_cost_micros_sum` and the sum of fully known estimated costs;
- first and last request timestamps.

Unknown pricing never removes token totals. The Dashboard reports known cost
plus the number of partial/unpriced requests instead of coercing unknown cost
to zero.

### `latency_hourly_buckets` and `latency_daily_buckets`

These one-year tables use the same time and dimension key as the usage
rollups, plus `metric_kind` (`time_to_first_token` or `duration`) and a fixed
upper-bound bucket. Version 1 uses millisecond bounds:

```text
25, 50, 100, 250, 500, 1000, 2000, 5000, 10000,
30000, 60000, 120000, +infinity
```

The worker increments exactly one bucket per known latency value. Dashboard
P50 and P95 are deterministic cumulative-histogram estimates and are labelled
as bucketed percentiles for rollup ranges. Recent 30-day raw detail may compute
exact percentiles directly.

### `quota_snapshots`

This one-year append-only history contains:

- `snapshot_id`, `source_event_key_hash`, and `observed_at_ms`;
- route/provider/model plus `account_id_hash` and `api_key_id_hash` where the
  source supplies those dimensions;
- normalized quota kind and unit (`requests`, `tokens`, `currency`,
  `percent`, or `unknown`);
- nullable limit, used, remaining, and reset-at values;
- a sanitized source/status enum and `payload_fingerprint`.

The collector projects these fields from an allowlisted response in memory.
It never stores the raw Management response or exposes quota reset/cooldown
operations.

### `account_health_snapshots`

This one-year append-only history contains observation time, provider/model
where applicable, `account_id_hash`, optional `api_key_id_hash`, and normalized
health status (`healthy`, `degraded`, `unavailable`, or `unknown`) plus a
bounded reason enum. It contains no account label, auth index, credential
status body, cooldown mutation, token, or auth-file path.

Dashboard account health uses the latest snapshot per hashed account; history
is read-only and cannot trigger account selection, rotation, enable/disable,
quota reset, or cooldown clearing.

### `dead_letter_events`

Rejected CPA HTTP usage events are stored without the raw upstream event. The
table contains:

- `dead_letter_id`, `source_kind`, and `source_event_key_hash` when derivable;
- `request_id_hash`, sanitized dimensions/metrics already proven valid, and a
  bounded version-1 `sanitized_projection_json` containing only the normalized
  request-observation fields;
- `error_kind`, stable `error_code`, first/last failure timestamps;
- `retry_state` (`pending`, `terminal`, or `resolved`), `retry_count`, and
  nullable `next_retry_at_ms`;
- `payload_fingerprint` of the sanitized projection.

The projection has a strict size limit and schema; it cannot contain unknown
keys or raw source material. Forbidden sensitive input is discarded and makes
the dead letter terminal. Retry applies only to analytics normalization or
database ingestion. It never retries a model request or performs an account
rotation/cooldown action.

## Indexes

Migration 1 creates these stable access paths:

- `raw_request_events(occurred_at_ms DESC)`;
- raw detail composites for `(route_id, occurred_at_ms DESC)`,
  `(provider_id, model_id, occurred_at_ms DESC)`,
  `(account_id_hash, occurred_at_ms DESC)`, and
  `(api_key_id_hash, occurred_at_ms DESC)`;
- unique `ingest_receipts(observation_kind, source_event_key_hash)`;
- hourly/daily rollup bucket indexes followed by provider/model and by
  account/API-key hashes;
- hourly/daily latency indexes with bucket, dimensions, metric, and bound;
- `quota_snapshots(account_id_hash, observed_at_ms DESC)` and
  `(provider_id, model_id, observed_at_ms DESC)`;
- `account_health_snapshots(account_id_hash, observed_at_ms DESC)`;
- `dead_letter_events(retry_state, next_retry_at_ms)` and
  `(source_kind, source_event_key_hash)`.

## Ingestion, enrichment, dedupe, and rollup transaction

For an accepted gateway event or already-popped HTTP usage observation, the
worker:

1. validates schema, bounds, enums, timestamps, hashes, and fingerprint;
2. resolves the immutable bundled pricing snapshot and calculates
   snapshots/components with integer arithmetic;
3. begins one transaction and inserts the source receipt;
4. treats a matching receipt/fingerprint as an idempotent duplicate; a reused
   source key with a different fingerprint is dead-lettered as a conflict;
5. loads the prior request row, computes its old hourly/daily/latency
   contribution, and merges the new source without replacing known values
   with nulls;
6. uses gateway timing/route/outcome for a DSH-routed request and HTTP usage
   token/account/API-key metrics where supplied; incompatible non-null values
   produce a sanitized conflict dead letter rather than a silent choice;
7. subtracts the old contribution, adds the merged contribution to both
   hourly and daily usage/latency tables, and updates raw detail;
8. commits the accepted observation or sanitized dead-letter transaction.

For an HTTP usage item, the collector performs `GET /usage-queue` before step
1. CPA removes that item immediately and provides no ack, reservation, or
requeue operation. A crash, process kill, worker failure, or host shutdown
after the destructive pop and before step 8 leaves no source receipt or
dead-letter record for that item. This is the explicit crash-loss window;
queue delivery remains at-most-once and `collector_state` must expose
`crash_loss_possible`/`degraded` rather than claiming completeness. The
collector cannot replay the original popped item. Only a sanitized projection
that successfully reached `dead_letter_events` may be retried.

The subtract-then-add delta prevents a later HTTP usage record from counting a
gateway-observed request twice. It also allows token or pricing enrichment
without corrupting rollups. Aggregate invariants reject negative counts.

Quota and account-health observations use the same receipt/fingerprint rule
and append their snapshots in the same transaction. They are Host management
projections, not queue acknowledgements. A quota/health source failure is
recorded as `unsupported` or `unavailable`; it never creates a fabricated
zero/healthy snapshot.

A rejected upstream usage event is normalized as far as safely possible, then
upserted into `dead_letter_events`. Reprocessing uses only the sanitized
projection. A successful retry performs the normal dedupe/rollup transaction,
marks the dead letter resolved, and cannot double count an existing receipt.

## Pricing semantics

Money uses integer currency micro-units. Per-million-token components are
calculated with integer round-half-up arithmetic; floating-point currency is
never stored. Request-unit cost is `request_units * request_unit_price_micros`.

Each raw row snapshots every applicable category rate and component cost.
`estimated_cost_micros` is non-null only when every request unit and every
billable token category can be evaluated. A reported non-zero count without a
rate, or a missing count for a category with a configured non-zero rate, makes
the total unknown. Otherwise:

- token counts remain queryable and appear in rollups;
- known components contribute to `known_cost_micros`;
- `estimated_cost_micros` remains null;
- `pricing_state` is `partial` when at least one component is known and
  `unpriced` when none is known.

Rule changes never rewrite historical snapshots. Multiple currencies are
grouped separately and never converted. Dashboard copy labels cost as an
estimate and displays unknown/partial counts alongside known totals.

## Dashboard read model

Worker-owned, bounded read queries support:

- request totals and success rate;
- all five token-category totals, including known/missing coverage;
- known estimated cost plus partial/unpriced request counts;
- P50/P95 time-to-first-token and total-duration latency;
- filtering/grouping by time, provider, model, route,
  `account_id_hash`, and `api_key_id_hash`;
- paginated recent 30-day sanitized request details;
- latest normalized account health by hashed account; and
- one-year quota history and reset-time projections.

Hourly rollups serve short-range charts; daily rollups serve long-range
charts. Recent details expose only the typed `raw_request_events` projection.
No Dashboard query returns prompt/image/output data, auth material, raw
Management responses, or account actions.

## Retention and maintenance

Maintenance runs in the worker after startup and at a bounded interval:

1. complete any accepted event's hourly/daily rollups before raw deletion;
2. delete `raw_request_events` older than 30 UTC days in batches;
3. retain both hourly and daily usage/latency rollups for one year, then delete
   older buckets in batches;
4. retain quota and account-health snapshots for one year;
5. retain ingest receipts for the one-year rollup horizon;
6. keep pending dead letters while retryable, then retain terminal/resolved
   dead-letter metadata for 30 days;
7. retain active pricing rules and one year of expired pricing history;
8. checkpoint WAL when no worker query is active.

The policy retains the current UTC day plus the preceding 30 calendar days of
raw detail and the current UTC day plus the preceding 365 calendar days of
hourly/daily/snapshot history. Events outside the one-year horizon are
classified as `outside_retention` without changing rollups; this is not a CPA
queue acknowledgement.

Maintenance errors degrade analytics and are retried by the worker. Logs
contain table names, counts, error classes, and retry state only; they do not
log row values or upstream bodies.

## Migration rules

`0001_sanitized_usage_analytics` creates `schema_migrations`,
`collector_state`, `ingest_receipts`, `pricing_rules`,
`raw_request_events`, both usage rollup tables, both latency bucket tables,
`quota_snapshots`, `account_health_snapshots`, and `dead_letter_events`, plus
the indexes above. There is no prompt/output store, raw Management-response
store, account-action queue, RESP client state, or provider credential table.

Migrations are embedded and applied only by the worker in numeric order. Each
migration is transactional and checksummed. A mismatch, unsupported newer
schema, or second writer disables analytics while leaving gateway traffic
running. Downgrades are unsupported. No migration reads a CPA/CPAMP database,
auth file, refresh token, model payload, or raw upstream response.

## CPAMP attribution boundary

CPAMP `v1.12.0-rc.2` is a UX and Management API reference only. Its MIT
license does not make its Manager server, SQLite schema, SQL, collector code,
Dashboard components, installer, or localStorage behavior part of this
project. Schema version 1 above is the independently specified DSH data model;
no CPAMP code, SQL, schema text, or UI asset is copied into the initial
release.

If an accepted later change copies CPAMP implementation material, the exact
CPAMP source revision and original MIT copyright/license notice must accompany
the artifact containing that material. That attribution applies only to the
copied CPAMP material; it does not cover CLIProxyAPI, provider account policy,
DSH code, or unrelated dependencies.

## Phase 0 verification checklist

- run gateway traffic with analytics absent and verify identical delivery;
- prove one worker owns `usage.sqlite3` with WAL and one collector lease;
- collect CPA usage through HTTP only and reject any RESP configuration;
- require explicit opt-in and competition warning for an external CPA queue;
- merge gateway and HTTP observations for one request without double count;
- replay identical events and conflicting fingerprints through dedupe/DLQ;
- verify all token categories remain visible under unknown pricing;
- verify request and token-category price snapshots and partial/unknown cost;
- verify hourly and daily rollups, P50/P95 buckets, dimensions, recent detail,
  account health, and quota history;
- verify raw detail at 30 days and rollup/quota/health history at one year;
- scan SQLite, logs, worker messages, and Dashboard results for prompts,
  images, output, raw account/key/auth index, auth files, refresh tokens, and
  raw Management responses;
- verify no analytics action rotates accounts, resets quota, clears cooldown,
  or retries a model request.
