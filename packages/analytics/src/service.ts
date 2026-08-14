import { randomBytes } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import type {
  AccountHealthObservation,
  AnalyticsFilters,
  AnalyticsStatus,
  AnalyticsStore,
  AnalyticsSummary,
  AnalyticsTrendPoint,
  AnalyticsWriteStore,
  IngestResult,
  PricingRule,
  QuotaObservation,
  RecentRequestPage,
  RequestObservation,
} from './contracts.js'
import type { ResolvedAnalyticsConfig } from './config.js'
import {
  HttpUsageCollector,
  InstallationHasher,
  projectAccountHealthList,
  projectQuota,
} from './pipeline/index.js'

export interface AnalyticsStoreFactoryOptions {
  readonly databasePath: string
  readonly targetKey: string
  readonly mode: 'managed' | 'external'
  readonly queueCompleteness: AnalyticsStatus['queueCompleteness']
  readonly pricingRules: readonly PricingRule[]
}

export type AnalyticsStoreFactory = (options: AnalyticsStoreFactoryOptions) => Promise<AnalyticsStore>

interface GatewayAnalyticsSourceLike {
  readonly mode: 'managed' | 'external'
  readonly targetIdentity: string
  dequeueUsage(signal?: AbortSignal): Promise<readonly unknown[]>
  accountHealth(signal?: AbortSignal): Promise<unknown>
  quota(signal?: AbortSignal): Promise<readonly unknown[]>
}

interface GatewayAnalyticsHostLike {
  analyticsSource(): GatewayAnalyticsSourceLike
}

const EMPTY_SUMMARY: AnalyticsSummary = Object.freeze({
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

/** Failure-isolated Cordis service around the worker-owned analytics store. */
export class GatewayAnalyticsService implements AnalyticsStore {
  private readonly ctx: Context
  private readonly config: ResolvedAnalyticsConfig
  private readonly pricingRules: readonly PricingRule[]
  private readonly createStore: AnalyticsStoreFactory
  private readonly abortController = new AbortController()
  private startPromise: Promise<void> | undefined
  private cyclePromise: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private store: AnalyticsStore | undefined
  private collector: HttpUsageCollector | undefined
  private source: GatewayAnalyticsSourceLike | undefined
  private hasher: InstallationHasher | undefined
  private startupFailed = false
  private operationalErrorKind: string | undefined
  private disposed = false
  private cycleCount = 0

  constructor(
    ctx: Context,
    config: ResolvedAnalyticsConfig,
    pricingRules: readonly PricingRule[],
    createStore: AnalyticsStoreFactory,
  ) {
    this.ctx = ctx
    this.config = config
    this.pricingRules = pricingRules
    this.createStore = createStore
  }

  start(): Promise<void> {
    this.startPromise ??= this.initialize()
    return this.startPromise
  }

  async status(): Promise<AnalyticsStatus> {
    await this.start()
    if (!this.config.enabled) return disabledStatus()
    if (this.store === undefined) return unavailableStatus(this.startupFailed ? 'initialization_failed' : undefined)
    if (this.operationalErrorKind !== undefined) return this.unavailableStatus(this.operationalErrorKind)
    try {
      const storeStatus = await this.store.status()
      const collectorStatus = this.collector?.status()
      if (collectorStatus === undefined) return { ...storeStatus, databasePath: this.config.databasePath }
      return {
        ...storeStatus,
        ...collectorStatus,
        availability: worseAvailability(storeStatus.availability, collectorStatus.availability),
        lossPossibleCount: Math.max(storeStatus.lossPossibleCount, collectorStatus.lossPossibleCount),
        databasePath: this.config.databasePath,
      }
    } catch {
      this.operationalErrorKind = 'worker_status_failed'
      return this.unavailableStatus(this.operationalErrorKind)
    }
  }

  async ingestRequest(observation: RequestObservation): Promise<IngestResult> {
    return this.write((store) => store.ingestRequest(observation))
  }

  async ingestQuota(observation: QuotaObservation): Promise<IngestResult> {
    return this.write((store) => store.ingestQuota(observation))
  }

  async ingestAccountHealth(observation: AccountHealthObservation): Promise<IngestResult> {
    return this.write((store) => store.ingestAccountHealth(observation))
  }

  async ingestDeadLetter(observation: Parameters<AnalyticsWriteStore['ingestDeadLetter']>[0]): Promise<IngestResult> {
    return this.write((store) => store.ingestDeadLetter(observation))
  }

  async maintain(nowMs?: number): Promise<void> {
    await this.start()
    try {
      await this.store?.maintain(nowMs)
    } catch {
      this.operationalErrorKind = 'worker_maintenance_failed'
    }
  }

  async summary(filters: AnalyticsFilters): Promise<AnalyticsSummary> {
    return this.read((store) => store.summary(filters), EMPTY_SUMMARY)
  }

  async trend(filters: AnalyticsFilters & { readonly bucket: 'hour' | 'day' }): Promise<readonly AnalyticsTrendPoint[]> {
    return this.read((store) => store.trend(filters), [])
  }

  async recent(filters: AnalyticsFilters & { readonly limit: number; readonly cursor?: string }): Promise<RecentRequestPage> {
    return this.read((store) => store.recent(filters), { items: [] })
  }

  async quota(filters: { readonly fromMs: number; readonly toMs: number }): Promise<readonly QuotaObservation[]> {
    return this.read((store) => store.quota(filters), [])
  }

  async accountHealth(filters: { readonly fromMs: number; readonly toMs: number }): Promise<readonly AccountHealthObservation[]> {
    return this.read((store) => store.accountHealth(filters), [])
  }

  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.collector?.dispose()
    try { await this.cyclePromise } catch { /* failure-isolated */ }
    await this.store?.close()
    this.store = undefined
  }

  private async initialize(): Promise<void> {
    if (!this.config.enabled || this.disposed) return
    try {
      const host = this.ctx.get('dshGateway') as GatewayAnalyticsHostLike | undefined
      if (host === undefined) throw new Error('gateway host is unavailable')
      const source = host.analyticsSource()
      const key = await this.installationKey()
      if (this.disposed) return
      const hasher = new InstallationHasher(key, 1, source.targetIdentity)
      const collectUsage = source.mode === 'managed' || this.config.externalQueueOptIn
      const queueCompleteness = collectUsage
        ? source.mode === 'managed' ? 'sole_consumer' : 'competition_possible'
        : 'unknown'
      const targetKey = hasher.hash('source-event', 'analytics-target')
      const store = await this.createStore({
        databasePath: this.config.databasePath,
        targetKey,
        mode: source.mode,
        queueCompleteness,
        pricingRules: this.pricingRules,
      })
      if (this.disposed) {
        await store.close()
        return
      }
      this.source = source
      this.hasher = hasher
      this.store = store
      if (collectUsage) {
        this.collector = new HttpUsageCollector({
          mode: source.mode,
          externalOptIn: this.config.externalQueueOptIn,
          source: { dequeueUsage: (signal) => source.dequeueUsage(signal) },
          store,
          hasher,
        })
      }
      this.schedule(0)
    } catch {
      this.startupFailed = true
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const cycle = this.runCycle()
      this.cyclePromise = cycle
      void cycle.finally(() => {
        if (this.cyclePromise === cycle) this.cyclePromise = undefined
        this.schedule(this.config.pollIntervalMs)
      })
    }, delayMs)
  }

  private async runCycle(): Promise<void> {
    if (this.disposed) return
    try { await this.collector?.poll() } catch { /* failure-isolated */ }
    this.cycleCount += 1
    if (this.cycleCount === 1 || this.cycleCount % 12 === 0) {
      await this.collectAccountHealth()
      await this.collectQuota()
    }
    if (this.cycleCount % 12 === 0) await this.maintain()
  }

  private async collectAccountHealth(): Promise<void> {
    const source = this.source
    const hasher = this.hasher
    const store = this.store
    if (source === undefined || hasher === undefined || store === undefined || this.abortController.signal.aborted) return
    let observations: readonly AccountHealthObservation[]
    try {
      observations = projectAccountHealthList(
        await source.accountHealth(this.abortController.signal),
        hasher,
      )
    } catch {
      // Account health source failures are observational only.
      return
    }
    try {
      for (const observation of observations) await store.ingestAccountHealth(observation)
    } catch {
      this.operationalErrorKind = 'worker_operation_failed'
    }
  }

  private async collectQuota(): Promise<void> {
    const source = this.source
    const hasher = this.hasher
    const store = this.store
    if (source === undefined || hasher === undefined || store === undefined || this.abortController.signal.aborted) return
    let snapshots: readonly unknown[]
    try {
      snapshots = await source.quota(this.abortController.signal)
    } catch {
      try {
        for (const observation of projectQuota({ providerId: 'unknown' }, hasher, { sourceStatus: 'unavailable' })) {
          await store.ingestQuota(observation)
        }
      } catch {
        this.operationalErrorKind = 'worker_operation_failed'
      }
      return
    }
    try {
      for (const snapshot of snapshots) {
        for (const observation of projectQuota(snapshot, hasher)) {
          await store.ingestQuota(observation)
        }
      }
    } catch {
      this.operationalErrorKind = 'worker_operation_failed'
    }
  }

  private async installationKey(): Promise<Uint8Array> {
    const reference = credentialRef(this.config.hashCredentialRef)
    let resolved = await this.ctx.credentials.resolve(reference)
    if (resolved === undefined) {
      await this.ctx.credentials.set(reference, randomBytes(32).toString('base64url'))
      resolved = await this.ctx.credentials.resolve(reference)
    }
    if (resolved === undefined || !/^[A-Za-z0-9_-]{43}$/.test(resolved.value)) {
      throw new Error('analytics installation key is unavailable')
    }
    const key = Buffer.from(resolved.value, 'base64url')
    if (key.byteLength !== 32) throw new Error('analytics installation key is invalid')
    return new Uint8Array(key)
  }

  private async write(operation: (store: AnalyticsStore) => Promise<IngestResult>): Promise<IngestResult> {
    await this.start()
    if (this.store === undefined) return { disposition: 'ignored' }
    try {
      return await operation(this.store)
    } catch {
      this.operationalErrorKind = 'worker_operation_failed'
      return { disposition: 'ignored' }
    }
  }

  private async read<T>(operation: (store: AnalyticsStore) => Promise<T>, fallback: T): Promise<T> {
    await this.start()
    if (this.store === undefined) return fallback
    try {
      return await operation(this.store)
    } catch {
      this.operationalErrorKind = 'worker_read_failed'
      return fallback
    }
  }

  private unavailableStatus(lastErrorKind: string): AnalyticsStatus {
    const collectorStatus = this.collector?.status()
    return {
      availability: 'unavailable',
      mode: this.source?.mode ?? 'disabled',
      databasePath: this.config.databasePath,
      queueCompleteness: collectorStatus?.queueCompleteness ?? 'unknown',
      lossPossibleCount: collectorStatus?.lossPossibleCount ?? 0,
      lastErrorKind,
    }
  }
}

function disabledStatus(): AnalyticsStatus {
  return {
    availability: 'disabled',
    mode: 'disabled',
    queueCompleteness: 'unknown',
    lossPossibleCount: 0,
  }
}

function unavailableStatus(lastErrorKind?: string): AnalyticsStatus {
  return {
    availability: 'unavailable',
    mode: 'disabled',
    queueCompleteness: 'unknown',
    lossPossibleCount: 0,
    ...(lastErrorKind === undefined ? {} : { lastErrorKind }),
  }
}

function worseAvailability(left: AnalyticsStatus['availability'], right: AnalyticsStatus['availability']): AnalyticsStatus['availability'] {
  const priority: Record<AnalyticsStatus['availability'], number> = {
    disabled: 0,
    starting: 1,
    ready: 2,
    degraded: 3,
    unavailable: 4,
  }
  return priority[left] >= priority[right] ? left : right
}
