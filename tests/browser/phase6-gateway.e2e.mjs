import { readFile } from 'node:fs/promises'

import {
  assertHttp200,
  createGatewayWebHarness,
  pageDiagnostics,
  waitForUrl,
  waitForVisible,
} from './support.mjs'

const APP_ID = 'wha1echai.gateway'
const APP_PATH = `/apps/${APP_ID}`
const ROUTES = Object.freeze([
  { path: '/', nav: 'Overview', heading: 'AI Gateway', selector: '#gateway-dashboard-title' },
  { path: '/accounts', nav: 'Accounts', heading: 'Account health', selector: '#gateway-accounts-title' },
  { path: '/models', nav: 'Models', heading: 'Discover models', selector: '#gateway-models-title' },
  { path: '/requests', nav: 'Requests', heading: 'Requests', selector: '[data-gateway-view="requests"] h1' },
  { path: '/playground', nav: 'Playground', heading: 'Playground', selector: '[data-gateway-view="playground"] h1' },
  { path: '/settings', nav: 'Settings', heading: 'Settings', selector: '#gateway-settings-title' },
])

function fail(message, cause) {
  const error = new Error(message)
  if (cause !== undefined) error.cause = cause
  throw error
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function sameUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl).href
}

async function waitForShell(page) {
  await waitForVisible(page, page.locator('[data-conversation-scroll]'), 'DSH conversation tree')
  await waitForVisible(page, page.getByRole('button', { name: 'Apps', exact: true }), 'DSH Apps launcher')
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  let noticeVisible = false
  try {
    await continueButton.waitFor({ state: 'visible', timeout: 5_000 })
    noticeVisible = true
  } catch (error) {
    if (error?.name !== 'TimeoutError') fail(`DSH onboarding notice failed\n${await pageDiagnostics(page)}`, error)
  }
  if (noticeVisible) {
    await continueButton.click()
    await continueButton.waitFor({ state: 'hidden', timeout: 5_000 })
  }
  const locale = await page.evaluate(() => ({
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  }))
  assert(locale.language === 'en-US', `browser locale drifted: ${locale.language}`)
  assert(locale.viewport === '1680x1000', `browser viewport drifted: ${locale.viewport}`)
}

async function openGatewayFromApps(page, baseUrl) {
  await page.getByRole('button', { name: 'Apps', exact: true }).click()
  await waitForUrl(page, '/apps/wha1echai.webpage', 'Apps launcher Inspector route')
  await waitForVisible(page, page.getByRole('heading', { name: 'App Inspector', exact: true }), 'App Inspector heading')
  const card = page.locator(`[data-app-id="${APP_ID}"]`)
  await waitForVisible(page, card, 'Gateway App Inspector card')
  await card.getByRole('button', { name: 'Open App', exact: true }).click()
  return waitForApp(page, baseUrl, APP_PATH, ROUTES[0])
}

async function rememberConversation(page) {
  await page.evaluate(() => {
    const element = document.querySelector('[data-conversation-scroll]')
    if (element === null) throw new Error('data-conversation-scroll is absent')
    Object.defineProperty(window, '__phase6ConversationElement', {
      configurable: true,
      value: element,
    })
  })
}

async function assertConversationPreserved(page, label) {
  const result = await page.evaluate(() => {
    const current = document.querySelector('[data-conversation-scroll]')
    const remembered = window.__phase6ConversationElement
    return {
      connected: remembered?.isConnected === true,
      present: current !== null,
      same: remembered !== undefined && remembered === current,
    }
  })
  assert(result.connected, `${label}: saved conversation element is disconnected`)
  assert(result.present, `${label}: conversation element is absent`)
  assert(result.same, `${label}: conversation DOM element was replaced`)
}

async function waitForApp(page, baseUrl, appPath, route) {
  const routePath = route.path === '/' ? appPath : `${appPath}${route.path}`
  await waitForUrl(page, routePath, `Gateway route ${route.path}`)
  const app = page.locator('[data-gateway-app="phase-5"]')
  await waitForVisible(page, app, `Gateway App at ${route.path}`)
  await waitForVisible(page, app.locator(route.selector), `${route.heading} heading`)
  assert((await app.locator(route.selector).innerText()).trim() === route.heading, `${route.path}: heading drifted`)
  assert(page.url() === sameUrl(baseUrl, routePath), `${route.path}: URL drifted to ${page.url()}`)
  return app
}

function appNavigation(app) {
  return app.locator('nav').first()
}

async function navigateAppRoute(page, baseUrl, app, route) {
  await appNavigation(app).getByRole('button', { name: route.nav, exact: true }).click()
  return waitForApp(page, baseUrl, APP_PATH, route)
}

async function assertNoImageDataExposure(page, imageBase64, label) {
  const exposure = await page.evaluate(() => {
    const storage = (store) => Object.entries(store).map(([key, value]) => `${key}=${value}`).join('\n')
    return {
      body: document.body?.innerText ?? '',
      html: document.documentElement?.outerHTML ?? '',
      href: window.location.href,
      local: storage(window.localStorage),
      session: storage(window.sessionStorage),
    }
  })
  const serialized = Object.values(exposure).join('\n')
  assert(!serialized.includes(imageBase64), `${label}: raw PNG base64 reached DOM, URL, localStorage, or sessionStorage`)
  assert(!serialized.includes('data:image/png;base64,'), `${label}: image data URL reached a browser-visible surface`)
}

async function assertStableAnalyticsState(page, accepted, label) {
  await page.waitForFunction(
    ({ values }) => {
      const body = document.querySelector('[data-gateway-app="phase-5"]')?.textContent ?? ''
      return values.some((text) => body.includes(text))
    },
    { values: accepted },
    { timeout: 30_000 },
  )
  const body = await page.locator('[data-gateway-app="phase-5"]').innerText()
  assert(accepted.some((text) => body.includes(text)), `${label}: no stable state found in Gateway view; body was:\n${body}`)
}

async function runScenarios() {
  const harness = await createGatewayWebHarness()
  const { page, baseUrl, fakeCpa, imageFixturePath, profile } = harness
  const pageErrors = []
  const consoleErrors = []
  const consoleWarnings = []
  const failedRequests = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
    if (message.type() === 'warning') consoleWarnings.push(message.text())
  })
  page.on('requestfailed', (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`))

  try {
    assert(profile.profileName === 'web', `browser profile drifted: ${profile.profileName}`)
    await assertHttp200(baseUrl)
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await waitForShell(page)
    await rememberConversation(page)

    // The real Webpage launcher opens the App without replacing the shell's
    // conversation node, which is the preservation contract under test.
    let app = await openGatewayFromApps(page, baseUrl)
    await assertConversationPreserved(page, 'App open')

    // Every frozen App route renders through the App's own navigation.
    for (const route of ROUTES.slice(1)) {
      app = await navigateAppRoute(page, baseUrl, app, route)
      await assertConversationPreserved(page, `route ${route.path}`)
    }

    // The Models page must discover both fixture models and persist explicit
    // image capability only after the user enables it and applies the change.
    const modelsRoute = ROUTES.find((route) => route.path === '/models')
    app = await navigateAppRoute(page, baseUrl, app, modelsRoute)
    await waitForVisible(page, app.getByText('fake-text-model', { exact: true }).first(), 'fake text model')
    await waitForVisible(page, app.getByText('fake-vision-model', { exact: true }).first(), 'fake vision model')
    const visionRow = app.locator('label').filter({ hasText: 'fake-vision-model' })
    assert(await visionRow.count() === 1, 'fake vision model row is not unique')
    const visionCheckbox = visionRow.locator('input[type="checkbox"]')
    assert(!(await visionCheckbox.isChecked()), 'fake vision model was image-enabled before explicit apply')
    await visionCheckbox.check()
    await app.getByRole('button', { name: 'Apply changes', exact: true }).click()
    await waitForVisible(page, page.getByText('Saved', { exact: true }), 'saved model capability state')
    assert(await visionCheckbox.isChecked(), 'fake vision model checkbox did not remain enabled after apply')

    // Playground text one-shot through the official ctx.llm route.
    const playgroundRoute = ROUTES.find((route) => route.path === '/playground')
    app = await navigateAppRoute(page, baseUrl, app, playgroundRoute)
    const modelSelect = page.locator('#gateway-playground-model')
    await waitForVisible(page, modelSelect, 'Playground model selector')
    await modelSelect.selectOption('fake-text-model')
    await page.locator('#gateway-playground-prompt').fill('Reply with the fixture greeting.')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await waitForVisible(page, page.getByText('Hello from fake CPA.', { exact: true }), 'text probe result')

    // Upload the existing 1x1 PNG, prove the opaque-ref path, then issue one
    // image probe against the explicitly enabled fixture model.
    const pngBytes = await readFile(imageFixturePath)
    const pngBase64 = pngBytes.toString('base64')
    await modelSelect.selectOption('fake-vision-model')
    const imageInput = page.locator('#gateway-playground-image')
    await page.waitForFunction(() => document.querySelector('#gateway-playground-image')?.disabled === false)
    await imageInput.setInputFiles(imageFixturePath)
    await waitForVisible(page, page.getByText('red.png', { exact: true }), 'opaque uploaded image reference')
    await assertNoImageDataExposure(page, pngBase64, 'after image upload')
    await page.locator('#gateway-playground-prompt').fill('Probe this one-pixel image.')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await waitForVisible(page, page.getByText('Hello from fake CPA.', { exact: true }), 'image probe result')
    await assertNoImageDataExposure(page, pngBase64, 'after image probe')
    const imageRequest = await fakeCpa.waitForRequest({
      path: '/v1/chat/completions',
      timeoutMs: 5_000,
      predicate: (request) => request.body?.messages?.some((message) => Array.isArray(message.content)
        && message.content.some((part) => part.type === 'image_url' || part.type === 'input_image')) === true,
    })
    assert(imageRequest.response?.status === 200 && imageRequest.response?.completed === true, 'fake CPA did not complete the image probe')

    // Stable product headings and states for the four non-playground views.
    app = await navigateAppRoute(page, baseUrl, app, ROUTES[0])
    await assertStableAnalyticsState(page, ['Analytics ready', 'Analytics unavailable', 'Analytics disabled', 'Analytics degraded'], 'dashboard')
    app = await navigateAppRoute(page, baseUrl, app, ROUTES[1])
    await assertStableAnalyticsState(page, ['No data', 'Analytics unavailable', 'The service is temporarily unavailable'], 'accounts')
    app = await navigateAppRoute(page, baseUrl, app, ROUTES[3])
    await assertStableAnalyticsState(page, ['No data', 'Analytics unavailable', 'The service is temporarily unavailable'], 'requests')
    app = await navigateAppRoute(page, baseUrl, app, ROUTES[5])
    await assertStableAnalyticsState(page, ['Stopped', 'External', 'Not configured'], 'settings')

    // Close the App and prove the original conversation node survived the
    // complete same-document App session.
    await app.getByRole('button', { name: 'Back to conversation', exact: true }).click()
    await waitForUrl(page, '/', 'Gateway App close')
    await waitForShell(page)
    await assertConversationPreserved(page, 'App close')

    // A nested direct deep link must survive a real reload; browser history
    // must then support back/forward between App routes.
    const deepPath = `${APP_PATH}/playground`
    await page.goto(sameUrl(baseUrl, deepPath), { waitUntil: 'domcontentloaded' })
    app = await waitForApp(page, baseUrl, APP_PATH, playgroundRoute)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForShell(page)
    app = await waitForApp(page, baseUrl, APP_PATH, playgroundRoute)
    await rememberConversation(page)
    app = await navigateAppRoute(page, baseUrl, app, modelsRoute)
    app = await navigateAppRoute(page, baseUrl, app, playgroundRoute)
    await page.goBack({ waitUntil: 'domcontentloaded' })
    app = await waitForApp(page, baseUrl, APP_PATH, modelsRoute)
    await page.goForward({ waitUntil: 'domcontentloaded' })
    app = await waitForApp(page, baseUrl, APP_PATH, playgroundRoute)
    await assertConversationPreserved(page, 'deep-link history')

    await app.getByRole('button', { name: 'Back to conversation', exact: true }).click()
    await waitForUrl(page, '/', 'deep-link App close')
    await waitForShell(page)
    await assertConversationPreserved(page, 'deep-link App close')

    assert(pageErrors.length === 0, `browser page errors observed:\n${pageErrors.join('\n')}`)
    assert(consoleErrors.length === 0, `browser console errors observed:\n${consoleErrors.join('\n')}`)
    console.log(`Phase 6 real Gateway browser acceptance passed at ${baseUrl}`)
    console.log(`Packed rc.6 profile: ${profile.profileDir}`)
    console.log(`Fake CPA: ${fakeCpa.url}`)
    console.log('Scenarios: HTTP 200, direct App/deep-link/reload, six routes, back/forward, conversation identity, model discovery/apply, text probe, 1x1 PNG upload/image probe, no base64 DOM/storage, stable states, no page/console errors')
    if (consoleWarnings.length > 0) console.log(`Console warnings observed (non-fatal): ${consoleWarnings.length}`)
    if (failedRequests.length > 0) console.log(`Failed browser requests observed (non-fatal): ${failedRequests.length}`)
  } catch (error) {
    const diagnostics = await pageDiagnostics(page)
    const runtime = await page.evaluate(() => ({
      boot: window.__DSH_BOOT__,
      pathname: window.location.pathname,
      moduleLoaderKeys: Object.keys(window.__ModuleLoader__ ?? {}),
    })).catch((runtimeError) => ({ unavailable: String(runtimeError) }))
    fail(
      `${error instanceof Error ? error.message : String(error)}\n\n${diagnostics}\n\nRuntime:\n${JSON.stringify(runtime, null, 2)}\n\nFailed requests:\n${failedRequests.join('\n') || '(none)'}\n\nConsole errors:\n${consoleErrors.join('\n') || '(none)'}\n\nConsole warnings:\n${consoleWarnings.join('\n') || '(none)'}\n\nDSH output:\n${harness.dshOutput() || '(none)'}`,
      error instanceof Error ? error.cause : undefined,
    )
  } finally {
    await harness.close()
  }
}

export { runScenarios }
