import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const nodeModules = realpathSync(resolve(root, 'node_modules'))
const require = createRequire(import.meta.url)
const RC6 = '0.1.0-rc.6'

// Keep this list independent of the workspace manifest. A manifest edit must
// not be able to make the compatibility target float silently.
const REQUIRED_PACKAGES = Object.freeze({
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/cordis-plugin-loader': '1.0.2',
  '@deepseek-ai/dsh-api-gateway': RC6,
  '@deepseek-ai/dsh-api-remotes': RC6,
  '@deepseek-ai/dsh-atomic-write': RC6,
  '@deepseek-ai/dsh-attachment': RC6,
  '@deepseek-ai/dsh-attachment-local': RC6,
  '@deepseek-ai/dsh-brand': RC6,
  '@deepseek-ai/dsh-client-locale': RC6,
  '@deepseek-ai/dsh-client-modules': RC6,
  '@deepseek-ai/dsh-client-runtime': RC6,
  '@deepseek-ai/dsh-client-ui-attachment': RC6,
  '@deepseek-ai/dsh-client-ui-primitives': RC6,
  '@deepseek-ai/dsh-client-ui-slots': RC6,
  '@deepseek-ai/dsh-client-web-react': RC6,
  '@deepseek-ai/dsh-credentials': RC6,
  '@deepseek-ai/dsh-credentials-local': RC6,
  '@deepseek-ai/dsh-home-paths': RC6,
  '@deepseek-ai/dsh-host-webserver': RC6,
  '@deepseek-ai/dsh-invariants': RC6,
  '@deepseek-ai/dsh-launch-environment': RC6,
  '@deepseek-ai/dsh-llm': RC6,
  '@deepseek-ai/dsh-llm-pi-ai': RC6,
  '@deepseek-ai/dsh-settings': RC6,
  '@deepseek-ai/dsh-settings-file': RC6,
  '@deepseek-ai/dsh-subprocess': RC6,
  '@deepseek-ai/dsh-timeout': RC6,
  '@deepseek-ai/schemastery': '3.18.1',
})

function fail(message) {
  throw new Error(`public API probe failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function localRelative(path) {
  return relative(root, path).replaceAll('\\', '/')
}

function assertLocalResolution(specifier, resolved) {
  const real = realpathSync(resolved)
  const fromNodeModules = relative(nodeModules, real)
  assert(
    !isAbsolute(fromNodeModules)
      && fromNodeModules !== '..'
      && !fromNodeModules.startsWith('../')
      && !fromNodeModules.startsWith('..\\'),
    `${specifier} resolved outside this repo's node_modules: ${real}`,
  )
  assert(!/deepseek-harness/i.test(real), `${specifier} resolved through deepseek-harness: ${real}`)
  assert(!/(?:^|[\\/])rc[.]5(?:[\\/]|$)/iu.test(real), `${specifier} resolved through an rc.5 path: ${real}`)
  return real
}

function resolvePublic(specifier) {
  let resolved
  try {
    resolved = require.resolve(specifier)
  } catch (error) {
    fail(`public specifier ${specifier} does not resolve: ${error instanceof Error ? error.message : String(error)}`)
  }
  return assertLocalResolution(specifier, resolved)
}

function readPublicManifest(name) {
  const path = resolvePublic(`${name}/package.json`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read public ${name}/package.json at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert(manifest.name === name, `${name}/package.json reports ${JSON.stringify(manifest.name)}`)
  assert(manifest.version === REQUIRED_PACKAGES[name], `${name} installed version ${manifest.version}; expected ${REQUIRED_PACKAGES[name]}`)
  assert(manifest.exports?.['./package.json'] !== undefined, `${name} does not publicly export ./package.json`)
  return { manifest, path }
}

function walk(directory, predicate, output = []) {
  if (!existsSync(directory)) return output
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) walk(entryPath, predicate, output)
    else if (predicate(entryPath)) output.push(entryPath)
  }
  return output
}

function verifyManifestAndImportPolicy() {
  const manifests = [
    resolve(root, 'package.json'),
    ...['gateway', 'runtime', 'analytics', 'pack'].map((name) => resolve(root, `packages/${name}/package.json`)),
  ]
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries(manifest[group] ?? {})) {
        if (!name.startsWith('@deepseek-ai/')) continue
        assert(REQUIRED_PACKAGES[name] !== undefined, `${manifest.name} uses unreviewed DSH dependency ${name}`)
        assert(value === REQUIRED_PACKAGES[name], `${manifest.name} uses non-exact ${name}@${value}`)
        assert(!/[~^*xX><|\s]/u.test(value), `${manifest.name} uses floating ${name}@${value}`)
      }
    }
  }

  const codeFiles = [
    ...walk(resolve(root, 'packages'), (path) => /[\\/](?:src|lib)[\\/].+[.](?:ts|tsx|js)$/u.test(path)),
    ...walk(resolve(root, 'tests/public-api'), (path) => path.endsWith('.ts')),
  ]
  for (const codePath of codeFiles) {
    const content = readFileSync(codePath, 'utf8')
    assert(!/deepseek-harness/iu.test(content), `${localRelative(codePath)} references the adjacent source checkout`)
    assert(!/0[.]1[.]0-rc[.]5/u.test(content), `${localRelative(codePath)} references rc.5`)
    for (const match of content.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"](@deepseek-ai\/[^'"]+)['"]/gu)) {
      resolvePublic(match[1])
    }
  }

  for (const privateSpecifier of [
    '@deepseek-ai/dsh-settings/src/index.ts',
    '@deepseek-ai/dsh-llm/lib/internal',
    '@deepseek-ai/dsh-client-modules/src/client/index.ts',
  ]) {
    let rejected = false
    try {
      require.resolve(privateSpecifier)
    } catch (error) {
      rejected = error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || error.code === 'MODULE_NOT_FOUND'
    }
    assert(rejected, `private DSH specifier unexpectedly resolved: ${privateSpecifier}`)
  }
  process.stdout.write(`[public-api] exact manifest/import policy and private/local/rc.5 negative cases verified (${codeFiles.length} files)\n`)
}

function assertPublicExport(name, subpath) {
  const specifier = `${name}/${subpath}`
  const path = resolvePublic(specifier)
  const manifest = readPublicManifest(name).manifest
  assert(manifest.exports?.[`./${subpath}`] !== undefined, `${name} does not publicly export ./${subpath}`)
  return path
}

async function captureClientHandoff(specifier, expectedId) {
  assertPublicExport(specifier.slice(0, specifier.lastIndexOf('/')), 'client')

  const previousWindow = globalThis.window
  const hadLoader = Object.hasOwn(globalThis, '__ModuleLoader__')
  const previousLoader = globalThis.__ModuleLoader__
  let handoff

  globalThis.window = globalThis
  globalThis.__ModuleLoader__ = {
    load(value) {
      handoff = value
    },
  }

  try {
    await import(specifier)
  } catch (error) {
    fail(`${specifier} import failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (hadLoader) globalThis.__ModuleLoader__ = previousLoader
    else delete globalThis.__ModuleLoader__
  }

  assert(handoff !== undefined, `${specifier} did not perform the public Loader handoff`)
  assert(handoff.id === expectedId, `${specifier} handed off id ${JSON.stringify(handoff.id)}; expected ${expectedId}`)
  assert(typeof handoff.factory === 'function', `${specifier} handoff factory is not callable`)
  return handoff
}

function evaluateHandoff(handoff, modules) {
  let exports
  try {
    exports = handoff.factory((specifier) => {
      if (!(specifier in modules)) fail(`client handoff requested undeclared module ${specifier}`)
      return modules[specifier]
    })
  } catch (error) {
    fail(`client handoff ${handoff.id} factory failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert(exports !== null && typeof exports === 'object', `client handoff ${handoff.id} returned no export object`)
  return exports
}

async function verifyVersionsAndResolution() {
  const reports = []
  for (const name of Object.keys(REQUIRED_PACKAGES)) {
    const { path } = readPublicManifest(name)
    reports.push(`${name}@${REQUIRED_PACKAGES[name]} -> ${localRelative(realpathSync(path))}`)
  }
  process.stdout.write(`[public-api] exact installed versions verified (${reports.length} packages)\n`)
  process.stdout.write(`${reports.map((report) => `  ${report}`).join('\n')}\n`)
}

async function verifyHostSymbols() {
  const [cordis, loaderModule, home, settings, credentials, subprocess, remotes, gateway] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/cordis-plugin-loader'),
    import('@deepseek-ai/dsh-home-paths'),
    import('@deepseek-ai/dsh-settings'),
    import('@deepseek-ai/dsh-credentials'),
    import('@deepseek-ai/dsh-subprocess'),
    import('@deepseek-ai/dsh-api-remotes'),
    import('@deepseek-ai/dsh-api-gateway'),
  ])

  assert(typeof cordis.Context === 'function', '@deepseek-ai/cordis does not export Context')
  assert(typeof loaderModule.Loader === 'function' && loaderModule.default === loaderModule.Loader, 'Cordis Loader public export drift')

  assert(typeof home.resolveDshHome === 'function', 'dsh-home-paths.resolveDshHome is unavailable')
  assert(typeof home.dshHomePath === 'function', 'dsh-home-paths.dshHomePath is unavailable')
  const configuredHome = home.resolveDshHome('C:/dsh-public-api-probe', {})
  assert(configuredHome.endsWith('dsh-public-api-probe'), `resolveDshHome returned an unexpected path: ${configuredHome}`)

  assert(typeof settings.settingsNamespace === 'function', 'dsh-settings.settingsNamespace is unavailable')
  assert(typeof settings.SettingsProvider === 'function', 'dsh-settings.SettingsProvider is unavailable')
  assert(typeof settings.SettingsProvider.prototype.mutate === 'function', 'dsh-settings.SettingsProvider.mutate is unavailable')
  assert(typeof settings.SettingsProvider.prototype.update === 'function', 'dsh-settings.SettingsProvider.update is unavailable')
  assert(typeof settings.SettingsProvider.prototype.replace === 'function', 'dsh-settings.SettingsProvider.replace is unavailable')
  assert(settings.settingsNamespace('llm-pi-ai') === 'llm-pi-ai', 'settingsNamespace does not preserve the frozen namespace')

  assert(typeof credentials.credentialRef === 'function', 'dsh-credentials.credentialRef is unavailable')
  assert(typeof credentials.CredentialProvider === 'function', 'dsh-credentials.CredentialProvider is unavailable')
  assert(credentials.credentialRef('DSH_GATEWAY_PROXY') === 'DSH_GATEWAY_PROXY', 'credentialRef did not brand the expected reference')

  assert(typeof subprocess.SubprocessRuntime === 'function', 'dsh-subprocess.SubprocessRuntime is unavailable')
  assert(typeof subprocess.scrubbedParentEnv === 'function', 'dsh-subprocess.scrubbedParentEnv is unavailable')
  assert(subprocess.SENSITIVE_ENV_PATTERN instanceof RegExp, 'dsh-subprocess.SENSITIVE_ENV_PATTERN is unavailable')
  const scrubbed = subprocess.scrubbedParentEnv()
  assert(Object.keys(scrubbed).every((key) => !/^DSH_/iu.test(key)), 'scrubbedParentEnv forwarded an ambient DSH_* variable')

  assert(typeof remotes.apply === 'function', 'dsh-api-remotes.apply is unavailable')
  assert(Array.isArray(remotes.API_REMOTE_FORWARDED_EVENTS), 'dsh-api-remotes.API_REMOTE_FORWARDED_EVENTS is unavailable')
  assert(remotes.API_REMOTE_FORWARDED_EVENTS.includes('credentials/updated'), 'Remote event allowlist lost credentials/updated')
  assert(remotes.API_REMOTE_FORWARDED_EVENTS.includes('settings/document-updated'), 'Remote event allowlist lost settings/document-updated')
  assert(typeof gateway.TypertGatewayService === 'function', 'dsh-api-gateway.TypertGatewayService is unavailable')
  assert(typeof gateway.TypertGatewayService.prototype.invoke === 'function', 'TypertGatewayService.invoke is unavailable')

  const ctx = new cordis.Context()
  await ctx.plugin(loaderModule.Loader, { baseUrl: import.meta.url })
  assert(ctx.loader instanceof loaderModule.Loader, 'Cordis Loader was not installed on the public Context')
  assert(typeof ctx.loader.create === 'function', 'Cordis Loader.create is unavailable')
  assert(typeof ctx.loader.await === 'function', 'Cordis Loader.await is unavailable')
  await ctx.loader.await()

  process.stdout.write('[public-api] host/home/settings/credentials/subprocess/remotes/Cordis Loader symbols verified\n')
}

async function verifyClientHandoffs() {
  const cordis = await import('@deepseek-ai/cordis')
  const slots = await import('@deepseek-ai/dsh-client-ui-slots')
  const modulesHandoff = await captureClientHandoff('@deepseek-ai/dsh-client-modules/client', '@deepseek-ai/dsh-client-modules')
  const modulesExports = evaluateHandoff(modulesHandoff, {})
  assert(typeof modulesExports.ClientModuleSystem === 'function', 'client-modules handoff lost ClientModuleSystem')
  assert(typeof modulesExports.parseBootManifest === 'function', 'client-modules handoff lost parseBootManifest')
  assert(typeof modulesExports.apply === 'function', 'client-modules handoff lost apply')

  const parsed = modulesExports.parseBootManifest({
    rev: 'public-api-probe',
    entries: [{ id: '@probe/client', url: '/plugins/probe/client.js', rev: 'rev-1', inject: ['@probe/base'], immediately: true }],
  })
  assert(parsed.modules[0]?.id === '@probe/client', 'parseBootManifest did not expose the public module row')
  assert(parsed.plugins[0]?.inject[0] === '@probe/base', 'parseBootManifest did not expose the public plugin row')

  const previousLoader = globalThis.__ModuleLoader__
  delete globalThis.__ModuleLoader__
  const system = new modulesExports.ClientModuleSystem({
    modules: [{ id: '@probe/client', url: '/plugins/probe/client.js', rev: 'rev-1' }],
    staticModules: { '@probe/static': { value: 'static-ok' } },
    loadBundle: async () => {
      globalThis.__ModuleLoader__.load({ id: '@probe/client', factory: () => ({ value: 'factory-ok' }) })
    },
  })
  try {
    assert((await system.import('@probe/static')).value === 'static-ok', 'ClientModuleSystem static module import failed')
    await system.prefetch('@probe/client')
    assert((await system.import('@probe/client')).value === 'factory-ok', 'ClientModuleSystem Loader handoff import failed')
    assert(system.version === 'client', `ClientModuleSystem version changed to ${system.version}`)
  } finally {
    if (previousLoader === undefined) delete globalThis.__ModuleLoader__
    else globalThis.__ModuleLoader__ = previousLoader
  }

  const gatewayHandoff = await captureClientHandoff('@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-api-gateway')
  const gatewayExports = evaluateHandoff(gatewayHandoff, { '@deepseek-ai/cordis': cordis })
  assert(typeof gatewayExports.apply === 'function' && Array.isArray(gatewayExports.inject), 'api-gateway client handoff drifted')

  const remotesHandoff = await captureClientHandoff('@deepseek-ai/dsh-api-remotes/client', '@deepseek-ai/dsh-api-remotes')
  const remotesExports = evaluateHandoff(remotesHandoff, { '@deepseek-ai/cordis': cordis })
  assert(typeof remotesExports.apply === 'function' && Array.isArray(remotesExports.inject), 'api-remotes client handoff drifted')

  const runtimeHandoff = await captureClientHandoff('@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-runtime')
  const runtimeExports = evaluateHandoff(runtimeHandoff, {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-ui-slots': slots,
  })
  assert(typeof runtimeExports.apply === 'function', 'client-runtime handoff lost apply')
  assert(typeof runtimeExports.SlotRegistry === 'function', 'client-runtime handoff lost SlotRegistry')

  process.stdout.write('[public-api] client-modules, api-gateway, api-remotes, and client-runtime handoffs verified\n')
}

async function main() {
  await verifyVersionsAndResolution()
  verifyManifestAndImportPolicy()
  await verifyHostSymbols()
  await verifyClientHandoffs()
  process.stdout.write(`[public-api] PASS: DSH ${RC6} public contract resolved only from this repository's installed node_modules\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
