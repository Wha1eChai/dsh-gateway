import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { AppDescriptor } from '@wha1echai/dsh-webpage/client'
import gatewayRemote from '@wha1echai/dsh-gateway/remote'
import type {} from '@wha1echai/dsh-gateway/remote'

import { GatewayApp } from './GatewayApp.js'
import { en, zh } from './locales.js'

const descriptor = Object.freeze({
  id: 'wha1echai.gateway',
  label: 'AI Gateway',
  description: 'Manage CLIProxyAPI connectivity and DSH provider integration.',
  order: 20,
  categories: ['gateway', 'models'],
}) satisfies AppDescriptor

/** Stable client fiber name for HMR and diagnostics. */
export const name = '@wha1echai/dsh-gateway'
export const inject = ['remote', 'pages', 'slots', 'locale']

/** Mount the generated Gateway Remote contribution for this client fiber. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(gatewayRemote)
  const unregisterComposition = ctx.effect(() => {
    const unregisterLocale = ctx.locale.register('gateway', { zh, en })
    const unregisterPage = ctx.pages.register(descriptor)
    const unregisterSlot = ctx.slots.inject('webpage.app', () => ctx.slots.register({
      name: 'webpage.app',
      key: descriptor.id,
      locale: 'gateway',
    }, (props) => <GatewayApp {...props} loadStatus={() => ctx.remote.gateway.status()} />))
    return () => {
      unregisterSlot()
      unregisterPage()
      unregisterLocale()
    }
  }, 'dsh-gateway: App composition')

  return async () => {
    unregisterComposition()
    await unmountRemote()
  }
}
