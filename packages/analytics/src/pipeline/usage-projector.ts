import type { DeadLetterObservation, RequestErrorKind, RequestObservation } from '../contracts.js'
import { InstallationHasher } from './hashing.js'

const MAX_STRING_LENGTH = 256
const MAX_DIMENSION_LENGTH = 128
const MAX_REASONING_VALUE = Number.MAX_SAFE_INTEGER

export interface CpaUsageRecordLike {
  readonly eventId?: unknown
  readonly requestId?: unknown
  readonly timestamp?: unknown
  readonly occurredAtMs?: unknown
  readonly routeId?: unknown
  readonly provider?: unknown
  readonly model?: unknown
  readonly endpoint?: unknown
  readonly accountId?: unknown
  readonly accountIdHash?: unknown
  readonly apiKeyId?: unknown
  readonly apiKeyIdHash?: unknown
  readonly outcome?: unknown
  readonly errorKind?: unknown
  readonly httpStatus?: unknown
  readonly failed?: unknown
  readonly latencyMs?: unknown
  readonly durationMs?: unknown
  readonly timeToFirstTokenMs?: unknown
  readonly requestUnits?: unknown
  readonly tokens?: unknown
}

export type UsageDeadLetterCode =
  | 'invalid_shape'
  | 'missing_event_id'
  | 'missing_request_id'
  | 'invalid_event_id'
  | 'invalid_request_id'
  | 'invalid_timestamp'
  | 'invalid_field'

export type SanitizedUsageDeadLetter = DeadLetterObservation

export interface AcceptedUsageProjection {
  readonly disposition: 'accepted'
  readonly observation: RequestObservation
}

export interface DeadLetterUsageProjection {
  readonly disposition: 'dead_letter'
  readonly deadLetter: SanitizedUsageDeadLetter
}

export type UsageProjectionResult = AcceptedUsageProjection | DeadLetterUsageProjection

/** Project only the allowlisted, structural CPA usage shape. */
export function projectCpaUsage(
  source: unknown,
  hasher: InstallationHasher,
): UsageProjectionResult {
  const input = asRecord(source)
  if (!input) return deadLetter(hasher, {}, 'invalid_shape')

  const event = identifier(input.eventId)
  if (event.state === 'invalid') return deadLetter(hasher, safeFields(input), 'invalid_event_id')
  if (event.state === 'missing') return deadLetter(hasher, safeFields(input), 'missing_event_id')
  const request = identifier(input.requestId)
  if (request.state === 'invalid') return deadLetter(hasher, safeFields(input), 'invalid_request_id', event.value)
  if (request.state === 'missing') return deadLetter(hasher, safeFields(input), 'missing_request_id', event.value)

  const normalized = normalizeObservation(input, hasher, event.value, request.value)
  if (!normalized.ok) return deadLetter(hasher, normalized.safeFields, normalized.code, event.value, request.value)
  const payloadFingerprint = hasher.fingerprint(normalized.base)
  return {
    disposition: 'accepted',
    observation: Object.freeze({ ...normalized.base, payloadFingerprint }),
  }
}

export const projectCpaUsageRecord = projectCpaUsage
export const projectUsageRecord = projectCpaUsage

function normalizeObservation(
  input: Record<string, unknown>,
  hasher: InstallationHasher,
  eventId: string,
  requestId: string,
): { ok: true; base: Omit<RequestObservation, 'payloadFingerprint'> } | {
  ok: false
  code: UsageDeadLetterCode
  safeFields: Readonly<Record<string, unknown>>
} {
  const timestamp = readTimestamp(input)
  const provider = optionalDimension(input.provider, MAX_DIMENSION_LENGTH)
  const model = optionalDimension(input.model, MAX_DIMENSION_LENGTH)
  const route = optionalDimension(input.routeId !== undefined ? input.routeId : input.endpoint, MAX_DIMENSION_LENGTH)
  const outcome = readOutcome(input)
  const errorKind = readErrorKind(input, outcome)
  const httpStatus = readNullableInteger(input.httpStatus, 100, 599)
  const durationMs = readNullableInteger(
    input.durationMs !== undefined ? input.durationMs : input.latencyMs,
    0,
    MAX_REASONING_VALUE,
  )
  const timeToFirstTokenMs = readNullableInteger(input.timeToFirstTokenMs, 0, MAX_REASONING_VALUE)
  const requestUnits = readInteger(input.requestUnits === undefined ? 1 : input.requestUnits, 0, MAX_REASONING_VALUE)
  const tokens = readTokens(input.tokens)
  const account = readIdentifierField(input, 'accountId', 'accountIdHash')
  const apiKey = readIdentifierField(input, 'apiKeyId', 'apiKeyIdHash')
  const safeFields = makeSafeFields(input, timestamp, provider, model, route)

  if (timestamp === null) return { ok: false, code: 'invalid_timestamp', safeFields }
  if (!provider.valid || !model.valid || !route.valid || !httpStatus.valid || !durationMs.valid ||
      !timeToFirstTokenMs.valid || !requestUnits.valid || !tokens.valid || !account.valid || !apiKey.valid ||
      outcome === null) {
    return { ok: false, code: 'invalid_field', safeFields }
  }

  const base: Omit<RequestObservation, 'payloadFingerprint'> = {
    schemaVersion: 1,
    sourceKind: 'cpa_http_usage',
    sourceEventKeyHash: hasher.hash('source-event', eventId),
    requestIdHash: hasher.hash('request', requestId),
    occurredAtMs: timestamp,
    routeId: route.value,
    providerId: provider.value,
    modelId: model.value,
    accountIdHash: account.value === null ? null : hasher.hash('account', account.value),
    apiKeyIdHash: apiKey.value === null ? null : hasher.hash('api-key', apiKey.value),
    hashKeyVersion: hasher.keyVersion,
    outcome,
    errorKind,
    httpStatus: httpStatus.value,
    inputTokens: tokens.value.inputTokens,
    outputTokens: tokens.value.outputTokens,
    cacheReadTokens: tokens.value.cacheReadTokens,
    cacheWriteTokens: tokens.value.cacheWriteTokens,
    reasoningTokens: tokens.value.reasoningTokens,
    timeToFirstTokenMs: timeToFirstTokenMs.value,
    durationMs: durationMs.value,
    requestUnits: requestUnits.value as number,
  }
  return { ok: true, base }
}

function deadLetter(
  hasher: InstallationHasher,
  safeFields: Readonly<Record<string, unknown>>,
  errorCode: UsageDeadLetterCode,
  eventId?: string,
  requestId?: string,
): DeadLetterUsageProjection {
  const sanitizedProjection = Object.freeze({
    schemaVersion: 1,
    sourceKind: 'cpa_http_usage',
    ...safeFields,
    errorCode,
  })
  const payloadFingerprint = hasher.fingerprint(sanitizedProjection)
  // DeadLetterObservation has a required key even when the source event ID
  // was absent. This key is derived from the sanitized projection only; it is
  // never a timestamp/model heuristic and never contains source material.
  const sourceEventKeyHash = eventId === undefined
    ? hasher.hash('source-event', `dead-letter\0${payloadFingerprint}`)
    : hasher.hash('source-event', eventId)
  return {
    disposition: 'dead_letter',
    deadLetter: {
      sourceKind: 'cpa_http_usage',
      sourceEventKeyHash,
      payloadFingerprint,
      occurredAtMs: typeof safeFields.occurredAtMs === 'number' && safeFields.occurredAtMs >= 0
        ? safeFields.occurredAtMs
        : Date.now(),
      reasonCode: errorCode,
      retryable: false,
      retryCount: 0,
      nextRetryAtMs: null,
    },
  }
}

function safeFields(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return makeSafeFields(
    input,
    readTimestamp(input),
    optionalDimension(input.provider, MAX_DIMENSION_LENGTH),
    optionalDimension(input.model, MAX_DIMENSION_LENGTH),
    optionalDimension(input.routeId !== undefined ? input.routeId : input.endpoint, MAX_DIMENSION_LENGTH),
  )
}

function makeSafeFields(
  input: Record<string, unknown>,
  timestamp: number | null,
  provider: Dimension,
  model: Dimension,
  route: Dimension,
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    occurredAtMs: timestamp,
    routeId: route.value,
    providerId: provider.value,
    modelId: model.value,
  }
  const status = readNullableInteger(input.httpStatus, 100, 599)
  if (status.value !== null) output.httpStatus = status.value
  return Object.freeze(output)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function identifier(value: unknown): { state: 'missing' } | { state: 'invalid' } | { state: 'valid'; value: string } {
  if (value === undefined) return { state: 'missing' }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) return { state: 'invalid' }
  return { state: 'valid', value }
}

interface Dimension { readonly value: string; readonly valid: boolean }

function optionalDimension(value: unknown, max: number): Dimension {
  if (value === undefined) return { value: '', valid: true }
  if (typeof value !== 'string' || value.length > max) return { value: '', valid: false }
  return { value, valid: true }
}

function readIdentifierField(
  input: Record<string, unknown>,
  rawKey: 'accountId' | 'apiKeyId',
  hashKey: 'accountIdHash' | 'apiKeyIdHash',
): { readonly value: string | null; readonly valid: boolean } {
  const raw = input[rawKey]
  const hashed = input[hashKey]
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_STRING_LENGTH) return { value: null, valid: false }
    return { value: raw, valid: true }
  }
  if (hashed !== undefined) {
    if (typeof hashed !== 'string' || hashed.length === 0 || hashed.length > MAX_STRING_LENGTH) return { value: null, valid: false }
    return { value: hashed, valid: true }
  }
  return { value: null, valid: true }
}

function readTimestamp(input: Record<string, unknown>): number | null {
  if (input.occurredAtMs !== undefined) return readInteger(input.occurredAtMs, 0, MAX_REASONING_VALUE).value
  if (typeof input.timestamp !== 'string' || input.timestamp.length === 0 || input.timestamp.length > 128) return null
  const parsed = Date.parse(input.timestamp)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

interface NumericResult { readonly value: number | null; readonly valid: boolean }

function readNullableInteger(value: unknown, min: number, max: number): NumericResult {
  if (value === undefined || value === null) return { value: null, valid: true }
  return readInteger(value, min, max)
}

function readInteger(value: unknown, min: number, max: number): NumericResult {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return { value: null, valid: false }
  return { value: value as number, valid: true }
}

interface TokenResult {
  readonly valid: boolean
  readonly value: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly cacheReadTokens: number | null
    readonly cacheWriteTokens: number | null
    readonly reasoningTokens: number | null
  }
}

function readTokens(value: unknown): TokenResult {
  if (value === undefined || value === null) {
    return { valid: true, value: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } }
  }
  const record = asRecord(value)
  if (!record) return { valid: false, value: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } }
  const input = readToken(record.inputTokens ?? record.input_tokens)
  const output = readToken(record.outputTokens ?? record.output_tokens)
  const cached = readToken(record.cachedTokens ?? record.cached_tokens ?? record.cacheReadTokens ?? record.cache_read_tokens)
  const cacheWrite = readToken(record.cacheWriteTokens ?? record.cache_write_tokens)
  const reasoning = readToken(record.reasoningTokens ?? record.reasoning_tokens)
  return {
    valid: input.valid && output.valid && cached.valid && cacheWrite.valid && reasoning.valid,
    value: {
      inputTokens: input.value,
      outputTokens: output.value,
      cacheReadTokens: cached.value,
      cacheWriteTokens: cacheWrite.value,
      reasoningTokens: reasoning.value,
    },
  }
}

function readToken(value: unknown): NumericResult {
  return readNullableInteger(value, 0, MAX_REASONING_VALUE)
}

function readOutcome(input: Record<string, unknown>): RequestObservation['outcome'] | null {
  if (input.outcome !== undefined) {
    return input.outcome === 'success' || input.outcome === 'error' || input.outcome === 'aborted' ? input.outcome : null
  }
  if (input.failed !== undefined && typeof input.failed !== 'boolean') return null
  return input.failed === true ? 'error' : 'success'
}

function readErrorKind(input: Record<string, unknown>, outcome: RequestObservation['outcome'] | null): RequestErrorKind {
  const value = input.errorKind
  if (value === 'none' || value === 'authentication' || value === 'authorization' || value === 'rate_limit' ||
      value === 'upstream' || value === 'timeout' || value === 'cancelled' || value === 'invalid_request' || value === 'unknown') {
    return value
  }
  if (outcome === 'success') return 'none'
  if (outcome === 'aborted') return 'cancelled'
  return 'unknown'
}
