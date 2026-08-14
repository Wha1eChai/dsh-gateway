import { isAbsolute, join } from 'node:path'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const DEFAULT_ANALYTICS_HASH_CREDENTIAL_REF = 'DSH_GATEWAY_ANALYTICS_HASH_KEY'
export const DEFAULT_ANALYTICS_POLL_INTERVAL_MS = 5_000

export interface AnalyticsConfig {
  readonly enabled?: boolean
  readonly externalQueueOptIn?: boolean
  readonly pollIntervalMs?: number
  readonly hashCredentialRef?: string
  /** Test/advanced override; defaults below DSH_HOME and must be absolute. */
  readonly stateDir?: string
}

export interface ResolvedAnalyticsConfig {
  readonly enabled: boolean
  readonly externalQueueOptIn: boolean
  readonly pollIntervalMs: number
  readonly hashCredentialRef: string
  readonly stateDir: string
  readonly databasePath: string
}

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

export function resolveAnalyticsConfig(config: AnalyticsConfig = {}): ResolvedAnalyticsConfig {
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_ANALYTICS_POLL_INTERVAL_MS
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 60_000) {
    throw new TypeError('analytics pollIntervalMs must be an integer between 1000 and 60000')
  }
  const hashCredentialRef = config.hashCredentialRef ?? DEFAULT_ANALYTICS_HASH_CREDENTIAL_REF
  if (!CREDENTIAL_REF.test(hashCredentialRef)) throw new TypeError('analytics hashCredentialRef is invalid')
  if (config.stateDir !== undefined && !isAbsolute(config.stateDir)) {
    throw new TypeError('analytics stateDir must be absolute')
  }
  const stateDir = config.stateDir ?? join(resolveDshHome(), 'dsh-gateway', 'v1', 'analytics')
  return {
    enabled: config.enabled ?? true,
    externalQueueOptIn: config.externalQueueOptIn ?? false,
    pollIntervalMs,
    hashCredentialRef,
    stateDir,
    databasePath: join(stateDir, 'usage.sqlite3'),
  }
}
