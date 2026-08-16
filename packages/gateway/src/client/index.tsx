import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { AppDescriptor } from '@dshapps/webpage/client'
import gatewayRemote from '@dshapps/dsh-gateway/remote'
import type {} from '@dshapps/dsh-gateway/remote'

import { GatewayApp } from './GatewayApp.js'
import { en, zh } from './locales.js'
import type { GatewayRemote } from './view-types.js'

const descriptor = Object.freeze({
  id: 'dshapps.gateway',
  label: 'AI Gateway',
  description: 'Manage CLIProxyAPI connectivity and DSH provider integration.',
  order: 20,
  categories: ['gateway', 'models'],
}) satisfies AppDescriptor

/** Stable client fiber name for HMR and diagnostics. */
export const name = '@dshapps/dsh-gateway'
export const inject = ['remote', 'pages', 'slots', 'locale']

/** Mount the generated Gateway Remote contribution for this client fiber. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(gatewayRemote)
  const composition = ctx.inject(['remote.gateway'], (scope: ClientContext) => {
    const remote = scope.remote.gateway as unknown as GatewayRemote
    scope.effect(() => {
      const unregisterLocale = scope.locale.register('gateway', { zh, en })
      const unregisterPage = scope.pages.register(descriptor)
      const unregisterSlot = scope.slots.inject('webpage.app', () => scope.slots.register({
        name: 'webpage.app',
        key: descriptor.id,
        locale: 'gateway',
      }, (props) => <GatewayApp {...props} remote={remote} />))
      return () => {
        unregisterSlot()
        unregisterPage()
        unregisterLocale()
      }
    }, 'dsh-gateway: App composition')
  })
  await composition

  return async () => {
    await composition.dispose()
    await unmountRemote()
  }
}
