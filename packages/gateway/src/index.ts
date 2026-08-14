import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.js'
import { GatewayHostService } from './host/gateway-service.js'

export * from './config.js'
export * from './host/contracts.js'
export * from './host/cpa-client/index.js'
export * from './host/gateway-service.js'
export * from './host/oauth/index.js'
export * from './host/provider/index.js'

export { Config }

export const name = '@wha1echai/dsh-gateway'
export const inject = ['settings', 'credentials', 'llm', 'subprocess', 'attachments']

/** Install the generated-Remote Host BFF in the current plugin fiber. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(GatewayHostService, config)
}
