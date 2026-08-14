import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { GatewayStatusView } from '@wha1echai/dsh-gateway/contracts'
import type { WebpageAppSlotProps } from '@wha1echai/dsh-webpage/client'

import type {} from './locales.js'
import styles from './GatewayApp.module.css'

interface GatewayAppProps extends WebpageAppSlotProps, PropsLocale<'gateway'> {
  loadStatus(): Promise<RemoteResult<GatewayStatusView>>
}

/** Minimal addressable surface used until the Phase 5 dashboard replaces it. */
export function GatewayApp({ close, loadStatus, t }: GatewayAppProps): ReactNode {
  const [status, setStatus] = useState<GatewayStatusView | null | undefined>()

  useEffect(() => {
    let active = true
    void loadStatus().then((result) => {
      if (active) setStatus(result.ok ? result.value : null)
    }, () => {
      if (active) setStatus(null)
    })
    return () => { active = false }
  }, [loadStatus])

  return (
    <article className={styles.page} data-gateway-app="foundation">
      <header className={styles.hero}>
        <span className={styles.eyebrow}>{t('foundation')}</span>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.description}>{t('description')}</p>
      </header>

      <section className={styles.status} aria-live="polite">
        {status === undefined && <p className={styles.muted}>{t('loading')}</p>}
        {status === null && <p className={styles.muted}>{t('unavailable')}</p>}
        {status && (
          <dl className={styles.grid}>
            <div><dt>{t('runtime')}</dt><dd>{status.runtime.state}</dd></div>
            <div><dt>{t('mode')}</dt><dd>{status.runtime.mode === 'managed' ? t('managed') : status.runtime.mode === 'external' ? t('external') : t('notConfigured')}</dd></div>
            <div><dt>{t('endpoint')}</dt><dd>{status.runtime.endpoint ?? t('notConfigured')}</dd></div>
          </dl>
        )}
      </section>

      <button type="button" className={styles.button} onClick={() => close()}>{t('close')}</button>
    </article>
  )
}
