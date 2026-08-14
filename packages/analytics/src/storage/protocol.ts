import type {
  AccountHealthObservation,
  AnalyticsFilters,
  AnalyticsStatus,
  AnalyticsSummary,
  AnalyticsTrendPoint,
  DeadLetterObservation,
  IngestResult,
  QuotaObservation,
  RecentRequestPage,
  RequestObservation,
} from '../contracts.js'

export type WorkerOperation =
  | { readonly op: 'status' }
  | { readonly op: 'summary'; readonly filters: AnalyticsFilters }
  | { readonly op: 'trend'; readonly filters: AnalyticsFilters & { readonly bucket: 'hour' | 'day' } }
  | { readonly op: 'recent'; readonly filters: AnalyticsFilters & { readonly limit: number; readonly cursor?: string } }
  | { readonly op: 'quota'; readonly filters: { readonly fromMs: number; readonly toMs: number } }
  | { readonly op: 'accountHealth'; readonly filters: { readonly fromMs: number; readonly toMs: number } }
  | { readonly op: 'ingestRequest'; readonly observation: RequestObservation }
  | { readonly op: 'ingestQuota'; readonly observation: QuotaObservation }
  | { readonly op: 'ingestAccountHealth'; readonly observation: AccountHealthObservation }
  | { readonly op: 'ingestDeadLetter'; readonly observation: DeadLetterObservation }
  | { readonly op: 'maintain'; readonly nowMs?: number }
  | { readonly op: 'close' }

export type WorkerResult =
  | AnalyticsStatus
  | AnalyticsSummary
  | readonly AnalyticsTrendPoint[]
  | RecentRequestPage
  | readonly QuotaObservation[]
  | readonly AccountHealthObservation[]
  | IngestResult
  | undefined

export interface WorkerRequestMessage {
  readonly type: 'request'
  readonly id: number
  readonly operation: WorkerOperation
}

export interface WorkerReadyMessage {
  readonly type: 'ready'
}

export interface WorkerResponseMessage {
  readonly type: 'response'
  readonly id: number
  readonly ok: true
  readonly result: WorkerResult
}

export interface WorkerErrorMessage {
  readonly type: 'response'
  readonly id: number
  readonly ok: false
  readonly error: { readonly name: string; readonly message: string }
}

export interface WorkerFatalMessage {
  readonly type: 'fatal'
  readonly error: { readonly name: string; readonly message: string }
}

export type WorkerMessage = WorkerReadyMessage | WorkerResponseMessage | WorkerErrorMessage | WorkerFatalMessage

export interface WorkerData {
  readonly databasePath: string
  readonly targetKey: string
  readonly mode: 'disabled' | 'managed' | 'external'
  readonly queueCompleteness: 'unknown' | 'sole_consumer' | 'competition_possible' | 'crash_loss_possible'
  readonly pricingRules: readonly import('../contracts.js').PricingRule[]
}
