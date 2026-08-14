import { createHash, createHmac } from 'node:crypto'

import type { InstallationHasherLike } from '../contracts.js'

export type HashNamespace = 'request' | 'account' | 'api-key' | 'source-event'

const MAX_IDENTIFIER_LENGTH = 512

/**
 * Installation-scoped irreversible identifiers. The key is copied into this
 * object and is never returned, serialized, or included in fingerprints.
 */
export class InstallationHasher implements InstallationHasherLike {
  readonly keyVersion: number

  private readonly key: Uint8Array
  private readonly targetIdentity: string

  constructor(key: Uint8Array, keyVersion: number, targetIdentity = '') {
    if (!(key instanceof Uint8Array) || key.byteLength === 0 || key.byteLength > 1024) {
      throw new RangeError('installation key must contain 1 to 1024 bytes')
    }
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw new RangeError('hash key version must be a positive safe integer')
    }
    if (targetIdentity.length > MAX_IDENTIFIER_LENGTH) {
      throw new RangeError('target identity is too long')
    }
    this.key = new Uint8Array(key)
    this.keyVersion = keyVersion
    this.targetIdentity = targetIdentity
  }

  hash(namespace: HashNamespace, canonicalIdentifier: string): string {
    if (canonicalIdentifier.length === 0 || canonicalIdentifier.length > MAX_IDENTIFIER_LENGTH) {
      throw new RangeError('canonical identifier is empty or too long')
    }
    const targetQualifiedIdentifier = this.targetIdentity.length === 0
      ? canonicalIdentifier
      : `${this.targetIdentity}\0${canonicalIdentifier}`
    return createHmac('sha256', this.key)
      .update(`${namespace}\0${targetQualifiedIdentifier}`, 'utf8')
      .digest('hex')
  }

  fingerprint(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
  }
}

/** Stable JSON used for payload fingerprints; object key order is ignored. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>())
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('fingerprint cannot contain a non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`)
  if (typeof value !== 'object') return JSON.stringify(String(value))
  if (seen.has(value)) throw new TypeError('fingerprint cannot contain a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, seen)).join(',')}]`
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}
