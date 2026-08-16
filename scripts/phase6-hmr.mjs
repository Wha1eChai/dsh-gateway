import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { createGatewayWebHarness } from '../tests/browser/support.mjs'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GATEWAY_PACKAGE_ROOT = join(PROJECT_ROOT, 'packages', 'gateway')
const APP_ID = '@dshapps/dsh-gateway'
const APP_DESCRIPTOR_ID = 'dshapps.gateway'
const APP_PATH = '/apps/dshapps.gateway/playground'
const APP_LABEL = 'AI Gateway'
const REFERENCE_ID = 'dshapps.webpage'
const ORIGINAL_MARKER = 'Gateway console'
const REPLACEMENT_MARKER = 'Phase 6 Gateway HMR replacement is live.'
const CRASH_ERROR_MESSAGE = 'Phase 6 deterministic Gateway render crash.'
const CRASH_DIAGNOSTIC = `slot entry crashed in 'webpage.app': Error: ${CRASH_ERROR_MESSAGE}`
const TOOLCHAIN_VERSIONS = Object.freeze({ typescript: '6.0.3', tsdown: '0.22.2' })

function fail(message, cause) {
  const error = new Error(message)
  if (cause !== undefined) error.cause = cause
  throw error
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function normalized(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isWithin(parent, candidate) {
  const child = normalized(relative(resolve(parent), resolve(candidate)))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function countOccurrences(text, marker) {
  return text.split(marker).length - 1
}

function hashContent(content) {
  return createHash('sha1').update(content).digest('hex').slice(0, 12)
}

function assertProfilePath(profile, candidate, label) {
  assert(isWithin(profile.tempRoot, candidate), `${label} escaped the disposable profile: ${candidate}`)
  return candidate
}

async function assertProfileRealPath(profile, candidate, label) {
  const canonical = await realpath(candidate)
  assertProfilePath(profile, canonical, label)
  return canonical
}

function runTool(command, args, cwd, label, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const output = []
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NODE_ENV: 'production', ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', chunk => output.push(chunk.toString()))
    child.stderr?.on('data', chunk => output.push(chunk.toString()))
    child.once('error', error => reject(new Error(`${label} failed to start`, { cause: error })))
    child.once('close', code => {
      const text = output.join('').trim()
      if (code !== 0) {
        reject(new Error(`${label} exited with ${String(code)}${text ? `:\n${text}` : ''}`))
        return
      }
      resolvePromise(text)
    })
  })
}

async function createWebHarness() {
  return createGatewayWebHarness()
}

async function copyDirectory(source, destination, profile) {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(source, entry.name)
    const destinationPath = assertProfilePath(profile, join(destination, entry.name), 'copied Gateway fixture target')
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true })
      await copyDirectory(sourcePath, destinationPath, profile)
    } else if (entry.isFile()) {
      await mkdir(dirname(destinationPath), { recursive: true })
      await copyFile(sourcePath, destinationPath)
    } else {
      fail(`Gateway source contains an unsupported fixture entry: ${sourcePath}`)
    }
  }
}

async function removeHmrFixture(profile, fixture, fixtureNodeModules) {
  if (fixtureNodeModules !== undefined) {
    assertProfilePath(profile, fixtureNodeModules, 'temporary Gateway node_modules cleanup target')
    try {
      const stats = await lstat(fixtureNodeModules)
      if (stats.isSymbolicLink()) await unlink(fixtureNodeModules)
      else {
        assert(isWithin(profile.tempRoot, fixtureNodeModules), `refusing to clean an external node_modules directory: ${fixtureNodeModules}`)
        await rm(fixtureNodeModules, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (fixture !== undefined) {
    assertProfilePath(profile, fixture, 'temporary Gateway HMR fixture cleanup target')
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function linkFixtureNodeModules(profile, fixtureNodeModules) {
  const repositoryNodeModules = await realpath(join(PROJECT_ROOT, 'node_modules'))
  assert(!isWithin(profile.tempRoot, repositoryNodeModules), 'repository node_modules unexpectedly resides inside the disposable profile')
  await mkdir(fixtureNodeModules, { recursive: false })
  const linkOne = async (sourcePath, destinationPath) => {
    const source = await realpath(sourcePath)
    const sourceStats = await stat(source)
    await symlink(source, destinationPath, sourceStats.isDirectory() ? 'junction' : 'file')
  }
  for (const entry of await readdir(repositoryNodeModules, { withFileTypes: true })) {
    if (entry.name === '@dshapps' || entry.name === '.pnpm' || entry.name === '.modules.yaml') continue
    const sourcePath = join(repositoryNodeModules, entry.name)
    const destination = assertProfilePath(profile, join(fixtureNodeModules, entry.name), 'linked Gateway fixture dependency')
    if (!entry.name.startsWith('@')) {
      await linkOne(sourcePath, destination)
      continue
    }
    await mkdir(destination, { recursive: false })
    const scopeRoot = await realpath(sourcePath)
    for (const scopedEntry of await readdir(scopeRoot, { withFileTypes: true })) {
      const scopedSource = join(scopeRoot, scopedEntry.name)
      const scopedDestination = assertProfilePath(profile, join(destination, scopedEntry.name), 'linked Gateway scoped dependency')
      await linkOne(scopedSource, scopedDestination)
    }
  }
  const dshappsScope = assertProfilePath(profile, join(fixtureNodeModules, '@dshapps'), 'Gateway fixture package scope')
  await mkdir(dshappsScope, { recursive: false })
  const runtime = await realpath(join(PROJECT_ROOT, 'packages', 'runtime'))
  const webpage = await realpath(join(GATEWAY_PACKAGE_ROOT, 'node_modules', '@dshapps', 'webpage'))
  await symlink(runtime, assertProfilePath(profile, join(dshappsScope, 'dsh-gateway-runtime'), 'Gateway fixture runtime dependency'), 'junction')
  await symlink(webpage, assertProfilePath(profile, join(dshappsScope, 'webpage'), 'Gateway fixture Webpage dependency'), 'junction')
}

async function createHmrFixture(profile, kind) {
  const fixture = assertProfilePath(
    profile,
    join(profile.tempRoot, `phase6-gateway-hmr-${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    'temporary Gateway HMR fixture',
  )
  const fixtureNodeModules = assertProfilePath(profile, join(fixture, 'node_modules'), 'temporary Gateway node_modules junction')
  await mkdir(fixture, { recursive: false })
  try {
    await copyDirectory(join(GATEWAY_PACKAGE_ROOT, 'src'), assertProfilePath(profile, join(fixture, 'src'), 'copied Gateway source'), profile)
    for (const file of ['package.json', 'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts']) {
      await copyFile(join(GATEWAY_PACKAGE_ROOT, file), assertProfilePath(profile, join(fixture, file), 'copied Gateway build config'))
    }
    await copyFile(join(PROJECT_ROOT, 'tsdown.client.ts'), assertProfilePath(profile, join(fixture, 'tsdown.client.ts'), 'copied Gateway root build config'))
    await copyFile(join(PROJECT_ROOT, 'tsconfig.base.json'), assertProfilePath(profile, join(fixture, 'tsconfig.base.json'), 'copied Gateway root TypeScript config'))

    const tsconfig = join(fixture, 'tsconfig.json')
    const tsconfigText = await readFile(tsconfig, 'utf8')
    assert(countOccurrences(tsconfigText, '../../tsconfig.base.json') === 1, 'Gateway fixture tsconfig lost its root-config import')
    await writeFile(tsconfig, tsconfigText.replace('../../tsconfig.base.json', './tsconfig.base.json'), 'utf8')
    const tsconfigClient = join(fixture, 'tsconfig.client.json')
    const tsconfigClientText = await readFile(tsconfigClient, 'utf8')
    assert(countOccurrences(tsconfigClientText, '../../tsconfig.base.json') === 1, 'Gateway fixture client tsconfig lost its root-config import')
    await writeFile(tsconfigClient, tsconfigClientText.replace('../../tsconfig.base.json', './tsconfig.base.json'), 'utf8')
    const tsdownConfig = join(fixture, 'tsdown.config.ts')
    const tsdownConfigText = await readFile(tsdownConfig, 'utf8')
    assert(countOccurrences(tsdownConfigText, '../../tsdown.client.ts') === 1, 'Gateway fixture tsdown config lost its root-config import')
    await writeFile(tsdownConfig, tsdownConfigText.replace('../../tsdown.client.ts', './tsdown.client.ts'), 'utf8')

    await linkFixtureNodeModules(profile, fixtureNodeModules)

    const markerSource = join(fixture, 'src', 'client', 'locales.ts')
    const source = await readFile(markerSource, 'utf8')
    assert(countOccurrences(source, ORIGINAL_MARKER) === 1, 'fresh Gateway source does not contain exactly one original HMR marker')
    const replaced = source.replace(ORIGINAL_MARKER, REPLACEMENT_MARKER)
    assert(countOccurrences(replaced, REPLACEMENT_MARKER) === 1 && countOccurrences(replaced, ORIGINAL_MARKER) === 0, 'Gateway replacement marker transformation failed')
    await writeFile(markerSource, replaced, 'utf8')

    if (kind === 'crash') {
      const crashSource = join(fixture, 'src', 'client', 'GatewayApp.tsx')
      const gatewaySource = await readFile(crashSource, 'utf8')
      const anchor = 'export function GatewayApp({ appPath, close, navigate, remote, t }: GatewayAppProps): ReactNode {\n'
      assert(countOccurrences(gatewaySource, anchor) === 1, 'Gateway source lacks the deterministic crash injection point')
      const crashed = gatewaySource.replace(anchor, `${anchor}  if (appPath === '/playground') throw new Error(${JSON.stringify(CRASH_ERROR_MESSAGE)})\n`)
      assert(countOccurrences(crashed, CRASH_ERROR_MESSAGE) === 1, 'deterministic Gateway crash was not injected exactly once')
      await writeFile(crashSource, crashed, 'utf8')
    }
    return { fixture, fixtureNodeModules }
  } catch (error) {
    await removeHmrFixture(profile, fixture, fixtureNodeModules)
    throw error
  }
}

async function runCopiedGatewayBuild(fixture) {
  const typescriptPackage = JSON.parse(await readFile(join(PROJECT_ROOT, 'node_modules', 'typescript', 'package.json'), 'utf8'))
  const tsdownPackage = JSON.parse(await readFile(join(PROJECT_ROOT, 'node_modules', 'tsdown', 'package.json'), 'utf8'))
  assert(typescriptPackage.version === TOOLCHAIN_VERSIONS.typescript, `unexpected repository TypeScript toolchain: ${typescriptPackage.version}`)
  assert(tsdownPackage.version === TOOLCHAIN_VERSIONS.tsdown, `unexpected repository tsdown toolchain: ${tsdownPackage.version}`)
  const typescriptCli = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const tsdownCli = join(PROJECT_ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  await runTool(process.execPath, [typescriptCli, '-b', 'tsconfig.json', '--pretty', 'false'], fixture, 'Gateway HMR fixture host TypeScript build')
  for (const file of ['typert.remote-client.js', 'typert.remote-client.d.ts']) {
    await copyFile(join(GATEWAY_PACKAGE_ROOT, 'lib', file), join(fixture, 'lib', file))
  }
  await runTool(process.execPath, [typescriptCli, '-b', 'tsconfig.client.json', '--pretty', 'false'], fixture, 'Gateway HMR fixture client TypeScript build')
  await runTool(process.execPath, [tsdownCli, '--env.DSH_BUILD_FACE', 'client'], fixture, 'Gateway HMR fixture client bundle build')
}

async function buildAndInstallCandidate(profile, kind) {
  let fixture
  let fixtureNodeModules
  let staged
  try {
    ({ fixture, fixtureNodeModules } = await createHmrFixture(profile, kind))
    await runCopiedGatewayBuild(fixture)
    const builtBundle = assertProfilePath(profile, join(fixture, 'lib', 'client.js'), 'rebuilt Gateway HMR bundle')
    const rebuilt = await readFile(builtBundle, 'utf8')
    assert(rebuilt.length > 0, `rebuilt Gateway HMR bundle is empty: ${builtBundle}`)
    assert(countOccurrences(rebuilt, REPLACEMENT_MARKER) === 1, `${kind} Gateway bundle must contain the replacement marker exactly once`)
    if (kind === 'crash') assert(countOccurrences(rebuilt, CRASH_ERROR_MESSAGE) === 1, 'Gateway crash bundle must contain the deterministic crash message exactly once')

    const target = assertProfilePath(profile, join(profile.packageRoots.gateway, 'lib', 'client.js'), 'installed Gateway client target')
    await assertProfileRealPath(profile, dirname(target), 'installed Gateway client target directory')
    const original = await readFile(target, 'utf8')
    const originalRev = hashContent(original)
    const candidateRev = hashContent(rebuilt)
    assert(candidateRev !== originalRev, `${kind} Gateway HMR candidate content hash did not change`)

    staged = assertProfilePath(profile, `${target}.phase6-${kind}-next`, 'staged Gateway HMR bundle')
    await copyFile(builtBundle, staged)
    await assertProfileRealPath(profile, dirname(staged), 'staged Gateway HMR bundle directory')
    await rename(staged, target)
    staged = undefined
    assert(hashContent(await readFile(target, 'utf8')) === candidateRev, 'atomic Gateway HMR replacement did not install the candidate content')
    return { target, originalRev, candidateRev }
  } finally {
    if (staged !== undefined) {
      assertProfilePath(profile, staged, 'failed Gateway HMR stage cleanup target')
      await rm(staged, { force: true })
    }
    await removeHmrFixture(profile, fixture, fixtureNodeModules)
  }
}

async function pageDiagnostics(page) {
  let body = '(body unavailable)'
  try {
    body = (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 8_000)
  } catch {
    // Preserve the original assertion as the primary failure when the page is gone.
  }
  return `URL: ${page.url()}\nBody text:\n${body}`
}

async function waitForVisible(page, locator, label, timeout = 30_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout })
  } catch (error) {
    fail(`${label} was not visible within ${timeout}ms\n${await pageDiagnostics(page)}`, error)
  }
  return locator
}

async function dismissTestingNotice(page) {
  const button = page.getByRole('button', { name: 'Continue', exact: true })
  try {
    await button.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (error) {
    if (error?.name === 'TimeoutError') return
    throw error
  }
  await button.click()
  await button.waitFor({ state: 'hidden', timeout: 5_000 })
}

async function installDocumentSentinels(page) {
  await page.evaluate(() => {
    const conversation = document.querySelector('[data-conversation-scroll]')
    if (conversation === null) throw new Error('[data-conversation-scroll] is absent')
    Object.defineProperties(window, {
      __phase6HmrDocument: { configurable: true, value: document },
      __phase6HmrConversation: { configurable: true, value: conversation },
    })
  })
}

async function assertDocumentSentinels(page, label = 'HMR') {
  const state = await page.evaluate(() => {
    const current = document.querySelector('[data-conversation-scroll]')
    return {
      documentSame: window.__phase6HmrDocument === document,
      conversationConnected: window.__phase6HmrConversation?.isConnected === true,
      conversationSame: window.__phase6HmrConversation === current,
    }
  })
  assert(state.documentSame, `${label} replaced the browser document`)
  assert(state.conversationConnected, `${label} disconnected the preserved conversation element`)
  assert(state.conversationSame, `${label} replaced the preserved conversation element`)
}

async function assertGatewayVisible(page, marker, label) {
  const dialog = page.getByRole('dialog', { name: APP_LABEL, exact: true })
  await waitForVisible(page, dialog, `${label} Gateway dialog`)
  await waitForVisible(page, dialog.locator('[data-gateway-app="phase-5"]'), `${label} Gateway App shell`)
  await waitForVisible(page, dialog.locator('[data-gateway-view="playground"]'), `${label} Gateway Playground`)
  assert(await page.getByRole('dialog', { name: APP_LABEL, exact: true }).count() === 1, `${label} has duplicate Gateway dialogs`)
  assert(await dialog.getByText(marker, { exact: true }).count() === 1, `${label} Gateway marker is missing or duplicated`)
  return dialog
}

async function assertClientGraphUnique(page, label) {
  const state = await page.evaluate(id => {
    const entries = window.__DSH_BOOT__?.entries ?? []
    return {
      bootEntries: entries.filter(entry => entry.id === id).length,
      gatewayScripts: [...document.scripts].filter(script => script.src.includes(`/plugins/${id}/client.js`)).length,
    }
  }, APP_ID)
  assert(state.bootEntries === 1, `${label} boot graph has ${state.bootEntries} Gateway entries`)
  assert(state.gatewayScripts <= 1, `${label} document has ${state.gatewayScripts} Gateway client script tags`)
}

async function assertPhaseHasNoUnexpectedDiagnostics(state, label) {
  assert(state.pageErrors.length === 0, `${label} page errors:\n${state.pageErrors.join('\n')}`)
  assert(state.consoleErrors.length === 0, `${label} console errors:\n${state.consoleErrors.join('\n')}`)
  assert(state.consoleWarnings.length === 0, `${label} console warnings:\n${state.consoleWarnings.join('\n')}`)
  assert(state.failedRequests.length === 0, `${label} request failures:\n${state.failedRequests.join('\n')}`)
}

function beginPhase(phases, name) {
  const state = {
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    failedRequests: [],
    cancelledModelRequests: [],
    hmrResponses: [],
    documentRequests: [],
    loadEvents: 0,
    mainFrameNavigations: 0,
  }
  phases.current = name
  phases[name] = state
  return state
}

function endPhase(phases) {
  phases.current = undefined
}

async function openInspectorAndAssertUnrelatedApp(page) {
  await page.evaluate(() => {
    history.pushState(null, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.waitForFunction(() => window.location.pathname === '/')
  await page.getByRole('dialog', { name: APP_LABEL, exact: true }).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Apps', exact: true }).click()
  const inspector = page.getByRole('dialog', { name: 'Webpage', exact: true })
  await waitForVisible(page, inspector.getByRole('heading', { name: 'App Inspector', exact: true }), 'Webpage App Inspector after Gateway HMR')
  assert(await inspector.locator(`[data-app-id="${APP_DESCRIPTOR_ID}"]`).count() === 1, 'Gateway App Inspector entry is missing or duplicated')
  assert(await inspector.locator(`[data-app-id="${REFERENCE_ID}"]`).count() === 1, 'unrelated Webpage Inspector App entry is missing or duplicated')
  await inspector.getByRole('button', { name: 'Close app', exact: true }).click()
  await page.getByRole('dialog', { name: 'Webpage', exact: true }).waitFor({ state: 'hidden' })
}

async function navigateToGatewayPlayground(page, baseUrl) {
  const target = new URL(APP_PATH, baseUrl).href
  await page.evaluate(url => {
    history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, target)
  await page.waitForFunction(url => window.location.href === url, target)
  return assertGatewayVisible(page, REPLACEMENT_MARKER, 'Gateway recovery route')
}

export async function runHmrScenario() {
  let harness
  const phases = { current: undefined }
  try {
    harness = await createWebHarness()
    const { page, baseUrl, profile } = harness
    page.on('pageerror', error => {
      const phase = phases[phases.current]
      if (phase !== undefined) phase.pageErrors.push(String(error))
    })
    page.on('console', message => {
      const phase = phases[phases.current]
      if (phase === undefined) return
      if (message.type() === 'error') phase.consoleErrors.push(message.text())
      if (message.type() === 'warning') phase.consoleWarnings.push(message.text())
    })
    page.on('requestfailed', request => {
      const phase = phases[phases.current]
      if (phase === undefined) return
      const failure = request.failure()?.errorText ?? 'unknown failure'
      const url = new URL(request.url())
      if (failure === 'net::ERR_ABORTED' && url.pathname === '/api/gateway/models') {
        phase.cancelledModelRequests.push(request.url())
        return
      }
      phase.failedRequests.push(`${request.url()}: ${failure}`)
    })
    page.on('request', request => {
      const phase = phases[phases.current]
      if (phase !== undefined && request.resourceType() === 'document') phase.documentRequests.push(request.url())
    })
    page.on('response', response => {
      const phase = phases[phases.current]
      if (phase !== undefined && response.url().includes(`/plugins/${APP_ID}/client.js`)) phase.hmrResponses.push(response.url())
    })
    page.on('load', () => {
      const phase = phases[phases.current]
      if (phase !== undefined) phase.loadEvents += 1
    })
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return
      const phase = phases[phases.current]
      if (phase !== undefined) phase.mainFrameNavigations += 1
    })

    await page.goto(new URL(APP_PATH, baseUrl).href, { waitUntil: 'domcontentloaded' })
    await waitForVisible(page, page.locator('[data-conversation-scroll]'), 'conversation tree before Gateway HMR')
    await dismissTestingNotice(page)
    const initialDialog = page.getByRole('dialog', { name: APP_LABEL, exact: true })
    await waitForVisible(page, initialDialog.locator('[data-gateway-view="playground"]'), 'Gateway Playground before HMR')
    assert(await initialDialog.getByText(ORIGINAL_MARKER, { exact: true }).count() === 1, 'original Gateway marker is missing before HMR')
    await installDocumentSentinels(page)
    await assertClientGraphUnique(page, 'initial Gateway client')
    const bootEntry = await page.evaluate(id => window.__DSH_BOOT__?.entries.find(entry => entry.id === id), APP_ID)
    assert(bootEntry?.rev, `boot graph is missing ${APP_ID}`)
    const originalUrl = page.url()

    const successful = beginPhase(phases, 'success')
    const installedBundle = await buildAndInstallCandidate(profile, 'replacement')
    assert(installedBundle.originalRev === bootEntry.rev, `installed Gateway bundle hash ${installedBundle.originalRev} differs from boot rev ${bootEntry.rev}`)
    await waitForVisible(page, page.getByRole('dialog', { name: APP_LABEL, exact: true }).getByText(REPLACEMENT_MARKER, { exact: true }), 'Gateway replacement after client HMR', 30_000)
    assert(page.url() === originalUrl, `Gateway HMR changed the URL: expected ${originalUrl}, got ${page.url()}`)
    assert(await page.getByRole('dialog', { name: APP_LABEL, exact: true }).getByText(ORIGINAL_MARKER, { exact: true }).count() === 0, 'old Gateway marker survived HMR')
    assert(await page.getByRole('dialog', { name: APP_LABEL, exact: true }).getByText(REPLACEMENT_MARKER, { exact: true }).count() === 1, 'Gateway replacement marker is duplicated after HMR')
    await assertDocumentSentinels(page)
    await assertClientGraphUnique(page, 'successful Gateway HMR')
    assert(successful.hmrResponses.at(-1) !== undefined, `Gateway HMR did not refetch ${APP_ID}; responses: ${JSON.stringify(successful.hmrResponses)}`)
    assert(successful.documentRequests.length === 0, `Gateway HMR issued document requests: ${successful.documentRequests.join(', ')}`)
    assert(successful.loadEvents === 0, `Gateway HMR emitted ${successful.loadEvents} page load event(s)`)
    assert(successful.mainFrameNavigations === 0, `Gateway HMR emitted ${successful.mainFrameNavigations} main-frame navigation event(s)`)
    await assertPhaseHasNoUnexpectedDiagnostics(successful, 'successful Gateway HMR')
    endPhase(phases)

    await openInspectorAndAssertUnrelatedApp(page)
    await navigateToGatewayPlayground(page, baseUrl)
    await assertDocumentSentinels(page, 'pre-crash HMR')
    const crashOriginalUrl = page.url()

    const crashPhase = beginPhase(phases, 'crash')
    const crashBundle = await buildAndInstallCandidate(profile, 'crash')
    assert(crashBundle.originalRev === installedBundle.candidateRev, `crash HMR started from unexpected installed Gateway hash ${crashBundle.originalRev}`)
    await page.locator('[data-gateway-app="phase-5"]').waitFor({ state: 'detached', timeout: 30_000 })
    await waitForVisible(page, page.getByRole('dialog', { name: APP_LABEL, exact: true }), 'Gateway shell overlay after contained crash HMR')
    assert(await page.locator('[data-gateway-app="phase-5"]').count() === 0, 'Gateway render crash escaped the existing slot boundary')
    assert(page.url() === crashOriginalUrl, `Gateway crash HMR changed the URL: expected ${crashOriginalUrl}, got ${page.url()}`)
    await assertDocumentSentinels(page, 'Gateway crash HMR')
    await assertClientGraphUnique(page, 'Gateway crash HMR')
    assert(crashPhase.hmrResponses.at(-1) !== undefined, `Gateway crash HMR did not refetch ${APP_ID}; responses: ${JSON.stringify(crashPhase.hmrResponses)}`)
    assert(crashPhase.documentRequests.length === 0, `Gateway crash HMR issued document requests: ${crashPhase.documentRequests.join(', ')}`)
    assert(crashPhase.loadEvents === 0, `Gateway crash HMR emitted ${crashPhase.loadEvents} page load event(s)`)
    assert(crashPhase.mainFrameNavigations === 0, `Gateway crash HMR emitted ${crashPhase.mainFrameNavigations} main-frame navigation event(s)`)
    assert(crashPhase.pageErrors.length === 0, `Gateway crash HMR page errors:\n${crashPhase.pageErrors.join('\n')}`)
    assert(crashPhase.failedRequests.length === 0, `Gateway crash HMR request failures:\n${crashPhase.failedRequests.join('\n')}`)
    assert(crashPhase.consoleWarnings.length === 0, `Gateway crash HMR unexpected console warnings:\n${crashPhase.consoleWarnings.join('\n')}`)
    assert(crashPhase.consoleErrors.length === 2, `Gateway crash HMR expected exactly the React and DSH boundary diagnostics, got ${JSON.stringify(crashPhase.consoleErrors)}`)
    assert(crashPhase.consoleErrors[0].startsWith(`Error: ${CRASH_ERROR_MESSAGE}\n`) && crashPhase.consoleErrors[0].includes('at GatewayApp'), `Gateway React diagnostic did not match the injected render failure: ${JSON.stringify(crashPhase.consoleErrors[0])}`)
    assert(crashPhase.consoleErrors[1].startsWith(`${CRASH_DIAGNOSTIC}\n`) && crashPhase.consoleErrors[1].includes('at GatewayApp'), `Gateway DSH boundary diagnostic did not match: ${JSON.stringify(crashPhase.consoleErrors[1])}`)
    endPhase(phases)

    const recoveryPhase = beginPhase(phases, 'recovery')
    const recoveryBundle = await buildAndInstallCandidate(profile, 'recovery')
    assert(recoveryBundle.originalRev === crashBundle.candidateRev, `Gateway recovery HMR started from unexpected crash hash ${recoveryBundle.originalRev}`)
    await assertGatewayVisible(page, REPLACEMENT_MARKER, 'Gateway recovery after crash HMR')
    assert(page.url() === crashOriginalUrl, `Gateway recovery HMR changed the URL: expected ${crashOriginalUrl}, got ${page.url()}`)
    await assertDocumentSentinels(page, 'Gateway recovery HMR')
    await assertClientGraphUnique(page, 'Gateway recovery HMR')
    assert(recoveryPhase.hmrResponses.at(-1) !== undefined, `Gateway recovery HMR did not refetch ${APP_ID}; responses: ${JSON.stringify(recoveryPhase.hmrResponses)}`)
    assert(recoveryPhase.documentRequests.length === 0, `Gateway recovery HMR issued document requests: ${recoveryPhase.documentRequests.join(', ')}`)
    assert(recoveryPhase.loadEvents === 0, `Gateway recovery HMR emitted ${recoveryPhase.loadEvents} page load event(s)`)
    assert(recoveryPhase.mainFrameNavigations === 0, `Gateway recovery HMR emitted ${recoveryPhase.mainFrameNavigations} main-frame navigation event(s)`)
    await assertPhaseHasNoUnexpectedDiagnostics(recoveryPhase, 'Gateway recovery HMR')
    endPhase(phases)

    await openInspectorAndAssertUnrelatedApp(page)
    console.log(`Phase 6 real Gateway client HMR acceptance passed for ${installedBundle.target}`)
    console.log(`Changed content hash: ${installedBundle.originalRev} -> ${installedBundle.candidateRev}`)
    console.log(`Crash candidate hash: ${crashBundle.originalRev} -> ${crashBundle.candidateRev}`)
    console.log(`Recovery candidate hash: ${recoveryBundle.originalRev} -> ${recoveryBundle.candidateRev}`)
    console.log(`No-cache bundle refetch: ${successful.hmrResponses.at(-1)}`)
    console.log('Verified Gateway Playground URL, document/conversation identity, atomic client replacement, one Gateway App, unrelated Webpage Inspector survival, remote/client graph uniqueness, SlotErrorBoundary crash containment and recovery, timer/remotes lifecycle across HMR, and no unexpected page/request errors.')
  } catch (error) {
    const diagnostics = harness === undefined ? '(harness unavailable)' : await pageDiagnostics(harness.page)
    const phaseDiagnostics = Object.fromEntries(Object.entries(phases).filter(([name]) => name !== 'current' && phases[name] !== undefined))
    const dshOutput = harness?.dshOutput() ?? '(none)'
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${diagnostics}\n\nHMR diagnostics:\n${JSON.stringify(phaseDiagnostics, null, 2)}\n\nDSH output:\n${dshOutput}`, error instanceof Error ? error.cause : undefined)
  } finally {
    phases.current = undefined
    await harness?.close()
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHmrScenario().catch(error => {
    console.error(error.stack ?? String(error))
    process.exitCode = 1
  })
}
