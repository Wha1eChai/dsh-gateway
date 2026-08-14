/// <reference types="node" />

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cpaRuntime: GatewayRuntime
  }
}

const require = createRequire(import.meta.url)

export const DEFAULT_MANAGED_PORT = 8317
export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_READINESS_TIMEOUT_MS = 15_000
export const DEFAULT_READINESS_INTERVAL_MS = 250
export const DEFAULT_GRACE_MS = 2_000
export const DEFAULT_OUTPUT_MAX_BYTES = 65_536

export type RuntimeState =
  | 'disabled'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'failed'

export type RuntimeErrorCode =
  | 'runtime_disabled'
  | 'runtime_disposed'
  | 'invalid_transition'
  | 'invalid_configuration'
  | 'runtime_owner_exists'
  | 'asset_not_found'
  | 'asset_hash_mismatch'
  | 'asset_metadata_invalid'
  | 'runtime_not_installed'
  | 'runtime_install_active'
  | 'port_occupied'
  | 'endpoint_invalid'
  | 'endpoint_unavailable'
  | 'endpoint_unauthorized'
  | 'endpoint_incompatible'
  | 'endpoint_unhealthy'
  | 'credential_validation_failed'
  | 'startup_timeout'
  | 'child_exit'
  | 'spawn_failed'
  | 'duplicate_start'

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: RuntimeErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class RuntimeOwnerError extends RuntimeError {
  constructor() {
    super('runtime_owner_exists', 'another managed runtime owner is active')
  }
}

export class AssetHashMismatchError extends RuntimeError {
  readonly expected: string
  readonly actual: string

  constructor(filePath: string, expected: string, actual: string) {
    super('asset_hash_mismatch', 'bundled runtime asset SHA-256 verification failed', {
      filePath,
      expected,
      actual,
    })
    this.expected = expected
    this.actual = actual
  }
}

export class PortOccupiedError extends RuntimeError {
  readonly compatible: boolean

  constructor(compatible: boolean) {
    super('port_occupied', compatible
      ? 'managed runtime port is occupied by a compatible CPA; configure external mode explicitly'
      : 'managed runtime port is occupied by an incompatible endpoint')
    this.compatible = compatible
  }
}

export class StartupTimeoutError extends RuntimeError {
  constructor() {
    super('startup_timeout', 'managed runtime readiness probe timed out')
  }
}

export class ChildExitError extends RuntimeError {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  constructor(outcome: SubprocessOutcome) {
    super('child_exit', 'managed runtime exited before readiness', {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    })
    this.exitCode = outcome.exitCode
    this.signal = outcome.signal
  }
}

export interface CredentialReferences {
  readonly proxyCredentialRef?: CredentialRef
  readonly managementCredentialRef?: CredentialRef
}

export type ManagedBootstrapEnvironment = Readonly<Record<string, string | undefined>>

export interface ManagedRuntimeConfig {
  readonly mode: 'managed'
  readonly port?: number
  readonly readinessTimeoutMs?: number
  readonly readinessIntervalMs?: number
  readonly graceMs?: number
  readonly stdoutMaxBytes?: number
  readonly stderrMaxBytes?: number
  /** Explicit CPA bootstrap values only; no ambient credential inheritance is allowed. */
  readonly managedEnv?: ManagedBootstrapEnvironment
  readonly credentialRefs?: CredentialReferences
  readonly enabled?: boolean
}

export interface ExternalRuntimeConfig {
  readonly mode: 'external'
  readonly endpoint: string
  readonly probeTimeoutMs?: number
  readonly credentialRefs?: CredentialReferences
  readonly enabled?: boolean
}

export type RuntimeConfig = ManagedRuntimeConfig | ExternalRuntimeConfig

export interface RuntimePaths {
  readonly dshHome: string
  readonly stateDir: string
  readonly runtimeDir: string
  readonly releasesDir: string
  readonly stagingDir: string
  readonly currentFile: string
  readonly configFile: string
  readonly managedConfigFile: string
  readonly authDir: string
  readonly lockFile: string
  readonly diagnosticsDir: string
}

export function resolveRuntimePaths(options: {
  readonly dshHome?: string
  readonly env?: Record<string, string | undefined>
} = {}): RuntimePaths {
  const dshHome = options.env === undefined
    ? resolveDshHome(options.dshHome)
    : resolveDshHome(options.dshHome, options.env)
  const stateDir = join(dshHome, 'dsh-gateway', 'v1')
  const runtimeDir = join(stateDir, 'runtime')
  return {
    dshHome,
    stateDir,
    runtimeDir,
    releasesDir: join(runtimeDir, 'releases'),
    stagingDir: join(runtimeDir, 'staging'),
    currentFile: join(runtimeDir, 'current.json'),
    configFile: join(stateDir, 'runtime-config.json'),
    managedConfigFile: join(runtimeDir, 'managed.yaml'),
    authDir: join(runtimeDir, 'auth'),
    lockFile: join(stateDir, 'runtime.lock'),
    diagnosticsDir: join(stateDir, 'diagnostics'),
  }
}

export interface PlatformPackageMetadata {
  readonly binary: string
  readonly provenance: string
  readonly managedConfig: string
  readonly upstreamAsset: string
}

export interface BundledPlatformAsset {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageRoot: string
  readonly target: { readonly os: string; readonly cpu: string }
  readonly binarySourcePath: string
  readonly managedConfigSourcePath: string
  readonly provenancePath: string
  readonly upstreamAsset: string
  readonly releaseId: string
  readonly expectedSha256: string
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new RuntimeError('asset_metadata_invalid', `platform metadata field ${key} is invalid`)
  return value
}

function safeRelativePath(root: string, file: string): string {
  if (isAbsolute(file) || file.length === 0) throw new RuntimeError('asset_metadata_invalid', 'platform asset paths must be relative')
  const resolved = resolve(root, file)
  const suffix = relative(root, resolved)
  if (suffix.length === 0 || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new RuntimeError('asset_metadata_invalid', 'platform asset path escapes its package')
  }
  return resolved
}

function safeReleaseId(value: string): string {
  const id = value.replace(/^v/, '')
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new RuntimeError('asset_metadata_invalid', 'platform release id is invalid')
  return id
}

export async function readBundledPlatformAsset(packageRoot: string): Promise<BundledPlatformAsset> {
  const resolvedRoot = resolve(packageRoot)
  let manifest: JsonRecord
  try {
    manifest = JSON.parse(await readFile(join(resolvedRoot, 'package.json'), 'utf8')) as JsonRecord
  } catch {
    throw new RuntimeError('asset_metadata_invalid', 'installed platform package metadata is unreadable')
  }
  const platformMetadata = manifest.wha1echaiPlatform
  if (!isRecord(platformMetadata)) throw new RuntimeError('asset_metadata_invalid', 'installed platform package has no asset metadata')
  const packageName = requiredString(manifest, 'name')
  const packageVersion = requiredString(manifest, 'version')
  const metadata: PlatformPackageMetadata = {
    binary: requiredString(platformMetadata, 'binary'),
    provenance: requiredString(platformMetadata, 'provenance'),
    managedConfig: requiredString(platformMetadata, 'managedConfig'),
    upstreamAsset: requiredString(platformMetadata, 'upstreamAsset'),
  }
  const provenancePath = safeRelativePath(resolvedRoot, metadata.provenance)
  let provenance: JsonRecord
  try {
    provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as JsonRecord
  } catch {
    throw new RuntimeError('asset_metadata_invalid', 'installed platform provenance is unreadable')
  }
  const provenancePackage = isRecord(provenance.package) ? provenance.package : undefined
  const target = isRecord(provenance.target) ? provenance.target : undefined
  const upstream = isRecord(provenance.upstream) ? provenance.upstream : undefined
  const executable = isRecord(provenance.executable) ? provenance.executable : undefined
  if (provenancePackage === undefined || target === undefined || upstream === undefined || executable === undefined) {
    throw new RuntimeError('asset_metadata_invalid', 'installed platform provenance is incomplete')
  }
  if (requiredString(provenancePackage, 'name') !== packageName || requiredString(provenancePackage, 'version') !== packageVersion) {
    throw new RuntimeError('asset_metadata_invalid', 'platform provenance package identity does not match its manifest')
  }
  if (requiredString(executable, 'path') !== metadata.binary) {
    throw new RuntimeError('asset_metadata_invalid', 'platform provenance executable path does not match its manifest')
  }
  const os = requiredString(target, 'os')
  const cpu = requiredString(target, 'cpu')
  const expectedSha256 = requiredString(executable, 'sha256').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new RuntimeError('asset_metadata_invalid', 'platform executable SHA-256 is invalid')
  const tag = requiredString(upstream, 'tag')
  const binarySourcePath = safeRelativePath(resolvedRoot, metadata.binary)
  const managedConfigSourcePath = safeRelativePath(resolvedRoot, metadata.managedConfig)
  return {
    packageName,
    packageVersion,
    packageRoot: resolvedRoot,
    target: { os, cpu },
    binarySourcePath,
    managedConfigSourcePath,
    provenancePath,
    upstreamAsset: metadata.upstreamAsset,
    releaseId: safeReleaseId(tag),
    expectedSha256,
  }
}

const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'win32-x64': '@wha1echai/dsh-gateway-platform-win32-x64',
  'win32-arm64': '@wha1echai/dsh-gateway-platform-win32-arm64',
  'darwin-x64': '@wha1echai/dsh-gateway-platform-darwin-x64',
  'darwin-arm64': '@wha1echai/dsh-gateway-platform-darwin-arm64',
  'linux-x64': '@wha1echai/dsh-gateway-platform-linux-x64',
  'linux-arm64': '@wha1echai/dsh-gateway-platform-linux-arm64',
}

export interface PlatformDiscoveryOptions {
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly resolvePackageJson?: (packageName: string) => string
}

export async function discoverBundledPlatformAsset(options: PlatformDiscoveryOptions = {}): Promise<BundledPlatformAsset> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const packageName = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (packageName === undefined) throw new RuntimeError('asset_not_found', `no bundled runtime asset exists for ${platform}/${arch}`)
  const resolvePackageJson = options.resolvePackageJson ?? ((name: string) => require.resolve(`${name}/package.json`))
  let packageJsonPath: string
  try {
    packageJsonPath = resolvePackageJson(packageName)
  } catch {
    throw new RuntimeError('asset_not_found', 'the current platform runtime package is not installed')
  }
  return readBundledPlatformAsset(dirname(packageJsonPath))
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<string> {
  const actual = await sha256File(filePath)
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) throw new AssetHashMismatchError(filePath, expectedSha256.toLowerCase(), actual)
  return actual
}

function isPathInside(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate))
  return suffix.length > 0 && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    await chmod(path, 0o700)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

async function ensureRuntimeDirectories(paths: RuntimePaths): Promise<void> {
  await ensurePrivateDirectory(paths.stateDir)
  await ensurePrivateDirectory(paths.runtimeDir)
  await ensurePrivateDirectory(paths.releasesDir)
  await ensurePrivateDirectory(paths.stagingDir)
  await ensurePrivateDirectory(paths.authDir)
  await ensurePrivateDirectory(paths.diagnosticsDir)
}

async function writeFileAtomically(filePath: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode })
    try {
      await rename(temporaryPath, filePath)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error
      await rm(filePath, { force: true })
      await rename(temporaryPath, filePath)
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600)
}

function renderManagedConfig(source: string, port: number, authDir: string, proxyApiKey?: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const withoutBinding: string[] = []
  let skippingManagedKey = false
  for (const line of lines) {
    const topLevelKey = /^([A-Za-z0-9_-]+):(?:\s|$)/.exec(line)?.[1]
    if (topLevelKey !== undefined) skippingManagedKey = ['host', 'port', 'auth-dir', 'api-keys'].includes(topLevelKey)
    else if (line.length > 0 && !/^\s/.test(line)) skippingManagedKey = false
    if (!skippingManagedKey) withoutBinding.push(line)
  }
  const apiKeys = proxyApiKey === undefined ? '' : `api-keys:\n  - ${JSON.stringify(proxyApiKey)}\n`
  return `${withoutBinding.join('\n').trimEnd()}\nhost: ${LOOPBACK_HOST}\nport: ${port}\nauth-dir: ${JSON.stringify(authDir)}\n${apiKeys}`
}

async function writeManagedConfig(sourcePath: string, targetPath: string, port: number, authDir: string, proxyApiKey?: string): Promise<string> {
  const source = await readFile(sourcePath, 'utf8')
  await writeFileAtomically(targetPath, renderManagedConfig(source, port, authDir, proxyApiKey), 0o600)
  return targetPath
}

export interface RuntimeLockRecord {
  readonly pid: number
  readonly token: string
  readonly acquiredAt: number
}

export interface RuntimeOwnerLockOptions {
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>
  readonly maxRecoveryAttempts?: number
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    return code === 'EPERM'
  }
}

export class RuntimeOwnerLock {
  private readonly token = randomUUID()
  private readonly isAlive: (pid: number) => boolean | Promise<boolean>
  private readonly maxRecoveryAttempts: number
  private acquired = false

  constructor(readonly lockFile: string, options: RuntimeOwnerLockOptions = {}) {
    this.isAlive = options.isProcessAlive ?? isProcessAlive
    this.maxRecoveryAttempts = Math.max(1, options.maxRecoveryAttempts ?? 5)
  }

  async acquire(): Promise<void> {
    if (this.acquired) throw new RuntimeOwnerError()
    await mkdir(dirname(this.lockFile), { recursive: true })
    for (let attempt = 0; attempt < this.maxRecoveryAttempts; attempt += 1) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600)
        try {
          const record: RuntimeLockRecord = { pid: process.pid, token: this.token, acquiredAt: Date.now() }
          await handle.writeFile(JSON.stringify(record), 'utf8')
        } finally {
          await handle.close()
        }
        this.acquired = true
        return
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'EEXIST') throw error
        const existing = await this.readRecord()
        if (existing !== undefined && await this.isAlive(existing.pid)) throw new RuntimeOwnerError()
        const stalePath = `${this.lockFile}.stale-${process.pid}-${randomUUID()}`
        try {
          await rename(this.lockFile, stalePath)
          await rm(stalePath, { force: true })
        } catch (staleError) {
          const staleCode = staleError instanceof Error && 'code' in staleError ? staleError.code : undefined
          if (staleCode !== 'ENOENT') throw staleError
        }
      }
    }
    throw new RuntimeOwnerError()
  }

  async release(): Promise<void> {
    if (!this.acquired) return
    this.acquired = false
    try {
      const existing = await this.readRecord()
      if (existing !== undefined && existing.pid === process.pid && existing.token === this.token) await rm(this.lockFile, { force: true })
    } catch {
      // Disposal is best effort after ownership has already been relinquished locally.
    }
  }

  private async readRecord(): Promise<RuntimeLockRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.lockFile, 'utf8')) as unknown
      if (!isRecord(value) || typeof value.pid !== 'number' || typeof value.token !== 'string' || typeof value.acquiredAt !== 'number') return undefined
      return { pid: value.pid, token: value.token, acquiredAt: value.acquiredAt }
    } catch {
      return undefined
    }
  }
}

export type ProcessHandle = Pick<SubprocessHandle, 'pid' | 'done' | 'terminate' | 'waitForExit'>

export interface SubprocessSpawner {
  spawn(spec: SubprocessSpawnSpec): ProcessHandle
}

export interface EndpointHealthSnapshot {
  readonly endpoint: string
  readonly status: 'ready'
  readonly statusCode: number
  readonly version?: string
  readonly capabilities: Readonly<Record<string, unknown>>
}

export type EndpointProbeKind = 'ready' | 'unavailable' | 'unauthorized' | 'incompatible' | 'unhealthy' | 'invalid'

export interface EndpointProbeResult {
  readonly endpoint: string
  readonly kind: EndpointProbeKind
  readonly statusCode?: number
  readonly reason?: string
  readonly health?: EndpointHealthSnapshot
}

export interface EndpointProbeOptions {
  readonly fetch?: typeof fetch | undefined
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

function endpointBase(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) return undefined
    if (url.hostname.length === 0) return undefined
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

interface JsonFetchResult {
  readonly statusCode: number
  readonly body: unknown
  readonly parseError: boolean
}

async function fetchJson(url: string, options: { readonly fetch: typeof fetch; readonly timeoutMs: number; readonly maxResponseBytes: number }): Promise<JsonFetchResult | EndpointProbeKind> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('probe timeout'))
    }, options.timeoutMs)
  })
  try {
    const response = await Promise.race([
      options.fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store' }),
      timeout,
    ])
    const text = await Promise.race([
      response.text(),
      timeout,
    ])
    if (Buffer.byteLength(text, 'utf8') > options.maxResponseBytes) return 'incompatible'
    try {
      return { statusCode: response.status, body: JSON.parse(text) as unknown, parseError: false }
    } catch {
      return { statusCode: response.status, body: undefined, parseError: true }
    }
  } catch {
    return 'unavailable'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}

function resultWithReason(endpoint: string, kind: EndpointProbeKind, reason?: string, statusCode?: number): EndpointProbeResult {
  return {
    endpoint,
    kind,
    ...(reason === undefined ? {} : { reason }),
    ...(statusCode === undefined ? {} : { statusCode }),
  }
}

export async function probeCpaEndpoint(endpoint: string, options: EndpointProbeOptions = {}): Promise<EndpointProbeResult> {
  const base = endpointBase(endpoint)
  if (base === undefined) return resultWithReason(endpoint, 'invalid', 'endpoint must be an http(s) URL without embedded credentials or query parameters')
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') return resultWithReason(endpoint, 'unavailable', 'fetch is unavailable in this Node runtime')
  const timeoutMs = Math.max(1, options.timeoutMs ?? 2_000)
  const maxResponseBytes = Math.max(1_024, options.maxResponseBytes ?? 256 * 1_024)
  const healthResponse = await fetchJson(`${base}/healthz`, { fetch: fetcher, timeoutMs, maxResponseBytes })
  if (typeof healthResponse === 'string') return resultWithReason(endpoint, healthResponse, healthResponse === 'unavailable' ? 'health endpoint unavailable' : 'health response is malformed')
  if (healthResponse.statusCode === 401 || healthResponse.statusCode === 403) return resultWithReason(endpoint, 'unauthorized', 'health endpoint rejected the request', healthResponse.statusCode)
  if (healthResponse.statusCode < 200 || healthResponse.statusCode >= 300) {
    return resultWithReason(endpoint, healthResponse.statusCode >= 500 ? 'unhealthy' : 'incompatible', 'health endpoint returned an unexpected status', healthResponse.statusCode)
  }
  if (healthResponse.parseError || !isRecord(healthResponse.body) || healthResponse.body.status !== 'ok') return resultWithReason(endpoint, 'incompatible', 'health response is not a CPA health response', healthResponse.statusCode)
  const modelsResponse = await fetchJson(`${base}/v1/models`, { fetch: fetcher, timeoutMs, maxResponseBytes })
  if (typeof modelsResponse === 'string') return resultWithReason(endpoint, modelsResponse, 'models endpoint unavailable or malformed')
  if (modelsResponse.statusCode === 401 || modelsResponse.statusCode === 403) {
    const health: EndpointHealthSnapshot = {
      endpoint,
      status: 'ready',
      statusCode: healthResponse.statusCode,
      capabilities: { models: 'authentication-required' },
      ...(typeof healthResponse.body.version === 'string' ? { version: healthResponse.body.version } : {}),
    }
    return { endpoint, kind: 'ready', statusCode: healthResponse.statusCode, health }
  }
  if (modelsResponse.statusCode < 200 || modelsResponse.statusCode >= 300) {
    return resultWithReason(endpoint, modelsResponse.statusCode >= 500 ? 'unhealthy' : 'incompatible', 'models endpoint returned an unexpected status', modelsResponse.statusCode)
  }
  const health: EndpointHealthSnapshot = {
    endpoint,
    status: 'ready',
    statusCode: healthResponse.statusCode,
    capabilities: { models: 'available' },
    ...(typeof healthResponse.body.version === 'string' ? { version: healthResponse.body.version } : {}),
  }
  return { endpoint, kind: 'ready', statusCode: healthResponse.statusCode, health }
}

export interface RuntimeErrorSnapshot {
  readonly code: RuntimeErrorCode
  readonly message: string
  readonly at: number
}

export interface InstalledRuntimeSnapshot {
  readonly releaseId: string
  readonly sha256: string
  readonly directory: string
  readonly binaryPath: string
  readonly configPath: string
}

export interface RuntimeSnapshot {
  readonly state: RuntimeState
  readonly mode: RuntimeConfig['mode']
  readonly endpoint: string
  readonly port?: number
  readonly pid?: number
  readonly release?: InstalledRuntimeSnapshot
  readonly health?: EndpointHealthSnapshot
  readonly lastError?: RuntimeErrorSnapshot
  readonly updatedAt: number
}

export type CredentialReferenceValidator = (references: CredentialReferences) => void | Promise<void>
export type CredentialResolver = CredentialProvider['resolve']

export interface GatewayRuntimeOptions {
  readonly config: RuntimeConfig
  readonly paths?: RuntimePaths
  readonly asset?: BundledPlatformAsset
  readonly assetDiscovery?: () => Promise<BundledPlatformAsset>
  readonly subprocess?: SubprocessSpawner
  readonly fetch?: typeof fetch
  readonly validateCredentialReferences?: CredentialReferenceValidator
  readonly resolveCredential?: CredentialResolver
  readonly ownerLock?: RuntimeOwnerLock
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

type ChildCompletion =
  | { readonly kind: 'exit'; readonly outcome: SubprocessOutcome }
  | { readonly kind: 'error'; readonly error: unknown }

const ALLOWED_TRANSITIONS: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  disabled: ['stopped'],
  stopped: ['starting', 'disabled'],
  starting: ['ready', 'degraded', 'stopping', 'failed'],
  ready: ['degraded', 'stopping', 'failed'],
  degraded: ['starting', 'stopping', 'stopped', 'failed'],
  stopping: ['stopped', 'disabled', 'failed'],
  failed: ['starting', 'stopping', 'stopped', 'disabled'],
}

function errorCodeForProbe(kind: EndpointProbeKind): RuntimeErrorCode {
  switch (kind) {
    case 'invalid': return 'endpoint_invalid'
    case 'unavailable': return 'endpoint_unavailable'
    case 'unauthorized': return 'endpoint_unauthorized'
    case 'incompatible': return 'endpoint_incompatible'
    case 'unhealthy': return 'endpoint_unhealthy'
    case 'ready': return 'endpoint_unhealthy'
  }
}

function safeRuntimeError(error: unknown, fallback: RuntimeErrorCode = 'spawn_failed'): RuntimeError {
  if (error instanceof RuntimeError) return error
  return new RuntimeError(fallback, 'managed runtime operation failed')
}

export class GatewayRuntime {
  private readonly config: RuntimeConfig
  private readonly paths: RuntimePaths
  private readonly configuredAsset: BundledPlatformAsset | undefined
  private readonly assetDiscovery: () => Promise<BundledPlatformAsset>
  private readonly subprocess: SubprocessSpawner | undefined
  private readonly fetcher: (typeof fetch) | undefined
  private readonly validateCredentials: CredentialReferenceValidator
  private readonly resolveCredential: CredentialResolver | undefined
  private readonly ownerLock: RuntimeOwnerLock
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private state: RuntimeState
  private port: number | undefined
  private endpoint: string
  private health: EndpointHealthSnapshot | undefined
  private lastError: RuntimeErrorSnapshot | undefined
  private installedRelease: InstalledRuntimeSnapshot | undefined
  private processHandle: ProcessHandle | undefined
  private childCompletion: Promise<ChildCompletion> | undefined
  private ownerHeld = false
  private startPromise: Promise<RuntimeSnapshot> | undefined
  private stopRequested = false
  private disposed = false
  private updatedAt: number

  constructor(options: GatewayRuntimeOptions) {
    this.config = options.config
    this.paths = options.paths ?? resolveRuntimePaths()
    this.configuredAsset = options.asset
    this.assetDiscovery = options.assetDiscovery ?? (() => discoverBundledPlatformAsset())
    this.subprocess = options.subprocess
    this.fetcher = options.fetch
    this.validateCredentials = options.validateCredentialReferences ?? (() => undefined)
    this.resolveCredential = options.resolveCredential
    this.ownerLock = options.ownerLock ?? new RuntimeOwnerLock(this.paths.lockFile)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)))
    this.port = options.config.mode === 'managed' ? options.config.port : undefined
    this.endpoint = options.config.mode === 'managed'
      ? `http://${LOOPBACK_HOST}:${this.port ?? DEFAULT_MANAGED_PORT}`
      : options.config.endpoint
    this.state = options.config.enabled === false ? 'disabled' : 'stopped'
    this.updatedAt = this.now()
  }

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      mode: this.config.mode,
      endpoint: this.endpoint,
      updatedAt: this.updatedAt,
      ...(this.port === undefined ? {} : { port: this.port }),
      ...(this.processHandle === undefined ? {} : { pid: this.processHandle.pid }),
      ...(this.installedRelease === undefined ? {} : { release: { ...this.installedRelease } }),
      ...(this.health === undefined ? {} : { health: { ...this.health, capabilities: { ...this.health.capabilities } } }),
      ...(this.lastError === undefined ? {} : { lastError: { ...this.lastError } }),
    }
  }

  async install(asset?: BundledPlatformAsset): Promise<InstalledRuntimeSnapshot> {
    this.ensureNotDisposed()
    if (this.config.mode !== 'managed') throw new RuntimeError('invalid_configuration', 'external mode has no managed asset to install')
    if (this.state === 'ready' || this.state === 'starting' || this.state === 'stopping') throw new RuntimeError('runtime_install_active', 'managed asset installation requires a stopped runtime')
    await ensureRuntimeDirectories(this.paths)
    const selected = asset ?? this.configuredAsset ?? await this.assetDiscovery()
    await this.acquireOwner()
    const releaseDirectoryName = `${safeReleaseId(selected.releaseId)}-${selected.expectedSha256.slice(0, 12)}`
    const releaseDirectory = join(this.paths.releasesDir, releaseDirectoryName)
    const stageDirectory = join(this.paths.stagingDir, `${releaseDirectoryName}-${randomUUID()}`)
    const binaryName = basenameForPath(selected.binarySourcePath)
    const configName = 'managed.yaml'
    try {
      if (!isPathInside(selected.packageRoot, selected.binarySourcePath) || !isPathInside(selected.packageRoot, selected.managedConfigSourcePath) || !isPathInside(selected.packageRoot, selected.provenancePath)) {
        throw new RuntimeError('asset_metadata_invalid', 'bundled asset paths must remain inside the installed platform package')
      }
      await verifyFileSha256(selected.binarySourcePath, selected.expectedSha256)
      await mkdir(stageDirectory, { recursive: true, mode: 0o700 })
      const stagedBinary = join(stageDirectory, binaryName)
      const stagedConfig = join(stageDirectory, configName)
      await copyFile(selected.binarySourcePath, stagedBinary)
      await chmod(stagedBinary, 0o700)
      await verifyFileSha256(stagedBinary, selected.expectedSha256)
      await copyFile(selected.managedConfigSourcePath, stagedConfig)
      await chmod(stagedConfig, 0o600)
      await writeJsonAtomically(join(stageDirectory, 'release.json'), {
        releaseId: selected.releaseId,
        sha256: selected.expectedSha256,
        binaryName,
        configName,
        packageName: selected.packageName,
        packageVersion: selected.packageVersion,
      })
      try {
        await stat(releaseDirectory)
        await verifyFileSha256(join(releaseDirectory, binaryName), selected.expectedSha256)
        await rm(stageDirectory, { recursive: true, force: true })
      } catch {
        await rename(stageDirectory, releaseDirectory)
      }
      const installed: InstalledRuntimeSnapshot = {
        releaseId: selected.releaseId,
        sha256: selected.expectedSha256,
        directory: releaseDirectory,
        binaryPath: join(releaseDirectory, binaryName),
        configPath: join(releaseDirectory, configName),
      }
      await writeJsonAtomically(this.paths.currentFile, {
        releaseId: installed.releaseId,
        sha256: installed.sha256,
        directory: relative(this.paths.runtimeDir, installed.directory),
        binaryName,
        configName,
      })
      this.installedRelease = installed
      return { ...installed }
    } catch (error) {
      await rm(stageDirectory, { recursive: true, force: true })
      throw safeRuntimeError(error, 'asset_metadata_invalid')
    } finally {
      await this.releaseOwner()
    }
  }

  async start(): Promise<RuntimeSnapshot> {
    this.ensureNotDisposed()
    if (this.state === 'disabled') throw new RuntimeError('runtime_disabled', 'runtime is disabled')
    if (this.startPromise !== undefined) throw new RuntimeError('duplicate_start', 'runtime start is already in progress')
    if (this.state === 'ready') throw new RuntimeError('duplicate_start', 'runtime is already ready')
    if (this.state === 'stopping') throw new RuntimeError('invalid_transition', 'runtime is stopping')
    this.stopRequested = false
    const promise = this.startInternal()
    this.startPromise = promise
    try {
      return await promise
    } finally {
      this.startPromise = undefined
    }
  }

  async stop(): Promise<RuntimeSnapshot> {
    if (this.state === 'disabled' || this.state === 'stopped') {
      await this.removeManagedConfig()
      return this.snapshot()
    }
    if (this.state === 'stopping') return this.snapshot()
    const pendingStart = this.state === 'starting' ? this.startPromise : undefined
    if (pendingStart !== undefined) this.stopRequested = true
    this.transition('stopping')
    const handle = this.processHandle
    if (handle !== undefined) await this.terminateAndJoin(handle)
    if (pendingStart !== undefined) {
      try {
        await pendingStart
      } catch {
        // The start path records its bounded failure; stop owns the final state.
      }
    }
    this.processHandle = undefined
    this.childCompletion = undefined
    await this.releaseOwner()
    await this.removeManagedConfig()
    this.health = undefined
    this.transition('stopped')
    this.stopRequested = false
    return this.snapshot()
  }

  async restart(): Promise<RuntimeSnapshot> {
    this.ensureNotDisposed()
    if (this.state === 'disabled') throw new RuntimeError('runtime_disabled', 'runtime is disabled')
    await this.stop()
    return this.start()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.stop()
    if (this.state === 'stopped') this.transition('disabled')
    this.disposed = true
  }

  async probe(): Promise<EndpointProbeResult> {
    this.ensureNotDisposed()
    const timeoutMs = this.config.mode === 'external'
      ? this.config.probeTimeoutMs ?? 2_000
      : Math.min(this.config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS, 2_000)
    return probeCpaEndpoint(this.endpoint, { fetch: this.fetcher, timeoutMs })
  }

  private async startInternal(): Promise<RuntimeSnapshot> {
    this.transition('starting')
    this.health = undefined
    this.lastError = undefined
    if (this.config.mode === 'external') return this.startExternal()
    return this.startManaged()
  }

  private async startExternal(): Promise<RuntimeSnapshot> {
    if (this.config.mode !== 'external') throw new RuntimeError('invalid_configuration', 'external lifecycle called for managed runtime')
    try {
      if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
      validateCredentialReferences(this.config.credentialRefs)
      await this.validateCredentials(this.config.credentialRefs ?? {})
    } catch {
      if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
      const error = new RuntimeError('credential_validation_failed', 'external credential references failed validation')
      this.failDegraded(error)
      return this.snapshot()
    }
    if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
    const result = await this.probe()
    if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
    if (result.kind === 'ready' && result.health !== undefined) {
      this.health = result.health
      this.transition('ready')
      return this.snapshot()
    }
    this.failDegraded(new RuntimeError(errorCodeForProbe(result.kind), result.reason ?? 'external endpoint is not ready'))
    return this.snapshot()
  }

  private async startManaged(): Promise<RuntimeSnapshot> {
    if (this.config.mode !== 'managed') throw new RuntimeError('invalid_configuration', 'managed lifecycle called for external runtime')
    if (this.subprocess === undefined) return this.failManaged(new RuntimeError('spawn_failed', 'managed runtime requires a DSH subprocess service'))
    try {
      const installed = await this.loadInstalledRelease()
      const port = await this.resolveAndPersistPort()
      this.port = port
      this.endpoint = `http://${LOOPBACK_HOST}:${port}`
      await this.acquireOwner()
      if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
      const occupied = await probeCpaEndpoint(this.endpoint, {
        fetch: this.fetcher,
        timeoutMs: Math.min(this.config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS, 500),
      })
      if (occupied.kind !== 'unavailable') throw new PortOccupiedError(occupied.kind === 'ready')
      if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
      const credentials = await this.resolveManagedCredentials()
      await ensurePrivateDirectory(this.paths.authDir)
      const managedConfigPath = await writeManagedConfig(installed.configPath, this.paths.managedConfigFile, port, this.paths.authDir, credentials.proxyApiKey)
      const spec = this.createSpawnSpec(installed, managedConfigPath, credentials.managementPassword)
      let handle: ProcessHandle
      try {
        handle = this.subprocess.spawn(spec)
      } catch {
        throw new RuntimeError('spawn_failed', 'managed runtime process could not be spawned')
      }
      this.processHandle = handle
      this.monitorChild(handle)
      const ready = await this.waitForReadiness(handle)
      this.health = ready.health
      this.transition('ready')
      return this.snapshot()
    } catch (error) {
      return this.failManaged(safeRuntimeError(error))
    }
  }

  private async waitForReadiness(handle: ProcessHandle): Promise<EndpointProbeResult & { readonly health: EndpointHealthSnapshot }> {
    if (this.config.mode !== 'managed') throw new RuntimeError('invalid_configuration', 'managed readiness called for external runtime')
    const timeoutMs = this.config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    const intervalMs = this.config.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
      const result = await probeCpaEndpoint(this.endpoint, {
        fetch: this.fetcher,
        timeoutMs: Math.max(1, Math.min(intervalMs, deadline - this.now())),
      })
      if (this.stopRequested) throw new RuntimeError('invalid_transition', 'runtime stop requested')
      if (result.kind === 'ready' && result.health !== undefined) return { ...result, health: result.health }
      if (result.kind === 'incompatible' || result.kind === 'unauthorized' || result.kind === 'invalid') {
        throw new RuntimeError(errorCodeForProbe(result.kind), result.reason ?? 'managed endpoint is incompatible')
      }
      const remaining = deadline - this.now()
      if (remaining <= 0) break
      const completion = this.childCompletion
      if (completion === undefined) {
        await this.sleep(Math.min(intervalMs, remaining))
      } else {
        const winner = await Promise.race([
          completion.then((value) => ({ kind: 'child' as const, value })),
          this.sleep(Math.min(intervalMs, remaining)).then(() => ({ kind: 'timer' as const })),
        ])
        if (winner.kind === 'child') {
          if (winner.value.kind === 'error') throw new RuntimeError('spawn_failed', 'managed runtime process failed while starting')
          throw new ChildExitError(winner.value.outcome)
        }
      }
    }
    // Read the handle so an implementation cannot optimize away the lifecycle ownership argument.
    void handle.pid
    throw new StartupTimeoutError()
  }

  private createSpawnSpec(installed: InstalledRuntimeSnapshot, managedConfigPath: string, managementPassword?: string): SubprocessSpawnSpec {
    const managedEnv: NodeJS.ProcessEnv = {
      ...(this.config.mode === 'managed' ? this.config.managedEnv : undefined),
    }
    delete managedEnv.MANAGEMENT_PASSWORD
    if (managementPassword !== undefined) managedEnv.MANAGEMENT_PASSWORD = managementPassword
    return {
      argv: [installed.binaryPath, '-config', managedConfigPath, '-local-model'],
      cwd: installed.directory,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.mode === 'managed' ? this.config.stdoutMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES : DEFAULT_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: this.config.mode === 'managed' ? this.config.stderrMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES : DEFAULT_OUTPUT_MAX_BYTES },
      },
      graceMs: this.config.mode === 'managed' ? this.config.graceMs ?? DEFAULT_GRACE_MS : DEFAULT_GRACE_MS,
      env: managedEnv,
    }
  }

  private monitorChild(handle: ProcessHandle): void {
    const completion = handle.done.then(
      (outcome): ChildCompletion => ({ kind: 'exit', outcome }),
      (error): ChildCompletion => ({ kind: 'error', error }),
    )
    this.childCompletion = completion
    void completion.then((result) => {
      if (this.processHandle !== handle) return
      if (this.state === 'starting') {
        this.lastError = this.errorSnapshot(result.kind === 'exit' ? new ChildExitError(result.outcome) : new RuntimeError('spawn_failed', 'managed runtime process failed'))
        this.transition('failed')
      } else if (this.state === 'ready' || this.state === 'degraded') {
        this.lastError = this.errorSnapshot(result.kind === 'exit' ? new ChildExitError(result.outcome) : new RuntimeError('spawn_failed', 'managed runtime process failed'))
        this.transition('failed')
      }
    })
  }

  private async terminateAndJoin(handle: ProcessHandle): Promise<void> {
    try {
      handle.terminate()
      await handle.waitForExit()
    } catch {
      // The DSH subprocess service owns escalation; disposal still releases the runtime owner.
    }
  }

  private async loadInstalledRelease(): Promise<InstalledRuntimeSnapshot> {
    if (this.installedRelease !== undefined) return this.installedRelease
    let value: unknown
    try {
      value = JSON.parse(await readFile(this.paths.currentFile, 'utf8')) as unknown
    } catch {
      throw new RuntimeError('runtime_not_installed', 'managed runtime has no verified installed release')
    }
    if (!isRecord(value) || typeof value.releaseId !== 'string' || typeof value.sha256 !== 'string' || typeof value.directory !== 'string' || typeof value.binaryName !== 'string' || typeof value.configName !== 'string') {
      throw new RuntimeError('runtime_not_installed', 'managed runtime selection metadata is invalid')
    }
    const directory = resolve(this.paths.runtimeDir, value.directory)
    const binaryPath = resolve(directory, value.binaryName)
    const configPath = resolve(directory, value.configName)
    if (!isPathInside(this.paths.runtimeDir, directory) || !isPathInside(directory, binaryPath) || !isPathInside(directory, configPath)) {
      throw new RuntimeError('runtime_not_installed', 'managed runtime selection path is invalid')
    }
    await verifyFileSha256(binaryPath, value.sha256)
    this.installedRelease = { releaseId: value.releaseId, sha256: value.sha256, directory, binaryPath, configPath }
    return this.installedRelease
  }

  private async resolveAndPersistPort(): Promise<number> {
    const configuredPort = this.config.mode === 'managed' ? this.config.port : undefined
    const port = configuredPort ?? await this.readPersistedPort() ?? DEFAULT_MANAGED_PORT
    validatePort(port)
    await writeJsonAtomically(this.paths.configFile, { mode: 'managed', port })
    return port
  }

  private async readPersistedPort(): Promise<number | undefined> {
    try {
      const value = JSON.parse(await readFile(this.paths.configFile, 'utf8')) as unknown
      if (isRecord(value) && value.mode === 'managed' && typeof value.port === 'number') return value.port
    } catch {
      // No persisted setup is the normal first-start path.
    }
    return undefined
  }

  private async acquireOwner(): Promise<void> {
    if (this.ownerHeld) throw new RuntimeOwnerError()
    await this.ownerLock.acquire()
    this.ownerHeld = true
  }

  private async releaseOwner(): Promise<void> {
    if (!this.ownerHeld) return
    this.ownerHeld = false
    await this.ownerLock.release()
  }

  private failDegraded(error: RuntimeError): void {
    this.lastError = this.errorSnapshot(error)
    this.transition('degraded')
  }

  private async failManaged(error: RuntimeError): Promise<RuntimeSnapshot> {
    const handle = this.processHandle
    if (handle !== undefined) await this.terminateAndJoin(handle)
    this.processHandle = undefined
    this.childCompletion = undefined
    await this.releaseOwner()
    await this.removeManagedConfig()
    if (this.stopRequested) {
      this.lastError = undefined
      if (this.state === 'stopping') this.transition('stopped')
      throw error
    }
    this.lastError = this.errorSnapshot(error)
    if (this.state !== 'failed') this.transition('failed')
    throw error
  }

  private errorSnapshot(error: RuntimeError): RuntimeErrorSnapshot {
    return { code: error.code, message: error.message, at: this.now() }
  }

  private transition(next: RuntimeState): void {
    if (this.state === next) return
    if (!ALLOWED_TRANSITIONS[this.state].includes(next)) throw new RuntimeError('invalid_transition', `runtime cannot transition from ${this.state} to ${next}`)
    this.state = next
    this.updatedAt = this.now()
  }

  private ensureNotDisposed(): void {
    if (this.disposed) throw new RuntimeError('runtime_disposed', 'runtime has been disposed')
  }

  private async resolveManagedCredentials(): Promise<{
    readonly proxyApiKey?: string
    readonly managementPassword?: string
  }> {
    if (this.config.mode !== 'managed') return {}
    const references = this.config.credentialRefs
    validateCredentialReferences(references)
    if (references === undefined || (references.proxyCredentialRef === undefined && references.managementCredentialRef === undefined)) return {}
    if (this.resolveCredential === undefined) throw new RuntimeError('credential_validation_failed', 'managed credential resolver is unavailable')
    const resolveValue = async (reference: CredentialRef | undefined): Promise<string | undefined> => {
      if (reference === undefined) return undefined
      try {
        const resolved = await this.resolveCredential!(reference)
        if (resolved === undefined || resolved.value.length === 0) throw new Error('missing credential')
        return resolved.value
      } catch {
        throw new RuntimeError('credential_validation_failed', 'configured managed credential is unavailable')
      }
    }
    const proxyApiKey = await resolveValue(references.proxyCredentialRef)
    const managementPassword = await resolveValue(references.managementCredentialRef)
    return {
      ...(proxyApiKey === undefined ? {} : { proxyApiKey }),
      ...(managementPassword === undefined ? {} : { managementPassword }),
    }
  }

  private async removeManagedConfig(): Promise<void> {
    if (this.config.mode === 'managed') await rm(this.paths.managedConfigFile, { force: true })
  }
}

function basenameForPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (name.length === 0 || name === '.' || name === '..') throw new RuntimeError('asset_metadata_invalid', 'platform executable name is invalid')
  return name
}

function validateCredentialReferences(references: CredentialReferences | undefined): void {
  for (const value of [references?.proxyCredentialRef, references?.managementCredentialRef]) {
    if (value === undefined) continue
    try {
      credentialRef(value)
    } catch {
      throw new RuntimeError('credential_validation_failed', 'credential reference is invalid')
    }
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RuntimeError('invalid_configuration', 'managed runtime port must be between 1 and 65535')
}

/** Compatibility alias for callers that prefer the shorter controller name. */
export const RuntimeController = GatewayRuntime

export const inject = ['subprocess', 'credentials']

/** Compose one runtime service into the current Cordis plugin fiber. */
export function apply(ctx: Context, config: RuntimeConfig): void {
  const paths = resolveRuntimePaths()
  const runtime = new GatewayRuntime({
    config,
    paths,
    subprocess: ctx.subprocess,
    resolveCredential: (reference) => ctx.credentials.resolve(reference),
  })
  ctx.effect(function* provideRuntime() {
    yield ctx.provide('cpaRuntime', runtime)
    yield () => runtime.dispose()
  }, 'cpaRuntime lifecycle')
}
