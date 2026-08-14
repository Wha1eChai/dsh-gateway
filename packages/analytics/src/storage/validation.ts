import { createHash } from 'node:crypto'
import type {
  AccountHealthObservation,
  AnalyticsFilters,
  DeadLetterObservation,
  PricingRule,
  QuotaObservation,
  RequestErrorKind,
  RequestObservation,
} from '../contracts.js'

export const MAX_BOUND_STRING = 256
export const MAX_SOURCE_URL = 2_048
export const MAX_DEAD_LETTER_PROJECTION = 8_192
export const MAX_QUERY_RANGE_MS = 366 * 24 * 60 * 60 * 1_000
export const MAX_RECENT_LIMIT = 100
export const MAX_QUERY_ROWS = 1_000

const REQUEST_KEYS = [
  'schemaVersion', 'sourceKind', 'sourceEventKeyHash', 'requestIdHash', 'payloadFingerprint',
  'occurredAtMs', 'routeId', 'providerId', 'modelId', 'accountIdHash', 'apiKeyIdHash',
  'hashKeyVersion', 'outcome', 'errorKind', 'httpStatus', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'timeToFirstTokenMs',
  'durationMs', 'requestUnits',
] as const
const QUOTA_KEYS = [
  'sourceEventKeyHash', 'providerId', 'accountIdHash', 'quotaKind', 'unit', 'limit', 'used',
  'remaining', 'resetAtMs', 'sourceStatus', 'projectionVersion', 'observedAtMs', 'fingerprint',
  'hashKeyVersion',
] as const
const HEALTH_KEYS = [
  'sourceEventKeyHash', 'providerId', 'accountIdHash', 'healthStatus', 'reasonCode',
  'observedAtMs', 'hashKeyVersion',
] as const

export class AnalyticsInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalyticsInputError'
  }
}

function input(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AnalyticsInputError(message)
}

function object(value: unknown, label: string): Record<string, unknown> {
  input(typeof value === 'object' && value !== null && !Array.isArray(value), `${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) input(allowed.has(key), `${label} contains an unknown field`)
  for (const key of keys) input(Object.prototype.hasOwnProperty.call(value, key), `${label}.${key} is required`)
}

function boundedString(value: unknown, label: string, max = MAX_BOUND_STRING, allowEmpty = true): string {
  input(typeof value === 'string', `${label} must be a string`)
  const result = value as string
  input(result.length <= max, `${label} is too long`)
  input(!result.includes('\u0000'), `${label} contains a forbidden character`)
  input(allowEmpty || result.length > 0, `${label} must not be empty`)
  return result
}

function hash(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null
  input(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `${label} must be a lowercase 64-hex hash`)
  return value as string
}

function safeInteger(value: unknown, label: string, nullable = false, nonNegative = true): number | null {
  if (nullable && value === null) return null
  input(typeof value === 'number' && Number.isSafeInteger(value), `${label} must be a safe integer`)
  const result = value as number
  if (nonNegative) input(result >= 0, `${label} must be non-negative`)
  return result
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  input(typeof value === 'string' && (values as readonly string[]).includes(value), `${label} is not supported`)
  return value as T
}

export function validateRequestObservation(value: unknown): RequestObservation {
  const raw = object(value, 'request observation')
  exactKeys(raw, REQUEST_KEYS, 'request observation')
  input(raw.schemaVersion === 1, 'request observation.schemaVersion is unsupported')
  const sourceKind = enumValue(raw.sourceKind, 'request observation.sourceKind', ['gateway', 'cpa_http_usage'] as const)
  const outcome = enumValue(raw.outcome, 'request observation.outcome', ['success', 'error', 'aborted'] as const)
  const errorKind = enumValue(raw.errorKind, 'request observation.errorKind', ['none', 'authentication', 'authorization', 'rate_limit', 'upstream', 'timeout', 'cancelled', 'invalid_request', 'unknown'] as const)
  const httpStatus = safeInteger(raw.httpStatus, 'request observation.httpStatus', true)
  if (httpStatus !== null) input(httpStatus >= 100 && httpStatus <= 599, 'request observation.httpStatus is outside 100..599')
  return {
    schemaVersion: 1,
    sourceKind,
    sourceEventKeyHash: hash(raw.sourceEventKeyHash, 'request observation.sourceEventKeyHash') as string,
    requestIdHash: hash(raw.requestIdHash, 'request observation.requestIdHash') as string,
    payloadFingerprint: hash(raw.payloadFingerprint, 'request observation.payloadFingerprint') as string,
    occurredAtMs: safeInteger(raw.occurredAtMs, 'request observation.occurredAtMs') as number,
    routeId: boundedString(raw.routeId, 'request observation.routeId'),
    providerId: boundedString(raw.providerId, 'request observation.providerId'),
    modelId: boundedString(raw.modelId, 'request observation.modelId'),
    accountIdHash: hash(raw.accountIdHash, 'request observation.accountIdHash', true),
    apiKeyIdHash: hash(raw.apiKeyIdHash, 'request observation.apiKeyIdHash', true),
    hashKeyVersion: safeInteger(raw.hashKeyVersion, 'request observation.hashKeyVersion') as number,
    outcome,
    errorKind,
    httpStatus,
    inputTokens: safeInteger(raw.inputTokens, 'request observation.inputTokens', true),
    outputTokens: safeInteger(raw.outputTokens, 'request observation.outputTokens', true),
    cacheReadTokens: safeInteger(raw.cacheReadTokens, 'request observation.cacheReadTokens', true),
    cacheWriteTokens: safeInteger(raw.cacheWriteTokens, 'request observation.cacheWriteTokens', true),
    reasoningTokens: safeInteger(raw.reasoningTokens, 'request observation.reasoningTokens', true),
    timeToFirstTokenMs: safeInteger(raw.timeToFirstTokenMs, 'request observation.timeToFirstTokenMs', true),
    durationMs: safeInteger(raw.durationMs, 'request observation.durationMs', true),
    requestUnits: safeInteger(raw.requestUnits, 'request observation.requestUnits') as number,
  }
}

export function validateQuotaObservation(value: unknown): QuotaObservation {
  const raw = object(value, 'quota observation')
  exactKeys(raw, QUOTA_KEYS, 'quota observation')
  input(raw.projectionVersion === 1, 'quota observation.projectionVersion is unsupported')
  const unit = enumValue(raw.unit, 'quota observation.unit', ['requests', 'tokens', 'currency', 'percent', 'unknown'] as const)
  const quotaKind = boundedString(raw.quotaKind, 'quota observation.quotaKind', MAX_BOUND_STRING, false)
  const integerValues = unit !== 'percent'
  return {
    sourceEventKeyHash: hash(raw.sourceEventKeyHash, 'quota observation.sourceEventKeyHash') as string,
    providerId: boundedString(raw.providerId, 'quota observation.providerId', MAX_BOUND_STRING, false),
    accountIdHash: hash(raw.accountIdHash, 'quota observation.accountIdHash', true),
    quotaKind,
    unit,
    limit: safeQuotaNumber(raw.limit, 'quota observation.limit', integerValues),
    used: safeQuotaNumber(raw.used, 'quota observation.used', integerValues),
    remaining: safeQuotaNumber(raw.remaining, 'quota observation.remaining', integerValues),
    resetAtMs: safeInteger(raw.resetAtMs, 'quota observation.resetAtMs', true),
    sourceStatus: enumValue(raw.sourceStatus, 'quota observation.sourceStatus', ['available', 'unavailable', 'unsupported'] as const),
    projectionVersion: 1,
    observedAtMs: safeInteger(raw.observedAtMs, 'quota observation.observedAtMs') as number,
    fingerprint: hash(raw.fingerprint, 'quota observation.fingerprint') as string,
    hashKeyVersion: safeInteger(raw.hashKeyVersion, 'quota observation.hashKeyVersion') as number,
  }
}

function safeQuotaNumber(value: unknown, label: string, integer: boolean): number | null {
  if (value === null) return null
  input(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number`)
  const result = value as number
  input(result >= 0 && result <= Number.MAX_SAFE_INTEGER, `${label} must be non-negative and safe`)
  if (integer) input(Number.isSafeInteger(result), `${label} must be a safe integer`)
  return result
}

export function validateAccountHealthObservation(value: unknown): AccountHealthObservation {
  const raw = object(value, 'account health observation')
  exactKeys(raw, HEALTH_KEYS, 'account health observation')
  return {
    sourceEventKeyHash: hash(raw.sourceEventKeyHash, 'account health observation.sourceEventKeyHash') as string,
    providerId: boundedString(raw.providerId, 'account health observation.providerId', MAX_BOUND_STRING, false),
    accountIdHash: hash(raw.accountIdHash, 'account health observation.accountIdHash', true),
    healthStatus: enumValue(raw.healthStatus, 'account health observation.healthStatus', ['healthy', 'degraded', 'unavailable', 'unsupported'] as const),
    reasonCode: boundedString(raw.reasonCode, 'account health observation.reasonCode', MAX_BOUND_STRING, false),
    observedAtMs: safeInteger(raw.observedAtMs, 'account health observation.observedAtMs') as number,
    hashKeyVersion: safeInteger(raw.hashKeyVersion, 'account health observation.hashKeyVersion') as number,
  }
}

export function validateDeadLetterObservation(value: unknown): DeadLetterObservation {
  const raw = object(value, 'dead-letter observation')
  exactKeys(raw, ['sourceKind', 'sourceEventKeyHash', 'payloadFingerprint', 'occurredAtMs', 'reasonCode', 'retryable', 'retryCount', 'nextRetryAtMs'] as const, 'dead-letter observation')
  return {
    sourceKind: enumValue(raw.sourceKind, 'dead-letter observation.sourceKind', ['cpa_http_usage', 'quota', 'account_health'] as const),
    sourceEventKeyHash: hash(raw.sourceEventKeyHash, 'dead-letter observation.sourceEventKeyHash') as string,
    payloadFingerprint: hash(raw.payloadFingerprint, 'dead-letter observation.payloadFingerprint') as string,
    occurredAtMs: safeInteger(raw.occurredAtMs, 'dead-letter observation.occurredAtMs') as number,
    reasonCode: boundedString(raw.reasonCode, 'dead-letter observation.reasonCode', MAX_BOUND_STRING, false),
    retryable: raw.retryable === true || raw.retryable === false ? raw.retryable : (() => { throw new AnalyticsInputError('dead-letter observation.retryable must be boolean') })(),
    retryCount: safeInteger(raw.retryCount, 'dead-letter observation.retryCount') as number,
    nextRetryAtMs: safeInteger(raw.nextRetryAtMs, 'dead-letter observation.nextRetryAtMs', true),
  }
}

export function validateFilters(value: AnalyticsFilters): AnalyticsFilters {
  const raw = object(value, 'analytics filters')
  const fromMs = safeInteger(raw.fromMs, 'analytics filters.fromMs') as number
  const toMs = safeInteger(raw.toMs, 'analytics filters.toMs') as number
  input(toMs >= fromMs, 'analytics filters.toMs must be >= fromMs')
  input(toMs - fromMs <= MAX_QUERY_RANGE_MS, 'analytics filters range is too large')
  const result: AnalyticsFilters = {
    fromMs,
    toMs,
  }
  for (const [key, label] of [['providerId', 'analytics filters.providerId'], ['modelId', 'analytics filters.modelId'], ['routeId', 'analytics filters.routeId']] as const) {
    if (raw[key] !== undefined) (result as unknown as Record<string, unknown>)[key] = boundedString(raw[key], label)
  }
  if (raw.accountIdHash !== undefined) (result as unknown as Record<string, unknown>).accountIdHash = hash(raw.accountIdHash, 'analytics filters.accountIdHash')
  if (raw.apiKeyIdHash !== undefined) (result as unknown as Record<string, unknown>).apiKeyIdHash = hash(raw.apiKeyIdHash, 'analytics filters.apiKeyIdHash')
  return result
}

export function validatePricingRules(rules: readonly PricingRule[]): PricingRule[] {
  input(Array.isArray(rules), 'pricing rules must be an array')
  return rules.map((value, index) => {
    const raw = object(value, `pricing rule ${index}`)
    const expected = ['snapshotVersion', 'ruleId', 'routeId', 'providerId', 'modelId', 'accountIdHash', 'apiKeyIdHash', 'currency', 'requestUnitPriceMicros', 'inputTokenPriceMicrosPerMillion', 'outputTokenPriceMicrosPerMillion', 'cacheReadTokenPriceMicrosPerMillion', 'cacheWriteTokenPriceMicrosPerMillion', 'reasoningTokenPriceMicrosPerMillion', 'effectiveFromMs', 'effectiveToMs', 'sourceName', 'sourceUrl', 'sourceVersion', 'sourceSha256', 'generatedAtMs', 'releaseVersion'] as const
    exactKeys(raw, expected, `pricing rule ${index}`)
    const dimension = (key: string): string => boundedString(raw[key], `pricing rule ${index}.${key}`, MAX_BOUND_STRING)
    const rate = (key: string): number | null => safeInteger(raw[key], `pricing rule ${index}.${key}`, true)
    const effectiveToMs = safeInteger(raw.effectiveToMs, `pricing rule ${index}.effectiveToMs`, true)
    const effectiveFromMs = safeInteger(raw.effectiveFromMs, `pricing rule ${index}.effectiveFromMs`) as number
    input(effectiveToMs === null || effectiveToMs > effectiveFromMs, `pricing rule ${index} has an invalid effective range`)
    const rates = [
      rate('requestUnitPriceMicros'), rate('inputTokenPriceMicrosPerMillion'), rate('outputTokenPriceMicrosPerMillion'),
      rate('cacheReadTokenPriceMicrosPerMillion'), rate('cacheWriteTokenPriceMicrosPerMillion'), rate('reasoningTokenPriceMicrosPerMillion'),
    ]
    for (const item of rates) input(item === null || item <= Number.MAX_SAFE_INTEGER, `pricing rule ${index} rate is unsafe`)
    const sourceSha256 = hash(raw.sourceSha256, `pricing rule ${index}.sourceSha256`) as string
    const currency = boundedString(raw.currency, `pricing rule ${index}.currency`, 3, false)
    input(/^[A-Z]{3}$/.test(currency), `pricing rule ${index}.currency is not ISO-4217`
    )
    return {
      snapshotVersion: boundedString(raw.snapshotVersion, `pricing rule ${index}.snapshotVersion`, MAX_BOUND_STRING, false),
      ruleId: boundedString(raw.ruleId, `pricing rule ${index}.ruleId`, MAX_BOUND_STRING, false),
      routeId: dimension('routeId'),
      providerId: dimension('providerId'),
      modelId: dimension('modelId'),
      accountIdHash: dimension('accountIdHash'),
      apiKeyIdHash: dimension('apiKeyIdHash'),
      currency,
      requestUnitPriceMicros: rates[0] ?? null,
      inputTokenPriceMicrosPerMillion: rates[1] ?? null,
      outputTokenPriceMicrosPerMillion: rates[2] ?? null,
      cacheReadTokenPriceMicrosPerMillion: rates[3] ?? null,
      cacheWriteTokenPriceMicrosPerMillion: rates[4] ?? null,
      reasoningTokenPriceMicrosPerMillion: rates[5] ?? null,
      effectiveFromMs,
      effectiveToMs,
      sourceName: boundedString(raw.sourceName, `pricing rule ${index}.sourceName`, MAX_BOUND_STRING, false),
      sourceUrl: boundedString(raw.sourceUrl, `pricing rule ${index}.sourceUrl`, MAX_SOURCE_URL, false),
      sourceVersion: boundedString(raw.sourceVersion, `pricing rule ${index}.sourceVersion`, MAX_BOUND_STRING, false),
      sourceSha256,
      generatedAtMs: safeInteger(raw.generatedAtMs, `pricing rule ${index}.generatedAtMs`) as number,
      releaseVersion: boundedString(raw.releaseVersion, `pricing rule ${index}.releaseVersion`, MAX_BOUND_STRING, false),
    }
  })
}

export function requestProjection(observation: RequestObservation): Record<string, unknown> {
  return { ...observation }
}

export function quotaProjection(observation: QuotaObservation): Record<string, unknown> {
  return { ...observation }
}

export function healthProjection(observation: AccountHealthObservation): Record<string, unknown> {
  return { ...observation }
}

export function projectionFingerprint(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value)
  input(encoded.length <= MAX_DEAD_LETTER_PROJECTION, 'dead-letter projection is too large')
  return createHash('sha256').update(encoded).digest('hex')
}

export function healthFingerprint(observation: AccountHealthObservation): string {
  return projectionFingerprint(healthProjection(observation))
}

export function observationKind(sourceKind: RequestObservation['sourceKind']): 'gateway_request' | 'cpa_http_usage' {
  return sourceKind === 'gateway' ? 'gateway_request' : 'cpa_http_usage'
}

export function assertRequestErrorKind(value: string): RequestErrorKind {
  return enumValue(value, 'error kind', ['none', 'authentication', 'authorization', 'rate_limit', 'upstream', 'timeout', 'cancelled', 'invalid_request', 'unknown'] as const)
}
