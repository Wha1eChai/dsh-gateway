import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { resolveAnalyticsConfig } from './config.js'
import type {
  AnalyticsFilters,
  AnalyticsStatus,
  AnalyticsStore,
  AnalyticsSummary,
  IngestResult,
  RecentRequestPage,
} from './contracts.js'
import { GatewayAnalyticsService } from './service.js'

const EMPTY_SUMMARY: AnalyticsSummary = {
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
}

function fakeStore(): AnalyticsStore {
  const result = async (): Promise<IngestResult> => ({ disposition: 'inserted' })
  return {
    status: vi.fn(async (): Promise<AnalyticsStatus> => ({
      availability: 'ready',
      mode: 'external',
      queueCompleteness: 'unknown',
      lossPossibleCount: 0,
    })),
    summary: vi.fn(async (_filters: AnalyticsFilters) => EMPTY_SUMMARY),
    trend: vi.fn(async () => []),
    recent: vi.fn(async (): Promise<RecentRequestPage> => ({ items: [] })),
    quota: vi.fn(async () => []),
    accountHealth: vi.fn(async () => []),
    ingestRequest: vi.fn(result),
    ingestQuota: vi.fn(result),
    ingestAccountHealth: vi.fn(result),
    ingestDeadLetter: vi.fn(result),
    maintain: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

function context(mode: 'managed' | 'external' = 'managed') {
  let credential: string | undefined
  const source = {
    mode,
    targetIdentity: 'http://127.0.0.1:8317',
    dequeueUsage: vi.fn(async () => []),
    accountHealth: vi.fn(async () => []),
    quota: vi.fn(async () => [{
      providerId: 'openai-codex',
      windows: [{ kind: 'primary', unit: 'percent', limit: 100, used: 25, remaining: 75, resetAtMs: 2_000 }],
    }]),
  }
  const ctx = {
    get: vi.fn((key: string) => key === 'dshGateway' ? { analyticsSource: () => source } : undefined),
    credentials: {
      resolve: vi.fn(async () => credential === undefined ? undefined : { value: credential, source: 'file' }),
      set: vi.fn(async (_ref, value: string) => { credential = value }),
    },
  } as unknown as Context
  return { ctx, source }
}

describe('GatewayAnalyticsService', () => {
  it('does not provision credentials or create a database while disabled', async () => {
    const { ctx } = context('external')
    const createStore = vi.fn(async () => fakeStore())
    const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig({ enabled: false }), [], createStore)
    await service.start()
    expect((ctx.credentials as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled()
    expect(createStore).not.toHaveBeenCalled()
    expect(await service.status()).toMatchObject({ availability: 'disabled' })
    await service.close()
  })

  it('provisions one installation key and polls managed usage without leaking failures', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, source } = context('managed')
      const store = fakeStore()
      const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig({ pollIntervalMs: 1_000 }), [], async () => store)
      await service.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(source.dequeueUsage).toHaveBeenCalledTimes(1)
      expect(source.accountHealth).toHaveBeenCalledTimes(1)
      expect(source.quota).toHaveBeenCalledTimes(1)
      expect(store.ingestQuota).toHaveBeenCalledTimes(1)
      expect((ctx.credentials as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledTimes(1)
      expect(await service.status()).toMatchObject({ availability: 'ready', mode: 'managed' })
      await service.close()
      expect(store.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an external destructive queue off until explicit opt-in', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, source } = context('external')
      const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig({ pollIntervalMs: 1_000 }), [], async () => fakeStore())
      await service.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(source.dequeueUsage).not.toHaveBeenCalled()
      expect(source.accountHealth).toHaveBeenCalledTimes(1)
      expect(source.quota).toHaveBeenCalledTimes(1)
      expect(await service.status()).toMatchObject({ mode: 'external', queueCompleteness: 'unknown' })
      await service.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('degrades startup failure to unavailable and returns empty read models', async () => {
    const { ctx } = context()
    const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig(), [], async () => { throw new Error('sqlite unavailable') })
    expect(await service.status()).toMatchObject({ availability: 'unavailable', lastErrorKind: 'initialization_failed' })
    expect(await service.summary({ fromMs: 0, toMs: 1 })).toEqual(EMPTY_SUMMARY)
    await service.close()
  })

  it('records a sanitized unavailable quota observation when the source fails', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, source } = context('managed')
      source.quota.mockRejectedValue(new Error('raw management credential must not persist'))
      const store = fakeStore()
      const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig({ pollIntervalMs: 1_000 }), [], async () => store)
      await service.start()
      await vi.advanceTimersByTimeAsync(0)
      const unavailable = (store.ingestQuota as ReturnType<typeof vi.fn>).mock.calls
        .map(([observation]) => observation as { sourceStatus: string; quotaKind: string; providerId: string })
        .find((observation) => observation.sourceStatus === 'unavailable')
      expect(unavailable).toMatchObject({ sourceStatus: 'unavailable', quotaKind: 'unknown', providerId: 'unknown' })
      expect(JSON.stringify(unavailable)).not.toContain('raw management credential')
      await service.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns typed unavailable when worker status fails', async () => {
    const { ctx } = context('external')
    const store = fakeStore()
    store.status = vi.fn(async () => { throw new Error('worker secret') })
    const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig(), [], async () => store)
    expect(await service.status()).toMatchObject({ availability: 'unavailable', lastErrorKind: 'worker_status_failed' })
    await service.close()
  })

  it('marks the service unavailable when a quota worker write fails', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = context('managed')
      const store = fakeStore()
      store.ingestQuota = vi.fn(async () => { throw new Error('worker write failed') })
      const service = new GatewayAnalyticsService(ctx, resolveAnalyticsConfig({ pollIntervalMs: 1_000 }), [], async () => store)
      await service.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(await service.status()).toMatchObject({ availability: 'unavailable', lastErrorKind: 'worker_operation_failed' })
      await service.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
