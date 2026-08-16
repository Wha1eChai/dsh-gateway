/// <reference types="node" />

import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as runtimePlugin from './index.js'
import {
  GatewayRuntime,
  RuntimeOwnerLock,
  discoverBundledPlatformAsset,
  readBundledPlatformAsset,
  resolveRuntimePaths,
  type ProcessHandle,
  type RuntimePaths,
  type SubprocessSpawner,
} from './index.js'

const testRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-runtime-test-'))
  testRoots.push(root)
  return root
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function createPlatformPackage(options: { expectedSha256?: string; binaryText?: string } = {}) {
  const root = await temporaryRoot()
  const packageRoot = join(root, 'platform')
  const binaryText = options.binaryText ?? 'fake-cpa-binary'
  const binaryPath = join(packageRoot, 'vendor', 'fake-cpa')
  const provenancePath = join(packageRoot, 'provenance', 'cli-proxy-api.json')
  const configPath = join(packageRoot, 'config', 'managed.yaml')
  await mkdir(join(packageRoot, 'vendor'), { recursive: true })
  await mkdir(join(packageRoot, 'provenance'), { recursive: true })
  await mkdir(join(packageRoot, 'config'), { recursive: true })
  await writeFile(binaryPath, binaryText)
  await writeFile(configPath, 'plugins:\n  enabled: false\n')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@fixture/dsh-gateway-platform-win32-x64',
    version: '0.1.0',
    os: ['win32'],
    cpu: ['x64'],
    dshappsPlatform: {
      binary: 'vendor/fake-cpa',
      provenance: 'provenance/cli-proxy-api.json',
      managedConfig: 'config/managed.yaml',
      upstreamAsset: 'fixture.zip',
    },
  }))
  await writeFile(provenancePath, JSON.stringify({
    schemaVersion: 1,
    package: {
      name: '@fixture/dsh-gateway-platform-win32-x64',
      version: '0.1.0',
    },
    upstream: {
      repository: 'fixture/cpa',
      tag: 'v7.2.131',
      releaseUrl: 'https://example.invalid/cpa',
      asset: 'fixture.zip',
      assetSha256: '0'.repeat(64),
    },
    target: { os: 'win32', cpu: 'x64' },
    executable: {
      path: 'vendor/fake-cpa',
      upstreamName: 'fake-cpa',
      sha256: options.expectedSha256 ?? sha256(binaryText),
    },
    managedConfiguration: { 'plugins.enabled': false },
    platformPolicy: 'fixture',
    licenseFiles: ['LICENSE'],
  }))
  return readBundledPlatformAsset(packageRoot)
}

function readyFetcher(): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const pathname = new URL(input).pathname
    if (pathname === '/healthz') {
      return new Response(JSON.stringify({
        status: 'ok',
        version: '7.2.131',
        capabilities: { protocol: 'openai-compatible' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (pathname === '/v1/models') {
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'fixture-model', object: 'model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

function managedReadyFetcher(): typeof fetch {
  let preflight = true
  return vi.fn(async (input: string | URL) => {
    const pathname = new URL(input).pathname
    if (preflight && pathname === '/healthz') {
      preflight = false
      throw new TypeError('connect ECONNREFUSED')
    }
    if (pathname === '/healthz') {
      return new Response(JSON.stringify({
        status: 'ok',
        version: '7.2.131',
        capabilities: { protocol: 'openai-compatible' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (pathname === '/v1/models') {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model' }] }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

function unavailableFetcher(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('connect ECONNREFUSED')
  }) as typeof fetch
}

function malformedFetcher(): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    if (new URL(input).pathname === '/healthz') return new Response('{not-json', { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
}

function createFakeSpawner(options: {
  autoExit?: { exitCode: number | null; signal: NodeJS.Signals | null }
  deferTerminate?: boolean
} = {}) {
  let resolveDone!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveDone = resolve
  })
  const handle: ProcessHandle = {
    pid: 4242,
    done,
    terminate: vi.fn(() => {
      if (!options.deferTerminate) resolveDone({ exitCode: null, signal: 'SIGTERM' })
    }),
    waitForExit: vi.fn(async () => {
      await done
      return true
    }),
  }
  let spec: Parameters<SubprocessSpawner['spawn']>[0] | undefined
  const spawner: SubprocessSpawner = {
    spawn: vi.fn((spawnSpec) => {
      spec = spawnSpec
      if (options.autoExit) queueMicrotask(() => resolveDone(options.autoExit!))
      return handle
    }),
  }
  return {
    spawner,
    handle,
    get spec() {
      return spec
    },
    exit: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => resolveDone(outcome),
  }
}

function createRestartableSpawner() {
  let running = false
  let nextPid = 6000
  const specs: Parameters<SubprocessSpawner['spawn']>[0][] = []
  const spawner: SubprocessSpawner = {
    spawn: vi.fn((spec) => {
      specs.push(spec)
      running = true
      let resolveDone!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        resolveDone = resolve
      })
      return {
        pid: nextPid++,
        done,
        terminate: vi.fn(() => {
          running = false
          resolveDone({ exitCode: null, signal: 'SIGTERM' })
        }),
        waitForExit: vi.fn(async () => {
          await done
          return true
        }),
      }
    }),
  }
  const fetcher = vi.fn(async (input: string | URL) => {
    if (!running) throw new TypeError('connect ECONNREFUSED')
    if (new URL(input).pathname === '/healthz') {
      return new Response(JSON.stringify({ status: 'ok', version: '7.2.131' }), { status: 200 })
    }
    return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
  }) as typeof fetch
  return { spawner, specs, fetcher }
}

async function managedRuntime(options: {
  fetcher?: typeof fetch
  spawner?: SubprocessSpawner
  asset?: Awaited<ReturnType<typeof createPlatformPackage>>
  paths?: RuntimePaths
  readinessTimeoutMs?: number
} = {}) {
  const home = await temporaryRoot()
  const asset = options.asset ?? await createPlatformPackage()
  const paths = options.paths ?? resolveRuntimePaths({ dshHome: home })
  const spawner = options.spawner ?? createFakeSpawner().spawner
  const runtime = new GatewayRuntime({
    config: {
      mode: 'managed',
      port: 18317,
      readinessTimeoutMs: options.readinessTimeoutMs ?? 200,
      readinessIntervalMs: 5,
      graceMs: 25,
      managedEnv: {
        DSH_GATEWAY_TEST: 'explicit',
      },
    },
    paths,
    asset,
    subprocess: spawner,
    fetch: options.fetcher ?? managedReadyFetcher(),
  })
  return { runtime, asset, paths, spawner }
}

describe('runtime paths and bundled assets', () => {
  it('resolves the one gateway state root below DSH_HOME', async () => {
    const home = await temporaryRoot()
    const paths = resolveRuntimePaths({ dshHome: home })

    expect(paths.stateDir).toBe(join(home, 'dsh-gateway', 'v1'))
    expect(paths.runtimeDir).toBe(join(home, 'dsh-gateway', 'v1', 'runtime'))
    expect(paths.lockFile).toBe(join(home, 'dsh-gateway', 'v1', 'runtime.lock'))
  })

  it('discovers the current platform package through installed package metadata', async () => {
    const asset = await createPlatformPackage()
    const discovered = await discoverBundledPlatformAsset({
      platform: 'win32',
      arch: 'x64',
      resolvePackageJson: () => join(asset.packageRoot, 'package.json'),
    })

    expect(discovered.packageName).toBe('@fixture/dsh-gateway-platform-win32-x64')
    expect(discovered.binarySourcePath).toBe(join(asset.packageRoot, 'vendor', 'fake-cpa'))
    expect(discovered.expectedSha256).toBe(sha256('fake-cpa-binary'))
  })

  it('rejects a bundled asset hash mismatch before changing the active release', async () => {
    const asset = await createPlatformPackage({ expectedSha256: '0'.repeat(64) })
    const home = await temporaryRoot()
    const runtime = new GatewayRuntime({
      config: { mode: 'managed', port: 18317 },
      paths: resolveRuntimePaths({ dshHome: home }),
      asset,
      subprocess: createFakeSpawner().spawner,
    })

    await expect(runtime.install()).rejects.toMatchObject({ code: 'asset_hash_mismatch' })
    await expect(access(join(home, 'dsh-gateway', 'v1', 'runtime', 'current.json'))).rejects.toBeDefined()
  })
})

describe('runtime ownership', () => {
  it('recovers a stale PID lock and rejects a live duplicate owner', async () => {
    const root = await temporaryRoot()
    const lockPath = join(root, 'runtime.lock')
    await mkdir(root, { recursive: true })
    await writeFile(lockPath, JSON.stringify({ pid: 999999, token: 'stale', acquiredAt: 0 }))

    const recovered = new RuntimeOwnerLock(lockPath, { isProcessAlive: async () => false })
    await recovered.acquire()
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(process.pid)

    const duplicate = new RuntimeOwnerLock(lockPath)
    await expect(duplicate.acquire()).rejects.toMatchObject({ code: 'runtime_owner_exists' })
    await recovered.release()
  })
})

describe('managed runtime lifecycle', () => {
  it('installs, starts with an explicit direct spawn spec, and stops cleanly', async () => {
    const process = createFakeSpawner()
    const { runtime, paths } = await managedRuntime({ spawner: process.spawner })
    await runtime.install()

    const started = await runtime.start()
    expect(started.state).toBe('ready')
    expect(runtime.deviceLoginTarget()).toEqual({
      binaryPath: started.release!.binaryPath,
      configPath: paths.managedConfigFile,
      cwd: started.release!.directory,
    })
    expect(process.spec).toBeDefined()
    expect(Object.keys(process.spec!).sort()).toEqual(['argv', 'cwd', 'env', 'graceMs', 'stdio'])
    expect(process.spec!.argv).toEqual([process.spec!.argv[0], '-config', paths.managedConfigFile, '-local-model'])
    expect(process.spec!.argv[0]).toContain('fake-cpa')
    expect(process.spec!.argv).not.toContain('--host')
    expect(process.spec!.argv).not.toContain('--port')
    const managedConfig = await readFile(paths.managedConfigFile, 'utf8')
    expect(managedConfig).toContain('host: 127.0.0.1')
    expect(managedConfig).toContain('port: 18317')
    expect(managedConfig).toContain('plugins:\n  enabled: false')
    expect(process.spec!.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: 65536 },
      stderr: { maxBytes: 65536 },
    })
    expect(process.spec!.graceMs).toBe(25)
    expect(process.spec!.env).toEqual({ DSH_GATEWAY_TEST: 'explicit' })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'duplicate_start' })
    await runtime.stop()
    expect(runtime.snapshot().state).toBe('stopped')
    expect(() => runtime.deviceLoginTarget()).toThrow(/must be ready/)
    expect(process.handle.terminate).toHaveBeenCalledTimes(1)
  })

  it('fails a managed start when the configured port already serves a compatible CPA', async () => {
    const process = createFakeSpawner()
    const { runtime } = await managedRuntime({ spawner: process.spawner, fetcher: readyFetcher() })
    await runtime.install()

    await expect(runtime.start()).rejects.toMatchObject({ code: 'port_occupied', compatible: true })
    expect(process.spawner.spawn).not.toHaveBeenCalled()
  })

  it('fails loud when the configured port is occupied by an incompatible listener', async () => {
    const process = createFakeSpawner()
    const { runtime } = await managedRuntime({ spawner: process.spawner, fetcher: malformedFetcher() })
    await runtime.install()

    await expect(runtime.start()).rejects.toMatchObject({ code: 'port_occupied', compatible: false })
    expect(process.spawner.spawn).not.toHaveBeenCalled()
  })

  it('fails a managed start on startup timeout and terminates the child', async () => {
    const process = createFakeSpawner()
    const { runtime } = await managedRuntime({
      spawner: process.spawner,
      fetcher: unavailableFetcher(),
      readinessTimeoutMs: 30,
    })
    await runtime.install()

    await expect(runtime.start()).rejects.toMatchObject({ code: 'startup_timeout' })
    expect(runtime.snapshot().state).toBe('failed')
    expect(process.handle.terminate).toHaveBeenCalled()
  })

  it('reports a child crash after readiness without restarting indefinitely', async () => {
    const process = createFakeSpawner()
    const { runtime } = await managedRuntime({ spawner: process.spawner })
    await runtime.install()
    await runtime.start()

    process.exit({ exitCode: 17, signal: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.snapshot().state).toBe('failed')
    expect(runtime.snapshot().lastError?.code).toBe('child_exit')
    expect(process.spawner.spawn).toHaveBeenCalledTimes(1)
    await runtime.stop()
  })

  it('disposes the process and transitions to disabled', async () => {
    const process = createFakeSpawner()
    const { runtime } = await managedRuntime({ spawner: process.spawner })
    await runtime.install()
    await runtime.start()

    await runtime.dispose()
    expect(runtime.snapshot().state).toBe('disabled')
    expect(process.handle.terminate).toHaveBeenCalledTimes(1)
  })

  it('restarts the managed child on the same persisted loopback port', async () => {
    const asset = await createPlatformPackage()
    const home = await temporaryRoot()
    const paths = resolveRuntimePaths({ dshHome: home })
    let running = false
    let nextPid = 5000
    const handles: ProcessHandle[] = []
    const fetcher = vi.fn(async (input: string | URL) => {
      if (!running) throw new TypeError('connect ECONNREFUSED')
      if (new URL(input).pathname === '/healthz') return new Response(JSON.stringify({ status: 'ok', version: '7.2.131' }), { status: 200 })
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model' }] }), { status: 200 })
    }) as typeof fetch
    const spawner: SubprocessSpawner = {
      spawn: vi.fn(() => {
        running = true
        let resolveDone!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveDone = resolve })
        const handle: ProcessHandle = {
          pid: nextPid++,
          done,
          terminate: vi.fn(() => {
            running = false
            resolveDone({ exitCode: null, signal: 'SIGTERM' })
          }),
          waitForExit: vi.fn(async () => {
            await done
            return true
          }),
        }
        handles.push(handle)
        return handle
      }),
    }
    const runtime = new GatewayRuntime({
      config: { mode: 'managed', port: 18318, readinessTimeoutMs: 200, readinessIntervalMs: 5 },
      paths,
      asset,
      subprocess: spawner,
      fetch: fetcher,
    })
    await runtime.install()
    await runtime.start()
    await runtime.stop()
    await runtime.restart()
    expect(spawner.spawn).toHaveBeenCalledTimes(2)
    expect(runtime.snapshot().port).toBe(18318)
    await runtime.stop()
    expect(handles).toHaveLength(2)
  })
})

describe('external runtime probe', () => {
  it('validates credential references without resolving values and probes health and models', async () => {
    const fetcher = readyFetcher()
    const runtime = new GatewayRuntime({
      config: {
        mode: 'external',
        endpoint: 'http://127.0.0.1:18317',
        credentialRefs: { proxyCredentialRef: credentialRef('DSH_GATEWAY_PROXY') },
      },
      fetch: fetcher,
    })

    const snapshot = await runtime.start()
    expect(snapshot.state).toBe('ready')
    expect(() => runtime.deviceLoginTarget()).toThrow(/external mode/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(snapshot.health?.capabilities).toMatchObject({ models: 'available' })
  })

  it('treats an authenticated-required models response as a compatible CPA endpoint', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (new URL(input).pathname === '/healthz') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      return new Response('Missing API key', { status: 401 })
    }) as typeof fetch
    const runtime = new GatewayRuntime({
      config: { mode: 'external', endpoint: 'http://127.0.0.1:18317' },
      fetch: fetcher,
    })

    const snapshot = await runtime.start()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.health?.capabilities).toMatchObject({ models: 'authentication-required' })
  })

  it('enters degraded state for an unavailable or incompatible endpoint', async () => {
    const unavailable = new GatewayRuntime({
      config: { mode: 'external', endpoint: 'http://127.0.0.1:18317' },
      fetch: unavailableFetcher(),
    })
    expect((await unavailable.start()).state).toBe('degraded')
    expect(unavailable.snapshot().lastError?.code).toBe('endpoint_unavailable')

    const incompatible = new GatewayRuntime({
      config: { mode: 'external', endpoint: 'http://127.0.0.1:18317' },
      fetch: malformedFetcher(),
    })
    expect((await incompatible.start()).state).toBe('degraded')
    expect(incompatible.snapshot().lastError?.code).toBe('endpoint_incompatible')
  })
})

describe('Cordis runtime composition', () => {
  function provideSubprocess(ctx: Context, spawner: SubprocessSpawner): () => void {
    return ctx.provide('subprocess', spawner as Context['subprocess'])
  }

  function provideCredentials(
    ctx: Context,
    resolve: Context['credentials']['resolve'] = vi.fn(async () => undefined),
  ): () => void {
    return ctx.provide('credentials', { resolve } as Context['credentials'])
  }

  it('provides one truthful external runtime and removes it on unload', async () => {
    const ctx = new Context()
    const process = createFakeSpawner()
    const removeSubprocess = provideSubprocess(ctx, process.spawner)
    const resolveCredential = vi.fn<Context['credentials']['resolve']>(async () => undefined)
    const removeCredentials = provideCredentials(ctx, resolveCredential)
    vi.stubGlobal('fetch', readyFetcher())

    expect(runtimePlugin.inject).toEqual(['subprocess', 'credentials'])
    const fiber = ctx.plugin(runtimePlugin, {
      mode: 'external',
      endpoint: 'http://127.0.0.1:18317',
    })
    await fiber

    const runtime = ctx.get('cpaRuntime')
    expect(runtime).toBeInstanceOf(GatewayRuntime)
    expect(runtime?.snapshot()).toMatchObject({ mode: 'external', state: 'stopped' })
    expect(runtime?.snapshot().pid).toBeUndefined()
    expect((await runtime!.start()).state).toBe('ready')
    expect(process.spawner.spawn).not.toHaveBeenCalled()
    expect(resolveCredential).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(ctx.get('cpaRuntime')).toBeUndefined()
    await removeCredentials()
    await removeSubprocess()
  })

  it('fails loud when a second runtime plugin tries to provide the same service', async () => {
    const ctx = new Context()
    const process = createFakeSpawner()
    const removeSubprocess = provideSubprocess(ctx, process.spawner)
    const removeCredentials = provideCredentials(ctx)
    const config = { mode: 'external', endpoint: 'http://127.0.0.1:18317' } as const
    const first = ctx.plugin(runtimePlugin, config)
    await first
    const firstRuntime = ctx.get('cpaRuntime')

    const duplicate = ctx.plugin(runtimePlugin, config)
    await expect(duplicate.await()).rejects.toThrow(/service "cpaRuntime" has been registered/)
    expect(ctx.get('cpaRuntime')).toBe(firstRuntime)

    await duplicate.dispose()
    await first.dispose()
    await removeCredentials()
    await removeSubprocess()
  })

  it('keeps the service provided until managed stop and lock release finish', async () => {
    const home = await temporaryRoot()
    const laterHome = await temporaryRoot()
    const asset = await createPlatformPackage()
    const process = createFakeSpawner({ deferTerminate: true })
    const ctx = new Context()
    const removeSubprocess = provideSubprocess(ctx, process.spawner)
    const removeCredentials = provideCredentials(ctx)
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', managedReadyFetcher())

    const fiber = ctx.plugin(runtimePlugin, {
      mode: 'managed',
      port: 18319,
      readinessTimeoutMs: 200,
      readinessIntervalMs: 5,
      graceMs: 25,
    })
    await fiber
    const runtime = ctx.cpaRuntime
    vi.stubEnv('DSH_HOME', laterHome)
    await runtime.install(asset)
    await runtime.start()
    const paths = resolveRuntimePaths({ dshHome: home })
    await expect(access(paths.lockFile)).resolves.toBeUndefined()

    let disposed = false
    const disposing = fiber.dispose().then(() => {
      disposed = true
    })
    await vi.waitFor(() => expect(process.handle.terminate).toHaveBeenCalledOnce())
    expect(disposed).toBe(false)
    expect(ctx.get('cpaRuntime')).toBeUndefined()
    expect(ctx.get('cpaRuntime', false)).toBe(runtime)
    await expect(access(paths.lockFile)).resolves.toBeUndefined()

    process.exit({ exitCode: null, signal: 'SIGTERM' })
    await disposing
    expect(runtime.snapshot().state).toBe('disabled')
    expect(ctx.get('cpaRuntime')).toBeUndefined()
    await expect(access(paths.lockFile)).rejects.toBeDefined()
    await expect(access(join(laterHome, 'dsh-gateway', 'v1', 'runtime.lock'))).rejects.toBeDefined()
    await removeCredentials()
    await removeSubprocess()
  })

  it('re-resolves rotating managed credentials and keeps their handoff channels separate', async () => {
    const home = await temporaryRoot()
    const asset = await createPlatformPackage()
    const process = createRestartableSpawner()
    const proxyRef = credentialRef('DSH_GATEWAY_PROXY')
    const managementRef = credentialRef('DSH_GATEWAY_MANAGEMENT')
    let generation = 1
    const resolveCredential = vi.fn<Context['credentials']['resolve']>(async (ref) => {
      if (ref === proxyRef) return { value: `proxy-key-${generation}`, source: 'test' }
      if (ref === managementRef) return { value: `management-key-${generation}`, source: 'test' }
      return undefined
    })
    const ctx = new Context()
    const removeSubprocess = provideSubprocess(ctx, process.spawner)
    const removeCredentials = provideCredentials(ctx, resolveCredential)
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', process.fetcher)
    const fiber = ctx.plugin(runtimePlugin, {
      mode: 'managed',
      port: 18320,
      readinessTimeoutMs: 200,
      readinessIntervalMs: 5,
      managedEnv: { DSH_GATEWAY_TEST: 'explicit' },
      credentialRefs: { proxyCredentialRef: proxyRef, managementCredentialRef: managementRef },
    })
    await fiber
    const runtime = ctx.cpaRuntime
    const paths = resolveRuntimePaths({ dshHome: home })
    await runtime.install(asset)

    await runtime.start()
    const firstConfig = await readFile(paths.managedConfigFile, 'utf8')
    expect(firstConfig).toContain('api-keys:\n  - "proxy-key-1"')
    expect(firstConfig).toContain(`auth-dir: ${JSON.stringify(paths.authDir)}`)
    expect(firstConfig).not.toContain('management-key-1')
    expect(process.specs[0]?.env).toEqual({
      DSH_GATEWAY_TEST: 'explicit',
      MANAGEMENT_PASSWORD: 'management-key-1',
    })
    expect(JSON.stringify(runtime.snapshot())).not.toContain('proxy-key-1')
    expect(JSON.stringify(runtime.snapshot())).not.toContain('management-key-1')

    generation = 2
    await runtime.restart()
    const secondConfig = await readFile(paths.managedConfigFile, 'utf8')
    expect(secondConfig).toContain('api-keys:\n  - "proxy-key-2"')
    expect(secondConfig).not.toContain('proxy-key-1')
    expect(secondConfig).not.toContain('management-key-2')
    expect(process.specs[1]?.env).toEqual({
      DSH_GATEWAY_TEST: 'explicit',
      MANAGEMENT_PASSWORD: 'management-key-2',
    })
    expect(resolveCredential.mock.calls.map(([ref]) => ref)).toEqual([
      proxyRef,
      managementRef,
      proxyRef,
      managementRef,
    ])

    await runtime.stop()
    await expect(access(paths.managedConfigFile)).rejects.toBeDefined()
    await expect(access(paths.authDir)).resolves.toBeUndefined()
    await fiber.dispose()
    await removeCredentials()
    await removeSubprocess()
  })

  it('fails loud before spawn when a configured managed credential is missing', async () => {
    const home = await temporaryRoot()
    const asset = await createPlatformPackage()
    const process = createFakeSpawner()
    const proxyRef = credentialRef('DSH_GATEWAY_PROXY')
    const resolveCredential = vi.fn<Context['credentials']['resolve']>(async () => undefined)
    const ctx = new Context()
    const removeSubprocess = provideSubprocess(ctx, process.spawner)
    const removeCredentials = provideCredentials(ctx, resolveCredential)
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', unavailableFetcher())
    const fiber = ctx.plugin(runtimePlugin, {
      mode: 'managed',
      port: 18321,
      credentialRefs: { proxyCredentialRef: proxyRef },
    })
    await fiber
    const runtime = ctx.cpaRuntime
    const paths = resolveRuntimePaths({ dshHome: home })
    await runtime.install(asset)

    await expect(runtime.start()).rejects.toMatchObject({ code: 'credential_validation_failed' })
    expect(process.spawner.spawn).not.toHaveBeenCalled()
    await expect(access(paths.managedConfigFile)).rejects.toBeDefined()

    await fiber.dispose()
    await removeCredentials()
    await removeSubprocess()
  })

  it('removes credential YAML after startup failure without leaking keys into errors or snapshots', async () => {
    const home = await temporaryRoot()
    const asset = await createPlatformPackage()
    const process = createFakeSpawner()
    const proxyKey = 'proxy-key-must-not-leak'
    const managementKey = 'management-key-must-not-leak'
    const proxyRef = credentialRef('DSH_GATEWAY_PROXY')
    const managementRef = credentialRef('DSH_GATEWAY_MANAGEMENT')
    const resolveCredential = vi.fn<Context['credentials']['resolve']>(async (ref) => ({
      value: ref === proxyRef ? proxyKey : managementKey,
      source: 'test',
    }))
    const ctx = new Context()
    const removeSubprocess = provideSubprocess(ctx, process.spawner)
    const removeCredentials = provideCredentials(ctx, resolveCredential)
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', unavailableFetcher())
    const fiber = ctx.plugin(runtimePlugin, {
      mode: 'managed',
      port: 18322,
      readinessTimeoutMs: 25,
      readinessIntervalMs: 5,
      credentialRefs: { proxyCredentialRef: proxyRef, managementCredentialRef: managementRef },
    })
    await fiber
    const runtime = ctx.cpaRuntime
    const paths = resolveRuntimePaths({ dshHome: home })
    await runtime.install(asset)

    const error = await runtime.start().catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'startup_timeout' })
    const publicFailure = `${String(error)}\n${JSON.stringify(error)}\n${JSON.stringify(runtime.snapshot())}`
    expect(publicFailure).not.toContain(proxyKey)
    expect(publicFailure).not.toContain(managementKey)
    await expect(access(paths.managedConfigFile)).rejects.toBeDefined()

    await fiber.dispose()
    await removeCredentials()
    await removeSubprocess()
  })
})
