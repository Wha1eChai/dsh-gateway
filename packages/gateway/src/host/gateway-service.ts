import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
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
  GatewayCredentialView,
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
  LLM_PI_AI_SETTINGS_NAMESPACE,
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
const MAX_TOOL_COUNT = 32
const MAX_TOOL_DESCRIPTION_CHARS = 4_096
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const TERMINAL_OAUTH_STATES = new Set(['success', 'denied', 'expired', 'cancelled', 'timed_out', 'failed'])

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
    return {
      models: discovered.map((model) => ({ id: model.id, name: model.name ?? model.id, imageInput: false })),
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
