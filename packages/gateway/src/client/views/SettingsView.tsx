import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GatewayOAuthStatus, GatewayRuntimeState, GatewayRuntimeView, GatewayStatusView } from '../../host/contracts.js'

import type { GatewayViewProps } from '../view-types.js'
import { errorCode, remoteErrorCode, remoteValue } from '../view-types.js'
import styles from './SettingsView.module.css'

type RuntimeAction = 'install' | 'start' | 'stop' | 'restart'

function runtimeState(value: GatewayRuntimeState): 'done' | 'warning' | 'ongoing' | 'error' {
  if (value === 'ready') return 'done'
  if (value === 'starting' || value === 'stopping') return 'ongoing'
  if (value === 'degraded') return 'warning'
  return value === 'failed' || value === 'unavailable' ? 'error' : 'warning'
}

function runtimeLabel(value: GatewayRuntimeState, t: GatewayViewProps['t']): string {
  switch (value) {
    case 'disabled': return t('disabled')
    case 'stopped': return t('stopped')
    case 'starting': return t('starting')
    case 'ready': return t('ready')
    case 'degraded': return t('degraded')
    case 'stopping': return t('stopping')
    case 'failed': return t('failedState')
    case 'unavailable': return t('unavailableState')
  }
}

function oauthLabel(status: GatewayOAuthStatus, t: GatewayViewProps['t']): string {
  switch (status.state) {
    case 'starting': return t('oauthStarting')
    case 'pending': return t('oauthPending')
    case 'success': return t('oauthSuccess')
    case 'denied': return t('oauthDenied')
    case 'expired': return t('oauthExpired')
    case 'cancelled': return t('oauthCancelled')
    case 'timed_out': return t('oauthTimedOut')
    case 'failed': return t('oauthFailed')
  }
}

function terminalOAuth(status: GatewayOAuthStatus): boolean {
  return ['success', 'denied', 'expired', 'cancelled', 'timed_out', 'failed'].includes(status.state)
}

export function SettingsView({ remote, t }: GatewayViewProps): ReactNode {
  const [status, setStatus] = useState<GatewayStatusView | undefined>()
  const [runtime, setRuntime] = useState<GatewayRuntimeView | undefined>()
  const [oauth, setOauth] = useState<GatewayOAuthStatus | undefined>()
  const [busy, setBusy] = useState<RuntimeAction | 'oauth' | 'cancel' | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const result = await remote.status()
        if (controller.signal.aborted) return
        const value = remoteValue(result)
        if (value === undefined) {
          setMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
          return
        }
        setStatus(value)
        setRuntime(value.runtime)
        setMessage(undefined)
      } catch (error) {
        if (!controller.signal.aborted) setMessage(`${t('failed')}: ${errorCode(error)}`)
      }
    }
    void load()
    return () => controller.abort()
  }, [refreshToken, remote, t])

  useEffect(() => {
    if (oauth === undefined || terminalOAuth(oauth)) return
    const controller = new AbortController()
    let timer: ReturnType<typeof window.setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await remote.oauthDeviceStatus({ operationId: oauth.operationId })
        if (controller.signal.aborted) return
        const value = remoteValue(result)
        if (value === undefined) {
          setMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
          return
        }
        setOauth(value)
        if (!terminalOAuth(value)) {
          timer = window.setTimeout(() => { void poll() }, Math.max(1_000, Math.min(value.pollIntervalMs ?? 5_000, 10_000)))
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessage(`${t('failed')}: ${errorCode(error)}`)
      }
    }
    timer = window.setTimeout(() => { void poll() }, Math.max(1_000, Math.min(oauth.pollIntervalMs ?? 5_000, 10_000)))
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [oauth, remote, t])

  const refresh = (): void => setRefreshToken((value) => value + 1)

  const runtimeAction = async (action: RuntimeAction): Promise<void> => {
    if (busy !== undefined) return
    setBusy(action)
    setMessage(undefined)
    try {
      const result = action === 'install'
        ? await remote.runtimeInstall()
        : action === 'start'
          ? await remote.runtimeStart()
          : action === 'stop'
            ? await remote.runtimeStop()
            : await remote.runtimeRestart()
      const value = remoteValue(result)
      if (value === undefined) {
        setMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
      } else {
        setRuntime(value)
        setStatus((current) => current === undefined ? current : { ...current, runtime: value })
      }
    } catch (error) {
      setMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      setBusy(undefined)
    }
  }

  const oauthStart = async (): Promise<void> => {
    if (busy !== undefined) return
    setBusy('oauth')
    setMessage(undefined)
    try {
      const result = await remote.oauthDeviceStart()
      const value = remoteValue(result)
      if (value === undefined) setMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
      else setOauth(value)
    } catch (error) {
      setMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      setBusy(undefined)
    }
  }

  const oauthCancel = async (): Promise<void> => {
    if (oauth === undefined || busy !== undefined) return
    setBusy('cancel')
    try {
      const result = await remote.oauthDeviceCancel({ operationId: oauth.operationId })
      const value = remoteValue(result)
      if (value === undefined) setMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
      else setOauth(value)
    } catch (error) {
      setMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className={styles.page} aria-labelledby="gateway-settings-title">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>{t('settings')}</p>
          <h2 id="gateway-settings-title" className={styles.title}>{t('settings')}</h2>
          <p className={styles.subtitle}>{t('modelApplyHint')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh}>{t('refresh')}</Button>
      </div>

      {message !== undefined && <p className={styles.notice} role="status">{message}</p>}
      {status === undefined && message === undefined && <p className={styles.state}>{t('loading')}</p>}

      {status !== undefined && runtime !== undefined && (
        <>
          <section className={styles.card} aria-labelledby="gateway-runtime-heading">
            <div className={styles.cardHeading}>
              <div>
                <h3 id="gateway-runtime-heading">{t('runtime')}</h3>
                <p>{runtime.endpoint ?? t('notConfigured')}</p>
              </div>
              <span className={styles.statePill}><StateDot state={runtimeState(runtime.state)} />{runtimeLabel(runtime.state, t)}</span>
            </div>
            <div className={styles.facts}>
              <span>{t('mode')}: {runtime.mode === 'managed' ? t('managed') : runtime.mode === 'external' ? t('external') : t('notConfigured')}</span>
              <span>{runtime.version ?? t('notConfigured')}</span>
            </div>
            <div className={styles.actions}>
              <Button size="sm" variant="outline" onClick={() => void runtimeAction('install')} disabled={busy !== undefined}>{busy === 'install' ? t('refreshing') : t('install')}</Button>
              <Button size="sm" variant="primary" onClick={() => void runtimeAction('start')} disabled={busy !== undefined || runtime.state === 'ready'}>{busy === 'start' ? t('refreshing') : t('start')}</Button>
              <Button size="sm" variant="outline" onClick={() => void runtimeAction('restart')} disabled={busy !== undefined || runtime.state === 'unavailable'}>{busy === 'restart' ? t('refreshing') : t('restart')}</Button>
              <Button size="sm" variant="ghost" onClick={() => void runtimeAction('stop')} disabled={busy !== undefined || runtime.state === 'stopped' || runtime.state === 'unavailable'}>{busy === 'stop' ? t('refreshing') : t('stop')}</Button>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="gateway-credentials-heading">
            <div className={styles.cardHeading}>
              <div>
                <h3 id="gateway-credentials-heading">{t('credentials')}</h3>
                <p>{t('callbackUnavailable')}</p>
              </div>
            </div>
            <div className={styles.credentialGrid}>
              <Credential label={t('proxyCredential')} configured={status.proxyCredential.configured} t={t} />
              <Credential label={t('managementCredential')} configured={status.managementCredential.configured} t={t} />
              <div className={styles.credential}>
                <span>{t('callback')}</span>
                <strong>{status.localCallbackAvailable ? t('configured') : t('callbackUnavailable')}</strong>
              </div>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="gateway-oauth-heading">
            <div className={styles.cardHeading}>
              <div>
                <h3 id="gateway-oauth-heading">{t('oauth')}</h3>
                <p>{oauth === undefined ? t('oauthStart') : oauthLabel(oauth, t)}</p>
              </div>
              {oauth !== undefined && <span className={styles.statePill}><StateDot state={terminalOAuth(oauth) ? oauth.state === 'success' ? 'done' : 'error' : 'ongoing'} />{oauthLabel(oauth, t)}</span>}
            </div>
            {oauth !== undefined && oauth.verificationUri !== undefined && (
              <div className={styles.oauthDetails}>
                <a href={oauth.verificationUri} target="_blank" rel="noreferrer">{oauth.verificationUri}</a>
                {oauth.userCode !== undefined && <code>{oauth.userCode}</code>}
                <span>{t('copyCode')}</span>
              </div>
            )}
            <div className={styles.actions}>
              <Button size="sm" variant="primary" onClick={() => void oauthStart()} disabled={busy !== undefined || (oauth !== undefined && !terminalOAuth(oauth))}>{busy === 'oauth' ? t('oauthStarting') : t('oauthStart')}</Button>
              {oauth !== undefined && !terminalOAuth(oauth) && <Button size="sm" variant="ghost" onClick={() => void oauthCancel()} disabled={busy !== undefined}>{busy === 'cancel' ? t('refreshing') : t('cancel')}</Button>}
            </div>
          </section>
        </>
      )}
    </section>
  )
}

function Credential({ label, configured, t }: { label: string; configured: boolean; t: GatewayViewProps['t'] }): ReactNode {
  return (
    <div className={styles.credential}>
      <span>{label}</span>
      <strong>{configured ? t('configured') : t('notConfiguredCredential')}</strong>
    </div>
  )
}
