import { isAbsolute, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ANALYTICS_HASH_CREDENTIAL_REF,
  DEFAULT_ANALYTICS_POLL_INTERVAL_MS,
  resolveAnalyticsConfig,
} from './config.js'

describe('analytics config', () => {
  it('resolves the private database below DSH_HOME by default', () => {
    const config = resolveAnalyticsConfig()
    expect(config.enabled).toBe(true)
    expect(config.externalQueueOptIn).toBe(false)
    expect(config.pollIntervalMs).toBe(DEFAULT_ANALYTICS_POLL_INTERVAL_MS)
    expect(config.hashCredentialRef).toBe(DEFAULT_ANALYTICS_HASH_CREDENTIAL_REF)
    expect(isAbsolute(config.stateDir)).toBe(true)
    expect(config.databasePath).toBe(join(config.stateDir, 'usage.sqlite3'))
  })

  it('accepts bounded explicit values and rejects ambiguous paths or refs', () => {
    const stateDir = join(process.cwd(), '.staging', 'analytics-config-test')
    expect(resolveAnalyticsConfig({
      enabled: false,
      externalQueueOptIn: true,
      pollIntervalMs: 1_000,
      hashCredentialRef: 'DSH_GATEWAY_TEST_HASH_KEY',
      stateDir,
    })).toMatchObject({ enabled: false, externalQueueOptIn: true, stateDir })
    expect(() => resolveAnalyticsConfig({ stateDir: 'relative' })).toThrow(/absolute/u)
    expect(() => resolveAnalyticsConfig({ hashCredentialRef: 'not-valid' })).toThrow(/CredentialRef/u)
    expect(() => resolveAnalyticsConfig({ pollIntervalMs: 999 })).toThrow(/pollIntervalMs/u)
  })
})
