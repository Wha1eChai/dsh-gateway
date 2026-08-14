import type { AnalyticsStatus, AnalyticsWriteStore } from '../contracts.js'
import { InstallationHasher } from './hashing.js'
import { projectCpaUsage } from './usage-projector.js'

export type CollectorMode = 'disabled' | 'managed' | 'external'

export interface StructuralUsageSource {
  dequeueUsage(signal?: AbortSignal): Promise<readonly unknown[]>
}

export interface HttpUsageCollectorOptions {
  readonly mode: CollectorMode
  readonly source?: StructuralUsageSource
  readonly store?: AnalyticsWriteStore
  readonly hasher: InstallationHasher
  readonly externalOptIn?: boolean
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly disposeTimeoutMs?: number
}

export interface CollectorMetrics {
  readonly polls: number
  readonly popped: number
  readonly committed: number
  readonly deadLetter: number
  readonly lossPossible: number
  readonly dequeueFailures: number
  readonly ingestFailures: number
}

export interface CollectorPollReport {
  readonly polled: boolean
  readonly popped: number
  readonly committed: number
  readonly deadLetter: number
  readonly lossPossible: number
  readonly errorKind?: 'dequeue_failed' | 'ingest_failed' | 'disposed'
}

const DEFAULT_INITIAL_BACKOFF_MS = 250
const DEFAULT_MAX_BACKOFF_MS = 30_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 250

/**
 * At-most-once HTTP queue collector. It has no ack, RESP, account action, or
 * model-request path; a pop is counted before any worker/store operation.
 */
export class HttpUsageCollector {
  private readonly mode: CollectorMode
  private readonly source: StructuralUsageSource | undefined
  private readonly store: AnalyticsWriteStore | undefined
  private readonly hasher: InstallationHasher
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly disposeTimeoutMs: number
  private readonly abortController = new AbortController()
  private metricsValue: CollectorMetrics = {
    polls: 0,
    popped: 0,
    committed: 0,
    deadLetter: 0,
    lossPossible: 0,
    dequeueFailures: 0,
    ingestFailures: 0,
  }
  private inFlight: Promise<CollectorPollReport> | undefined
  private disposed = false
  private unavailableLatched = false
  private currentBackoffMs: number
  private lastErrorKind: string | undefined
  private availability: AnalyticsStatus['availability']

  constructor(options: HttpUsageCollectorOptions) {
    if (options.mode === 'external' && options.externalOptIn !== true) throw new Error('external collector requires explicit opt-in')
    this.mode = options.mode
    this.source = options.source
    this.store = options.store
    this.hasher = options.hasher
    this.initialBackoffMs = boundedDelay(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS)
    this.maxBackoffMs = Math.max(this.initialBackoffMs, boundedDelay(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS))
    this.disposeTimeoutMs = boundedDelay(options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS)
    this.currentBackoffMs = this.initialBackoffMs
    this.availability = options.mode === 'disabled' ? 'disabled' : 'starting'
  }

  metrics(): CollectorMetrics {
    return Object.freeze({ ...this.metricsValue })
  }

  status(): AnalyticsStatus {
    const completeness = this.mode === 'disabled'
      ? 'unknown'
      : this.mode === 'external'
        ? 'competition_possible'
        : this.metricsValue.lossPossible > 0
          ? 'crash_loss_possible'
          : 'sole_consumer'
    return Object.freeze({
      availability: this.availability,
      mode: this.mode,
      queueCompleteness: completeness,
      lossPossibleCount: this.metricsValue.lossPossible,
      ...(this.lastErrorKind === undefined ? {} : { lastErrorKind: this.lastErrorKind }),
    })
  }

  poll(): Promise<CollectorPollReport> {
    if (this.inFlight) return this.inFlight
    if (this.disposed) return Promise.resolve({ polled: false, popped: 0, committed: 0, deadLetter: 0, lossPossible: 0, errorKind: 'disposed' })
    if (this.mode === 'disabled') return Promise.resolve({ polled: false, popped: 0, committed: 0, deadLetter: 0, lossPossible: 0 })
    if (this.unavailableLatched) return Promise.resolve({ polled: false, popped: 0, committed: 0, deadLetter: 0, lossPossible: 0, errorKind: 'ingest_failed' })
    const operation = this.executePoll()
    this.inFlight = operation
    void operation.then(
      () => this.clearInFlight(operation),
      () => this.clearInFlight(operation),
    )
    return operation
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
    const pending = this.inFlight
    if (pending) {
      await Promise.race([pending, delay(this.disposeTimeoutMs)])
    }
    this.availability = this.mode === 'disabled' ? 'disabled' : 'unavailable'
  }

  private async executePoll(): Promise<CollectorPollReport> {
    this.metricsValue = { ...this.metricsValue, polls: this.metricsValue.polls + 1 }
    if (!this.source || !this.store) {
      this.availability = 'unavailable'
      this.lastErrorKind = 'configuration'
      return { polled: false, popped: 0, committed: 0, deadLetter: 0, lossPossible: 0, errorKind: 'dequeue_failed' }
    }
    let items: readonly unknown[]
    try {
      items = await this.source.dequeueUsage(this.abortController.signal)
      if (!Array.isArray(items)) throw new TypeError('usage source did not return an array')
    } catch (error) {
      if (this.disposed || this.abortController.signal.aborted) {
        this.availability = 'unavailable'
        return { polled: false, popped: 0, committed: 0, deadLetter: 0, lossPossible: 0, errorKind: 'disposed' }
      }
      this.metricsValue = { ...this.metricsValue, dequeueFailures: this.metricsValue.dequeueFailures + 1 }
      this.availability = 'unavailable'
      this.lastErrorKind = 'dequeue_failed'
      this.currentBackoffMs = Math.min(this.maxBackoffMs, Math.max(this.initialBackoffMs, this.currentBackoffMs * 2))
      void error
      return { polled: false, popped: 0, committed: 0, deadLetter: 0, lossPossible: 0, errorKind: 'dequeue_failed' }
    }

    const popped = items.length
    this.metricsValue = { ...this.metricsValue, popped: this.metricsValue.popped + popped }
    let committed = 0
    let deadLetter = 0
    let lossPossible = 0
    for (let index = 0; index < items.length; index += 1) {
      const projection = projectCpaUsage(items[index], this.hasher)
      if (projection.disposition === 'dead_letter') {
        try {
          await this.store.ingestDeadLetter(projection.deadLetter)
          deadLetter += 1
          this.metricsValue = { ...this.metricsValue, deadLetter: this.metricsValue.deadLetter + 1 }
          continue
        } catch {
          lossPossible += items.length - index
          this.metricsValue = {
            ...this.metricsValue,
            ingestFailures: this.metricsValue.ingestFailures + 1,
          }
          this.latchUnavailable('ingest_failed')
          break
        }
      }
      try {
        await this.store.ingestRequest(projection.observation)
        committed += 1
        this.metricsValue = { ...this.metricsValue, committed: this.metricsValue.committed + 1 }
      } catch {
        lossPossible += items.length - index
        this.metricsValue = {
          ...this.metricsValue,
          ingestFailures: this.metricsValue.ingestFailures + 1,
        }
        this.latchUnavailable('ingest_failed')
        break
      }
    }
    if (lossPossible > 0) {
      this.metricsValue = { ...this.metricsValue, lossPossible: this.metricsValue.lossPossible + lossPossible }
      if (!this.unavailableLatched) this.availability = 'degraded'
      this.lastErrorKind = 'ingest_failed'
    } else {
      this.availability = this.mode === 'external' ? 'ready' : 'ready'
      this.currentBackoffMs = this.initialBackoffMs
      this.lastErrorKind = undefined
    }
    return { polled: true, popped, committed, deadLetter, lossPossible, ...(lossPossible > 0 ? { errorKind: 'ingest_failed' as const } : {}) }
  }

  private clearInFlight(operation: Promise<CollectorPollReport>): void {
    if (this.inFlight === operation) this.inFlight = undefined
  }

  private latchUnavailable(errorKind: 'ingest_failed'): void {
    this.unavailableLatched = true
    this.availability = 'unavailable'
    this.lastErrorKind = errorKind
  }
}

export const UsageCollector = HttpUsageCollector

function boundedDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('collector delay must be a non-negative safe integer')
  return Math.min(value, 300_000)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
