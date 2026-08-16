import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

import { GatewayHostService } from '../packages/gateway/lib/index.js'
import * as runtimePlugin from '../packages/runtime/lib/index.js'

const PROXY_REF = 'DSH_GATEWAY_PROXY_KEY'
const MANAGEMENT_REF = 'DSH_GATEWAY_MANAGEMENT_KEY'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  const address = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  assert(address !== null && typeof address === 'object', 'failed to allocate a loopback port')
  return address.port
}

async function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    process.stdout.write(`[verify-managed-first-run] SKIP: current=${process.platform}-${process.arch}\n`)
    return
  }

  const temp = await mkdtemp(join(tmpdir(), 'dsh-gateway-first-run-'))
  const previousHome = process.env.DSH_HOME
  const ctx = new Context()
  let host
  try {
    process.env.DSH_HOME = temp
    const credentialsFiber = ctx.plugin(LocalCredentialProvider, { path: join(temp, '.credentials.yaml'), watch: false })
    const subprocessFiber = ctx.plugin(LocalSubprocessRuntime)
    await Promise.all([credentialsFiber, subprocessFiber])
    const port = await freePort()
    const runtimeFiber = ctx.plugin(runtimePlugin, {
      mode: 'managed',
      port,
      credentialRefs: {
        proxyCredentialRef: credentialRef(PROXY_REF),
        managementCredentialRef: credentialRef(MANAGEMENT_REF),
      },
    })
    await runtimeFiber
    host = new GatewayHostService(ctx, {
      endpoint: `http://127.0.0.1:${port}`,
      allowExternalEndpoint: false,
      proxyCredentialRef: PROXY_REF,
      managementCredentialRef: MANAGEMENT_REF,
    })

    const before = await host.status()
    assert(before.proxyCredential.configured === false, 'first-run fixture unexpectedly began with a proxy credential')
    assert(before.managementCredential.configured === false, 'first-run fixture unexpectedly began with a management credential')
    await host.runtimeInstall()
    const ready = await host.runtimeStart()
    assert(ready.state === 'ready' && ready.mode === 'managed', 'managed runtime did not become ready')

    const after = await host.status()
    assert(after.proxyCredential.configured, 'managed first start did not provision the proxy credential')
    assert(after.managementCredential.configured, 'managed first start did not provision the management credential')
    assert(after.codexAccount === 'not_connected', 'an empty auth directory was mistaken for a connected Codex account')
    const proxy = await ctx.credentials.resolve(credentialRef(PROXY_REF))
    const management = await ctx.credentials.resolve(credentialRef(MANAGEMENT_REF))
    assert(proxy !== undefined && management !== undefined, 'provisioned credentials could not be resolved')

    const models = await fetch(`${ready.endpoint}/v1/models`, {
      headers: { authorization: `Bearer ${proxy.value}` },
    })
    assert(models.status === 200, `provisioned proxy credential was rejected (${models.status})`)
    const accounts = await fetch(`${ready.endpoint}/v0/management/auth-files`, {
      headers: { authorization: `Bearer ${management.value}` },
    })
    assert(accounts.status === 200, `provisioned management credential was rejected (${accounts.status})`)

    await host.runtimeStop()
    process.stdout.write('[verify-managed-first-run] PASS: empty credentials -> install -> start -> authenticated CPA APIs\n')
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(temp, { recursive: true, force: true })
  }
}

await run()
