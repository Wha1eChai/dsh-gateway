import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DeviceLoginLaunchTarget, GatewayRuntime, RuntimeSnapshot } from '@wha1echai/dsh-gateway-runtime'

import type { Config } from '../config.js'
import { createCpaClientForOperation } from './cpa-client/index.js'
import type { CpaAccountStatus, CpaCredentialRefs, CpaQuota, CpaUsageRecord } from './cpa-client/types.js'
import type {
  GatewayApplyModelsRequest,
  GatewayApplyModelsResult,
  GatewayAnalyticsAccountView,
  GatewayAnalyticsAvailability,
  GatewayAnalyticsFilters,
  GatewayAnalyticsMode,
  GatewayAnalyticsQuotaView,
  GatewayAnalyticsRequestPageView,
  GatewayAnalyticsRequestsRequest,
  GatewayAnalyticsRequestView,
  GatewayAnalyticsStatusView,
  GatewayAnalyticsSummaryView,
  GatewayAnalyticsTimeRange,
  GatewayAnalyticsTrendPoint,
  GatewayAnalyticsTrendRequest,
  GatewayCredentialView,
  GatewayImageUploadRequest,
  GatewayModelsView,
  GatewayOAuthOperationRequest,
  GatewayOAuthStatus,
  GatewayProbeBlock,
  GatewayProbeImageRef,
  GatewayProbeRequest,
  GatewayProbeResult,
  GatewayProbeTool,
  GatewayRuntimeView,
  GatewayStatusView,
} from './contracts.js'
import { CodexDeviceLoginManager } from './oauth/index.js'
import type { CodexDeviceLoginStatus } from './oauth/index.js'
import {
  CPA_PROVIDER_API,
  LLM_PI_AI_SETTINGS_NAMESPACE,
  normalizeCpaProviderBaseURL,
  normalizeDiscoveredModels,
  planCpaProviderSettings,
} from './provider/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshGateway: GatewayHostService
  }
}

const MAX_MODEL_ID_CHARS = 256
const MAX_PROMPT_CHARS = 65_536
const MAX_IMAGE_NAME_CHARS = 255
const MAX_TOOL_COUNT = 32
const MAX_TOOL_DESCRIPTION_CHARS = 4_096
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const TERMINAL_OAUTH_STATES = new Set(['success', 'denied', 'expired', 'cancelled', 'timed_out', 'failed'])
const MAX_ANALYTICS_DIMENSION_CHARS = 256
const MAX_ANALYTICS_CURSOR_CHARS = 512
const MAX_ANALYTICS_ROWS = 1_000
const MAX_ANALYTICS_RANGE_MS = 366 * 24 * 60 * 60 * 1_000
const ANALYTICS_HASH = /^[0-9a-f]{64}$/
const ANALYTICS_CURSOR = /^[A-Za-z0-9_-]+$/
const ANALYTICS_CURRENCIES = /^[A-Z]{3}$/
const ANALYTICS_UNAVAILABLE_STATUS: GatewayAnalyticsStatusView = Object.freeze({
  availability: 'unavailable',
  mode: 'disabled',
  queueCompleteness: 'unknown',
  lossPossibleCount: 0,
})
const EMPTY_ANALYTICS_SUMMARY: GatewayAnalyticsSummaryView = Object.freeze({
  requests: 0,
  successes: 0,
  errors: 0,
  aborted: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  knownCostMicros: 0,
  pricedRequests: 0,
  partialRequests: 0,
  unpricedRequests: 0,
  currency: null,
  p50DurationMs: null,
  p95DurationMs: null,
  p50TimeToFirstTokenMs: null,
  p95TimeToFirstTokenMs: null,
})

interface GatewayAnalyticsReadService {
  status(): Promise<unknown>
  summary(filters: GatewayAnalyticsFilters): Promise<unknown>
  trend(filters: GatewayAnalyticsTrendRequest): Promise<unknown>
  recent(filters: GatewayAnalyticsRequestsRequest): Promise<unknown>
  quota(filters: GatewayAnalyticsTimeRange): Promise<unknown>
  accountHealth(filters: GatewayAnalyticsTimeRange): Promise<unknown>
}

/** Host-only, content-free source consumed by the optional analytics plugin. */
export interface GatewayAnalyticsSource {
  readonly mode: 'managed' | 'external'
  readonly targetIdentity: string
  dequeueUsage(signal?: AbortSignal): Promise<readonly CpaUsageRecord[]>
  accountHealth(signal?: AbortSignal): Promise<readonly CpaAccountStatus[]>
  quota(signal?: AbortSignal): Promise<readonly CpaQuota[]>
}

export class GatewayHostError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GatewayHostError'
    this.code = code
  }
}

/** Closed Host BFF for runtime, provider, OAuth, and one-shot model probes. */
export class GatewayHostService extends TypertRemoteService {
  private readonly config: Config
  private oauth: CodexDeviceLoginManager | undefined
  private oauthTarget: string | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dshGateway', { namespace: 'gateway' })
    this.config = config
    ctx.effect(() => async () => {
      await this.oauth?.dispose()
      this.oauth = undefined
      this.oauthTarget = undefined
    }, 'dsh-gateway.oauth')
  }

  @Remote('status')
  async status(): Promise<GatewayStatusView> {
    const [proxyCredential, managementCredential] = await Promise.all([
      this.credentialView(this.config.proxyCredentialRef),
      this.credentialView(this.config.managementCredentialRef),
    ])
    return {
      runtime: this.runtimeView(this.runtime()?.snapshot()),
      proxyCredential,
      managementCredential,
      localCallbackAvailable: false,
    }
  }

  @Remote('analyticsStatus')
  async analyticsStatus(): Promise<GatewayAnalyticsStatusView> {
    const analytics = this.analyticsService()
    if (analytics === undefined) return ANALYTICS_UNAVAILABLE_STATUS
    try {
      return projectAnalyticsStatus(await analytics.status())
    } catch {
      return ANALYTICS_UNAVAILABLE_STATUS
    }
  }

  @Remote('analyticsSummary')
  async analyticsSummary(request: GatewayAnalyticsFilters): Promise<GatewayAnalyticsSummaryView> {
    const filters = parseAnalyticsFilters(request)
    const analytics = this.analyticsService()
    if (analytics === undefined) return EMPTY_ANALYTICS_SUMMARY
    try {
      return projectAnalyticsSummary(await analytics.summary(filters))
    } catch {
      return EMPTY_ANALYTICS_SUMMARY
    }
  }

  @Remote('analyticsTrend')
  async analyticsTrend(request: GatewayAnalyticsTrendRequest): Promise<readonly GatewayAnalyticsTrendPoint[]> {
    const filters = parseAnalyticsTrendRequest(request)
    const analytics = this.analyticsService()
    if (analytics === undefined) return []
    try {
      return projectAnalyticsTrend(await analytics.trend(filters))
    } catch {
      return []
    }
  }

  @Remote('analyticsRequests')
  async analyticsRequests(request: GatewayAnalyticsRequestsRequest): Promise<GatewayAnalyticsRequestPageView> {
    const filters = parseAnalyticsRequestsRequest(request)
    const analytics = this.analyticsService()
    if (analytics === undefined) return { items: [] }
    try {
      return projectAnalyticsRequests(await analytics.recent(filters))
    } catch {
      return { items: [] }
    }
  }

  @Remote('analyticsQuota')
  async analyticsQuota(request: GatewayAnalyticsTimeRange): Promise<readonly GatewayAnalyticsQuotaView[]> {
    const filters = parseAnalyticsTimeRange(request)
    const analytics = this.analyticsService()
    if (analytics === undefined) return []
    try {
      return projectAnalyticsQuota(await analytics.quota(filters))
    } catch {
      return []
    }
  }

  @Remote('analyticsAccounts')
  async analyticsAccounts(request: GatewayAnalyticsTimeRange): Promise<readonly GatewayAnalyticsAccountView[]> {
    const filters = parseAnalyticsTimeRange(request)
    const analytics = this.analyticsService()
    if (analytics === undefined) return []
    try {
      return projectAnalyticsAccounts(await analytics.accountHealth(filters))
    } catch {
      return []
    }
  }

  @Remote('runtimeInstall')
  async runtimeInstall(): Promise<GatewayRuntimeView> {
    const runtime = this.requireRuntime()
    await runtime.install()
    return this.runtimeView(runtime.snapshot())
  }

  @Remote('runtimeStart')
  async runtimeStart(): Promise<GatewayRuntimeView> {
    return this.runtimeView(await this.requireRuntime().start())
  }

  @Remote('runtimeStop')
  async runtimeStop(): Promise<GatewayRuntimeView> {
    return this.runtimeView(await this.requireRuntime().stop())
  }

  @Remote('runtimeRestart')
  async runtimeRestart(): Promise<GatewayRuntimeView> {
    return this.runtimeView(await this.requireRuntime().restart())
  }

  @Remote('models')
  async models(signal: AbortSignal): Promise<GatewayModelsView> {
    const descriptor = this.requireLlmSettingsDescriptor()
    const client = await createCpaClientForOperation(
      'models',
      this.ctx.credentials,
      this.credentialRefs(),
      this.clientOptions(),
    )
    const discovered = normalizeDiscoveredModels(await client.models({ signal }))
    const imageModels = configuredImageModels(descriptor, this.endpoint(), this.config.proxyCredentialRef)
    return {
      models: discovered.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        imageInput: imageModels.has(model.id),
      })),
      settingsRevision: descriptor.revision,
    }
  }

  @Remote('applyModels')
  async applyModels(request: GatewayApplyModelsRequest): Promise<GatewayApplyModelsResult> {
    const descriptor = this.requireLlmSettingsDescriptor()
    if (request.expectedRevision !== descriptor.revision) {
      throw new GatewayHostError('settings_conflict', 'LLM settings changed; refresh models and retry')
    }
    const plan = planCpaProviderSettings({
      descriptor,
      expectedRevision: request.expectedRevision,
      endpoint: this.endpoint(),
      proxyCredentialRef: this.config.proxyCredentialRef,
      models: request.models,
    })
    if (plan.changed) {
      await this.ctx.settings.mutate(plan.namespace, plan.ops, plan.expectedRevision)
    }
    return {
      changed: plan.changed,
      settingsRevision: this.requireLlmSettingsDescriptor().revision,
    }
  }

  @Remote('oauthDeviceStart')
  async oauthDeviceStart(): Promise<GatewayOAuthStatus> {
    const target = this.requireRuntime().deviceLoginTarget()
    await this.prepareOauthManager(target)
    return oauthStatus(await this.oauth!.start())
  }

  @Remote('oauthDeviceStatus')
  oauthDeviceStatus(request: GatewayOAuthOperationRequest): GatewayOAuthStatus {
    const status = this.oauth?.status(request.operationId)
    if (status === undefined) throw new GatewayHostError('oauth_not_found', 'OAuth operation is unavailable')
    return oauthStatus(status)
  }

  @Remote('oauthDeviceCancel')
  async oauthDeviceCancel(request: GatewayOAuthOperationRequest): Promise<GatewayOAuthStatus> {
    if (this.oauth === undefined) throw new GatewayHostError('oauth_not_found', 'OAuth operation is unavailable')
    return oauthStatus(await this.oauth.cancel(request.operationId))
  }

  @Remote('uploadImage')
  async uploadImage(request: GatewayImageUploadRequest): Promise<GatewayProbeImageRef> {
    const { dataBase64, mediaType, name } = parseImageUploadRequest(request, this.ctx.attachments.imageLimits.maxImageBytes)
    const data = Buffer.from(dataBase64, 'base64')
    const ref = await this.ctx.attachments.saveImage({
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      mediaType,
      ...(name === undefined ? {} : { name }),
    })
    return probeImageRef(ref)
  }

  @Remote('probe')
  async probe(request: GatewayProbeRequest, signal: AbortSignal): Promise<GatewayProbeResult> {
    const model = boundedText(request.model, 'model', MAX_MODEL_ID_CHARS)
    const prompt = boundedText(request.prompt, 'prompt', MAX_PROMPT_CHARS)
    const content: ContentBlock[] = [{ type: 'text', text: prompt }]
    if (request.image !== undefined) content.push({ type: 'image', attachment: imageRef(request.image) })
    const tools = request.tools === undefined ? undefined : probeTools(request.tools)
    const maxTokens = request.maxTokens
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131_072)) {
      throw new GatewayHostError('invalid_probe_request', 'Probe maxTokens is invalid')
    }

    const assembler = new BlockAssembler()
    try {
      for await (const chunk of this.ctx.llm.stream({
        provider: 'cpa',
        model,
        messages: [createUserMessage({ content, source: { kind: 'user' } })],
        signal,
        ...(tools === undefined ? {} : { tools }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      })) assembler.push(chunk)
    } catch {
      return { ok: false, error: { code: 'PROBE_FAILED' } }
    }

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      return { ok: false, error: safeLlmFailure(finish) }
    }
    if (!['stop', 'tool-calls', 'max-tokens'].includes(finish.kind)) {
      return { ok: false, error: { code: 'UNSUPPORTED_FINISH' } }
    }
    const blocks = assembler.blocks().flatMap<GatewayProbeBlock>((block) => {
      if (block.type === 'text' || block.type === 'reasoning') return [{ type: block.type, text: block.text }]
      if (block.type === 'tool-call') {
        return [{ type: 'tool-call', id: String(block.id), name: block.name, arguments: block.arguments }]
      }
      return []
    })
    return {
      ok: true,
      blocks,
      finish: finish.kind as 'stop' | 'tool-calls' | 'max-tokens',
      ...(assembler.usage === undefined ? {} : { usage: { ...assembler.usage } }),
    }
  }

  /** Build a narrow Host-only analytics source; credentials remain per-operation. */
  analyticsSource(): GatewayAnalyticsSource {
    const snapshot = this.runtime()?.snapshot()
    return {
      mode: snapshot?.mode ?? 'external',
      targetIdentity: this.endpoint(),
      dequeueUsage: async (signal) => {
        const client = await createCpaClientForOperation(
          'dequeueUsage',
          this.ctx.credentials,
          this.credentialRefs(),
          this.clientOptions(),
        )
        return client.dequeueUsage({ ...(signal === undefined ? {} : { signal }) })
      },
      accountHealth: async (signal) => {
        const client = await createCpaClientForOperation(
          'authStatus',
          this.ctx.credentials,
          this.credentialRefs(),
          this.clientOptions(),
        )
        return client.accountStatus({ ...(signal === undefined ? {} : { signal }) })
      },
      quota: async (signal) => {
        const client = await createCpaClientForOperation(
          'quota',
          this.ctx.credentials,
          this.credentialRefs(),
          this.clientOptions(),
        )
        const options = signal === undefined ? {} : { signal }
        const selections = await client.quotaSelections(options)
        return Promise.all(selections.map((selection) => client.quota({ authIndex: selection.authIndex }, options)))
      },
    }
  }

  private runtime(): GatewayRuntime | undefined {
    return this.ctx.get('cpaRuntime')
  }

  /** Optional companion is deliberately resolved structurally to keep Gateway decoupled. */
  private analyticsService(): GatewayAnalyticsReadService | undefined {
    return this.ctx.get('gatewayAnalytics') as GatewayAnalyticsReadService | undefined
  }

  private requireRuntime(): GatewayRuntime {
    const runtime = this.runtime()
    if (runtime === undefined) throw new GatewayHostError('runtime_unavailable', 'Gateway Runtime plugin is not installed')
    return runtime
  }

  private endpoint(): string {
    return this.runtime()?.snapshot().endpoint ?? this.config.endpoint
  }

  private clientOptions() {
    return {
      baseUrl: this.endpoint(),
      allowExternalBaseUrl: this.config.allowExternalEndpoint,
    }
  }

  private credentialRefs(): CpaCredentialRefs {
    return {
      proxyCredentialRef: credentialRef(this.config.proxyCredentialRef),
      managementCredentialRef: credentialRef(this.config.managementCredentialRef),
    }
  }

  private async credentialView(rawRef: string): Promise<GatewayCredentialView> {
    const ref = credentialRef(rawRef)
    const info = await this.ctx.credentials.describe(ref)
    return {
      ref,
      configured: info.configured,
      writable: info.writable,
      ...(info.source === undefined ? {} : { source: info.source }),
    }
  }

  private requireLlmSettingsDescriptor(): SettingsDescriptor {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === LLM_PI_AI_SETTINGS_NAMESPACE)
    if (descriptor === undefined) {
      throw new GatewayHostError('llm_pi_ai_unavailable', 'The official llm-pi-ai settings namespace is unavailable')
    }
    return descriptor
  }

  private runtimeView(snapshot: RuntimeSnapshot | undefined): GatewayRuntimeView {
    if (snapshot === undefined) return { available: false, state: 'unavailable' }
    return {
      available: true,
      state: snapshot.state,
      mode: snapshot.mode,
      endpoint: snapshot.endpoint,
      ...(snapshot.release === undefined ? {} : { version: snapshot.release.releaseId }),
      ...(snapshot.lastError === undefined ? {} : { errorCode: snapshot.lastError.code }),
    }
  }

  private async prepareOauthManager(target: DeviceLoginLaunchTarget): Promise<void> {
    const key = `${target.binaryPath}\0${target.configPath}\0${target.cwd}`
    const current = this.oauth?.status()
    if (this.oauth !== undefined && this.oauthTarget === key
      && current !== undefined && !TERMINAL_OAUTH_STATES.has(current.state)) return
    await this.oauth?.dispose()
    this.oauth = new CodexDeviceLoginManager({
      subprocess: this.ctx.subprocess,
      binaryPath: target.binaryPath,
      configPath: target.configPath,
      cwd: target.cwd,
    })
    this.oauthTarget = key
  }
}

function configuredImageModels(descriptor: SettingsDescriptor, endpoint: string, proxyCredentialRef: string): ReadonlySet<string> {
  const user = valueObject(descriptor.user)
  const providers = valueObject(user?.providers)
  const route = valueObject(providers?.cpa)
  if (route === undefined || route.api !== CPA_PROVIDER_API || route.apiKeyEnv !== proxyCredentialRef
    || typeof route.baseURL !== 'string' || !Array.isArray(route.models)) return new Set()
  try {
    if (normalizeCpaProviderBaseURL(route.baseURL) !== normalizeCpaProviderBaseURL(endpoint)) return new Set()
  } catch {
    return new Set()
  }
  const ids = new Set<string>()
  for (const model of route.models) {
    const item = valueObject(model)
    if (item !== undefined && typeof item.id === 'string' && item.id.length > 0
      && Array.isArray(item.input) && item.input.includes('image')) ids.add(item.id)
  }
  return ids
}

function parseImageUploadRequest(value: unknown, maxBytes: number): {
  dataBase64: string
  mediaType: ImageMediaType
  name?: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidImageUpload()
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['dataBase64', 'mediaType', 'name'].includes(key))) throw invalidImageUpload()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new GatewayHostError('attachments_unavailable', 'Image attachment limits are unavailable')
  if (typeof raw.dataBase64 !== 'string' || raw.dataBase64.length === 0
    || raw.dataBase64.length > Math.ceil(maxBytes / 3) * 4
    || raw.dataBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.dataBase64)) throw invalidImageUpload()
  const decoded = Buffer.from(raw.dataBase64, 'base64')
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64') !== raw.dataBase64) throw invalidImageUpload()
  if (!isImageMediaType(raw.mediaType)) throw invalidImageUpload()
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length === 0
    || raw.name.length > MAX_IMAGE_NAME_CHARS || raw.name.includes('\u0000'))) throw invalidImageUpload()
  return {
    dataBase64: raw.dataBase64,
    mediaType: raw.mediaType,
    ...(raw.name === undefined ? {} : { name: raw.name as string }),
  }
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function invalidImageUpload(): GatewayHostError {
  return new GatewayHostError('invalid_image_upload', 'Image upload request is invalid')
}

function probeImageRef(ref: ImageAttachmentRef): GatewayProbeImageRef {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

function parseAnalyticsFilters(value: unknown, extraKeys: readonly string[] = []): GatewayAnalyticsFilters {
  const raw = analyticsObject(value)
  assertAnalyticsKeys(raw, ['fromMs', 'toMs', 'providerId', 'modelId', 'routeId', 'accountIdHash', 'apiKeyIdHash', ...extraKeys])
  const fromMs = parseAnalyticsTime(raw.fromMs)
  const toMs = parseAnalyticsTime(raw.toMs)
  if (fromMs >= toMs || toMs - fromMs > MAX_ANALYTICS_RANGE_MS) throw invalidAnalyticsRequest()
  const result: GatewayAnalyticsFilters = { fromMs, toMs }
  const providerId = parseOptionalAnalyticsDimension(raw.providerId)
  const modelId = parseOptionalAnalyticsDimension(raw.modelId)
  const routeId = parseOptionalAnalyticsDimension(raw.routeId)
  const accountIdHash = parseOptionalAnalyticsHash(raw.accountIdHash)
  const apiKeyIdHash = parseOptionalAnalyticsHash(raw.apiKeyIdHash)
  if (providerId !== undefined) (result as { providerId?: string }).providerId = providerId
  if (modelId !== undefined) (result as { modelId?: string }).modelId = modelId
  if (routeId !== undefined) (result as { routeId?: string }).routeId = routeId
  if (accountIdHash !== undefined) (result as { accountIdHash?: string }).accountIdHash = accountIdHash
  if (apiKeyIdHash !== undefined) (result as { apiKeyIdHash?: string }).apiKeyIdHash = apiKeyIdHash
  return result
}

function parseAnalyticsTimeRange(value: unknown): GatewayAnalyticsTimeRange {
  const raw = analyticsObject(value)
  assertAnalyticsKeys(raw, ['fromMs', 'toMs'])
  const fromMs = parseAnalyticsTime(raw.fromMs)
  const toMs = parseAnalyticsTime(raw.toMs)
  if (fromMs >= toMs || toMs - fromMs > MAX_ANALYTICS_RANGE_MS) throw invalidAnalyticsRequest()
  return { fromMs, toMs }
}

function parseAnalyticsTrendRequest(value: unknown): GatewayAnalyticsTrendRequest {
  const raw = analyticsObject(value)
  const filters = parseAnalyticsFilters(raw, ['bucket'])
  if (raw.bucket !== 'hour' && raw.bucket !== 'day') throw invalidAnalyticsRequest()
  return { ...filters, bucket: raw.bucket }
}

function parseAnalyticsRequestsRequest(value: unknown): GatewayAnalyticsRequestsRequest {
  const raw = analyticsObject(value)
  const filters = parseAnalyticsFilters(raw, ['limit', 'cursor'])
  if (typeof raw.limit !== 'number' || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 100) {
    throw invalidAnalyticsRequest()
  }
  const cursor = parseOptionalAnalyticsCursor(raw.cursor)
  return {
    ...filters,
    limit: raw.limit,
    ...(cursor === undefined ? {} : { cursor }),
  }
}

function analyticsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidAnalyticsRequest()
  return value as Record<string, unknown>
}

function assertAnalyticsKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidAnalyticsRequest()
}

function parseAnalyticsTime(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidAnalyticsRequest()
  return value as number
}

function parseOptionalAnalyticsDimension(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ANALYTICS_DIMENSION_CHARS || value.includes('\u0000')) {
    throw invalidAnalyticsRequest()
  }
  return value
}

function parseOptionalAnalyticsHash(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !ANALYTICS_HASH.test(value)) throw invalidAnalyticsRequest()
  return value
}

function parseOptionalAnalyticsCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ANALYTICS_CURSOR_CHARS || !ANALYTICS_CURSOR.test(value)) {
    throw invalidAnalyticsRequest()
  }
  return value
}

function invalidAnalyticsRequest(): GatewayHostError {
  return new GatewayHostError('invalid_analytics_request', 'Analytics request is invalid')
}

function projectAnalyticsStatus(value: unknown): GatewayAnalyticsStatusView {
  const raw = valueObject(value)
  if (raw === undefined
    || !isAnalyticsAvailability(raw.availability)
    || !isAnalyticsMode(raw.mode)
    || !isAnalyticsQueueCompleteness(raw.queueCompleteness)
    || !isNonNegativeSafeInteger(raw.lossPossibleCount)) return ANALYTICS_UNAVAILABLE_STATUS
  return {
    availability: raw.availability,
    mode: raw.mode,
    queueCompleteness: raw.queueCompleteness,
    lossPossibleCount: raw.lossPossibleCount,
  }
}

function projectAnalyticsSummary(value: unknown): GatewayAnalyticsSummaryView {
  return readAnalyticsSummary(value) ?? EMPTY_ANALYTICS_SUMMARY
}

function readAnalyticsSummary(value: unknown): GatewayAnalyticsSummaryView | undefined {
  const raw = valueObject(value)
  if (raw === undefined) return undefined
  const integerMetrics = [
    raw.requests, raw.successes, raw.errors, raw.aborted,
    raw.inputTokens, raw.outputTokens, raw.cacheReadTokens, raw.cacheWriteTokens,
    raw.reasoningTokens, raw.knownCostMicros, raw.pricedRequests,
    raw.partialRequests, raw.unpricedRequests,
  ]
  if (!integerMetrics.every(isNonNegativeSafeInteger)) return undefined
  const currency = readAnalyticsCurrency(raw.currency)
  const p50DurationMs = readNullableNonNegativeSafeInteger(raw.p50DurationMs)
  const p95DurationMs = readNullableNonNegativeSafeInteger(raw.p95DurationMs)
  const p50TimeToFirstTokenMs = readNullableNonNegativeSafeInteger(raw.p50TimeToFirstTokenMs)
  const p95TimeToFirstTokenMs = readNullableNonNegativeSafeInteger(raw.p95TimeToFirstTokenMs)
  if (currency === undefined || p50DurationMs === undefined || p95DurationMs === undefined
    || p50TimeToFirstTokenMs === undefined || p95TimeToFirstTokenMs === undefined) return undefined
  return {
    requests: raw.requests as number,
    successes: raw.successes as number,
    errors: raw.errors as number,
    aborted: raw.aborted as number,
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    cacheReadTokens: raw.cacheReadTokens as number,
    cacheWriteTokens: raw.cacheWriteTokens as number,
    reasoningTokens: raw.reasoningTokens as number,
    knownCostMicros: raw.knownCostMicros as number,
    pricedRequests: raw.pricedRequests as number,
    partialRequests: raw.partialRequests as number,
    unpricedRequests: raw.unpricedRequests as number,
    currency,
    p50DurationMs,
    p95DurationMs,
    p50TimeToFirstTokenMs,
    p95TimeToFirstTokenMs,
  }
}

function projectAnalyticsTrend(value: unknown): readonly GatewayAnalyticsTrendPoint[] {
  if (!Array.isArray(value)) return []
  const result: GatewayAnalyticsTrendPoint[] = []
  for (const item of value.slice(0, MAX_ANALYTICS_ROWS)) {
    const raw = valueObject(item)
    const summary = readAnalyticsSummary(raw)
    if (raw === undefined || summary === undefined || !isNonNegativeSafeInteger(raw.bucketStartMs)) continue
    result.push({ ...summary, bucketStartMs: raw.bucketStartMs })
  }
  return result
}

function projectAnalyticsRequests(value: unknown): GatewayAnalyticsRequestPageView {
  const raw = valueObject(value)
  if (raw === undefined || !Array.isArray(raw.items)) return { items: [] }
  const items: GatewayAnalyticsRequestView[] = []
  for (const item of raw.items.slice(0, MAX_ANALYTICS_ROWS)) {
    const projected = readAnalyticsRequest(item)
    if (projected !== undefined) items.push(projected)
  }
  const nextCursor = readAnalyticsCursor(raw.nextCursor)
  return nextCursor === undefined ? { items } : { items, nextCursor }
}

function readAnalyticsRequest(value: unknown): GatewayAnalyticsRequestView | undefined {
  const raw = valueObject(value)
  if (raw === undefined || !isAnalyticsHash(raw.requestIdHash)
    || !isNonNegativeSafeInteger(raw.occurredAtMs)
    || !isBoundedAnalyticsText(raw.routeId) || !isBoundedAnalyticsText(raw.providerId)
    || !isBoundedAnalyticsText(raw.modelId)
    || !isNullableAnalyticsHash(raw.accountIdHash) || !isNullableAnalyticsHash(raw.apiKeyIdHash)
    || !isAnalyticsOutcome(raw.outcome) || !isAnalyticsErrorKind(raw.errorKind)
    || !isNullableNonNegativeSafeInteger(raw.inputTokens) || !isNullableNonNegativeSafeInteger(raw.outputTokens)
    || !isNullableNonNegativeSafeInteger(raw.durationMs) || !isNullableNonNegativeSafeInteger(raw.estimatedCostMicros)
    || readAnalyticsCurrency(raw.currency) === undefined || !isAnalyticsPricingState(raw.pricingState)) return undefined
  return {
    requestIdHash: raw.requestIdHash,
    occurredAtMs: raw.occurredAtMs,
    routeId: raw.routeId,
    providerId: raw.providerId,
    modelId: raw.modelId,
    accountIdHash: raw.accountIdHash,
    apiKeyIdHash: raw.apiKeyIdHash,
    outcome: raw.outcome,
    errorKind: raw.errorKind,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    durationMs: raw.durationMs,
    estimatedCostMicros: raw.estimatedCostMicros,
    currency: readAnalyticsCurrency(raw.currency) as string | null,
    pricingState: raw.pricingState,
  }
}

function projectAnalyticsQuota(value: unknown): readonly GatewayAnalyticsQuotaView[] {
  if (!Array.isArray(value)) return []
  const result: GatewayAnalyticsQuotaView[] = []
  for (const item of value.slice(0, MAX_ANALYTICS_ROWS)) {
    const raw = valueObject(item)
    if (raw === undefined || !isBoundedAnalyticsText(raw.providerId, false)
      || !isNullableAnalyticsHash(raw.accountIdHash) || !isBoundedAnalyticsText(raw.quotaKind, false)
      || !isAnalyticsQuotaUnit(raw.unit) || !isNullableQuotaNumber(raw.limit, raw.unit)
      || !isNullableQuotaNumber(raw.used, raw.unit) || !isNullableQuotaNumber(raw.remaining, raw.unit)
      || !isNullableNonNegativeSafeInteger(raw.resetAtMs) || !isAnalyticsQuotaStatus(raw.sourceStatus)
      || !isNonNegativeSafeInteger(raw.observedAtMs)) continue
    result.push({
      providerId: raw.providerId,
      accountIdHash: raw.accountIdHash,
      quotaKind: raw.quotaKind,
      unit: raw.unit,
      limit: raw.limit,
      used: raw.used,
      remaining: raw.remaining,
      resetAtMs: raw.resetAtMs,
      sourceStatus: raw.sourceStatus,
      observedAtMs: raw.observedAtMs,
    })
  }
  return result
}

function projectAnalyticsAccounts(value: unknown): readonly GatewayAnalyticsAccountView[] {
  if (!Array.isArray(value)) return []
  const result: GatewayAnalyticsAccountView[] = []
  for (const item of value.slice(0, MAX_ANALYTICS_ROWS)) {
    const raw = valueObject(item)
    if (raw === undefined || !isBoundedAnalyticsText(raw.providerId, false)
      || !isNullableAnalyticsHash(raw.accountIdHash) || !isAnalyticsHealthStatus(raw.healthStatus)
      || !isBoundedAnalyticsText(raw.reasonCode, false) || !isNonNegativeSafeInteger(raw.observedAtMs)) continue
    result.push({
      providerId: raw.providerId,
      accountIdHash: raw.accountIdHash,
      healthStatus: raw.healthStatus,
      reasonCode: raw.reasonCode,
      observedAtMs: raw.observedAtMs,
    })
  }
  return result
}

function valueObject(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readNullableNonNegativeSafeInteger(value: unknown): number | null | undefined {
  return value === null ? null : isNonNegativeSafeInteger(value) ? value : undefined
}

function isNullableNonNegativeSafeInteger(value: unknown): value is number | null {
  return readNullableNonNegativeSafeInteger(value) !== undefined
}

function isBoundedAnalyticsText(value: unknown, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= MAX_ANALYTICS_DIMENSION_CHARS
    && (allowEmpty || value.length > 0) && !value.includes('\u0000')
}

function isAnalyticsHash(value: unknown): value is string {
  return typeof value === 'string' && ANALYTICS_HASH.test(value)
}

function isNullableAnalyticsHash(value: unknown): value is string | null {
  return value === null || isAnalyticsHash(value)
}

function readAnalyticsCurrency(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' && ANALYTICS_CURRENCIES.test(value) ? value : undefined
}

function readAnalyticsCursor(value: unknown): string | undefined {
  return value === undefined ? undefined
    : typeof value === 'string' && value.length > 0 && value.length <= MAX_ANALYTICS_CURSOR_CHARS && ANALYTICS_CURSOR.test(value)
      ? value
      : undefined
}

function isAnalyticsAvailability(value: unknown): value is GatewayAnalyticsAvailability {
  return value === 'disabled' || value === 'starting' || value === 'ready' || value === 'degraded' || value === 'unavailable'
}

function isAnalyticsMode(value: unknown): value is GatewayAnalyticsMode {
  return value === 'disabled' || value === 'managed' || value === 'external'
}

function isAnalyticsQueueCompleteness(value: unknown): value is GatewayAnalyticsStatusView['queueCompleteness'] {
  return value === 'unknown' || value === 'sole_consumer' || value === 'competition_possible' || value === 'crash_loss_possible'
}

function isAnalyticsOutcome(value: unknown): value is GatewayAnalyticsRequestView['outcome'] {
  return value === 'success' || value === 'error' || value === 'aborted'
}

function isAnalyticsErrorKind(value: unknown): value is GatewayAnalyticsRequestView['errorKind'] {
  return value === 'none' || value === 'authentication' || value === 'authorization' || value === 'rate_limit'
    || value === 'upstream' || value === 'timeout' || value === 'cancelled' || value === 'invalid_request' || value === 'unknown'
}

function isAnalyticsPricingState(value: unknown): value is GatewayAnalyticsRequestView['pricingState'] {
  return value === 'priced' || value === 'partial' || value === 'unpriced'
}

function isAnalyticsQuotaUnit(value: unknown): value is GatewayAnalyticsQuotaView['unit'] {
  return value === 'requests' || value === 'tokens' || value === 'currency' || value === 'percent' || value === 'unknown'
}

function isNullableQuotaNumber(value: unknown, unit: GatewayAnalyticsQuotaView['unit']): value is number | null {
  if (value === null) return true
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return false
  return unit === 'percent' || Number.isSafeInteger(value)
}

function isAnalyticsQuotaStatus(value: unknown): value is GatewayAnalyticsQuotaView['sourceStatus'] {
  return value === 'available' || value === 'unavailable' || value === 'unsupported'
}

function isAnalyticsHealthStatus(value: unknown): value is GatewayAnalyticsAccountView['healthStatus'] {
  return value === 'healthy' || value === 'degraded' || value === 'unavailable' || value === 'unsupported'
}

function oauthStatus(status: CodexDeviceLoginStatus): GatewayOAuthStatus {
  return status
}

function boundedText(value: string, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new GatewayHostError('invalid_probe_request', `Probe ${field} is invalid`)
  }
  return value
}

function imageRef(input: GatewayProbeImageRef): ImageAttachmentRef {
  if (typeof input.attachmentId !== 'string' || input.attachmentId.length === 0 || input.attachmentId.length > 256
    || !Number.isSafeInteger(input.bytes) || input.bytes < 1
    || !Number.isSafeInteger(input.width) || input.width < 1
    || !Number.isSafeInteger(input.height) || input.height < 1
    || (input.name !== undefined && (input.name.length === 0 || input.name.length > 256))) {
    throw new GatewayHostError('invalid_probe_request', 'Probe image reference is invalid')
  }
  return input as unknown as ImageAttachmentRef
}

function probeTools(input: readonly GatewayProbeTool[]): ToolSchema[] {
  if (input.length > MAX_TOOL_COUNT) throw new GatewayHostError('invalid_probe_request', 'Probe tools are invalid')
  return input.map((tool) => {
    if (!TOOL_NAME.test(tool.name) || typeof tool.description !== 'string'
      || tool.description.length === 0 || tool.description.length > MAX_TOOL_DESCRIPTION_CHARS
      || tool.parameters === null || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
      throw new GatewayHostError('invalid_probe_request', 'Probe tool is invalid')
    }
    return { name: tool.name, description: tool.description, parameters: { ...tool.parameters } }
  })
}

function safeLlmFailure(finish: Extract<FinishReason, { kind: 'error' | 'aborted' }>): { code: string; status?: number } {
  const rawCode = finish.failure.code
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'PROBE_FAILED'
  return {
    code,
    ...(finish.failure.status === undefined ? {} : { status: finish.failure.status }),
  }
}
