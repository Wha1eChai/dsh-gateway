export type AnalyticsMode = 'disabled' | 'managed' | 'external'
export type AnalyticsAvailability = 'disabled' | 'starting' | 'ready' | 'degraded' | 'unavailable'
export type RequestOutcome = 'success' | 'error' | 'aborted'
export type RequestErrorKind =
  | 'none'
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'upstream'
  | 'timeout'
  | 'cancelled'
  | 'invalid_request'
  | 'unknown'

export interface AnalyticsStatus {
  readonly availability: AnalyticsAvailability
  readonly mode: AnalyticsMode
  readonly databasePath?: string
  readonly queueCompleteness: 'unknown' | 'sole_consumer' | 'competition_possible' | 'crash_loss_possible'
  readonly lossPossibleCount: number
  readonly lastErrorKind?: string
}

/** Sanitized, bounded input accepted by the SQLite worker. */
export interface RequestObservation {
  readonly schemaVersion: 1
  readonly sourceKind: 'gateway' | 'cpa_http_usage'
  readonly sourceEventKeyHash: string
  readonly requestIdHash: string
  readonly payloadFingerprint: string
  readonly occurredAtMs: number
  readonly routeId: string
  readonly providerId: string
  readonly modelId: string
  readonly accountIdHash: string | null
  readonly apiKeyIdHash: string | null
  readonly hashKeyVersion: number
  readonly outcome: RequestOutcome
  readonly errorKind: RequestErrorKind
  readonly httpStatus: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly reasoningTokens: number | null
  readonly timeToFirstTokenMs: number | null
  readonly durationMs: number | null
  readonly requestUnits: number
}

export interface PricingRule {
  readonly snapshotVersion: string
  readonly ruleId: string
  readonly routeId: string
  readonly providerId: string
  readonly modelId: string
  readonly accountIdHash: string
  readonly apiKeyIdHash: string
  readonly currency: string
  readonly requestUnitPriceMicros: number | null
  readonly inputTokenPriceMicrosPerMillion: number | null
  readonly outputTokenPriceMicrosPerMillion: number | null
  readonly cacheReadTokenPriceMicrosPerMillion: number | null
  readonly cacheWriteTokenPriceMicrosPerMillion: number | null
  readonly reasoningTokenPriceMicrosPerMillion: number | null
  readonly effectiveFromMs: number
  readonly effectiveToMs: number | null
  readonly sourceName: string
  readonly sourceUrl: string
  readonly sourceVersion: string
  readonly sourceSha256: string
  readonly generatedAtMs: number
  readonly releaseVersion: string
}

export interface AccountHealthObservation {
  readonly sourceEventKeyHash: string
  readonly providerId: string
  readonly accountIdHash: string | null
  readonly healthStatus: 'healthy' | 'degraded' | 'unavailable' | 'unsupported'
  readonly reasonCode: string
  readonly observedAtMs: number
  readonly hashKeyVersion: number
}

export interface QuotaObservation {
  readonly sourceEventKeyHash: string
  readonly providerId: string
  readonly accountIdHash: string | null
  readonly quotaKind: string
  readonly unit: string
  readonly limit: number | null
  readonly used: number | null
  readonly remaining: number | null
  readonly resetAtMs: number | null
  readonly sourceStatus: 'available' | 'unavailable' | 'unsupported'
  readonly projectionVersion: 1
  readonly observedAtMs: number
  readonly fingerprint: string
  readonly hashKeyVersion: number
}

export interface DeadLetterObservation {
  readonly sourceKind: 'cpa_http_usage' | 'quota' | 'account_health'
  readonly sourceEventKeyHash: string
  readonly payloadFingerprint: string
  readonly occurredAtMs: number
  readonly reasonCode: string
  readonly retryable: boolean
  readonly retryCount: number
  readonly nextRetryAtMs: number | null
}

export interface IngestResult {
  readonly disposition: 'inserted' | 'enriched' | 'duplicate' | 'dead_letter' | 'outside_retention' | 'ignored'
  readonly requestIdHash?: string
}

export interface AnalyticsTimeRange {
  readonly fromMs: number
  readonly toMs: number
}

export interface AnalyticsFilters extends AnalyticsTimeRange {
  readonly providerId?: string
  readonly modelId?: string
  readonly routeId?: string
  readonly accountIdHash?: string
  readonly apiKeyIdHash?: string
}

export interface AnalyticsSummary {
  readonly requests: number
  readonly successes: number
  readonly errors: number
  readonly aborted: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly knownCostMicros: number
  readonly pricedRequests: number
  readonly partialRequests: number
  readonly unpricedRequests: number
  readonly currency: string | null
  readonly p50DurationMs: number | null
  readonly p95DurationMs: number | null
  readonly p50TimeToFirstTokenMs: number | null
  readonly p95TimeToFirstTokenMs: number | null
}

export interface AnalyticsTrendPoint extends AnalyticsSummary {
  readonly bucketStartMs: number
}

export interface RecentRequest {
  readonly requestIdHash: string
  readonly occurredAtMs: number
  readonly routeId: string
  readonly providerId: string
  readonly modelId: string
  readonly accountIdHash: string | null
  readonly apiKeyIdHash: string | null
  readonly outcome: RequestOutcome
  readonly errorKind: RequestErrorKind
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly durationMs: number | null
  readonly estimatedCostMicros: number | null
  readonly currency: string | null
  readonly pricingState: 'priced' | 'partial' | 'unpriced'
}

export interface RecentRequestPage {
  readonly items: readonly RecentRequest[]
  readonly nextCursor?: string
}

export interface AnalyticsReadStore {
  status(): Promise<AnalyticsStatus>
  summary(filters: AnalyticsFilters): Promise<AnalyticsSummary>
  trend(filters: AnalyticsFilters & { readonly bucket: 'hour' | 'day' }): Promise<readonly AnalyticsTrendPoint[]>
  recent(filters: AnalyticsFilters & { readonly limit: number; readonly cursor?: string }): Promise<RecentRequestPage>
  quota(filters: AnalyticsTimeRange): Promise<readonly QuotaObservation[]>
  accountHealth(filters: AnalyticsTimeRange): Promise<readonly AccountHealthObservation[]>
}

export interface AnalyticsWriteStore {
  ingestRequest(observation: RequestObservation): Promise<IngestResult>
  ingestQuota(observation: QuotaObservation): Promise<IngestResult>
  ingestAccountHealth(observation: AccountHealthObservation): Promise<IngestResult>
  ingestDeadLetter(observation: DeadLetterObservation): Promise<IngestResult>
  maintain(nowMs?: number): Promise<void>
}

export interface AnalyticsStore extends AnalyticsReadStore, AnalyticsWriteStore {
  close(): Promise<void>
}

export interface InstallationHasherLike {
  hash(namespace: 'request' | 'account' | 'api-key' | 'source-event', canonicalIdentifier: string): string
  fingerprint(value: unknown): string
  readonly keyVersion: number
}
