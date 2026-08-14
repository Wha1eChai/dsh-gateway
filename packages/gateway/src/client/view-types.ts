import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GatewayAnalyticsAccountView,
  GatewayAnalyticsFilters,
  GatewayAnalyticsQuotaView,
  GatewayAnalyticsRequestPageView,
  GatewayAnalyticsRequestsRequest,
  GatewayAnalyticsStatusView,
  GatewayAnalyticsSummaryView,
  GatewayAnalyticsTimeRange,
  GatewayAnalyticsTrendPoint,
  GatewayAnalyticsTrendRequest,
  GatewayApplyModelsRequest,
  GatewayApplyModelsResult,
  GatewayImageUploadRequest,
  GatewayModelsView,
  GatewayOAuthOperationRequest,
  GatewayOAuthStatus,
  GatewayProbeRequest,
  GatewayProbeImageRef,
  GatewayProbeResult,
  GatewayRuntimeView,
  GatewayStatusView,
} from '../host/contracts.js'

/** Client-side shape of the generated Gateway Remote contribution. */
export interface GatewayRemote {
  status(): Promise<RemoteResult<GatewayStatusView>>
  analyticsStatus(): Promise<RemoteResult<GatewayAnalyticsStatusView>>
  analyticsSummary(request: GatewayAnalyticsFilters): Promise<RemoteResult<GatewayAnalyticsSummaryView>>
  analyticsTrend(request: GatewayAnalyticsTrendRequest): Promise<RemoteResult<readonly GatewayAnalyticsTrendPoint[]>>
  analyticsRequests(request: GatewayAnalyticsRequestsRequest): Promise<RemoteResult<GatewayAnalyticsRequestPageView>>
  analyticsQuota(request: GatewayAnalyticsTimeRange): Promise<RemoteResult<readonly GatewayAnalyticsQuotaView[]>>
  analyticsAccounts(request: GatewayAnalyticsTimeRange): Promise<RemoteResult<readonly GatewayAnalyticsAccountView[]>>
  runtimeInstall(): Promise<RemoteResult<GatewayRuntimeView>>
  runtimeStart(): Promise<RemoteResult<GatewayRuntimeView>>
  runtimeStop(): Promise<RemoteResult<GatewayRuntimeView>>
  runtimeRestart(): Promise<RemoteResult<GatewayRuntimeView>>
  models(signal?: AbortSignal): Promise<RemoteResult<GatewayModelsView>>
  applyModels(request: GatewayApplyModelsRequest): Promise<RemoteResult<GatewayApplyModelsResult>>
  uploadImage(request: GatewayImageUploadRequest): Promise<RemoteResult<GatewayProbeImageRef>>
  oauthDeviceStart(): Promise<RemoteResult<GatewayOAuthStatus>>
  oauthDeviceStatus(request: GatewayOAuthOperationRequest): Promise<RemoteResult<GatewayOAuthStatus>>
  oauthDeviceCancel(request: GatewayOAuthOperationRequest): Promise<RemoteResult<GatewayOAuthStatus>>
  probe(request: GatewayProbeRequest, signal?: AbortSignal): Promise<RemoteResult<GatewayProbeResult>>
}

export type GatewayTranslate = TranslateNS<'gateway'>
export type GatewayLocaleProps = PropsLocale<'gateway'>
export type GatewayRoute = '/' | '/accounts' | '/models' | '/requests' | '/playground' | '/settings'

export interface GatewayViewProps {
  readonly remote: GatewayRemote
  readonly t: GatewayTranslate
}

export interface GatewayInteractiveViewProps extends GatewayViewProps {
  readonly navigate: (appPath: GatewayRoute) => void
}

export function remoteValue<T>(result: RemoteResult<T>): T | undefined {
  return result.ok ? result.value : undefined
}

export function remoteErrorCode(result: RemoteResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code
}

export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'REMOTE_UNAVAILABLE'
}
