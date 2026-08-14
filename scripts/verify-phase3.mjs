#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

import { startFakeCpa } from '../tests/fixtures/fake-cpa/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const fixture = await startFakeCpa()
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-phase3-'))
  const settingsPath = join(home, 'settings.yaml')
  const credentialsPath = join(home, '.credentials.yaml')
  let ctx

  try {
    await writeFile(settingsPath, '# phase 3 Loader fixture\n')
    await writeFile(
      credentialsPath,
      'DSH_GATEWAY_PROXY_KEY: fixture-proxy-key\nDSH_GATEWAY_MANAGEMENT_KEY: fixture-management-key\n',
      { mode: 0o600 },
    )

    ctx = new Context()
    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    await ctx.loader.create({ id: 'llm', name: '@deepseek-ai/dsh-llm' })
    await ctx.loader.create({
      id: 'settings',
      name: '@deepseek-ai/dsh-settings-file',
      config: { path: settingsPath, watch: false },
    })
    await ctx.loader.create({
      id: 'credentials',
      name: '@deepseek-ai/dsh-credentials-local',
      config: { path: credentialsPath, watch: false },
    })
    await ctx.loader.create({ id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' })
    await ctx.loader.create({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' })
    await ctx.loader.create({
      id: 'gateway',
      name: pathToFileURL(join(root, 'packages', 'gateway', 'lib', 'index.js')).href,
      config: { endpoint: fixture.url },
    })
    await ctx.loader.await()

    const gatewayEntry = ctx.loader.resolve('gateway')
    expect(gatewayEntry.fiber !== undefined, 'built Gateway entry was not active')
    expect(ctx.get('dshGateway') !== undefined, 'Gateway Host service was not provided')

    const discovered = await ctx.dshGateway.models(new AbortController().signal)
    expect(discovered.models.map((model) => model.id).join(',') === 'fake-text-model,fake-vision-model', 'model discovery drifted')
    const selected = discovered.models.map((model) => ({
      ...model,
      imageInput: model.id === 'fake-vision-model',
    }))
    const applied = await ctx.dshGateway.applyModels({
      models: selected,
      expectedRevision: discovered.settingsRevision,
    })
    expect(applied.changed === true, 'Gateway did not apply the cpa provider route')
    expect(ctx.llm.listProviders().some((provider) => provider.id === 'cpa'), 'official llm-pi-ai did not register cpa')

    const probe = await ctx.dshGateway.probe({
      model: 'fake-text-model',
      prompt: 'phase 3 Loader probe',
    }, new AbortController().signal)
    expect(probe.ok === true, 'Gateway probe failed through the official provider')
    expect(probe.ok && probe.blocks.some((block) => block.type === 'text' && block.text === 'Hello from fake CPA.'), 'Gateway probe text drifted')

    const hostTypert = await import(pathToFileURL(join(root, 'packages', 'gateway', 'lib', 'typert.host.js')).href)
    const remoteTypert = await import(pathToFileURL(join(root, 'packages', 'gateway', 'lib', 'typert.remote-client.js')).href)
    expect(hostTypert.TYPERT?.package === '@wha1echai/dsh-gateway', 'Host Typert contribution is missing')
    expect(remoteTypert.TYPERT_REMOTE?.descriptors?.length === 11, 'Remote endpoint count drifted')

    await ctx.loader.remove('gateway')
    await ctx.loader.await()
    expect(ctx.get('dshGateway') === undefined, 'Gateway service survived Loader removal')

    process.stdout.write(JSON.stringify({
      result: 'PASS',
      loader: 'built-entry',
      models: discovered.models.length,
      remoteEndpoints: remoteTypert.TYPERT_REMOTE.descriptors.length,
      provider: 'cpa',
      probe: 'text',
      unloaded: true,
    }) + '\n')
  } finally {
    await ctx?.fiber.dispose()
    await fixture.close()
    await rm(home, { recursive: true, force: true })
  }
}

await main()
