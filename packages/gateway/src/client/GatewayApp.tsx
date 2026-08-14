import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WebpageAppSlotProps } from '@wha1echai/dsh-webpage/client'

import { PlaygroundView } from './PlaygroundView.js'
import type { PlaygroundImageUpload, PlaygroundLabels } from './PlaygroundView.js'
import { RequestsView } from './RequestsView.js'
import type { RequestsViewLabels } from './RequestsView.js'
import { AccountsView } from './views/AccountsView.js'
import { DashboardView } from './views/DashboardView.js'
import { ModelsView } from './views/ModelsView.js'
import { SettingsView } from './views/SettingsView.js'
import type { GatewayProbeImageRef } from '../host/contracts.js'
import type { GatewayRemote, GatewayRoute } from './view-types.js'
import styles from './GatewayApp.module.css'

export interface GatewayAppProps extends WebpageAppSlotProps, PropsLocale<'gateway'> {
  readonly remote: GatewayRemote
}

const ROUTES: readonly GatewayRoute[] = ['/', '/accounts', '/models', '/requests', '/playground', '/settings']

function routeOf(appPath: string): GatewayRoute | undefined {
  if (appPath === '' || appPath === '/') return '/'
  const value = appPath.endsWith('/') ? appPath.slice(0, -1) : appPath
  return (ROUTES as readonly string[]).includes(value) ? value as GatewayRoute : undefined
}

/** Native Webpage App shell. Route state belongs to dsh-webpage's appPath. */
export function GatewayApp({ appPath, close, navigate, remote, t }: GatewayAppProps): ReactNode {
  const route = routeOf(appPath)

  useEffect(() => {
    if (route === undefined) navigate('/')
  }, [navigate, route])

  const currentRoute = route ?? '/'
  const viewNavigation = (next: GatewayRoute): void => navigate(next)

  return (
    <article className={styles.page} data-gateway-app="phase-5">
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.eyebrow}>{t('foundation')}</span>
          <h1 className={styles.title}>{t('title')}</h1>
        </div>
        <Button size="sm" variant="ghost" onClick={() => close()}>{t('close')}</Button>
      </header>

      <nav className={styles.nav} aria-label={t('title')}>
        <NavItem route="/" current={currentRoute} label={t('overview')} navigate={viewNavigation} />
        <NavItem route="/accounts" current={currentRoute} label={t('accounts')} navigate={viewNavigation} />
        <NavItem route="/models" current={currentRoute} label={t('models')} navigate={viewNavigation} />
        <NavItem route="/requests" current={currentRoute} label={t('requests')} navigate={viewNavigation} />
        <NavItem route="/playground" current={currentRoute} label={t('playground')} navigate={viewNavigation} />
        <NavItem route="/settings" current={currentRoute} label={t('settings')} navigate={viewNavigation} />
      </nav>

      {route === undefined && <p className={styles.routeNotice} role="status">{t('unknownRoute')}</p>}
      <main className={styles.content}>
        {currentRoute === '/' && <DashboardView remote={remote} t={t} />}
        {currentRoute === '/accounts' && <AccountsView remote={remote} t={t} />}
        {currentRoute === '/models' && <ModelsView remote={remote} t={t} />}
        {currentRoute === '/requests' && <RequestsView labels={requestLabels(t)} loadRequests={remote.analyticsRequests} />}
        {currentRoute === '/playground' && <PlaygroundView labels={playgroundLabels(t)} loadModels={remote.models} uploadImage={uploadImage(remote)} runProbe={remote.probe} />}
        {currentRoute === '/settings' && <SettingsView remote={remote} t={t} />}
      </main>
    </article>
  )
}

function requestLabels(t: GatewayAppProps['t']): RequestsViewLabels {
  return {
    title: t('requests'),
    from: t('from'),
    to: t('to'),
    provider: t('provider'),
    model: t('model'),
    allProviders: t('allProviders'),
    allModels: t('allModels'),
    applyFilters: t('applyFilters'),
    refresh: t('refresh'),
    loading: t('loading'),
    loadingNextPage: t('loadingNextPage'),
    empty: t('empty'),
    unavailable: t('unavailable'),
    invalidRange: t('invalidRange'),
    nextPage: t('nextPage'),
    noMore: t('noMore'),
    tableCaption: t('tableCaption'),
    occurredAt: t('occurredAt'),
    route: t('route'),
    outcome: t('outcome'),
    error: t('error'),
    tokens: t('tokens'),
    latency: t('latency'),
    cost: t('cost'),
    success: t('success'),
    failed: t('failed'),
    aborted: t('aborted'),
    none: t('none'),
    unpriced: t('unpriced'),
    partial: t('partial'),
    notAvailable: t('notAvailable'),
  }
}

function playgroundLabels(t: GatewayAppProps['t']): PlaygroundLabels {
  return {
    title: t('playground'),
    description: t('description'),
    model: t('model'),
    selectModel: t('selectModel'),
    loadingModels: t('loadingModels'),
    modelsUnavailable: t('modelsUnavailable'),
    noModels: t('noModels'),
    prompt: t('prompt'),
    promptPlaceholder: t('promptPlaceholder'),
    image: t('image'),
    chooseImage: t('chooseImage'),
    imageHint: t('imageHint'),
    removeImage: t('removeImage'),
    imageUploading: t('imageUploading'),
    invalidImageType: t('invalidImageType'),
    imageTooLarge: t('imageTooLarge'),
    uploadFailed: t('uploadFailed'),
    imageUnsupported: t('imageUnsupported'),
    maxTokens: t('maxTokens'),
    maxTokensHint: t('maxTokensHint'),
    toolSchema: t('toolSchema'),
    toolSchemaHint: t('toolSchemaHint'),
    run: t('run'),
    cancel: t('cancel'),
    running: t('running'),
    result: t('result'),
    textBlock: t('textBlock'),
    reasoningBlock: t('reasoningBlock'),
    toolCallBlock: t('toolCallBlock'),
    toolName: t('toolName'),
    toolArguments: t('toolArguments'),
    usage: t('usage'),
    inputTokens: t('inputTokens'),
    outputTokens: t('outputTokens'),
    cacheReadTokens: t('cacheReadTokens'),
    cacheWriteTokens: t('cacheWriteTokens'),
    reasoningTokens: t('reasoningTokens'),
    finish: t('finish'),
    error: t('error'),
    unavailable: t('unavailable'),
    cancelled: t('cancelled'),
    invalidPrompt: t('invalidPrompt'),
    invalidMaxTokens: t('invalidMaxTokens'),
  }
}

function uploadImage(remote: GatewayRemote): (image: PlaygroundImageUpload) => Promise<RemoteResult<GatewayProbeImageRef>> {
  return async (image) => {
    const comma = image.dataUrl.indexOf(',')
    if (comma < 0) {
      return { ok: false, error: { code: 'INVALID_IMAGE_DATA', message: 'Image data is invalid', details: {} } }
    }
    return remote.uploadImage({
      dataBase64: image.dataUrl.slice(comma + 1),
      mediaType: image.mediaType,
      ...(image.name === undefined ? {} : { name: image.name }),
    })
  }
}

function NavItem({ route, current, label, navigate }: { route: GatewayRoute; current: GatewayRoute; label: string; navigate: (route: GatewayRoute) => void }): ReactNode {
  return (
    <Button
      size="sm"
      variant={route === current ? 'primary' : 'ghost'}
      aria-current={route === current ? 'page' : undefined}
      onClick={() => navigate(route)}
    >
      {label}
    </Button>
  )
}
