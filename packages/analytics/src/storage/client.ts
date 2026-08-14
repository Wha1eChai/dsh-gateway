import { Worker } from 'node:worker_threads'
import type {
  AccountHealthObservation,
  AnalyticsFilters,
  AnalyticsStatus,
  AnalyticsStore,
  AnalyticsSummary,
  AnalyticsTimeRange,
  AnalyticsTrendPoint,
  DeadLetterObservation,
  IngestResult,
  QuotaObservation,
  RecentRequestPage,
  RequestObservation,
} from '../contracts.js'
import type { WorkerData, WorkerMessage, WorkerOperation, WorkerRequestMessage, WorkerResult } from './protocol.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PENDING = 64
const MAX_REQUEST_ID = 2_147_483_647

export const ANALYTICS_WORKER_ENTRY_URL = new URL('./storage/worker-entry.js', import.meta.url)

export interface AnalyticsWorkerClientOptions {
  readonly workerUrl?: URL
  readonly requestTimeoutMs?: number
  readonly maxPending?: number
}

interface PendingRequest {
  readonly operation: WorkerOperation
  readonly resolve: (value: WorkerResult) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type ClientState = 'starting' | 'ready' | 'failed' | 'closing' | 'closed'

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be within 1..${maximum}`)
  return value
}

export class AnalyticsWorkerClient implements AnalyticsStore {
  private readonly worker: Worker
  private readonly workerData: WorkerData
  private readonly timeoutMs: number
  private readonly maxPending: number
  private readonly pending = new Map<number, PendingRequest>()
  private readonly outbox: number[] = []
  private readonly drainWaiters = new Set<() => void>()
  private state: ClientState = 'starting'
  private nextId = 1
  private failure: Error | undefined
  private closePromise: Promise<void> | undefined
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise: Promise<void>
  private readonly readyTimer: ReturnType<typeof setTimeout>

  constructor(data: WorkerData, options: AnalyticsWorkerClientOptions = {}) {
    this.workerData = data
    this.timeoutMs = boundedPositiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'analytics request timeout', 300_000)
    this.maxPending = boundedPositiveInteger(options.maxPending ?? DEFAULT_MAX_PENDING, 'analytics pending request limit', 4_096)
    this.readyPromise = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.readyPromise.catch(() => undefined)
    this.readyTimer = setTimeout(() => this.fail(new Error(`analytics worker ready timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    this.worker = new Worker(options.workerUrl ?? ANALYTICS_WORKER_ENTRY_URL, { workerData: data })
    this.worker.on('message', (message: WorkerMessage) => this.onMessage(message))
    this.worker.on('error', (error) => this.fail(new Error(`analytics worker failed: ${error.message.slice(0, 256)}`)))
    this.worker.on('exit', (code) => {
      if (this.state !== 'closing' && this.state !== 'closed' && this.state !== 'failed') this.fail(new Error(`analytics worker exited unexpectedly (${code})`))
    })
  }

  status(): Promise<AnalyticsStatus> {
    return this.request<AnalyticsStatus>({ op: 'status' }).catch((error: unknown) => {
      if (this.state === 'closing' || this.state === 'closed') throw error
      return {
        availability: 'unavailable' as const,
        mode: this.workerData.mode,
        databasePath: this.workerData.databasePath,
        queueCompleteness: this.workerData.queueCompleteness,
        lossPossibleCount: 0,
        lastErrorKind: 'worker_unavailable',
      }
    })
  }
  summary(filters: AnalyticsFilters): Promise<AnalyticsSummary> { return this.request<AnalyticsSummary>({ op: 'summary', filters }) }
  trend(filters: AnalyticsFilters & { readonly bucket: 'hour' | 'day' }): Promise<readonly AnalyticsTrendPoint[]> { return this.request<readonly AnalyticsTrendPoint[]>({ op: 'trend', filters }) }
  recent(filters: AnalyticsFilters & { readonly limit: number; readonly cursor?: string }): Promise<RecentRequestPage> { return this.request<RecentRequestPage>({ op: 'recent', filters }) }
  quota(filters: AnalyticsTimeRange): Promise<readonly QuotaObservation[]> { return this.request<readonly QuotaObservation[]>({ op: 'quota', filters }) }
  accountHealth(filters: AnalyticsTimeRange): Promise<readonly AccountHealthObservation[]> { return this.request<readonly AccountHealthObservation[]>({ op: 'accountHealth', filters }) }
  ingestRequest(observation: RequestObservation): Promise<IngestResult> { return this.request<IngestResult>({ op: 'ingestRequest', observation }) }
  ingestQuota(observation: QuotaObservation): Promise<IngestResult> { return this.request<IngestResult>({ op: 'ingestQuota', observation }) }
  ingestAccountHealth(observation: AccountHealthObservation): Promise<IngestResult> { return this.request<IngestResult>({ op: 'ingestAccountHealth', observation }) }
  ingestDeadLetter(observation: DeadLetterObservation): Promise<IngestResult> { return this.request<IngestResult>({ op: 'ingestDeadLetter', observation }) }
  maintain(nowMs?: number): Promise<void> {
    const request = nowMs === undefined ? this.request<undefined>({ op: 'maintain' }) : this.request<undefined>({ op: 'maintain', nowMs })
    return request.then(() => undefined)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.state === 'closed') return Promise.resolve()
    this.state = 'closing'
    this.closePromise = (async () => {
      try {
        await this.readyPromise
        await this.waitForDrain()
        if (!this.failure) await this.requestInternal<undefined>({ op: 'close' }, true)
      } catch {
        // Failure and timeout are already propagated to in-flight callers.
      } finally {
        this.state = 'closed'
        this.rejectAll(new Error('analytics store is closed'))
        await this.worker.terminate()
      }
    })()
    return this.closePromise
  }

  private request<T extends WorkerResult>(operation: WorkerOperation): Promise<T> {
    return this.requestInternal<T>(operation, false)
  }

  private requestInternal<T extends WorkerResult>(operation: WorkerOperation, allowClosing: boolean): Promise<T> {
    if (this.state === 'failed') return Promise.reject(this.failure ?? new Error('analytics worker failed'))
    if (this.state === 'closed' || (this.state === 'closing' && !allowClosing)) return Promise.reject(new Error('analytics store is closed'))
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error('analytics pending request limit exceeded'))
    const id = this.allocateId()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.removeFromOutbox(id)
        reject(new Error(`analytics request timed out after ${this.timeoutMs}ms`))
        this.notifyDrain()
      }, this.timeoutMs)
      this.pending.set(id, { operation, resolve: (value) => resolve(value as T), reject, timer })
      if (this.state === 'ready' || (allowClosing && this.state === 'closing')) this.post(id)
      else this.outbox.push(id)
    })
  }

  private allocateId(): number {
    for (let attempt = 0; attempt <= this.maxPending; attempt += 1) {
      const id = this.nextId
      this.nextId = id >= MAX_REQUEST_ID ? 1 : id + 1
      if (!this.pending.has(id)) return id
    }
    throw new Error('analytics request ID space is exhausted')
  }

  private post(id: number): void {
    const pending = this.pending.get(id)
    if (!pending) return
    const message: WorkerRequestMessage = { type: 'request', id, operation: pending.operation }
    try {
      this.worker.postMessage(message)
    } catch (error) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error instanceof Error ? error : new Error('analytics worker post failed'))
      this.notifyDrain()
    }
  }

  private onMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      if (this.state !== 'starting' && this.state !== 'closing') return
      if (this.state === 'starting') this.state = 'ready'
      clearTimeout(this.readyTimer)
      this.readyResolve()
      for (const id of this.outbox.splice(0)) this.post(id)
      return
    }
    if (message.type === 'fatal') {
      this.fail(this.remoteError(message.error))
      return
    }
    if (message.type !== 'response') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(this.remoteError(message.error))
    this.notifyDrain()
  }

  private remoteError(error: { readonly name: string; readonly message: string }): Error {
    const result = new Error(error.message.slice(0, 256))
    result.name = error.name.slice(0, 64) || 'Error'
    return result
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'closed') return
    this.failure = error
    this.state = 'failed'
    clearTimeout(this.readyTimer)
    this.readyReject(error)
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.outbox.length = 0
    this.notifyDrain()
  }

  private removeFromOutbox(id: number): void {
    const index = this.outbox.indexOf(id)
    if (index >= 0) this.outbox.splice(index, 1)
  }

  private waitForDrain(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.add(resolve))
  }

  private notifyDrain(): void {
    if (this.pending.size !== 0) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }
}

export function createAnalyticsWorkerStore(data: WorkerData, options: AnalyticsWorkerClientOptions = {}): AnalyticsWorkerClient {
  return new AnalyticsWorkerClient(data, options)
}
