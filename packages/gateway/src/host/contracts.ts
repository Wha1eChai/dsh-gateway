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
