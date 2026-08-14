import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GatewayModelView } from '../../host/contracts.js'

import type { GatewayViewProps } from '../view-types.js'
import { errorCode, remoteErrorCode, remoteValue } from '../view-types.js'
import styles from './ModelsView.module.css'

type ModelPhase = 'loading' | 'ready' | 'offline'

function modelErrorMessage(code: string, t: GatewayViewProps['t']): string {
  if (code === 'settings_conflict') return t('settingsConflict')
  return `${t('failed')}: ${code}`
}

export function ModelsView({ remote, t }: GatewayViewProps): ReactNode {
  const [phase, setPhase] = useState<ModelPhase>('loading')
  const [models, setModels] = useState<GatewayModelView[]>([])
  const [revision, setRevision] = useState<number | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [refreshToken, setRefreshToken] = useState(0)
  const [saving, setSaving] = useState(false)

  const discover = useCallback(async (signal: AbortSignal): Promise<void> => {
    setPhase('loading')
    setMessage(undefined)
    try {
      const result = await remote.models(signal)
      if (signal.aborted) return
      const value = remoteValue(result)
      if (value === undefined) {
        setPhase('offline')
        setMessage(modelErrorMessage(remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE', t))
        return
      }
      setModels(value.models.map((model) => ({ ...model })))
      setRevision(value.settingsRevision)
      setPhase('ready')
    } catch (error) {
      if (!signal.aborted) {
        setPhase('offline')
        setMessage(modelErrorMessage(errorCode(error), t))
      }
    }
  }, [remote, t])

  useEffect(() => {
    const controller = new AbortController()
    void discover(controller.signal)
    return () => controller.abort()
  }, [discover, refreshToken])

  const toggleImage = (id: string, checked: boolean): void => {
    setModels((current) => current.map((model) => model.id === id ? { ...model, imageInput: checked } : model))
    setMessage(undefined)
  }

  const apply = async (): Promise<void> => {
    if (revision === undefined || saving) return
    setSaving(true)
    setMessage(undefined)
    try {
      const result = await remote.applyModels({ models, expectedRevision: revision })
      const value = remoteValue(result)
      if (value === undefined) {
        const code = remoteErrorCode(result) ?? 'REMOTE_UNAVAILABLE'
        setMessage(modelErrorMessage(code, t))
        if (code === 'settings_conflict') setRefreshToken((current) => current + 1)
        return
      }
      setRevision(value.settingsRevision)
      setMessage(value.changed ? t('saved') : t('saved'))
    } catch (error) {
      const code = errorCode(error)
      setMessage(modelErrorMessage(code, t))
      if (code === 'settings_conflict') setRefreshToken((current) => current + 1)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={styles.page} aria-labelledby="gateway-models-title">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>{t('models')}</p>
          <h2 id="gateway-models-title" className={styles.title}>{t('discoverModels')}</h2>
          <p className={styles.subtitle}>{t('modelApplyHint')}</p>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="outline" onClick={() => setRefreshToken((value) => value + 1)} disabled={phase === 'loading'}>{phase === 'loading' ? t('discoveringModels') : t('refresh')}</Button>
          <Button size="sm" variant="primary" onClick={() => void apply()} disabled={phase !== 'ready' || revision === undefined || saving}>{saving ? t('applying') : t('apply')}</Button>
        </div>
      </div>

      {message !== undefined && <p className={styles.notice} role="status">{message}</p>}
      {phase === 'loading' && <p className={styles.state}>{t('loading')}</p>}
      {phase === 'offline' && (
        <div className={styles.stateBlock} role="status">
          <p>{message ?? t('offline')}</p>
          <Button size="sm" variant="outline" onClick={() => setRefreshToken((value) => value + 1)}>{t('retry')}</Button>
        </div>
      )}
      {phase === 'ready' && models.length === 0 && <p className={styles.state}>{t('noModels')}</p>}
      {phase === 'ready' && models.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeading}>
            <div>
              <h3>{t('modelName')}</h3>
              <p>{t('imageInputHelp')}</p>
            </div>
            <span className={styles.revision}>{t('settingsRevision')}: {revision}</span>
          </div>
          <div className={styles.rows}>
            {models.map((model) => (
              <label className={styles.row} key={model.id}>
                <StateDot state={model.imageInput ? 'done' : 'ongoing'} />
                <span className={styles.modelText}>
                  <strong>{model.name}</strong>
                  <code>{model.id}</code>
                </span>
                <span className={styles.checkboxText}>{t('imageInput')}</span>
                <input type="checkbox" checked={model.imageInput} onChange={(event) => toggleImage(model.id, event.currentTarget.checked)} />
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
