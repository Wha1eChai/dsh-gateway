import type { AccountHealthObservation, QuotaObservation } from '../contracts.js'
import { InstallationHasher } from './hashing.js'

const MAX_PROVIDER_LENGTH = 128
const MAX_REASON_LENGTH = 64
const MAX_KIND_LENGTH = 64
const MAX_UNIT_LENGTH = 32

export interface CpaAccountStatusProjectionLike {
  readonly providerId?: unknown
  readonly healthStatus?: unknown
  readonly reasonCode?: unknown
  readonly accountId?: unknown
  readonly accountIdHash?: unknown
  readonly observedAtMs?: unknown
}

export interface CpaQuotaWindowProjectionLike {
  readonly kind?: unknown
  readonly unit?: unknown
  readonly limit?: unknown
  readonly used?: unknown
  readonly remaining?: unknown
  readonly resetAtMs?: unknown
}

export interface CpaQuotaProjectionLike {
  readonly providerId?: unknown
  readonly accountId?: unknown
  readonly accountIdHash?: unknown
  readonly windows?: unknown
}

export interface ProjectorOptions {
  readonly nowMs?: number
  readonly sourceStatus?: 'unavailable' | 'unsupported'
}

export function projectAccountHealth(
  source: unknown,
  hasher: InstallationHasher,
  options: ProjectorOptions = {},
): AccountHealthObservation {
  const input = asRecord(source)
  const observedAtValue = input?.observedAtMs
  const observedAtMs = validTime(observedAtValue) ? observedAtValue as number : boundedNow(options.nowMs)
  const provider = boundedString(input?.providerId, MAX_PROVIDER_LENGTH) ?? 'unknown'
  const account = readAccountIdentifier(input)
  const accountIdHash = account === null ? null : hasher.hash('account', account)
  const sourceEventKeyHash = hasher.hash('source-event', `account-health\0${provider}\0${accountIdHash ?? ''}\0${observedAtMs}`)
  const status = normalizeHealth(input?.healthStatus, options.sourceStatus)
  const reasonCode = normalizeReason(input?.reasonCode, status)
  return Object.freeze({
    sourceEventKeyHash,
    providerId: provider,
    accountIdHash,
    healthStatus: status,
    reasonCode,
    observedAtMs,
    hashKeyVersion: hasher.keyVersion,
  })
}

export function projectAccountHealthList(
  source: unknown,
  hasher: InstallationHasher,
  options: ProjectorOptions = {},
): readonly AccountHealthObservation[] {
  if (!Array.isArray(source) || source.length === 0) return Object.freeze([projectAccountHealth({ providerId: 'unknown' }, hasher, { ...options, sourceStatus: 'unsupported' })])
  return Object.freeze(source.map((item) => projectAccountHealth(item, hasher, options)))
}

export function projectQuota(
  source: unknown,
  hasher: InstallationHasher,
  options: ProjectorOptions = {},
): readonly QuotaObservation[] {
  const input = asRecord(source)
  const provider = boundedString(input?.providerId, MAX_PROVIDER_LENGTH) ?? 'unknown'
  const account = readAccountIdentifier(input)
  const accountIdHash = account === null ? null : hasher.hash('account', account)
  const observedAtMs = boundedNow(options.nowMs)
  const windows = input?.windows
  if (!Array.isArray(windows) || windows.length === 0) {
    return Object.freeze([quotaUnavailable(hasher, provider, accountIdHash, observedAtMs, options.sourceStatus ?? 'unsupported')])
  }

  const result: QuotaObservation[] = []
  for (const item of windows) {
    const window = asRecord(item)
    const kind = boundedString(window?.kind, MAX_KIND_LENGTH)
    const unit = normalizeUnit(window?.unit)
    const limit = readQuotaNumber(window?.limit)
    const used = readQuotaNumber(window?.used)
    const remaining = readQuotaNumber(window?.remaining)
    const resetAtMs = readNullableTime(window?.resetAtMs)
    const valid = kind !== null && unit !== null && limit.valid && used.valid && remaining.valid && resetAtMs.valid
    if (!valid) {
      result.push(quotaUnavailable(hasher, provider, accountIdHash, observedAtMs, 'unsupported'))
      continue
    }
    const base = {
      sourceEventKeyHash: hasher.hash('source-event', `quota\0${provider}\0${accountIdHash ?? ''}\0${kind}\0${observedAtMs}`),
      providerId: provider,
      accountIdHash,
      quotaKind: kind,
      unit,
      limit: limit.value,
      used: used.value,
      remaining: remaining.value,
      resetAtMs: resetAtMs.value,
      sourceStatus: options.sourceStatus ?? 'available' as const,
      projectionVersion: 1 as const,
      observedAtMs,
      hashKeyVersion: hasher.keyVersion,
    }
    result.push(Object.freeze({ ...base, fingerprint: hasher.fingerprint(base) }))
  }
  return Object.freeze(result)
}

export const projectCpaAccountHealth = projectAccountHealth
export const projectCpaQuota = projectQuota

function quotaUnavailable(
  hasher: InstallationHasher,
  providerId: string,
  accountIdHash: string | null,
  observedAtMs: number,
  sourceStatus: 'unavailable' | 'unsupported',
): QuotaObservation {
  const base = {
    sourceEventKeyHash: hasher.hash('source-event', `quota\0${providerId}\0${accountIdHash ?? ''}\0unknown\0${observedAtMs}`),
    providerId,
    accountIdHash,
    quotaKind: 'unknown',
    unit: 'unknown',
    limit: null,
    used: null,
    remaining: null,
    resetAtMs: null,
    sourceStatus,
    projectionVersion: 1 as const,
    observedAtMs,
    hashKeyVersion: hasher.keyVersion,
  }
  return Object.freeze({ ...base, fingerprint: hasher.fingerprint(base) })
}

function normalizeHealth(value: unknown, sourceStatus: ProjectorOptions['sourceStatus']): AccountHealthObservation['healthStatus'] {
  if (sourceStatus === 'unavailable') return 'unavailable'
  if (sourceStatus === 'unsupported') return 'unsupported'
  if (value === 'healthy') return 'healthy'
  if (value === 'unhealthy' || value === 'degraded') return 'degraded'
  if (value === 'unavailable') return 'unavailable'
  return 'unsupported'
}

function normalizeReason(value: unknown, status: AccountHealthObservation['healthStatus']): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_REASON_LENGTH && /^[a-z0-9._-]+$/.test(value)) return value
  return status === 'healthy' ? 'ready' : status === 'unavailable' ? 'unavailable' : 'invalid_projection'
}

function readAccountIdentifier(input: Record<string, unknown> | null): string | null {
  const value = input?.accountId ?? input?.accountIdHash
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null
  return value
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function validTime(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function boundedNow(value: number | undefined): number {
  if (value !== undefined && validTime(value)) return value
  const now = Date.now()
  return Number.isSafeInteger(now) && now >= 0 ? now : 0
}

function readQuotaNumber(value: unknown): { readonly value: number | null; readonly valid: boolean } {
  if (value === null || value === undefined) return { value: null, valid: true }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value)) || value < 0) return { value: null, valid: false }
  return { value, valid: true }
}

function readNullableTime(value: unknown): { readonly value: number | null; readonly valid: boolean } {
  if (value === null || value === undefined) return { value: null, valid: true }
  return validTime(value) ? { value: value as number, valid: true } : { value: null, valid: false }
}

function normalizeUnit(value: unknown): QuotaObservation['unit'] | null {
  if (value === 'requests' || value === 'tokens' || value === 'currency' || value === 'percent' || value === 'unknown') return value
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_UNIT_LENGTH && /^[a-z0-9._-]+$/.test(value)) return value
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
