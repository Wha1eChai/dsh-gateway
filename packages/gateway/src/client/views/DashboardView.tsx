import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { use as useECharts, init } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import type { GatewayAnalyticsStatusView, GatewayAnalyticsSummaryView, GatewayAnalyticsTrendPoint } from '../../host/contracts.js'

import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'

import type { GatewayViewProps } from '../view-types.js'
import { remoteValue } from '../view-types.js'
import styles from './DashboardView.module.css'

useECharts([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

interface DashboardData {
  readonly status: GatewayAnalyticsStatusView
  readonly summary: GatewayAnalyticsSummaryView
  readonly trend: readonly GatewayAnalyticsTrendPoint[]
}

type DashboardPhase = 'loading' | 'ready' | 'offline'

const EMPTY_SUMMARY: GatewayAnalyticsSummaryView = {
  requests: 0,
  successes: 0,
  errors: 0,
  aborted: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  knownCostMicros: 0,
  pricedRequests: 0,
  partialRequests: 0,
  unpricedRequests: 0,
  currency: null,
  p50DurationMs: null,
  p95DurationMs: null,
  p50TimeToFirstTokenMs: null,
  p95TimeToFirstTokenMs: null,
}

const EMPTY_STATUS: GatewayAnalyticsStatusView = {
  availability: 'unavailable',
  mode: 'disabled',
  queueCompleteness: 'unknown',
  lossPossibleCount: 0,
}

function analyticsRange(): { fromMs: number; toMs: number } {
  const toMs = Date.now()
  return { fromMs: toMs - 24 * 60 * 60 * 1_000, toMs }
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function duration(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`
}

function cost(summary: GatewayAnalyticsSummaryView): string {
  if (summary.currency === null || summary.pricedRequests === 0) return '—'
  return `${summary.currency} ${(summary.knownCostMicros / 1_000_000).toFixed(4)}`
}

function statusState(status: GatewayAnalyticsStatusView): 'done' | 'warning' | 'ongoing' | 'error' {
  if (status.availability === 'ready') return 'done'
  if (status.availability === 'starting') return 'ongoing'
  if (status.availability === 'degraded') return 'warning'
  return 'error'
}

function statusLabel(status: GatewayAnalyticsStatusView, t: GatewayViewProps['t']): string {
  switch (status.availability) {
    case 'ready': return t('analyticsReady')
    case 'starting': return t('analyticsStarting')
    case 'degraded': return t('analyticsDegraded')
    case 'disabled': return t('analyticsDisabled')
    case 'unavailable': return t('analyticsUnavailable')
  }
}

function TrendChart({ trend, t }: { trend: readonly GatewayAnalyticsTrendPoint[]; t: GatewayViewProps['t'] }): ReactNode {
  const element = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (element.current === null || trend.length === 0) return
    const chart = init(element.current)
    const labels = trend.map((point) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(point.bucketStartMs))
    chart.setOption({
      animation: false,
      grid: { top: 28, right: 18, bottom: 28, left: 42, containLabel: true },
      legend: { top: 0, right: 0, textStyle: { color: 'var(--dsw-alias-label-tertiary)' } },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', boundaryGap: true, data: labels },
      yAxis: [
        { type: 'value', min: 0, splitLine: { lineStyle: { color: 'rgba(128, 128, 128, 0.16)' } } },
        { type: 'value', min: 0, max: 100, splitLine: { show: false }, axisLabel: { formatter: '{value}%' } },
      ],
      series: [
        {
          name: t('requestsSeries'),
          type: 'bar',
          barMaxWidth: 18,
          data: trend.map((point) => point.requests),
          itemStyle: { color: '#6688ff', borderRadius: [4, 4, 0, 0] },
        },
        {
          name: t('successSeries'),
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: trend.map((point) => point.requests === 0 ? 0 : point.successes / point.requests * 100),
          itemStyle: { color: '#35b981' },
          lineStyle: { color: '#35b981', width: 2 },
        },
      ],
    })
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      chart.dispose()
    }
  }, [t, trend])

  return <div ref={element} className={styles.chart} role="img" aria-label={t('trend')} />
}

export function DashboardView({ remote, t }: GatewayViewProps): ReactNode {
  const [phase, setPhase] = useState<DashboardPhase>('loading')
  const [data, setData] = useState<DashboardData>({ status: EMPTY_STATUS, summary: EMPTY_SUMMARY, trend: [] })
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof window.setTimeout> | undefined

    const poll = async (): Promise<void> => {
      const range = analyticsRange()
      try {
        const [statusResult, summaryResult, trendResult] = await Promise.all([
          remote.analyticsStatus(),
          remote.analyticsSummary(range),
          remote.analyticsTrend({ ...range, bucket: 'hour' }),
        ])
        if (controller.signal.aborted) return
        const status = remoteValue(statusResult)
        const summary = remoteValue(summaryResult)
        const trend = remoteValue(trendResult)
        if (status === undefined || summary === undefined || trend === undefined) {
          setPhase('offline')
        } else {
          setData({ status, summary, trend })
          setPhase('ready')
        }
      } catch {
        if (!controller.signal.aborted) setPhase('offline')
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void poll() }, 30_000)
      }
    }

    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshToken, remote])

  const summary = data.summary
  const empty = phase === 'ready' && summary.requests === 0 && data.trend.length === 0

  return (
    <section className={styles.page} aria-labelledby="gateway-dashboard-title">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.eyebrow}>{t('overview')}</p>
          <h2 id="gateway-dashboard-title" className={styles.title}>{t('title')}</h2>
          <p className={styles.subtitle}>{t('description')}</p>
        </div>
        <div className={styles.statusPill}>
          <StateDot state={statusState(data.status)} />
          <span>{statusLabel(data.status, t)}</span>
        </div>
      </div>

      {phase === 'loading' && <p className={styles.state}>{t('loading')}</p>}
      {phase === 'offline' && (
        <div className={styles.stateBlock} role="status">
          <p>{t('offline')}</p>
          <Button size="sm" variant="outline" onClick={() => setRefreshToken((value) => value + 1)}>{t('retry')}</Button>
        </div>
      )}

      {phase === 'ready' && (
        <>
          {data.status.availability !== 'ready' && <p className={styles.notice}>{t('noAnalytics')}</p>}
          <div className={styles.cards}>
            <Metric label={t('requestCount')} value={compact(summary.requests)} detail={`${compact(summary.errors)} ${t('error')}`} />
            <Metric label={t('successCount')} value={compact(summary.successes)} detail={`${summary.requests === 0 ? 0 : Math.round(summary.successes / summary.requests * 100)}%`} />
            <Metric label={t('tokenCount')} value={compact(summary.inputTokens + summary.outputTokens)} detail={`${compact(summary.inputTokens)} in · ${compact(summary.outputTokens)} out`} />
            <Metric label={t('knownCost')} value={cost(summary)} detail={`${compact(summary.partialRequests + summary.unpricedRequests)} ${t('unknownUnit')}`} />
            <Metric label={t('p50')} value={duration(summary.p50DurationMs)} detail={t('trend')} />
            <Metric label={t('p95')} value={duration(summary.p95DurationMs)} detail={t('trend')} />
          </div>
          <div className={styles.chartCard}>
            <div className={styles.cardHeading}>
              <h3>{t('trend')}</h3>
              <span>{t('queueCompleteness')}: {data.status.queueCompleteness}</span>
            </div>
            {empty ? <p className={styles.state}>{t('noRequests')}</p> : <TrendChart trend={data.trend} t={t} />}
          </div>
          <div className={styles.footerFacts}>
            <span>{t('inputTokens')}: {compact(summary.inputTokens)}</span>
            <span>{t('outputTokens')}: {compact(summary.outputTokens)}</span>
            <span>{t('lossPossible')}: {compact(data.status.lossPossibleCount)}</span>
          </div>
        </>
      )}
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }): ReactNode {
  return (
    <article className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <strong className={styles.metricValue}>{value}</strong>
      <span className={styles.metricDetail}>{detail}</span>
    </article>
  )
}
