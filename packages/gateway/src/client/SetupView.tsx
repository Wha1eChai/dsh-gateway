import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  GatewayModelView,
  GatewayOAuthStatus,
  GatewayProbeResult,
  GatewayRuntimeView,
  GatewayStatusView,
} from '../host/contracts.js'

import type { GatewayInteractiveViewProps } from './view-types.js'
import { errorCode, remoteErrorCode, remoteValue } from './view-types.js'
import styles from './SetupView.module.css'

type SetupStep = 'runtime' | 'login' | 'models' | 'probe' | 'complete'
type SetupPhase = 'loading' | 'ready' | 'error'
type BusyAction = 'install' | 'start' | 'login' | 'cancel' | 'discover' | 'apply' | 'probe'
type ProbeState = 'idle' | 'running' | 'success' | 'error' | 'cancelled'

const TERMINAL_OAUTH_STATES: readonly GatewayOAuthStatus['state'][] = [
  'success',
  'denied',
  'expired',
  'cancelled',
  'timed_out',
  'failed',
]

function terminalOAuth(status: GatewayOAuthStatus): boolean {
  return TERMINAL_OAUTH_STATES.includes(status.state)
}

function runtimeLabel(value: GatewayRuntimeView['state'], t: GatewayInteractiveViewProps['t']): string {
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

function oauthLabel(status: GatewayOAuthStatus, t: GatewayInteractiveViewProps['t']): string {
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

function failureMessage<T>(result: { readonly ok: boolean; readonly error?: { readonly code: string } }, t: GatewayInteractiveViewProps['t']): string {
  const code = result.ok ? 'REMOTE_UNAVAILABLE' : result.error?.code ?? 'REMOTE_UNAVAILABLE'
  if (code === 'port_occupied') return t('setupPortOccupied')
  if (code === 'credential_not_writable' || code === 'credential_validation_failed') return t('setupCredentialUnavailable')
  return `${t('failed')}: ${code}`
}

function runtimeDotState(runtime: GatewayRuntimeView | undefined): 'done' | 'warning' | 'ongoing' | 'error' {
  if (runtime?.state === 'ready') return 'done'
  if (runtime?.state === 'starting' || runtime?.state === 'stopping') return 'ongoing'
  if (runtime?.state === 'failed' || runtime?.state === 'unavailable') return 'error'
  return 'warning'
}

/** Compact first-run path. Every completed state below comes from a successful Host Remote result. */
export function SetupView({ remote, t, navigate }: GatewayInteractiveViewProps): ReactNode {
  const [status, setStatus] = useState<GatewayStatusView | undefined>()
  const [runtime, setRuntime] = useState<GatewayRuntimeView | undefined>()
  const [statusPhase, setStatusPhase] = useState<SetupPhase>('loading')
  const [statusMessage, setStatusMessage] = useState<string | undefined>()
  const [oauth, setOauth] = useState<GatewayOAuthStatus | undefined>()
  const [models, setModels] = useState<readonly GatewayModelView[]>([])
  const [modelsPhase, setModelsPhase] = useState<SetupPhase>('ready')
  const [modelsRevision, setModelsRevision] = useState<number | undefined>()
  const [modelsApplied, setModelsApplied] = useState(false)
  const [modelsMessage, setModelsMessage] = useState<string | undefined>()
  const [selectedModel, setSelectedModel] = useState('')
  const [prompt, setPrompt] = useState(t('setupProbeDefaultPrompt'))
  const [probeState, setProbeState] = useState<ProbeState>('idle')
  const [probeResult, setProbeResult] = useState<GatewayProbeResult | undefined>()
  const [probeMessage, setProbeMessage] = useState<string | undefined>()
  const [busy, setBusy] = useState<BusyAction | undefined>()

  const mounted = useRef(true)
  const statusGeneration = useRef(0)
  const modelsGeneration = useRef(0)
  const modelsController = useRef<AbortController | undefined>()
  const probeGeneration = useRef(0)
  const probeController = useRef<AbortController | undefined>()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      modelsController.current?.abort()
      probeGeneration.current += 1
      probeController.current?.abort()
    }
  }, [])

  const loadStatus = useCallback(async (): Promise<void> => {
    const generation = statusGeneration.current + 1
    statusGeneration.current = generation
    setStatusPhase('loading')
    setStatusMessage(undefined)
    try {
      const result = await remote.status()
      if (!mounted.current || generation !== statusGeneration.current) return
      const value = remoteValue(result)
      if (value === undefined) {
        setStatusPhase('error')
        setStatusMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
        return
      }
      setStatus(value)
      setRuntime(value.runtime)
      setStatusPhase('ready')
    } catch (error) {
      if (!mounted.current || generation !== statusGeneration.current) return
      setStatusPhase('error')
      setStatusMessage(`${t('failed')}: ${errorCode(error)}`)
    }
  }, [remote, t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (oauth === undefined || terminalOAuth(oauth)) return
    let active = true
    let timer: ReturnType<typeof window.setTimeout> | undefined

    const delay = (value: GatewayOAuthStatus): number => Math.max(1_000, Math.min(value.pollIntervalMs ?? 5_000, 10_000))
    const schedule = (value: GatewayOAuthStatus): void => {
      if (!active || !mounted.current) return
      timer = window.setTimeout(() => { void poll() }, delay(value))
    }
    const poll = async (): Promise<void> => {
      if (!active || !mounted.current) return
      try {
        const result = await remote.oauthDeviceStatus({ operationId: oauth.operationId })
        if (!active || !mounted.current) return
        const value = remoteValue(result)
        if (value === undefined) {
          active = false
          setStatusMessage(`${t('failed')}: ${remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'}`)
          return
        }
        setOauth(value)
        if (!terminalOAuth(value)) schedule(value)
      } catch (error) {
        if (!active || !mounted.current) return
        active = false
        setStatusMessage(`${t('failed')}: ${errorCode(error)}`)
      }
    }

    schedule(oauth)
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [oauth, remote, t])

  useEffect(() => {
    const currentModels = models
    if (currentModels.length === 0) {
      setSelectedModel('')
      return
    }
    setSelectedModel((current) => currentModels.some((model) => model.id === current) ? current : (currentModels[0]?.id ?? ''))
  }, [models])

  const runtimeReady = runtime?.state === 'ready'
  const loginReady = status?.codexAccount === 'connected' || oauth?.state === 'success'

  if (statusPhase === 'ready' && runtimeReady && status?.codexAccount === 'connected'
    && status.cpaProviderConfigured && oauth === undefined && models.length === 0 && probeState === 'idle') {
    return (
      <section className={styles.configured} aria-labelledby="gateway-setup-configured-title" data-gateway-setup="configured">
        <div className={styles.completeHeading}>
          <StateDot state="done" />
          <div>
            <p className={styles.panelEyebrow}>{t('setupEyebrow')}</p>
            <h2 id="gateway-setup-configured-title">{t('setupConfiguredTitle')}</h2>
            <p>{t('setupConfiguredDescription')}</p>
          </div>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="primary" onClick={() => navigate('/playground')}>{t('setupContinue')}</Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}>{t('setupAdvanced')}</Button>
        </div>
      </section>
    )
  }

  const activeStep: SetupStep = probeState === 'success'
    ? 'complete'
    : !runtimeReady
      ? 'runtime'
      : !loginReady
        ? 'login'
        : !modelsApplied
          ? 'models'
          : 'probe'

  const runtimeAction = async (action: 'install' | 'start'): Promise<void> => {
    if (busy !== undefined) return
    setBusy(action)
    setStatusMessage(undefined)
    try {
      const result = action === 'install' ? await remote.runtimeInstall() : await remote.runtimeStart()
      if (!mounted.current) return
      const value = remoteValue(result)
      if (value === undefined) {
        setStatusMessage(failureMessage(result, t))
        return
      }
      setRuntime(value)
      setStatus((current) => current === undefined ? current : { ...current, runtime: value })
      if (action === 'start') void loadStatus()
    } catch (error) {
      if (mounted.current) setStatusMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const startLogin = async (): Promise<void> => {
    if (busy !== undefined || !runtimeReady) return
    setBusy('login')
    setStatusMessage(undefined)
    try {
      const result = await remote.oauthDeviceStart()
      if (!mounted.current) return
      const value = remoteValue(result)
      if (value === undefined) {
        setStatusMessage(failureMessage(result, t))
        return
      }
      setOauth(value)
      if (value.state === 'success') void loadStatus()
    } catch (error) {
      if (mounted.current) setStatusMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const cancelLogin = async (): Promise<void> => {
    if (oauth === undefined || busy !== undefined || terminalOAuth(oauth)) return
    setBusy('cancel')
    setStatusMessage(undefined)
    try {
      const result = await remote.oauthDeviceCancel({ operationId: oauth.operationId })
      if (!mounted.current) return
      const value = remoteValue(result)
      if (value === undefined) setStatusMessage(failureMessage(result, t))
      else setOauth(value)
    } catch (error) {
      if (mounted.current) setStatusMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const discoverModels = async (): Promise<void> => {
    if (busy !== undefined) return
    modelsController.current?.abort()
    const controller = new AbortController()
    const generation = modelsGeneration.current + 1
    modelsGeneration.current = generation
    modelsController.current = controller
    setBusy('discover')
    setModelsPhase('loading')
    setModelsMessage(undefined)
    setModelsApplied(false)
    try {
      const result = await remote.models(controller.signal)
      if (!mounted.current || controller.signal.aborted || generation !== modelsGeneration.current) return
      const value = remoteValue(result)
      if (value === undefined) {
        setModelsPhase('error')
        setModelsMessage(failureMessage(result, t))
        return
      }
      setModels(value.models.map((model) => ({ ...model })))
      setModelsRevision(value.settingsRevision)
      setModelsPhase('ready')
      if (value.models.length === 0) setModelsMessage(t('setupNoModels'))
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || generation !== modelsGeneration.current) return
      setModelsPhase('error')
      setModelsMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      if (mounted.current && generation === modelsGeneration.current) {
        modelsController.current = undefined
        setBusy(undefined)
      }
    }
  }

  const applyModels = async (): Promise<void> => {
    if (busy !== undefined || modelsRevision === undefined || models.length === 0) return
    setBusy('apply')
    setModelsMessage(undefined)
    try {
      const result = await remote.applyModels({ models, expectedRevision: modelsRevision })
      if (!mounted.current) return
      const value = remoteValue(result)
      if (value === undefined) {
        setModelsMessage(failureMessage(result, t))
        if (remoteErrorCode(result) === 'settings_conflict') setModelsPhase('error')
        return
      }
      setModelsRevision(value.settingsRevision)
      setModelsApplied(true)
      setModelsMessage(t('setupModelsApplied'))
    } catch (error) {
      if (mounted.current) setModelsMessage(`${t('failed')}: ${errorCode(error)}`)
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const cancelProbe = (): void => {
    if (probeState !== 'running') return
    probeGeneration.current += 1
    probeController.current?.abort()
    probeController.current = undefined
    setProbeState('cancelled')
    setProbeResult(undefined)
    setProbeMessage(t('cancelled'))
    setBusy(undefined)
  }

  const runProbe = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy !== undefined || probeState === 'running') return
    if (selectedModel.length === 0) {
      setProbeState('error')
      setProbeMessage(t('setupNoModels'))
      return
    }
    if (prompt.trim().length === 0) {
      setProbeState('error')
      setProbeMessage(t('invalidPrompt'))
      return
    }

    const generation = probeGeneration.current + 1
    probeGeneration.current = generation
    const controller = new AbortController()
    probeController.current = controller
    setBusy('probe')
    setProbeState('running')
    setProbeResult(undefined)
    setProbeMessage(undefined)

    void remote.probe({ model: selectedModel, prompt }, controller.signal).then((response) => {
      if (!mounted.current || controller.signal.aborted || generation !== probeGeneration.current) return
      const value = remoteValue(response)
      if (value === undefined) {
        setProbeState('error')
        setProbeMessage(failureMessage(response, t))
        return
      }
      setProbeResult(value)
      if (value.ok) {
        setProbeState('success')
        setProbeMessage(undefined)
      } else {
        setProbeState('error')
        setProbeMessage(`${t('failed')}: ${value.error.code}`)
      }
    }, (error: unknown) => {
      if (!mounted.current || controller.signal.aborted || generation !== probeGeneration.current) return
      setProbeState('error')
      setProbeMessage(`${t('failed')}: ${errorCode(error)}`)
    }).finally(() => {
      if (mounted.current && generation === probeGeneration.current) {
        probeController.current = undefined
        setBusy(undefined)
      }
    })
  }

  const runtimeError = activeStep === 'runtime' && statusPhase === 'error'
  const loginError = activeStep === 'login' && oauth !== undefined && terminalOAuth(oauth) && oauth.state !== 'success'
  const modelsError = activeStep === 'models' && modelsPhase === 'error'
  const probeError = activeStep === 'probe' && probeState === 'error'
  const stepState = (step: Exclude<SetupStep, 'complete'>): 'done' | 'warning' | 'ongoing' | 'error' => {
    const order: readonly Exclude<SetupStep, 'complete'>[] = ['runtime', 'login', 'models', 'probe']
    const currentIndex = order.indexOf(activeStep === 'complete' ? 'probe' : activeStep)
    const stepIndex = order.indexOf(step)
    if (stepIndex < currentIndex) return 'done'
    if (stepIndex > currentIndex) return 'warning'
    if (step === 'runtime' && runtimeError) return 'error'
    if (step === 'login' && loginError) return 'error'
    if (step === 'models' && modelsError) return 'error'
    if (step === 'probe' && probeError) return 'error'
    return 'ongoing'
  }

  return (
    <section className={styles.page} aria-labelledby="gateway-setup-title" data-gateway-setup="first-run">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>{t('setupEyebrow')}</p>
          <h2 id="gateway-setup-title" className={styles.title}>{t('setupTitle')}</h2>
          <p className={styles.subtitle}>{t('setupDescription')}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}>{t('setupAdvanced')}</Button>
      </div>

      <ol className={styles.steps} aria-label={t('setupTitle')}>
        <SetupStepItem number="1" label={t('setupStepRuntime')} state={stepState('runtime')} />
        <SetupStepItem number="2" label={t('setupStepLogin')} state={stepState('login')} />
        <SetupStepItem number="3" label={t('setupStepModels')} state={stepState('models')} />
        <SetupStepItem number="4" label={t('setupStepProbe')} state={stepState('probe')} />
      </ol>

      {statusMessage !== undefined && <p className={styles.notice} role="alert">{statusMessage}</p>}

      {activeStep === 'runtime' && (
        <section className={styles.panel} aria-labelledby="gateway-setup-runtime-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelEyebrow}>{t('setupStepRuntime')}</p>
              <h3 id="gateway-setup-runtime-title">{t('setupRuntimeTitle')}</h3>
              <p>{t('setupRuntimeDescription')}</p>
            </div>
            {runtime !== undefined && <span className={styles.statePill}><StateDot state={runtimeDotState(runtime)} />{runtimeLabel(runtime.state, t)}</span>}
          </div>
          {statusPhase === 'loading' && runtime === undefined && <p className={styles.state}>{t('loading')}</p>}
          {runtime !== undefined && (
            <>
              <div className={styles.facts}>
                <span>{t('mode')}: {runtime.mode === 'managed' ? t('managed') : runtime.mode === 'external' ? t('external') : t('notConfigured')}</span>
                <span>{runtime.endpoint ?? t('notConfigured')}</span>
              </div>
              <p className={styles.help}>{runtime.state === 'ready' ? t('setupRuntimeReady') : t('setupRuntimeAction')}</p>
            </>
          )}
          <div className={styles.actions}>
            <Button size="sm" variant="outline" onClick={() => void runtimeAction('install')} disabled={busy !== undefined}>{busy === 'install' ? t('refreshing') : t('install')}</Button>
            <Button size="sm" variant="primary" onClick={() => void runtimeAction('start')} disabled={busy !== undefined || runtime?.state === 'ready'}>{busy === 'start' ? t('refreshing') : t('start')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void loadStatus()} disabled={busy !== undefined}>{t('setupRefreshStatus')}</Button>
          </div>
        </section>
      )}

      {activeStep === 'login' && (
        <section className={styles.panel} aria-labelledby="gateway-setup-login-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelEyebrow}>{t('setupStepLogin')}</p>
              <h3 id="gateway-setup-login-title">{t('setupLoginTitle')}</h3>
              <p>{t('setupLoginDescription')}</p>
            </div>
            {oauth !== undefined && <span className={styles.statePill}><StateDot state={oauth.state === 'success' ? 'done' : terminalOAuth(oauth) ? 'error' : 'ongoing'} />{oauthLabel(oauth, t)}</span>}
          </div>
          {!runtimeReady && <p className={styles.notice}>{t('setupLoginNeedRuntime')}</p>}
          {oauth !== undefined && oauth.verificationUri !== undefined && (
            <div className={styles.oauthDetails}>
              <a href={oauth.verificationUri} target="_blank" rel="noreferrer">{oauth.verificationUri}</a>
              {oauth.userCode !== undefined && <code>{oauth.userCode}</code>}
              <span>{t('copyCode')}</span>
            </div>
          )}
          {oauth === undefined && <p className={styles.help}>{t('setupLoginWaiting')}</p>}
          <div className={styles.actions}>
            <Button size="sm" variant="primary" onClick={() => void startLogin()} disabled={busy !== undefined || !runtimeReady || (oauth !== undefined && !terminalOAuth(oauth))}>{busy === 'login' ? t('oauthStarting') : t('oauthStart')}</Button>
            {oauth !== undefined && !terminalOAuth(oauth) && <Button size="sm" variant="ghost" onClick={() => void cancelLogin()} disabled={busy !== undefined}>{busy === 'cancel' ? t('refreshing') : t('cancel')}</Button>}
          </div>
        </section>
      )}

      {activeStep === 'models' && (
        <section className={styles.panel} aria-labelledby="gateway-setup-models-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelEyebrow}>{t('setupStepModels')}</p>
              <h3 id="gateway-setup-models-title">{t('setupModelsTitle')}</h3>
              <p>{t('setupModelsDescription')}</p>
            </div>
          </div>
          {modelsMessage !== undefined && <p className={styles.notice} role="status">{modelsMessage}</p>}
          {modelsPhase === 'loading' && <p className={styles.state}>{t('discoveringModels')}</p>}
          {modelsPhase === 'error' && <div className={styles.stateBlock}><p>{modelsMessage ?? t('modelsUnavailable')}</p><Button size="sm" variant="outline" onClick={() => void discoverModels()} disabled={busy !== undefined}>{t('retry')}</Button></div>}
          {modelsPhase === 'ready' && models.length > 0 && (
            <>
              <div className={styles.modelList} aria-label={t('setupDiscoveredModels')}>
                {models.map((model) => <div className={styles.modelRow} key={model.id}><strong>{model.name}</strong><code>{model.id}</code></div>)}
              </div>
              <div className={styles.actions}>
                <Button size="sm" variant="outline" onClick={() => void discoverModels()} disabled={busy !== undefined}>{t('refresh')}</Button>
                <Button size="sm" variant="primary" onClick={() => void applyModels()} disabled={busy !== undefined || modelsRevision === undefined}>{busy === 'apply' ? t('applying') : t('setupApplyModels')}</Button>
              </div>
            </>
          )}
          {modelsPhase === 'ready' && models.length === 0 && modelsMessage !== undefined && (
            <div className={styles.stateBlock}>
              <p>{modelsMessage ?? t('setupNoModels')}</p>
              <Button size="sm" variant="outline" onClick={() => void discoverModels()} disabled={busy !== undefined}>{t('discoverModels')}</Button>
            </div>
          )}
          {modelsPhase === 'ready' && models.length === 0 && modelsMessage === undefined && <Button size="sm" variant="primary" onClick={() => void discoverModels()} disabled={busy !== undefined}>{t('discoverModels')}</Button>}
        </section>
      )}

      {activeStep === 'probe' && (
        <section className={styles.panel} aria-labelledby="gateway-setup-probe-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelEyebrow}>{t('setupStepProbe')}</p>
              <h3 id="gateway-setup-probe-title">{t('setupProbeTitle')}</h3>
              <p>{t('setupProbeDescription')}</p>
            </div>
          </div>
          <form className={styles.probeForm} onSubmit={runProbe}>
            <label className={styles.field}>
              <span>{t('model')}</span>
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.currentTarget.value)} disabled={busy !== undefined}>
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('prompt')}</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} rows={3} placeholder={t('promptPlaceholder')} disabled={busy !== undefined} />
            </label>
            <p className={styles.help}>{t('setupProbeHint')}</p>
            {probeMessage !== undefined && <p className={probeState === 'error' ? styles.notice : styles.help} role={probeState === 'error' ? 'alert' : 'status'}>{probeMessage}</p>}
            <div className={styles.actions}>
              <Button size="sm" variant="primary" type="submit" disabled={busy !== undefined || selectedModel.length === 0}>{busy === 'probe' ? t('running') : t('setupRunProbe')}</Button>
              {probeState === 'running' && <Button size="sm" variant="ghost" type="button" onClick={cancelProbe}>{t('cancel')}</Button>}
            </div>
          </form>
        </section>
      )}

      {activeStep === 'complete' && probeResult?.ok === true && (
        <section className={styles.complete} aria-labelledby="gateway-setup-complete-title">
          <div className={styles.completeHeading}>
            <StateDot state="done" />
            <div>
              <p className={styles.panelEyebrow}>{t('setupStepProbe')}</p>
              <h3 id="gateway-setup-complete-title">{t('setupComplete')}</h3>
              <p>{t('setupCompleteDescription')}</p>
            </div>
          </div>
          <div className={styles.result} aria-label={t('setupProbeResponse')}>
            <strong>{t('setupProbeResponse')}</strong>
            {probeResult.blocks.map((block, index) => (
              <div className={styles.resultBlock} key={`${block.type}-${index}`}>
                <span>{block.type === 'text' ? t('textBlock') : block.type === 'reasoning' ? t('reasoningBlock') : t('toolCallBlock')}</span>
                <pre>{block.type === 'tool-call' ? `${block.name}\n${block.arguments}` : block.text}</pre>
              </div>
            ))}
          </div>
          <div className={styles.actions}>
            <Button size="sm" variant="primary" onClick={() => navigate('/playground')}>{t('setupContinue')}</Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}>{t('setupAdvanced')}</Button>
          </div>
        </section>
      )}
    </section>
  )
}

function SetupStepItem({ number, label, state }: { number: string; label: string; state: 'done' | 'warning' | 'ongoing' | 'error' }): ReactNode {
  return (
    <li className={styles.step}>
      <span className={styles.stepNumber}>{number}</span>
      <StateDot state={state} />
      <span>{label}</span>
    </li>
  )
}
