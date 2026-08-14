import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GatewayAnalyticsAccountView, GatewayAnalyticsQuotaView, GatewayAnalyticsStatusView } from '../../host/contracts.js'

import type { GatewayViewProps } from '../view-types.js'
import { remoteValue } from '../view-types.js'
import styles from './AccountsView.module.css'

interface AccountsData {
  readonly status: GatewayAnalyticsStatusView
  readonly accounts: readonly GatewayAnalyticsAccountView[]
  readonly quota: readonly GatewayAnalyticsQuotaView[]
}

function range(): { fromMs: number; toMs: number } {
  const toMs = Date.now()
  return { fromMs: toMs - 30 * 24 * 60 * 60 * 1_000, toMs }
}

function healthState(value: GatewayAnalyticsAccountView['healthStatus']): 'done' | 'warning' | 'ongoing' | 'error' {
  switch (value) {
    case 'healthy': return 'done'
    case 'degraded': return 'warning'
    case 'unsupported': return 'ongoing'
    case 'unavailable': return 'error'
  }
}

function accountStatus(value: GatewayAnalyticsAccountView['healthStatus'], t: GatewayViewProps['t']): string {
  switch (value) {
    case 'healthy': return t('healthy')
    case 'degraded': return t('accountDegraded')
    case 'unavailable': return t('accountUnavailable')
    case 'unsupported': return t('unsupported')
  }
}

function quotaValue(value: number | null, unit: GatewayAnalyticsQuotaView['unit'], t: GatewayViewProps['t']): string {
  if (value === null) return '—'
  if (unit === 'percent') return `${value}%`
  if (unit === 'currency') return value.toFixed(2)
  if (unit === 'tokens') return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  return `${value} ${unit === 'requests' ? t('requestsUnit') : unit === 'unknown' ? t('unknownUnit') : ''}`.trim()
}

function accountLabel(accountIdHash: string | null): string {
  return accountIdHash === null ? '—' : `#${accountIdHash.slice(0, 10)}`
}

export function AccountsView({ remote, t }: GatewayViewProps): ReactNode {
  const [data, setData] = useState<AccountsData | undefined>()
  const [offline, setOffline] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const filters = range()
        const [statusResult, accountsResult, quotaResult] = await Promise.all([
          remote.analyticsStatus(),
          remote.analyticsAccounts(filters),
          remote.analyticsQuota(filters),
        ])
        if (controller.signal.aborted) return
        const status = remoteValue(statusResult)
        const accounts = remoteValue(accountsResult)
        const quota = remoteValue(quotaResult)
        if (status === undefined || accounts === undefined || quota === undefined) {
          setOffline(true)
          return
        }
        setOffline(false)
        setData({ status, accounts, quota })
      } catch {
        if (!controller.signal.aborted) setOffline(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [refreshToken, remote])

  return (
    <section className={styles.page} aria-labelledby="gateway-accounts-title">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>{t('accounts')}</p>
          <h2 id="gateway-accounts-title" className={styles.title}>{t('accountHealth')}</h2>
          <p className={styles.subtitle}>{t('noAnalytics')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setRefreshToken((value) => value + 1)}>{t('refresh')}</Button>
      </div>

      {data === undefined && !offline && <p className={styles.state}>{t('loading')}</p>}
      {offline && (
        <div className={styles.stateBlock} role="status">
          <p>{t('offline')}</p>
          <Button size="sm" variant="outline" onClick={() => setRefreshToken((value) => value + 1)}>{t('retry')}</Button>
        </div>
      )}

      {data !== undefined && !offline && (
        <>
          <div className={styles.summary}>
            <span className={styles.statusDot}><StateDot state={data.status.availability === 'ready' ? 'done' : data.status.availability === 'degraded' ? 'warning' : 'error'} />{data.status.availability}</span>
            <span>{t('queueCompleteness')}: {data.status.queueCompleteness}</span>
          </div>
          <div className={styles.columns}>
            <section className={styles.card} aria-labelledby="gateway-account-health-heading">
              <div className={styles.cardHeading}>
                <h3 id="gateway-account-health-heading">{t('accountHealth')}</h3>
                <span>{data.accounts.length}</span>
              </div>
              {data.accounts.length === 0 ? <p className={styles.state}>{t('empty')}</p> : (
                <div className={styles.rows}>
                  {data.accounts.map((account) => (
                    <div className={styles.row} key={`${account.providerId}:${account.accountIdHash ?? 'unknown'}`}>
                      <span className={styles.stateDot}><StateDot state={healthState(account.healthStatus)} /></span>
                      <span className={styles.primary}>{account.providerId} · {accountLabel(account.accountIdHash)}</span>
                      <span className={styles.secondary}>{accountStatus(account.healthStatus, t)} · {account.reasonCode}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className={styles.card} aria-labelledby="gateway-quota-heading">
              <div className={styles.cardHeading}>
                <h3 id="gateway-quota-heading">{t('quota')}</h3>
                <span>{data.quota.length}</span>
              </div>
              {data.quota.length === 0 ? <p className={styles.state}>{t('empty')}</p> : (
                <div className={styles.rows}>
                  {data.quota.map((item) => (
                    <div className={styles.quotaRow} key={`${item.providerId}:${item.accountIdHash ?? 'unknown'}:${item.quotaKind}`}>
                      <div className={styles.quotaTopline}>
                        <span className={styles.primary}>{item.providerId} · {item.quotaKind}</span>
                        <span className={styles.secondary}>{accountLabel(item.accountIdHash)}</span>
                      </div>
                      <div className={styles.quotaValues}>
                        <span>{t('remaining')}: <strong>{quotaValue(item.remaining, item.unit, t)}</strong></span>
                        <span>{t('used')}: {quotaValue(item.used, item.unit, t)}</span>
                        <span>{t('limit')}: {quotaValue(item.limit, item.unit, t)}</span>
                      </div>
                      <span className={styles.secondary}>{item.sourceStatus === 'available' ? `${t('observedAt')}: ${new Date(item.observedAtMs).toLocaleString()}` : accountStatus(item.sourceStatus === 'unsupported' ? 'unsupported' : 'unavailable', t)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  )
}
