export type GatewayRuntimeState =
  | 'unavailable'
  | 'disabled'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'failed'

export interface GatewayRuntimeView {
  readonly available: boolean
  readonly state: GatewayRuntimeState
  readonly mode?: 'managed' | 'external'
  readonly endpoint?: string
  readonly version?: string
  readonly errorCode?: string
}

export interface GatewayCredentialView {
  readonly ref: string
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: string
}

export interface GatewayStatusView {
  readonly runtime: GatewayRuntimeView
  readonly proxyCredential: GatewayCredentialView
  readonly managementCredential: GatewayCredentialView
  readonly localCallbackAvailable: false
}

export type GatewayAnalyticsMode = 'disabled' | 'managed' | 'external'
export type GatewayAnalyticsAvailability = 'disabled' | 'starting' | 'ready' | 'degraded' | 'unavailable'
export type GatewayAnalyticsQueueCompleteness = 'unknown' | 'sole_consumer' | 'competition_possible' | 'crash_loss_possible'

/** Browser-safe analytics status; storage paths and worker diagnostics are Host-only. */
export interface GatewayAnalyticsStatusView {
  readonly availability: GatewayAnalyticsAvailability
  readonly mode: GatewayAnalyticsMode
  readonly queueCompleteness: GatewayAnalyticsQueueCompleteness
  readonly lossPossibleCount: number
}

export interface GatewayAnalyticsTimeRange {
  readonly fromMs: number
  readonly toMs: number
}

export interface GatewayAnalyticsFilters extends GatewayAnalyticsTimeRange {
  readonly providerId?: string
  readonly modelId?: string
  readonly routeId?: string
  readonly accountIdHash?: string
  readonly apiKeyIdHash?: string
}

export interface GatewayAnalyticsTrendRequest extends GatewayAnalyticsFilters {
  readonly bucket: 'hour' | 'day'
}

export interface GatewayAnalyticsRequestsRequest extends GatewayAnalyticsFilters {
  readonly limit: number
  readonly cursor?: string
}

export interface GatewayAnalyticsSummaryView {
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

export interface GatewayAnalyticsTrendPoint extends GatewayAnalyticsSummaryView {
  readonly bucketStartMs: number
}

/** Bounded request metadata; content, payloads, and source receipts are excluded. */
export interface GatewayAnalyticsRequestView {
  readonly requestIdHash: string
  readonly occurredAtMs: number
  readonly routeId: string
  readonly providerId: string
  readonly modelId: string
  readonly accountIdHash: string | null
  readonly apiKeyIdHash: string | null
  readonly outcome: 'success' | 'error' | 'aborted'
  readonly errorKind:
    | 'none'
    | 'authentication'
    | 'authorization'
    | 'rate_limit'
    | 'upstream'
    | 'timeout'
    | 'cancelled'
    | 'invalid_request'
    | 'unknown'
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly durationMs: number | null
  readonly estimatedCostMicros: number | null
  readonly currency: string | null
  readonly pricingState: 'priced' | 'partial' | 'unpriced'
}

export interface GatewayAnalyticsRequestPageView {
  readonly items: readonly GatewayAnalyticsRequestView[]
  readonly nextCursor?: string
}

export interface GatewayAnalyticsQuotaView {
  readonly providerId: string
  readonly accountIdHash: string | null
  readonly quotaKind: string
  readonly unit: 'requests' | 'tokens' | 'currency' | 'percent' | 'unknown'
  readonly limit: number | null
  readonly used: number | null
  readonly remaining: number | null
  readonly resetAtMs: number | null
  readonly sourceStatus: 'available' | 'unavailable' | 'unsupported'
  readonly observedAtMs: number
}

export interface GatewayAnalyticsAccountView {
  readonly providerId: string
  readonly accountIdHash: string | null
  readonly healthStatus: 'healthy' | 'degraded' | 'unavailable' | 'unsupported'
  readonly reasonCode: string
  readonly observedAtMs: number
}

export interface GatewayModelView {
  readonly id: string
  readonly name: string
  readonly imageInput: boolean
}

export interface GatewayModelsView {
  readonly models: readonly GatewayModelView[]
  readonly settingsRevision: number
}

export interface GatewayApplyModelsRequest {
  readonly models: readonly GatewayModelView[]
  readonly expectedRevision: number
}

export interface GatewayApplyModelsResult {
  readonly changed: boolean
  readonly settingsRevision: number
}

export interface GatewayOAuthOperationRequest {
  readonly operationId: string
}

export type GatewayOAuthState =
  | 'starting'
  | 'pending'
  | 'success'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'timed_out'
  | 'failed'

export interface GatewayOAuthError {
  readonly category:
    | 'configuration'
    | 'duplicate'
    | 'not_found'
    | 'disposed'
    | 'cancelled'
    | 'spawn'
    | 'nonzero_exit'
    | 'timeout'
    | 'parse'
  readonly code: string
  readonly exitCode?: number
}

export interface GatewayOAuthStatus {
  readonly operationId: string
  readonly provider: 'openai-codex'
  readonly state: GatewayOAuthState
  readonly verificationUri?: string
  readonly userCode?: string
  readonly expiresAtMs?: number
  readonly pollIntervalMs?: number
  readonly error?: GatewayOAuthError
}

export interface GatewayProbeImageRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Ephemeral browser upload request; bytes are persisted only by the Host attachment service. */
export interface GatewayImageUploadRequest {
  readonly dataBase64: string
  readonly mediaType: GatewayProbeImageRef['mediaType']
  readonly name?: string
}

export interface GatewayProbeTool {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, GatewayJsonValue>>
}

export type GatewayJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly GatewayJsonValue[]
  | { readonly [key: string]: GatewayJsonValue }

export interface GatewayProbeRequest {
  readonly model: string
  readonly prompt: string
  readonly image?: GatewayProbeImageRef
  readonly tools?: readonly GatewayProbeTool[]
  readonly maxTokens?: number
}

export type GatewayProbeBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

export interface GatewayProbeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export type GatewayProbeResult =
  | {
    readonly ok: true
    readonly blocks: readonly GatewayProbeBlock[]
    readonly finish: 'stop' | 'tool-calls' | 'max-tokens'
    readonly usage?: GatewayProbeUsage
  }
  | {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly status?: number
    }
  }
