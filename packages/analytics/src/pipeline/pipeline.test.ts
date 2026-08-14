import { describe, expect, it, vi } from 'vitest'

import type { AnalyticsWriteStore, PricingRule } from '../contracts.js'
import { HttpUsageCollector } from './collector.js'
import { InstallationHasher } from './hashing.js'
import { projectAccountHealth, projectQuota } from './management-projectors.js'
import { PricingRuleMatcher } from './pricing.js'
import { projectCpaUsage } from './usage-projector.js'

const hasher = () => new InstallationHasher(new Uint8Array(32).fill(7), 3, 'target-a')

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    snapshotVersion: 'snapshot-1',
    ruleId: 'rule-1',
    routeId: '*',
    providerId: '*',
    modelId: '*',
    accountIdHash: '*',
    apiKeyIdHash: '*',
    currency: 'USD',
    requestUnitPriceMicros: 2,
    inputTokenPriceMicrosPerMillion: null,
    outputTokenPriceMicrosPerMillion: null,
    cacheReadTokenPriceMicrosPerMillion: null,
    cacheWriteTokenPriceMicrosPerMillion: null,
    reasoningTokenPriceMicrosPerMillion: null,
    effectiveFromMs: 0,
    effectiveToMs: null,
    sourceName: 'fixture',
    sourceUrl: 'https://example.invalid/pricing',
    sourceVersion: '1',
    sourceSha256: 'a'.repeat(64),
    generatedAtMs: 1,
    releaseVersion: '0.1.0',
    ...overrides,
  }
}

function store(overrides: Partial<AnalyticsWriteStore> = {}): AnalyticsWriteStore {
  return {
    ingestRequest: vi.fn(async () => ({ disposition: 'inserted' as const })),
    ingestQuota: vi.fn(async () => ({ disposition: 'inserted' as const })),
    ingestAccountHealth: vi.fn(async () => ({ disposition: 'inserted' as const })),
    ingestDeadLetter: vi.fn(async () => ({ disposition: 'inserted' as const })),
    maintain: vi.fn(async () => undefined),
    ...overrides,
  } as AnalyticsWriteStore
}

function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'event-1',
    requestId: 'request-1',
    timestamp: '2026-08-14T00:00:00.000Z',
    provider: 'openai',
    model: 'gpt-test',
    endpoint: '/v1/chat/completions',
    tokens: { inputTokens: 1, outputTokens: 2 },
    ...overrides,
  }
}

describe('analytics pipeline', () => {
  it('separates hash namespaces and fingerprints canonical object order', () => {
    const value = hasher()
    expect(value.hash('request', 'same')).not.toBe(value.hash('account', 'same'))
    expect(value.fingerprint({ b: 2, a: 1 })).toBe(value.fingerprint({ a: 1, b: 2 }))
  })

  it('projects bounded usage and never retains raw account/API-key identifiers', () => {
    const result = projectCpaUsage(usage({ accountId: 'raw-account', apiKeyId: 'raw-api-key' }), hasher())
    expect(result.disposition).toBe('accepted')
    expect(JSON.stringify(result)).not.toContain('raw-account')
    expect(JSON.stringify(result)).not.toContain('raw-api-key')
    if (result.disposition === 'accepted') {
      expect(result.observation.routeId).toBe('/v1/chat/completions')
      expect(result.observation.inputTokens).toBe(1)
    }
  })

  it('dead-letters missing stable IDs without timestamp/model request heuristics', () => {
    const result = projectCpaUsage(usage({ eventId: undefined }), hasher())
    expect(result.disposition).toBe('dead_letter')
    if (result.disposition === 'dead_letter') {
      expect(result.deadLetter.reasonCode).toBe('missing_event_id')
      expect(result.deadLetter.retryable).toBe(false)
      expect(JSON.stringify(result)).not.toContain('request-1')
    }
  })

  it('selects the most specific effective pricing rule and rejects equal overlaps', () => {
    const specific = rule({ ruleId: 'specific', providerId: 'openai', modelId: 'gpt-test', requestUnitPriceMicros: 9 })
    const matcher = new PricingRuleMatcher([rule(), specific])
    expect(matcher.match({ routeId: '', providerId: 'openai', modelId: 'gpt-test', accountIdHash: null, apiKeyIdHash: null, occurredAtMs: 1 })?.ruleId).toBe('specific')
    expect(() => new PricingRuleMatcher([
      rule({ ruleId: 'left', providerId: 'openai' }),
      rule({ ruleId: 'right', providerId: 'openai' }),
    ])).toThrow(/equal-specificity/)
  })

  it('returns partial pricing without fabricating unknown cost', () => {
    const result = new PricingRuleMatcher([rule({ inputTokenPriceMicrosPerMillion: null, outputTokenPriceMicrosPerMillion: null })]).estimate({
      schemaVersion: 1,
      sourceKind: 'cpa_http_usage',
      sourceEventKeyHash: 'a',
      requestIdHash: 'b',
      payloadFingerprint: 'c',
      occurredAtMs: 1,
      routeId: '',
      providerId: '',
      modelId: '',
      accountIdHash: null,
      apiKeyIdHash: null,
      hashKeyVersion: 1,
      outcome: 'success',
      errorKind: 'none',
      httpStatus: null,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      timeToFirstTokenMs: null,
      durationMs: null,
      requestUnits: 1,
    })
    expect(result.pricingState).toBe('partial')
    expect(result.estimatedCostMicros).toBeNull()
    expect(result.knownCostMicros).toBe(2)
  })

  it('strictly projects health and quota failures to typed unavailable states', () => {
    const value = hasher()
    const health = projectAccountHealth({ providerId: 'openai', healthStatus: 'raw-secret-status', accountId: 'raw-account', observedAtMs: 1 }, value)
    expect(health.healthStatus).toBe('unsupported')
    expect(JSON.stringify(health)).not.toContain('raw-account')
    const quota = projectQuota({ providerId: 'openai', windows: [{ kind: 'primary', unit: 'percent', used: 'not-a-number' }] }, value, { nowMs: 1 })
    expect(quota[0]?.sourceStatus).toBe('unsupported')
    expect(quota[0]?.limit).toBeNull()
  })

  it('requires external opt-in and prevents concurrent single polls', async () => {
    const value = hasher()
    const source = {
      calls: 0,
      resolve: undefined as (() => void) | undefined,
      dequeueUsage: vi.fn((_signal?: AbortSignal) => {
        source.calls += 1
        return new Promise<readonly unknown[]>((resolve) => { source.resolve = () => resolve([]) })
      }),
    }
    expect(() => new HttpUsageCollector({ mode: 'external', externalOptIn: false, source, store: store(), hasher: value })).toThrow(/opt-in/)
    const collector = new HttpUsageCollector({ mode: 'managed', source, store: store(), hasher: value })
    const first = collector.poll()
    const second = collector.poll()
    expect(first).toBe(second)
    source.resolve?.()
    await first
    expect(source.calls).toBe(1)
  })

  it('aborts on disposal, reports dequeue failure, and exposes post-pop loss', async () => {
    const value = hasher()
    let signal: AbortSignal | undefined
    const pendingSource = {
      dequeueUsage: vi.fn((input?: AbortSignal) => {
        signal = input
        return new Promise<readonly unknown[]>((_resolve, reject) => input?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }),
    }
    const pending = new HttpUsageCollector({ mode: 'managed', source: pendingSource, store: store(), hasher: value })
    const poll = pending.poll()
    await pending.dispose()
    await poll
    expect(signal?.aborted).toBe(true)

    const failed = new HttpUsageCollector({ mode: 'managed', source: { dequeueUsage: vi.fn(async () => { throw new Error('network') }) }, store: store(), hasher: value })
    expect((await failed.poll()).errorKind).toBe('dequeue_failed')

    const dequeueAfterIngestFailure = vi.fn(async () => [usage()])
    const ingestFailure = new HttpUsageCollector({
      mode: 'managed',
      source: { dequeueUsage: dequeueAfterIngestFailure },
      store: store({ ingestRequest: vi.fn(async () => { throw new Error('worker') }) }),
      hasher: value,
    })
    const report = await ingestFailure.poll()
    expect(report.lossPossible).toBe(1)
    expect(ingestFailure.status()).toMatchObject({ availability: 'unavailable', queueCompleteness: 'crash_loss_possible' })
    expect((await ingestFailure.poll()).polled).toBe(false)
    expect(dequeueAfterIngestFailure).toHaveBeenCalledTimes(1)

    const deadLetterDequeue = vi.fn(async () => [usage({ eventId: undefined })])
    const deadLetterFailure = new HttpUsageCollector({
      mode: 'managed',
      source: { dequeueUsage: deadLetterDequeue },
      store: store({ ingestDeadLetter: vi.fn(async () => { throw new Error('worker') }) }),
      hasher: value,
    })
    expect((await deadLetterFailure.poll()).lossPossible).toBe(1)
    await deadLetterFailure.poll()
    expect(deadLetterDequeue).toHaveBeenCalledTimes(1)
  })
})
