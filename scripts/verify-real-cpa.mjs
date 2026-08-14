import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM_ROOT = resolve(ROOT, 'packages', 'platform', 'win32-x64')
const CPA_VERSION = '7.2.131'
const LOOPBACK_HOST = '127.0.0.1'
const READINESS_TIMEOUT_MS = 15_000
const READINESS_INTERVAL_MS = 100
const REQUEST_TIMEOUT_MS = 2_000
const GRACE_MS = 2_000
const CAPTURE_MAX_BYTES = 1_024 * 1_024
let activeSecrets = []

class VerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VerificationError'
  }
}

function assert(condition, message) {
  if (!condition) throw new VerificationError(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPathInside(parent, child) {
  const fromParent = relative(parent, child)
  return isAbsolute(fromParent) === false
    && fromParent !== '..'
    && !fromParent.startsWith(`..${'\\'}`)
    && !fromParent.startsWith(`..${'/'}`)
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function readJson(filePath, label) {
  let value
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new VerificationError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert(isRecord(value), `${label} must be a JSON object`)
  return value
}

async function verifyPlatformAsset() {
  const manifestPath = join(PLATFORM_ROOT, 'package.json')
  const provenancePath = join(PLATFORM_ROOT, 'provenance', 'cli-proxy-api.json')
  const managedConfigPath = join(PLATFORM_ROOT, 'config', 'managed.yaml')
  const manifest = await readJson(manifestPath, 'win32-x64 platform manifest')
  const provenance = await readJson(provenancePath, 'win32-x64 CLIProxyAPI provenance')
  const managedConfig = await readFile(managedConfigPath, 'utf8')

  assert(manifest.name === '@wha1echai/dsh-gateway-platform-win32-x64', 'win32-x64 platform package name drifted')
  assert(manifest.version === '0.1.0', 'win32-x64 platform package version drifted')
  assert(Array.isArray(manifest.os) && manifest.os.includes('win32'), 'win32-x64 platform manifest lost win32 targeting')
  assert(Array.isArray(manifest.cpu) && manifest.cpu.includes('x64'), 'win32-x64 platform manifest lost x64 targeting')
  assert(isRecord(manifest.wha1echaiPlatform), 'win32-x64 platform metadata is missing')
  assert(typeof manifest.wha1echaiPlatform.binary === 'string', 'win32-x64 platform binary metadata is missing')
  assert(typeof manifest.wha1echaiPlatform.provenance === 'string', 'win32-x64 platform provenance metadata is missing')
  assert(typeof manifest.wha1echaiPlatform.managedConfig === 'string', 'win32-x64 platform config metadata is missing')
  assert(manifest.wha1echaiPlatform.provenance === 'provenance/cli-proxy-api.json', 'platform provenance path drifted')
  assert(manifest.wha1echaiPlatform.managedConfig === 'config/managed.yaml', 'platform managed config path drifted')

  assert(provenance.schemaVersion === 1, 'CLIProxyAPI provenance schema drifted')
  assert(isRecord(provenance.upstream) && provenance.upstream.tag === `v${CPA_VERSION}`, 'CLIProxyAPI provenance release drifted')
  assert(provenance.upstream.asset === 'CLIProxyAPI_7.2.131_windows_amd64.zip', 'CLIProxyAPI provenance asset drifted')
  assert(isRecord(provenance.target) && provenance.target.os === 'win32' && provenance.target.cpu === 'x64', 'CLIProxyAPI provenance target drifted')
  assert(isRecord(provenance.executable), 'CLIProxyAPI executable provenance is missing')
  assert(provenance.executable.path === 'vendor/cli-proxy-api.exe', 'CLIProxyAPI executable provenance path drifted')
  assert(typeof provenance.executable.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(provenance.executable.sha256), 'CLIProxyAPI executable SHA-256 is invalid')
  assert(/plugins:\r?\n\s+enabled:\s+false\b/u.test(managedConfig), 'bundled managed config does not disable plugins')

  const binaryPath = resolve(PLATFORM_ROOT, manifest.wha1echaiPlatform.binary)
  assert(isPathInside(PLATFORM_ROOT, binaryPath), 'bundled CLIProxyAPI binary escaped the platform package')
  const actualSha256 = await sha256File(binaryPath)
  assert(actualSha256 === provenance.executable.sha256.toLowerCase(), 'bundled CLIProxyAPI binary SHA-256 does not match provenance')

  return { binaryPath, managedConfig }
}

async function findFreeLoopbackPort() {
  const server = (await import('node:net')).createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen({ host: LOOPBACK_HOST, port: 0 }, resolvePromise)
  })
  const address = server.address()
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
  })
  assert(address !== null && typeof address === 'object' && Number.isInteger(address.port) && address.port > 0, 'free loopback port allocation returned no port')
  return address.port
}

function randomSecret() {
  return randomBytes(32).toString('hex')
}

function yamlSingleQuoted(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function buildPrivateConfig({ port, authDir, proxyKey }) {
  return [
    `host: ${yamlSingleQuoted(LOOPBACK_HOST)}`,
    `port: ${port}`,
    'tls:',
    '  enable: false',
    '  cert: ""',
    '  key: ""',
    'remote-management:',
    '  allow-remote: false',
    '  secret-key: ""',
    '  disable-control-panel: true',
    '  disable-auto-update-panel: true',
    `auth-dir: ${yamlSingleQuoted(authDir)}`,
    'api-keys:',
    `  - ${yamlSingleQuoted(proxyKey)}`,
    'debug: false',
    'pprof:',
    '  enable: false',
    `  addr: ${yamlSingleQuoted(`${LOOPBACK_HOST}:0`)}`,
    'plugins:',
    '  enabled: false',
    'commercial-mode: true',
    'logging-to-file: false',
    'logs-max-total-size-mb: 0',
    'error-logs-max-files: 0',
    'usage-statistics-enabled: true',
    'redis-usage-queue-retention-seconds: 60',
    'proxy-url: ""',
    'request-retry: 0',
    'max-retry-credentials: 0',
    'disable-cooling: true',
    'ws-auth: true',
    '',
  ].join('\n')
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function getJson(url, bearer) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await getJson(`${baseUrl}/healthz`)
      if (response.status === 200 && isRecord(response.body) && response.body.status === 'ok') return
    } catch {
      // The bounded readiness window owns connection failures while CPA binds.
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await sleep(Math.min(READINESS_INTERVAL_MS, remaining))
  }
  throw new VerificationError('bounded GET /healthz readiness did not return HTTP 200 with exact status ok')
}

function requireHttp200(response, route) {
  assert(response.status === 200, `${route} returned unexpected HTTP status ${response.status}`)
}

function requireOpenAiModelList(body) {
  assert(isRecord(body) && body.object === 'list' && Array.isArray(body.data), 'GET /v1/models did not return an OpenAI model list')
  for (const [index, model] of body.data.entries()) {
    assert(isRecord(model) && model.object === 'model' && typeof model.id === 'string' && model.id.length > 0, `GET /v1/models returned an invalid model at index ${index}`)
  }
}

async function assertPortClosed(port) {
  await new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port })
    let settled = false
    const timer = setTimeout(() => {
      finish()
      reject(new VerificationError(`loopback port ${port} remained open after CPA termination`))
    }, REQUEST_TIMEOUT_MS)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
    }
    socket.once('connect', () => {
      finish()
      reject(new VerificationError(`loopback port ${port} accepted a connection after CPA termination`))
    })
    socket.once('error', () => {
      finish()
      resolvePromise()
    })
  })
}

async function assertNoSecretOutput(handle, secrets) {
  const streams = [
    ['stdout', handle.collected.stdout],
    ['stderr', handle.collected.stderr],
  ]
  for (const [label, reader] of streams) {
    if (reader === undefined) continue
    const capture = reader.readFrom(0)
    let output = capture.text
    if (capture.spillPath !== undefined) output += await readFile(capture.spillPath, 'utf8')
    if (capture.lossy && capture.spillPath === undefined) throw new VerificationError(`${label} capture was truncated before secret scanning`)
    for (const secret of secrets) {
      assert(!output.includes(secret), `${label} exposed a configured secret`)
    }
  }
}

async function stopAndJoin(handle) {
  handle.terminate()
  const exited = await handle.waitForExit()
  assert(exited === true, 'subprocess waitForExit was interrupted before the CPA tree closed')
  await handle.done
}

async function run() {
  assert(process.platform === 'win32' && process.arch === 'x64', `requires win32-x64; current platform is ${process.platform}-${process.arch}`)

  // Keep the asset/provenance check first: no temp state, secrets, or child runtime is created before this gate passes.
  const asset = await verifyPlatformAsset()
  const [{ Context }, { LocalSubprocessRuntime }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-subprocess-local'),
  ])

  let tempDir
  let context
  let subprocessFiber
  let child
  let childStopped = false
  let port
  let secrets = []
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-gateway-real-cpa-'))
    const authDir = join(tempDir, 'auth')
    await mkdir(authDir, { recursive: true })
    port = await findFreeLoopbackPort()
    const proxyKey = randomSecret()
    const managementKey = randomSecret()
    const wrongManagementKey = randomSecret()
    secrets = [proxyKey, managementKey, wrongManagementKey]
    activeSecrets = secrets
    const absoluteExe = join(tempDir, 'cli-proxy-api.exe')
    const absoluteConfig = join(tempDir, 'private.yaml')
    await copyFile(asset.binaryPath, absoluteExe)
    await writeFile(absoluteConfig, buildPrivateConfig({ port, authDir, proxyKey }), { encoding: 'utf8', mode: 0o600 })

    context = new Context()
    subprocessFiber = context.plugin(LocalSubprocessRuntime)
    await subprocessFiber
    const subprocess = context.subprocess
    assert(subprocess instanceof LocalSubprocessRuntime, 'Cordis did not provide a LocalSubprocessRuntime')

    const spec = {
      argv: [absoluteExe, '-config', absoluteConfig, '-local-model'],
      cwd: tempDir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: CAPTURE_MAX_BYTES },
        stderr: { maxBytes: CAPTURE_MAX_BYTES },
      },
      graceMs: GRACE_MS,
      env: { MANAGEMENT_PASSWORD: managementKey },
    }
    assert(spec.argv.length === 4 && spec.argv[0] === absoluteExe && spec.argv[1] === '-config' && spec.argv[2] === absoluteConfig && spec.argv[3] === '-local-model', 'CPA argv does not match the required direct launch')
    child = subprocess.spawn(spec)

    const baseUrl = `http://${LOOPBACK_HOST}:${port}`
    await waitForHealth(baseUrl)

    const models = await getJson(`${baseUrl}/v1/models`, proxyKey)
    requireHttp200(models, 'GET /v1/models')
    requireOpenAiModelList(models.body)

    const wrongAuthFiles = await getJson(`${baseUrl}/v0/management/auth-files`, wrongManagementKey)
    assert(wrongAuthFiles.status >= 400 && wrongAuthFiles.status < 500, 'management auth-files accepted the wrong key')

    const authFiles = await getJson(`${baseUrl}/v0/management/auth-files`, managementKey)
    requireHttp200(authFiles, 'GET /v0/management/auth-files')
    assert(isRecord(authFiles.body) && Array.isArray(authFiles.body.files), 'GET /v0/management/auth-files did not return a files array')

    const usageQueue = await getJson(`${baseUrl}/v0/management/usage-queue?count=10`, managementKey)
    requireHttp200(usageQueue, 'GET /v0/management/usage-queue?count=10')
    assert(Array.isArray(usageQueue.body), 'GET /v0/management/usage-queue?count=10 did not return an array')

    await stopAndJoin(child)
    childStopped = true
    await assertNoSecretOutput(child, secrets)
    await assertPortClosed(port)

    return {
      status: 'PASS',
      platform: 'win32-x64',
      cpaVersion: CPA_VERSION,
      models: models.body.data.length,
      authFiles: authFiles.body.files.length,
      usageQueue: usageQueue.body.length,
    }
  } finally {
    if (child !== undefined && !childStopped) {
      try {
        await stopAndJoin(child)
      } catch {
        // Preserve the original verification failure; context disposal remains the final cleanup guard.
      }
    }
    if (context !== undefined) await context.fiber.dispose()
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    activeSecrets = []
  }
}

function redact(text, secrets) {
  let output = text
  for (const secret of secrets) {
    if (secret.length > 0) output = output.replaceAll(secret, '<redacted>')
  }
  return output
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  process.stdout.write(`[verify-real-cpa] SKIP: requires win32-x64; current=${process.platform}-${process.arch}\n`)
} else {
  try {
    const summary = await run()
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } catch (error) {
    process.stderr.write(`[verify-real-cpa] FAIL: ${redact(error instanceof Error ? error.message : String(error), activeSecrets)}\n`)
    process.exitCode = 1
  }
}
