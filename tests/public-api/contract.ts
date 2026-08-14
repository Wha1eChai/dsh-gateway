import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  API_REMOTE_FORWARDED_EVENTS,
  apply as applyApiRemotes,
} from '@deepseek-ai/dsh-api-remotes'
import {
  TypertGatewayService,
  type InvokeRemoteRequest,
} from '@deepseek-ai/dsh-api-gateway'
import {
  CredentialProvider,
  credentialRef,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  ClientModuleSystem,
  type ClientModuleLoader,
  type ClientPluginHandoff,
} from '@deepseek-ai/dsh-client-modules/client'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import {
  scrubbedParentEnv,
  SubprocessRuntime,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

const settingsNs = settingsNamespace('llm-pi-ai')
const proxyRef: CredentialRef = credentialRef('DSH_GATEWAY_PROXY')
const forwardedEvent: (typeof API_REMOTE_FORWARDED_EVENTS)[number] = 'credentials/updated'
const stateRoot: string = resolveDshHome(undefined, { DSH_HOME: 'C:/dsh-public-api-probe' })
const parentEnv: Record<string, string> = scrubbedParentEnv()

const mutation: readonly SettingsPathOp[] = [
  { op: 'set', path: ['endpoint'], value: 'http://127.0.0.1:8317' },
  { op: 'unset', path: ['obsolete'] },
]

const spawnSpec: SubprocessSpawnSpec = {
  argv: ['cli-proxy-api', '--config', `${stateRoot}/runtime/cpa/config.yaml`],
  cwd: stateRoot,
  stdio: {
    stdin: 'ignore',
    stdout: { maxBytes: 4096 },
    stderr: { maxBytes: 4096 },
  },
  graceMs: 5_000,
  env: parentEnv,
}

/** Compile-only proof for settings namespace mutation and revision handling. */
export function settingsMutationContract(
  provider: SettingsProvider,
  expectedRevision: number,
): Promise<void> {
  return provider.mutate(settingsNs, mutation, expectedRevision)
}

/** Compile-only proof for per-operation credential reference resolution. */
export async function credentialsContract(provider: CredentialProvider): Promise<void> {
  const resolved = await provider.resolve(proxyRef)
  const described = await provider.describe(proxyRef)
  if (resolved !== undefined && described.configured) await provider.set(proxyRef, resolved.value)
  await provider.unset(proxyRef)
}

/** Compile-only proof for explicit argv/cwd/stdio/graceMs subprocess shape. */
export function subprocessContract(runtime: SubprocessRuntime): void {
  void runtime.spawn(spawnSpec)
  void runtime.resolveExecutable(spawnSpec.argv[0] ?? 'cli-proxy-api', parentEnv)
}

/** Compile-only proof for Host-side Typert dispatch and Remote event typing. */
export function remotesContract(ctx: Context): Promise<unknown> {
  const gateway = new TypertGatewayService(ctx)
  const request: InvokeRemoteRequest = {
    namespace: 'gateway',
    method: 'status',
    args: {},
  }
  void applyApiRemotes()
  void forwardedEvent
  return gateway.invoke(request)
}

/** Compile-only proof for the Cordis Loader and public client handoff types. */
export function loaderAndClientContract(ctx: Context): ClientModuleLoader {
  const loader = new Loader(ctx)
  void loader.create({ name: '@wha1echai/dsh-gateway' })

  const handoff: ClientPluginHandoff = {
    id: '@wha1echai/dsh-gateway',
    factory: () => ({ apply: (_clientContext: ClientContext) => undefined }),
  }
  void handoff

  const modules = new ClientModuleSystem({
    modules: [{ id: handoff.id, url: '/plugins/wha1echai.gateway/client.js', rev: 'probe' }],
    staticModules: {},
  })
  const publicLoader: ClientModuleLoader = modules
  void publicLoader.import(handoff.id, '', {})
  return publicLoader
}
