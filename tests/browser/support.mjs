/*
 * The packed-profile and process-lifecycle portions of this helper are
 * adapted from dsh-webpage's MIT-licensed tests/browser/support.mjs and
 * tests/phase5/packed-profile.mjs (Wha1eChai). The Gateway-specific profile
 * composition, fake CPA wiring, and browser assertions are original here.
 */

import { spawn, spawnSync } from 'node:child_process'
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { startFakeCpa } from '../fixtures/fake-cpa/index.js'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const RELEASE_TAG = 'v0.1.0'
const RELEASE_DIR = resolve(process.env.DSH_GATEWAY_PHASE6_RELEASE_DIR ?? join(ROOT, '.staging', 'release', RELEASE_TAG, 'local'))
const PROFILE_NAME = 'web'
const EXPECTED_DSH_VERSION = '0.1.0-rc.6'
const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/u
const READY_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 15_000
const PACKAGE_FILES = Object.freeze({
  webpage: 'dshapps-webpage-0.2.0.tgz',
  gateway: 'dshapps-dsh-gateway-0.1.0.tgz',
  runtime: 'dshapps-dsh-gateway-runtime-0.1.0.tgz',
  analytics: 'dshapps-dsh-gateway-analytics-0.1.0.tgz',
  pack: 'dshapps-dsh-gateway-pack-0.1.0.tgz',
  zod: 'zod-4.4.3.tgz',
  platform: {
    'win32-x64': 'dshapps-dsh-gateway-platform-win32-x64-0.1.0.tgz',
    'win32-arm64': 'dshapps-dsh-gateway-platform-win32-arm64-0.1.0.tgz',
    'darwin-x64': 'dshapps-dsh-gateway-platform-darwin-x64-0.1.0.tgz',
    'darwin-arm64': 'dshapps-dsh-gateway-platform-darwin-arm64-0.1.0.tgz',
    'linux-x64': 'dshapps-dsh-gateway-platform-linux-x64-0.1.0.tgz',
    'linux-arm64': 'dshapps-dsh-gateway-platform-linux-arm64-0.1.0.tgz',
  },
})
const PACKAGE_NAMES = Object.freeze({
  webpage: '@dshapps/webpage',
  gateway: '@dshapps/dsh-gateway',
  runtime: '@dshapps/dsh-gateway-runtime',
  analytics: '@dshapps/dsh-gateway-analytics',
  pack: '@dshapps/dsh-gateway-pack',
})
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function fail(message, cause) {
  const error = new Error(message)
  if (cause !== undefined) error.cause = cause
  throw error
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function normalized(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isWithin(parent, candidate) {
  const child = normalized(relative(resolve(parent), resolve(candidate)))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

function runSync(command, args, options = {}, label = `${command} ${args.join(' ')}`) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) fail(`${label} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    const output = commandOutput(result)
    fail(`${label} exited with ${String(result.status)}${output.length === 0 ? '' : `:\n${output}`}`)
  }
  return result.stdout ?? ''
}

function currentPnpmCommand() {
  const npmExecPath = process.env.npm_execpath
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0 && existsSync(npmExecPath)) {
    const version = runSync(process.execPath, [npmExecPath, '--version'], { capture: true }, 'pnpm --version').trim()
    if (version === '11.7.0') return Object.freeze({ cli: resolve(npmExecPath), prefix: Object.freeze([]) })
  }

  if (process.platform === 'win32') {
    const matches = runSync('where.exe', ['corepack.cmd'], { capture: true }, 'where.exe corepack.cmd')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const command of matches) {
      const corepackCli = join(dirname(command), 'node_modules', 'corepack', 'dist', 'corepack.js')
      if (!existsSync(corepackCli)) continue
      const version = runSync(process.execPath, [corepackCli, 'pnpm@11.7.0', '--version'], { capture: true }, 'corepack pnpm@11.7.0 --version').trim()
      assert(version === '11.7.0', `corepack resolved pnpm ${version}`)
      return Object.freeze({ cli: corepackCli, prefix: Object.freeze(['pnpm@11.7.0']) })
    }
  }

  fail('could not locate pnpm 11.7.0 through npm_execpath or Corepack')
}

function locateDshInstallation() {
  if (process.platform !== 'win32') {
    const executable = runSync('which', ['dsh'], { capture: true }, 'which dsh').trim()
    return validateDshInstallation(resolve(dirname(realpathSync(executable)), '..'))
  }

  const matches = runSync('where.exe', ['dsh.cmd'], { capture: true }, 'where.exe dsh.cmd')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  assert(matches.length > 0, 'where.exe found no dsh.cmd')
  for (const command of matches) {
    const packageRoot = join(dirname(command), 'node_modules', '@deepseek-ai', 'dsh')
    if (existsSync(join(packageRoot, 'package.json'))) return validateDshInstallation(packageRoot)
  }
  fail(`could not resolve @deepseek-ai/dsh beside: ${matches.join(', ')}`)
}

function validateDshInstallation(packageRoot) {
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert(manifest.name === '@deepseek-ai/dsh', `resolved CLI package is ${manifest.name}`)
  assert(manifest.version === EXPECTED_DSH_VERSION, `expected DSH ${EXPECTED_DSH_VERSION}, found ${manifest.version}`)
  const binPath = join(packageRoot, manifest.bin?.dsh ?? 'lib/bin.js')
  assert(existsSync(binPath), `installed DSH bin does not exist: ${binPath}`)
  const reportedVersion = runSync(process.execPath, [binPath, '--version'], { capture: true }, 'dsh --version').trim()
  assert(reportedVersion === EXPECTED_DSH_VERSION, `dsh bin reports ${reportedVersion}`)
  return Object.freeze({ packageRoot: resolve(packageRoot), binPath: resolve(binPath), version: manifest.version })
}

async function createTempRoot() {
  const tempBase = resolve(await realpath(tmpdir()))
  const created = await mkdtemp(join(tempBase, 'dsh-gateway-phase6-'))
  const canonical = resolve(await realpath(created))
  assert(canonical !== tempBase && isWithin(tempBase, canonical), `validated temp root escaped the system temp directory: ${canonical}`)
  return canonical
}

async function createPnpmShim(tempRoot, pnpm) {
  const binDirectory = join(tempRoot, 'bin')
  await mkdir(binDirectory, { recursive: true })
  assert(isWithin(tempRoot, binDirectory), 'temporary pnpm shim escaped the disposable profile')
  if (process.platform === 'win32') {
    const shim = join(binDirectory, 'pnpm.cmd')
    const prefix = pnpm.prefix.map((value) => ` "${value}"`).join('')
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${pnpm.cli}"${prefix} %*\r\n`, 'utf8')
  } else {
    const shim = join(binDirectory, 'pnpm')
    const prefix = pnpm.prefix.map((value) => ` "${value}"`).join('')
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${pnpm.cli}"${prefix} "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  }
  return binDirectory
}

async function ensureLocalRelease() {
  const platformKey = `${process.platform}-${process.arch}`
  const platformFile = PACKAGE_FILES.platform[platformKey]
  assert(platformFile !== undefined, `unsupported browser host ${platformKey}`)
  const required = [
    PACKAGE_FILES.webpage,
    PACKAGE_FILES.gateway,
    PACKAGE_FILES.runtime,
    PACKAGE_FILES.analytics,
    PACKAGE_FILES.pack,
    PACKAGE_FILES.zod,
    platformFile,
  ]
  const missing = () => required.filter((file) => !existsSync(join(RELEASE_DIR, file)))
  if (process.env.DSH_GATEWAY_PHASE6_REBUILD === '1' || missing().length > 0) {
    const pnpm = currentPnpmCommand()
    console.log('Phase 6: building packed local release artifacts from the current checkout…')
    runSync(
      process.execPath,
      [pnpm.cli, ...pnpm.prefix, 'run', 'pack:build'],
      {
        cwd: ROOT,
        env: { ...process.env, npm_execpath: pnpm.cli },
      },
      'corepack pnpm@11.7.0 run pack:build',
    )
  }
  const remaining = missing()
  assert(remaining.length === 0, `Phase 6 local release artifacts are missing: ${remaining.join(', ')}; run \`corepack pnpm@11.7.0 run pack:build\``)
  return Object.freeze({
    platformKey,
    paths: Object.freeze(Object.fromEntries(required.map((file) => [file, join(RELEASE_DIR, file)]))),
  })
}

function localPathSpecifier(filePath) {
  return `file:${filePath.replaceAll('\\', '/')}`
}

async function configureLocalOverrides(profileDirectory, release) {
  const manifestPath = join(profileDirectory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const overrides = Object.fromEntries([
    [PACKAGE_NAMES.webpage, localPathSpecifier(release.paths[PACKAGE_FILES.webpage])],
    [PACKAGE_NAMES.gateway, localPathSpecifier(release.paths[PACKAGE_FILES.gateway])],
    [PACKAGE_NAMES.runtime, localPathSpecifier(release.paths[PACKAGE_FILES.runtime])],
    [PACKAGE_NAMES.analytics, localPathSpecifier(release.paths[PACKAGE_FILES.analytics])],
    ['zod', localPathSpecifier(release.paths[PACKAGE_FILES.zod])],
  ])
  manifest.packageManager = 'pnpm@11.7.0'
  manifest.pnpm = { ...manifest.pnpm, overrides }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const yamlOverrides = Object.entries(overrides)
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
    .join('\n')
  await writeFile(
    join(profileDirectory, 'pnpm-workspace.yaml'),
    `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\noverrides:\n${yamlOverrides}\n`,
    'utf8',
  )
}

async function resolvedPackageRoot(profileDirectory, tempRoot, packageName) {
  const manifestPath = join(profileDirectory, 'node_modules', ...packageName.split('/'), 'package.json')
  await access(manifestPath, constants.F_OK)
  const canonicalManifest = await realpath(manifestPath)
  const root = dirname(canonicalManifest)
  assert(isWithin(tempRoot, root), `${packageName} resolved outside the disposable temp root: ${root}`)
  assert(!isWithin(ROOT, root), `${packageName} resolved back into the source checkout: ${root}`)
  return root
}

function profilePatch(endpoint) {
  const quotedEndpoint = JSON.stringify(endpoint)
  return [
    '- id: gateway-runtime',
    '  config:',
    '    mode: external',
    `    endpoint: ${quotedEndpoint}`,
    '- id: gateway',
    '  config:',
    `    endpoint: ${quotedEndpoint}`,
    '    allowExternalEndpoint: true',
    '    proxyCredentialRef: DSH_GATEWAY_PROXY_KEY',
    '    managementCredentialRef: DSH_GATEWAY_MANAGEMENT_KEY',
    '',
  ].join('\n')
}

async function createPackedGatewayProfile(tempRoot, release, endpoint, dsh) {
  const pnpm = currentPnpmCommand()
  const shimDirectory = await createPnpmShim(tempRoot, pnpm)
  const dshHome = join(tempRoot, 'home')
  const profileDirectory = join(dshHome, 'profiles', PROFILE_NAME)
  const storeDirectory = join(tempRoot, 'pnpm-store')
  await mkdir(dshHome, { recursive: true })
  await mkdir(storeDirectory, { recursive: true })
  const pathValue = `${shimDirectory}${sep === '\\' ? ';' : ':'}${process.env.PATH ?? ''}`
  const env = Object.freeze({
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    PATH: pathValue,
  })
  const runDsh = (args, options = {}) => runSync(
    process.execPath,
    [dsh.binPath, ...args],
    { cwd: ROOT, env, ...options },
    `dsh ${args.join(' ')}`,
  )
  const pnpmOptions = [
    '--ignore-scripts',
    '--config.auto-install-peers=false',
    '--lockfile=false',
    '--offline',
    '--store-dir',
    storeDirectory,
  ]

  runDsh(['plugin', '--profile', PROFILE_NAME, 'install', ...pnpmOptions])
  assert(existsSync(join(profileDirectory, 'package.json')), 'rc.6 dsh plugin install did not initialize the web profile')
  await configureLocalOverrides(profileDirectory, release)
  runDsh(['plugin', '--profile', PROFILE_NAME, 'add', release.paths[PACKAGE_FILES.pack], ...pnpmOptions])

  await writeFile(join(dshHome, '.credentials.yaml'), 'DSH_GATEWAY_PROXY_KEY: phase6-fixture-proxy\nDSH_GATEWAY_MANAGEMENT_KEY: phase6-fixture-management\n', { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), profilePatch(endpoint), 'utf8')

  const manifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'))
  const topLevelWhaDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@dshapps/'))
  assert(JSON.stringify(topLevelWhaDependencies) === JSON.stringify([PACKAGE_NAMES.pack]), `web profile top-level dependencies drifted: ${JSON.stringify(topLevelWhaDependencies)}`)

  const packageRoots = {}
  for (const [key, name] of Object.entries(PACKAGE_NAMES)) {
    packageRoots[key] = await resolvedPackageRoot(profileDirectory, tempRoot, name)
  }
  const profileRequire = createRequire(join(profileDirectory, 'package.json'))
  for (const name of [PACKAGE_NAMES.webpage, PACKAGE_NAMES.gateway]) {
    const clientManifest = profileRequire.resolve(`${name}/package.json`)
    assert(isWithin(tempRoot, clientManifest), `${name} client manifest resolved outside the disposable profile: ${clientManifest}`)
  }
  const dumpConfig = runDsh(['--profile', PROFILE_NAME, '--dump-config'], { capture: true })
  for (const id of ['webpage', 'gateway', 'gateway-runtime', 'gateway-analytics']) {
    assert(dumpConfig.includes(`id: ${id}`), `rc.6 dump-config omitted ${id}`)
  }

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    const tempBase = resolve(await realpath(tmpdir()))
    assert(tempRoot !== tempBase && isWithin(tempBase, tempRoot), `refusing to remove unsafe Phase 6 root: ${tempRoot}`)
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  return Object.freeze({
    dispose,
    dshHome,
    dumpConfig,
    env,
    home: dshHome,
    packageRoots: Object.freeze(packageRoots),
    profileDir: profileDirectory,
    profileDirectory,
    profileName: PROFILE_NAME,
    tempRoot,
    dshInvocation: Object.freeze({
      cwd: ROOT,
      env,
      executable: process.execPath,
      profile: PROFILE_NAME,
      script: dsh.binPath,
    }),
  })
}

function appendOutput(output, chunk) {
  output.value += chunk.toString()
}

function waitForReady(child, output) {
  return new Promise((resolveReady, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      callback(value)
    }
    const onData = () => {
      const match = READY_PATTERN.exec(output.value)
      if (match?.[1] !== undefined) finish(resolveReady, { url: match[1], output: output.value })
    }
    const onError = (error) => finish(reject, new Error(`dsh Web failed before ready:\n${output.value}`, { cause: error }))
    const onExit = (code, signal) => finish(reject, new Error(`dsh Web exited before ready (code ${String(code)}, signal ${String(signal)}):\n${output.value}`))
    const timer = setTimeout(() => finish(reject, new Error(`dsh Web was not ready within ${READY_TIMEOUT_MS}ms:\n${output.value}`)), READY_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveClose) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.off('close', finish)
      resolveClose()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    child.once('close', finish)
  })
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await waitForClose(child, STOP_TIMEOUT_MS)
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
    await waitForClose(child, STOP_TIMEOUT_MS)
  }
  assert(child.exitCode !== null || child.signalCode !== null, `dsh Web process ${String(child.pid)} did not stop`)
}

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch (error) {
    fail('The Phase 6 browser lane requires this project\'s Playwright dependency; run `corepack pnpm@11.7.0 install --frozen-lockfile`.', error)
  }
}

function launchDshWeb(profile) {
  const invocation = profile.dshInvocation
  const env = {
    ...invocation.env,
    DEEPSEEK_API_KEY: 'phase6-browser-no-model-calls',
    DSH_AGENTS_HOME: join(profile.tempRoot, 'agents'),
  }
  const child = spawn(invocation.executable, [invocation.script, 'web', '--port', '0'], {
    cwd: invocation.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { value: '' }
  child.stdout?.on('data', (chunk) => appendOutput(output, chunk))
  child.stderr?.on('data', (chunk) => appendOutput(output, chunk))
  return { child, output, ready: waitForReady(child, output) }
}

async function createOneByOnePng(tempRoot) {
  assert(ONE_BY_ONE_PNG.length >= 24, 'Phase 6 embedded image fixture is too small')
  assert(ONE_BY_ONE_PNG.readUInt32BE(0) === 0x89504e47 && ONE_BY_ONE_PNG.readUInt32BE(4) === 0x0d0a1a0a, 'Phase 6 embedded image fixture is not a PNG')
  assert(ONE_BY_ONE_PNG.toString('ascii', 12, 16) === 'IHDR', 'Phase 6 embedded image fixture has no IHDR')
  assert(ONE_BY_ONE_PNG.readUInt32BE(16) === 1 && ONE_BY_ONE_PNG.readUInt32BE(20) === 1, 'Phase 6 embedded image fixture must be 1x1 PNG')
  const path = join(tempRoot, 'fixtures', 'red.png')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, ONE_BY_ONE_PNG)
  return path
}

export async function createGatewayWebHarness() {
  let fakeCpa
  let tempRoot
  let profile
  let child
  let browser
  let context
  let page
  try {
    const release = await ensureLocalRelease()
    tempRoot = await createTempRoot()
    const imageFixturePath = await createOneByOnePng(tempRoot)
    fakeCpa = await startFakeCpa()
    const dsh = locateDshInstallation()
    profile = await createPackedGatewayProfile(tempRoot, release, fakeCpa.url, dsh)
    const launched = launchDshWeb(profile)
    child = launched.child
    const ready = await launched.ready
    const playwright = await loadPlaywright()
    browser = await playwright.chromium.launch()
    context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1680, height: 1000 },
    })
    page = await context.newPage()
    return Object.freeze({
      browser,
      context,
      dshOutput: () => launched.output.value,
      fakeCpa,
      imageFixturePath,
      page,
      profile,
      baseUrl: ready.url,
      async close() {
        const failures = []
        await browser.close().catch((error) => failures.push(error))
        await stopProcess(child).catch((error) => failures.push(error))
        await fakeCpa.close().catch((error) => failures.push(error))
        await profile.dispose().catch((error) => failures.push(error))
        if (failures.length > 0) throw new AggregateError(failures, 'Phase 6 browser harness cleanup failed')
      },
    })
  } catch (error) {
    const failures = []
    if (browser !== undefined) await browser.close().catch((cleanupError) => failures.push(cleanupError))
    if (child !== undefined) await stopProcess(child).catch((cleanupError) => failures.push(cleanupError))
    if (fakeCpa !== undefined) await fakeCpa.close().catch((cleanupError) => failures.push(cleanupError))
    if (profile !== undefined) await profile.dispose().catch((cleanupError) => failures.push(cleanupError))
    if (profile === undefined && tempRoot !== undefined) {
      const tempBase = resolve(await realpath(tmpdir()))
      if (tempRoot !== tempBase && isWithin(tempBase, tempRoot)) {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((cleanupError) => failures.push(cleanupError))
      }
    }
    if (failures.length > 0) throw new AggregateError([error, ...failures], 'Phase 6 browser harness setup and cleanup failed')
    throw error
  }
}

export async function pageDiagnostics(page) {
  let body = '(body unavailable)'
  try {
    body = (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 10_000)
  } catch {
    // Keep the original assertion as the primary failure when the page is gone.
  }
  return `URL: ${page.url()}\nBody text:\n${body}`
}

export async function waitForVisible(page, locator, label, timeout = 30_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout })
  } catch (error) {
    fail(`${label} was not visible within ${timeout}ms\n${await pageDiagnostics(page)}`, error)
  }
  return locator
}

export async function waitForUrl(page, expected, label) {
  const expectedUrl = new URL(expected, page.url()).href
  try {
    await page.waitForFunction((url) => window.location.href === url, expectedUrl, { timeout: 30_000 })
  } catch (error) {
    fail(`${label} did not reach ${expectedUrl}\n${await pageDiagnostics(page)}`, error)
  }
}

export async function assertHttp200(url) {
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    fail(`real DSH Web URL could not be fetched: ${url}`, error)
  }
  const body = await response.text()
  assert(response.status === 200, `real DSH Web startup expected HTTP 200 at ${url}, got ${response.status}: ${body.slice(0, 2_000)}`)
  assert(body.length > 0, `real DSH Web startup returned an empty HTTP 200 body at ${url}`)
  return body
}

export { EXPECTED_DSH_VERSION, READY_PATTERN }
