import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import type { Config } from '../config.js'
// The Remote-decorated service is exercised from the built Host face. Vite's
// source transformer intentionally does not lower the DSH decorator syntax.
import { GatewayHostService, inject } from '../../lib/index.js'

const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const RANGE = { fromMs: 1_700_000_000_000, toMs: 1_700_001_000_000 }
const FILTERS = {
  ...RANGE,
  providerId: 'openai-codex',
  modelId: 'gpt-test',
  routeId: 'cpa',
  accountIdHash: HASH,
  apiKeyIdHash: OTHER_HASH,
}
const config: Config = {
  endpoint: 'http://127.0.0.1:8317',
  allowExternalEndpoint: false,
  proxyCredentialRef: 'DSH_GATEWAY_PROXY_KEY',
  managementCredentialRef: 'DSH_GATEWAY_MANAGEMENT_KEY',
}

interface FakeAnalytics {
  status: () => Promise<unknown>
  summary: (filters: unknown) => Promise<unknown>
  trend: (filters: unknown) => Promise<unknown>
  recent: (filters: unknown) => Promise<unknown>
  quota: (filters: unknown) => Promise<unknown>
  accountHealth: (filters: unknown) => Promise<unknown>
}

function hostFor(analytics?: FakeAnalytics, attachments?: unknown): { host: GatewayHostService; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn((key: string) => key === 'gatewayAnalytics' ? analytics : undefined)
  const ctx = {
    get,
    reflect: { provide: vi.fn() },
    effect: vi.fn(),
    attachments,
  } as unknown as Context
  return { host: new GatewayHostService(ctx, config), get }
}

function emptyAnalytics(): FakeAnalytics {
  return {
    status: vi.fn(async () => ({
      availability: 'ready',
      mode: 'external',
      queueCompleteness: 'unknown',
      lossPossibleCount: 0,
    })),
    summary: vi.fn(async () => undefined),
    trend: vi.fn(async () => []),
    recent: vi.fn(async () => ({ items: [] })),
    quota: vi.fn(async () => []),
    accountHealth: vi.fn(async () => []),
  }
}

describe('Gateway analytics Remotes', () => {
  it('declares the attachment service required by the image upload Remote', () => {
    expect(inject).toContain('attachments')
  })

  it('keeps the existing eleven Remotes and adds six analytics plus image upload Remotes', () => {
    const { host } = hostFor()
    expect(remoteMethods(host).map((marker) => marker.exportName ?? marker.method)).toEqual([
      'status', 'analyticsStatus', 'analyticsSummary', 'analyticsTrend', 'analyticsRequests',
      'analyticsQuota', 'analyticsAccounts', 'runtimeInstall', 'runtimeStart', 'runtimeStop',
      'runtimeRestart', 'models', 'applyModels', 'oauthDeviceStart', 'oauthDeviceStatus',
      'oauthDeviceCancel', 'uploadImage', 'probe',
    ])
  })

  it('persists a bounded canonical image through the Host attachment seam', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const saveImage = vi.fn(async () => ({
      attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'pixel.png',
    }))
    const { host } = hostFor(undefined, { imageLimits: { maxImageBytes: 1_024 }, saveImage })

    await expect(host.uploadImage({ dataBase64: png, mediaType: 'image/png', name: 'pixel.png' })).resolves.toEqual({
      attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'pixel.png',
    })
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'pixel.png' }))
    const saved = saveImage.mock.calls[0]?.[0] as { data: Uint8Array }
    expect(saved.data).toBeInstanceOf(Uint8Array)
    expect(saved.data.byteLength).toBe(68)

    await expect(host.uploadImage({ dataBase64: 'not base64', mediaType: 'image/png' })).rejects.toMatchObject({ code: 'invalid_image_upload' })
    await expect(host.uploadImage({ dataBase64: png, mediaType: 'image/svg+xml' } as never)).rejects.toMatchObject({ code: 'invalid_image_upload' })
    await expect(host.uploadImage({ dataBase64: png, mediaType: 'image/png', extra: true } as never)).rejects.toMatchObject({ code: 'invalid_image_upload' })
  })

  it('returns typed unavailable and empty models when the optional service is absent', async () => {
    const { host, get } = hostFor()

    await expect(host.analyticsStatus()).resolves.toEqual({
      availability: 'unavailable',
      mode: 'disabled',
      queueCompleteness: 'unknown',
      lossPossibleCount: 0,
    })
    await expect(host.analyticsSummary(FILTERS)).resolves.toMatchObject({ requests: 0, currency: null })
    await expect(host.analyticsTrend({ ...FILTERS, bucket: 'hour' })).resolves.toEqual([])
    await expect(host.analyticsRequests({ ...FILTERS, limit: 10 })).resolves.toEqual({ items: [] })
    await expect(host.analyticsQuota(RANGE)).resolves.toEqual([])
    await expect(host.analyticsAccounts(RANGE)).resolves.toEqual([])
    expect(JSON.stringify(await host.analyticsStatus())).not.toContain('databasePath')
    expect(get).toHaveBeenCalledWith('gatewayAnalytics')
  })

  it('validates bounded ranges, dimensions, buckets, limits, cursors, and exact fields', async () => {
    const { host } = hostFor(emptyAnalytics())
    const tooLong = 'x'.repeat(257)
    const invalidCases: Array<Promise<unknown>> = [
      host.analyticsSummary({ fromMs: 0, toMs: 0 }),
      host.analyticsSummary({ fromMs: 0, toMs: 366 * 24 * 60 * 60 * 1_000 + 1 }),
      host.analyticsSummary({ fromMs: Number.NaN, toMs: 1 }),
      host.analyticsSummary({ fromMs: 0, toMs: 1, providerId: tooLong }),
      host.analyticsSummary({ fromMs: 0, toMs: 1, accountIdHash: 'raw-account-id' }),
      host.analyticsSummary({ fromMs: 0, toMs: 1, unexpected: true } as never),
      host.analyticsTrend({ ...RANGE, bucket: 'minute' } as never),
      host.analyticsRequests({ ...RANGE, limit: 0 }),
      host.analyticsRequests({ ...RANGE, limit: 101 }),
      host.analyticsRequests({ ...RANGE, limit: 1, cursor: 'not valid!' }),
      host.analyticsQuota({ ...RANGE, extra: true } as never),
    ]
    for (const pending of invalidCases) await expect(pending).rejects.toMatchObject({ code: 'invalid_analytics_request' })
  })

  it('constructs exact store filters and projects only browser-safe fields', async () => {
    const analytics = emptyAnalytics()
    analytics.status = vi.fn(async () => ({
      availability: 'ready',
      mode: 'managed',
      queueCompleteness: 'sole_consumer',
      lossPossibleCount: 2,
      databasePath: 'C:\\private\\analytics.sqlite',
      lastErrorKind: 'worker-private-error',
    }))
    analytics.summary = vi.fn(async () => ({
      requests: 3, successes: 2, errors: 1, aborted: 0,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3,
      knownCostMicros: 400, pricedRequests: 2, partialRequests: 1, unpricedRequests: 0, currency: 'USD',
      p50DurationMs: 100, p95DurationMs: 200, p50TimeToFirstTokenMs: 20, p95TimeToFirstTokenMs: 40,
      databasePath: 'C:\\private\\analytics.sqlite', prompt: 'private prompt', output: 'private output',
    }))
    analytics.trend = vi.fn(async () => {
      const summary = await analytics.summary(FILTERS) as Record<string, unknown>
      return [{ ...summary, bucketStartMs: RANGE.fromMs, sourceEventKeyHash: 'raw-source-event' }]
    })
    analytics.recent = vi.fn(async () => ({
      items: [{
        requestIdHash: HASH,
        occurredAtMs: RANGE.fromMs,
        routeId: 'cpa', providerId: 'openai-codex', modelId: 'gpt-test',
        accountIdHash: HASH, apiKeyIdHash: null,
        outcome: 'success', errorKind: 'none', inputTokens: 10, outputTokens: 20,
        durationMs: 100, estimatedCostMicros: 400, currency: 'USD', pricingState: 'priced',
        sourceEventKeyHash: 'raw-source-event', fingerprint: 'raw-fingerprint',
        databasePath: 'C:\\private\\analytics.sqlite', prompt: 'private prompt', output: 'private output',
      }],
      nextCursor: 'opaque_cursor',
    }))
    analytics.quota = vi.fn(async () => [{
      sourceEventKeyHash: 'raw-source-event', providerId: 'openai-codex', accountIdHash: HASH,
      quotaKind: 'primary', unit: 'percent', limit: 100, used: 25.5, remaining: 74.5,
      resetAtMs: RANGE.toMs, sourceStatus: 'available', projectionVersion: 1,
      observedAtMs: RANGE.fromMs, fingerprint: 'raw-fingerprint', hashKeyVersion: 1,
      databasePath: 'C:\\private\\analytics.sqlite',
    }])
    analytics.accountHealth = vi.fn(async () => [{
      sourceEventKeyHash: 'raw-source-event', providerId: 'openai-codex', accountIdHash: HASH,
      healthStatus: 'healthy', reasonCode: 'ready', observedAtMs: RANGE.fromMs, hashKeyVersion: 1,
      databasePath: 'C:\\private\\analytics.sqlite',
    }])
    const { host } = hostFor(analytics)

    await expect(host.analyticsStatus()).resolves.toEqual({
      availability: 'ready', mode: 'managed', queueCompleteness: 'sole_consumer', lossPossibleCount: 2,
    })
    await expect(host.analyticsSummary(FILTERS)).resolves.toMatchObject({ requests: 3, knownCostMicros: 400 })
    await expect(host.analyticsTrend({ ...FILTERS, bucket: 'day' })).resolves.toHaveLength(1)
    await expect(host.analyticsRequests({ ...FILTERS, limit: 10, cursor: 'opaque_cursor' })).resolves.toMatchObject({
      items: [{ requestIdHash: HASH, modelId: 'gpt-test', accountIdHash: HASH }],
      nextCursor: 'opaque_cursor',
    })
    await expect(host.analyticsQuota(RANGE)).resolves.toEqual([{
      providerId: 'openai-codex', accountIdHash: HASH, quotaKind: 'primary', unit: 'percent',
      limit: 100, used: 25.5, remaining: 74.5, resetAtMs: RANGE.toMs, sourceStatus: 'available', observedAtMs: RANGE.fromMs,
    }])
    await expect(host.analyticsAccounts(RANGE)).resolves.toEqual([{
      providerId: 'openai-codex', accountIdHash: HASH, healthStatus: 'healthy', reasonCode: 'ready', observedAtMs: RANGE.fromMs,
    }])

    expect(analytics.summary).toHaveBeenCalledWith(FILTERS)
    expect(analytics.trend).toHaveBeenCalledWith({ ...FILTERS, bucket: 'day' })
    expect(analytics.recent).toHaveBeenCalledWith({ ...FILTERS, limit: 10, cursor: 'opaque_cursor' })
    expect(analytics.quota).toHaveBeenCalledWith(RANGE)
    expect(analytics.accountHealth).toHaveBeenCalledWith(RANGE)
    const serialized = JSON.stringify({
      status: await host.analyticsStatus(), summary: await host.analyticsSummary(FILTERS),
      trend: await host.analyticsTrend({ ...FILTERS, bucket: 'day' }), requests: await host.analyticsRequests({ ...FILTERS, limit: 10 }),
      quota: await host.analyticsQuota(RANGE), accounts: await host.analyticsAccounts(RANGE),
    })
    expect(serialized).not.toMatch(/database\.sqlite|raw-source-event|raw-fingerprint|private prompt|private output|worker-private-error/)
  })

  it('turns throwing structural service methods into unavailable or empty data without error text', async () => {
    const analytics: FakeAnalytics = {
      status: vi.fn(async () => { throw new Error('databasePath=C:\\private\\analytics.sqlite secret-output') }),
      summary: vi.fn(async () => { throw new Error('summary secret-output') }),
      trend: vi.fn(async () => { throw new Error('trend secret-output') }),
      recent: vi.fn(async () => { throw new Error('recent secret-output') }),
      quota: vi.fn(async () => { throw new Error('quota secret-output') }),
      accountHealth: vi.fn(async () => { throw new Error('account secret-output') }),
    }
    const { host } = hostFor(analytics)

    await expect(host.analyticsStatus()).resolves.toMatchObject({ availability: 'unavailable' })
    await expect(host.analyticsSummary(FILTERS)).resolves.toMatchObject({ requests: 0 })
    await expect(host.analyticsTrend({ ...FILTERS, bucket: 'hour' })).resolves.toEqual([])
    await expect(host.analyticsRequests({ ...FILTERS, limit: 1 })).resolves.toEqual({ items: [] })
    await expect(host.analyticsQuota(RANGE)).resolves.toEqual([])
    await expect(host.analyticsAccounts(RANGE)).resolves.toEqual([])
    expect(JSON.stringify(await host.analyticsStatus())).not.toMatch(/private|secret|databasePath/)
  })
})
