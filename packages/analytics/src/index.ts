import type { Context } from '@deepseek-ai/cordis'

import { resolveAnalyticsConfig } from './config.js'
import type { AnalyticsConfig } from './config.js'
import { BUNDLED_PRICING_SNAPSHOT } from './pricing-snapshot.js'
import { GatewayAnalyticsService } from './service.js'
import { createAnalyticsWorkerStore } from './storage/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gatewayAnalytics: GatewayAnalyticsService
  }
}

export * from './config.js'
export * from './contracts.js'
export * from './pipeline/index.js'
export * from './pricing-snapshot.js'
export * from './service.js'
export * from './storage/index.js'

export const name = '@dshapps/dsh-gateway-analytics'
export const inject = ['dshGateway', 'credentials']

/** Provide one optional, failure-isolated analytics service per plugin fiber. */
export function apply(ctx: Context, config: AnalyticsConfig = {}): void {
  const resolved = resolveAnalyticsConfig(config)
  const service = new GatewayAnalyticsService(
    ctx,
    resolved,
    BUNDLED_PRICING_SNAPSHOT.rules,
    async (options) => createAnalyticsWorkerStore({
      databasePath: options.databasePath,
      targetKey: options.targetKey,
      mode: options.mode,
      queueCompleteness: options.queueCompleteness,
      pricingRules: options.pricingRules,
    }),
  )
  ctx.effect(function* provideAnalytics() {
    yield ctx.provide('gatewayAnalytics', service)
    void service.start()
    yield () => service.close()
  }, 'dsh-gateway.analytics')
}
