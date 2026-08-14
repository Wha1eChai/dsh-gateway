import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GatewayAnalyticsRequestPageView,
  GatewayAnalyticsRequestView,
  GatewayAnalyticsRequestsRequest,
  GatewayAnalyticsTimeRange,
} from '@wha1echai/dsh-gateway/contracts'

import styles from './RequestsView.module.css'

const DAY_MS = 24 * 60 * 60 * 1_000
const MAX_ANALYTICS_RANGE_MS = 366 * DAY_MS
const DEFAULT_ANALYTICS_RANGE_MS = DAY_MS
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

type RemoteValue<T> = T | RemoteResult<T>

export interface RequestsViewLabels {
  readonly title: string
  readonly from: string
  readonly to: string
  readonly provider: string
  readonly model: string
  readonly allProviders: string
  readonly allModels: string
  readonly applyFilters: string
  readonly refresh: string
  readonly loading: string
  readonly loadingNextPage: string
  readonly empty: string
  readonly unavailable: string
  readonly invalidRange: string
  readonly nextPage: string
  readonly noMore: string
  readonly tableCaption: string
  readonly occurredAt: string
  readonly route: string
  readonly outcome: string
  readonly error: string
  readonly tokens: string
  readonly latency: string
  readonly cost: string
  readonly success: string
  readonly failed: string
  readonly aborted: string
  readonly none: string
  readonly unpriced: string
  readonly partial: string
  readonly notAvailable: string
}

export interface RequestsViewProps {
  readonly labels: RequestsViewLabels
  readonly loadRequests: (request: GatewayAnalyticsRequestsRequest) => Promise<RemoteValue<GatewayAnalyticsRequestPageView>>
  readonly initialRange?: GatewayAnalyticsTimeRange
  readonly providers?: readonly string[]
  readonly models?: readonly string[]
  readonly pageSize?: number
}

type RequestsState = 'loading' | 'ready' | 'unavailable' | 'invalid'

function defaultRange(): GatewayAnalyticsTimeRange {
  const toMs = Date.now()
  return { fromMs: toMs - DEFAULT_ANALYTICS_RANGE_MS, toMs }
}

function dateTimeInputValue(timestampMs: number): string {
  const date = new Date(timestampMs)
  if (!Number.isFinite(date.getTime())) return ''
  const localMs = timestampMs - date.getTimezoneOffset() * 60 * 1_000
  return new Date(localMs).toISOString().slice(0, 16)
}

function parseDateTimeInput(value: string): number | undefined {
  if (value.length === 0) return undefined
  const timestampMs = new Date(value).getTime()
  return Number.isFinite(timestampMs) ? timestampMs : undefined
}

function boundedRange(fromMs: number | undefined, toMs: number | undefined): GatewayAnalyticsTimeRange | undefined {
  if (fromMs === undefined || toMs === undefined || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) {
    return undefined
  }
  if (fromMs < 0 || toMs <= fromMs) return undefined
  const boundedFromMs = toMs - fromMs > MAX_ANALYTICS_RANGE_MS ? toMs - MAX_ANALYTICS_RANGE_MS : fromMs
  return { fromMs: boundedFromMs, toMs }
}

function boundedPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)))
}

function unwrapRemoteValue<T>(result: RemoteValue<T>): T | undefined {
  if (typeof result === 'object' && result !== null && 'ok' in result && typeof result.ok === 'boolean') {
    return result.ok ? result.value : undefined
  }
  return result
}

function formatOccurredAt(timestampMs: number): string {
  const date = new Date(timestampMs)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatTokens(item: GatewayAnalyticsRequestView, notAvailable: string): string {
  const input = item.inputTokens === null ? notAvailable : String(item.inputTokens)
  const output = item.outputTokens === null ? notAvailable : String(item.outputTokens)
  return `${input} / ${output}`
}

function formatCost(item: GatewayAnalyticsRequestView, labels: RequestsViewLabels): string {
  if (item.pricingState === 'unpriced' || item.estimatedCostMicros === null) return labels.unpriced
  const amount = item.estimatedCostMicros / 1_000_000
  let formatted: string
  if (item.currency === null) {
    formatted = amount.toFixed(6)
  } else {
    try {
      formatted = new Intl.NumberFormat(undefined, { style: 'currency', currency: item.currency }).format(amount)
    } catch {
      formatted = `${item.currency} ${amount.toFixed(6)}`
    }
  }
  return item.pricingState === 'partial' ? `${formatted} · ${labels.partial}` : formatted
}

function formatOutcome(item: GatewayAnalyticsRequestView, labels: RequestsViewLabels): string {
  if (item.outcome === 'success') return labels.success
  if (item.outcome === 'aborted') return labels.aborted
  return labels.failed
}

function formatError(item: GatewayAnalyticsRequestView, labels: RequestsViewLabels): string {
  return item.errorKind === 'none' ? labels.none : item.errorKind
}

/**
 * Read-only, metadata-only analytics request history. The view owns query
 * state, while the shell owns the Remote callback and all locale strings.
 */
export function RequestsView({
  labels,
  loadRequests,
  initialRange,
  providers,
  models,
  pageSize,
}: RequestsViewProps): ReactNode {
  const initial = initialRange ?? defaultRange()
  const [fromValue, setFromValue] = useState(() => dateTimeInputValue(initial.fromMs))
  const [toValue, setToValue] = useState(() => dateTimeInputValue(initial.toMs))
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [items, setItems] = useState<readonly GatewayAnalyticsRequestView[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [state, setState] = useState<RequestsState>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [errorCode, setErrorCode] = useState<string | undefined>()
  const generation = useRef(0)
  const mounted = useRef(true)

  const range = useMemo(
    () => boundedRange(parseDateTimeInput(fromValue), parseDateTimeInput(toValue)),
    [fromValue, toValue],
  )
  const query = useMemo<GatewayAnalyticsRequestsRequest | undefined>(() => {
    if (range === undefined) return undefined
    return {
      ...range,
      limit: boundedPageSize(pageSize),
      ...(providerId.trim().length === 0 ? {} : { providerId: providerId.trim() }),
      ...(modelId.trim().length === 0 ? {} : { modelId: modelId.trim() }),
    }
  }, [modelId, pageSize, providerId, range])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])

  useEffect(() => {
    const requestGeneration = generation.current + 1
    generation.current = requestGeneration
    let active = true
    setItems([])
    setNextCursor(undefined)
    setErrorCode(undefined)

    if (query === undefined) {
      setState('invalid')
      return () => { active = false }
    }

    setState('loading')
    void loadRequests(query).then((response) => {
      if (!active || !mounted.current || generation.current !== requestGeneration) return
      const page = unwrapRemoteValue(response)
      if (page === undefined) {
        setState('unavailable')
        setErrorCode('REMOTE_UNAVAILABLE')
        return
      }
      setItems(page.items)
      setNextCursor(page.nextCursor)
      setState('ready')
    }, () => {
      if (!active || !mounted.current || generation.current !== requestGeneration) return
      setState('unavailable')
      setErrorCode('REMOTE_UNAVAILABLE')
    })

    return () => { active = false }
  }, [loadRequests, query, refreshVersion])

  const loadNextPage = (): void => {
    if (query === undefined || nextCursor === undefined || loadingMore) return
    const requestGeneration = generation.current
    let active = true
    setLoadingMore(true)
    setErrorCode(undefined)
    void loadRequests({ ...query, cursor: nextCursor }).then((response) => {
      if (!active || !mounted.current || generation.current !== requestGeneration) return
      const page = unwrapRemoteValue(response)
      if (page === undefined) {
        setErrorCode('REMOTE_UNAVAILABLE')
        return
      }
      setItems((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    }, () => {
      if (!active || !mounted.current || generation.current !== requestGeneration) return
      setErrorCode('REMOTE_UNAVAILABLE')
    }).finally(() => {
      if (active && mounted.current && generation.current === requestGeneration) setLoadingMore(false)
    })
  }

  const submitFilters = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setRefreshVersion((value) => value + 1)
  }

  const providerOptions = providers ?? []
  const modelOptions = models ?? []

  return (
    <article className={styles.page} data-gateway-view="requests">
      <header className={styles.header}>
        <h1 className={styles.title}>{labels.title}</h1>
      </header>

      <form className={styles.filters} onSubmit={submitFilters}>
        <div className={styles.filterGrid}>
          <label className={styles.field} htmlFor="gateway-requests-from">
            <span>{labels.from}</span>
            <input
              id="gateway-requests-from"
              className={styles.input}
              type="datetime-local"
              value={fromValue}
              onChange={(event) => setFromValue(event.target.value)}
            />
          </label>
          <label className={styles.field} htmlFor="gateway-requests-to">
            <span>{labels.to}</span>
            <input
              id="gateway-requests-to"
              className={styles.input}
              type="datetime-local"
              value={toValue}
              onChange={(event) => setToValue(event.target.value)}
            />
          </label>
          <label className={styles.field} htmlFor="gateway-requests-provider">
            <span>{labels.provider}</span>
            {providerOptions.length > 0 ? (
              <select
                id="gateway-requests-provider"
                className={styles.input}
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                <option value="">{labels.allProviders}</option>
                {providerOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : (
              <input
                id="gateway-requests-provider"
                className={styles.input}
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                placeholder={labels.allProviders}
              />
            )}
          </label>
          <label className={styles.field} htmlFor="gateway-requests-model">
            <span>{labels.model}</span>
            {modelOptions.length > 0 ? (
              <select
                id="gateway-requests-model"
                className={styles.input}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                <option value="">{labels.allModels}</option>
                {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : (
              <input
                id="gateway-requests-model"
                className={styles.input}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder={labels.allModels}
              />
            )}
          </label>
        </div>
        <div className={styles.toolbar}>
          <button type="submit" className={styles.button}>{labels.applyFilters}</button>
          <button type="button" className={styles.button} onClick={() => setRefreshVersion((value) => value + 1)}>
            {labels.refresh}
          </button>
        </div>
      </form>

      <section className={styles.status} aria-live="polite" aria-busy={state === 'loading'}>
        {state === 'loading' && <p>{labels.loading}</p>}
        {state === 'invalid' && <p role="alert">{labels.invalidRange}</p>}
        {state === 'unavailable' && <p role="alert">{labels.unavailable}</p>}
        {state === 'ready' && items.length === 0 && <p>{labels.empty}</p>}
        {errorCode !== undefined && state === 'ready' && <p className={styles.inlineError} role="alert">{labels.unavailable}</p>}
      </section>

      {state === 'ready' && items.length > 0 && (
        <div className={styles.tableScroller}>
          <table className={styles.table}>
            <caption>{labels.tableCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{labels.occurredAt}</th>
                <th scope="col">{labels.route}</th>
                <th scope="col">{labels.provider}</th>
                <th scope="col">{labels.model}</th>
                <th scope="col">{labels.outcome}</th>
                <th scope="col">{labels.error}</th>
                <th scope="col">{labels.tokens}</th>
                <th scope="col">{labels.latency}</th>
                <th scope="col">{labels.cost}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.requestIdHash}:${item.occurredAtMs}:${index}`}>
                  <td>{formatOccurredAt(item.occurredAtMs)}</td>
                  <td>{item.routeId}</td>
                  <td>{item.providerId}</td>
                  <td>{item.modelId}</td>
                  <td>{formatOutcome(item, labels)}</td>
                  <td>{formatError(item, labels)}</td>
                  <td>{formatTokens(item, labels.notAvailable)}</td>
                  <td>{item.durationMs === null ? labels.notAvailable : `${item.durationMs} ms`}</td>
                  <td>{formatCost(item, labels)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state === 'ready' && (nextCursor !== undefined || loadingMore) && (
        <div className={styles.pagination}>
          <button
            type="button"
            className={styles.button}
            onClick={loadNextPage}
            disabled={loadingMore || nextCursor === undefined}
            aria-busy={loadingMore}
          >
            {loadingMore ? labels.loadingNextPage : labels.nextPage}
          </button>
        </div>
      )}
      {state === 'ready' && nextCursor === undefined && items.length > 0 && <p className={styles.muted}>{labels.noMore}</p>}
    </article>
  )
}
