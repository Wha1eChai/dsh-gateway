import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import {
  packageFilename,
  packageSpecs,
  packageUrl,
  releaseTag,
  webpage,
} from './release/release-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootRequire = createRequire(import.meta.url)
const releaseRoot = path.join(root, '.staging', 'release', releaseTag)
const githubDirectory = path.join(releaseRoot, 'github')
const localDirectory = path.join(releaseRoot, 'local')
const reportDirectory = path.join(root, '.staging', 'reports')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

async function sha256(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

function tarText(tarball, member) {
  return run('tar', ['-xOzf', tarball, member], { capture: true })
}

function tarBuffer(tarball, member) {
  const result = spawnSync('tar', ['-xOzf', tarball, member], {
    cwd: root,
    maxBuffer: 96 * 1024 * 1024,
    shell: false,
    stdio: 'pipe',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cannot read ${member} from ${tarball}`)
  return result.stdout
}

function tarEntries(tarball) {
  return run('tar', ['-tzf', tarball], { capture: true })
    .split(/\r?\n/u)
    .filter(Boolean)
}

function assertPackagePayload(spec, tarball) {
  const entries = tarEntries(tarball)
  const names = entries.map((entry) => entry.replace(/^package\//u, ''))
  let expected
  if (spec.key === 'gateway') {
    expected = [
      'LICENSE',
      'README.md',
      'lib/client.js',
      'lib/index.js',
      'lib/typert.host.d.ts',
      'lib/typert.host.js',
      'lib/typert.remote-client.d.ts',
      'lib/typert.remote-client.js',
      'lib/types/client/GatewayApp.d.ts',
      'lib/types/client/PlaygroundView.d.ts',
      'lib/types/client/RequestsView.d.ts',
      'lib/types/client/index.d.ts',
      'lib/types/client/locales.d.ts',
      'lib/types/client/view-types.d.ts',
      'lib/types/client/views/AccountsView.d.ts',
      'lib/types/client/views/DashboardView.d.ts',
      'lib/types/client/views/ModelsView.d.ts',
      'lib/types/client/views/SettingsView.d.ts',
      'lib/types/config.d.ts',
      'lib/types/host/contracts.d.ts',
      'lib/types/host/contracts.js',
      'lib/types/host/cpa-client/errors.d.ts',
      'lib/types/host/cpa-client/index.d.ts',
      'lib/types/host/cpa-client/types.d.ts',
      'lib/types/host/gateway-service.d.ts',
      'lib/types/host/oauth/callback.d.ts',
      'lib/types/host/oauth/errors.d.ts',
      'lib/types/host/oauth/index.d.ts',
      'lib/types/host/oauth/manager.d.ts',
      'lib/types/host/oauth/parser.d.ts',
      'lib/types/host/oauth/types.d.ts',
      'lib/types/host/provider/errors.d.ts',
      'lib/types/host/provider/index.d.ts',
      'lib/types/host/provider/models.d.ts',
      'lib/types/host/provider/profile.d.ts',
      'lib/types/host/provider/settings.d.ts',
      'lib/types/host/provider/types.d.ts',
      'lib/types/index.d.ts',
      'package.json',
    ]
  } else if (spec.key === 'runtime') {
    expected = [
      'LICENSE',
      'README.md',
      'lib/index.js',
      'lib/typert.host.d.ts',
      'lib/typert.host.js',
      'lib/types/index.d.ts',
      'package.json',
    ]
  } else if (spec.key === 'analytics') {
    const chunks = names.filter((name) => /^lib\/engine-[A-Za-z0-9_-]+[.]js$/u.test(name))
    assert(chunks.length === 1, `${spec.name}: expected exactly one analytics engine chunk`)
    expected = [
      'LICENSE',
      'README.md',
      chunks[0],
      'lib/index.js',
      'lib/storage/worker-entry.js',
      'lib/typert.host.d.ts',
      'lib/typert.host.js',
      'lib/types/config.d.ts',
      'lib/types/contracts.d.ts',
      'lib/types/index.d.ts',
      'lib/types/pipeline/collector.d.ts',
      'lib/types/pipeline/hashing.d.ts',
      'lib/types/pipeline/index.d.ts',
      'lib/types/pipeline/management-projectors.d.ts',
      'lib/types/pipeline/pricing.d.ts',
      'lib/types/pipeline/usage-projector.d.ts',
      'lib/types/pricing-snapshot.d.ts',
      'lib/types/service.d.ts',
      'lib/types/storage/client.d.ts',
      'lib/types/storage/engine.d.ts',
      'lib/types/storage/index.d.ts',
      'lib/types/storage/protocol.d.ts',
      'lib/types/storage/schema.d.ts',
      'lib/types/storage/validation.d.ts',
      'lib/types/storage/worker-entry.d.ts',
      'package.json',
    ]
  } else if (spec.key.startsWith('platform-')) {
    const binary = spec.key.startsWith('platform-win32-')
      ? 'vendor/cli-proxy-api.exe'
      : 'vendor/cli-proxy-api'
    expected = ['LICENSE', 'README.md', 'config/managed.yaml', 'package.json', 'provenance/cli-proxy-api.json', binary]
  } else if (spec.key === 'pack') {
    expected = ['LICENSE', 'README.md', 'cordis.patch.yml', 'lib/index.js', 'lib/types/index.d.ts', 'package.json']
  } else {
    expected = ['LICENSE', 'README.md', 'lib/index.js', 'lib/types/index.d.ts', 'package.json']
  }
  assert(JSON.stringify(names.sort()) === JSON.stringify(expected.sort()), `${spec.name}: unexpected exact payload: ${names.sort().join(', ')}`)
  assert(entries.every((entry) => entry.startsWith('package/') && !entry.includes('..')), `${spec.name}: unsafe tar member path`)
}

function assertNoForbiddenLifecycle(manifest, label) {
  for (const name of ['preinstall', 'install', 'postinstall']) {
    assert(manifest.scripts?.[name] === undefined, `${label}: forbidden ${name} script`)
  }
}

function inspectManifest(spec, flavor) {
  const directory = flavor === 'github' ? githubDirectory : localDirectory
  const tarball = path.join(directory, packageFilename(spec.name))
  assertPackagePayload(spec, tarball)
  const manifest = JSON.parse(tarText(tarball, 'package/package.json'))
  assert(manifest.name === spec.name, `${flavor}/${spec.name}: package name drift`)
  assert(manifest.version === '0.1.0', `${flavor}/${spec.name}: version drift`)
  assertNoForbiddenLifecycle(manifest, `${flavor}/${spec.name}`)
  const serialized = JSON.stringify(manifest)
  assert(!serialized.includes('workspace:'), `${flavor}/${spec.name}: workspace reference leaked`)
  assert(manifest.devDependencies === undefined, `${flavor}/${spec.name}: devDependencies leaked`)
  for (const [name, value] of Object.entries(manifest.peerDependencies ?? {})) {
    assert(/^\d+[.]\d+[.]\d+(?:-rc[.]\d+)?$/u.test(value), `${spec.name}: peer ${name} is not exact: ${value}`)
  }
  if (flavor === 'github') {
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries(manifest[group] ?? {})) {
        if (name === 'zod') {
          assert(value === '4.4.3', `${spec.name}: unexpected zod version ${value}`)
          continue
        }
        assert(name.startsWith('@dshapps/'), `${spec.name}: registry dependency is forbidden: ${name}@${value}`)
        const expected = name === webpage.name ? webpage.url : packageUrl(name)
        assert(value === expected, `${spec.name}: unexpected public URL for ${name}`)
      }
    }
  } else {
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries(manifest[group] ?? {})) {
        if (name.startsWith('@dshapps/')) {
          assert(value.startsWith('file:'), `${spec.name}: local override missing for ${name}`)
        }
      }
    }
  }
  return { manifest, tarball }
}

function expectedDependencyNames(spec) {
  if (spec.key === 'runtime') {
    return [
      ...packageSpecs.filter((entry) => entry.key.startsWith('platform-')).map((entry) => entry.name),
    ].sort()
  }
  if (spec.key === 'gateway') return ['zod']
  if (spec.key === 'analytics') return ['@dshapps/dsh-gateway']
  if (spec.key === 'pack') {
    return [
      webpage.name,
      '@dshapps/dsh-gateway',
      '@dshapps/dsh-gateway-runtime',
      '@dshapps/dsh-gateway-analytics',
    ].sort()
  }
  return []
}

function assertDependencyClosure(spec, manifest, flavor) {
  const actual = ['dependencies', 'optionalDependencies']
    .flatMap((group) => Object.keys(manifest[group] ?? {}))
    .sort()
  assert(JSON.stringify(actual) === JSON.stringify(expectedDependencyNames(spec)), `${flavor}/${spec.name}: dependency closure drift: ${actual.join(', ')}`)
}

function normalizeDependencyRewrite(manifest) {
  const copy = structuredClone(manifest)
  for (const group of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(copy[group] ?? {})) {
      if (name.startsWith('@dshapps/')) copy[group][name] = `<artifact:${name}>`
      if (name === 'zod') copy[group][name] = '<artifact:zod>'
    }
  }
  return copy
}

function assertFlavorEquivalence(spec, github, local) {
  const githubEntries = tarEntries(github.tarball).sort()
  const localEntries = tarEntries(local.tarball).sort()
  assert(JSON.stringify(githubEntries) === JSON.stringify(localEntries), `${spec.name}: public/local payload members differ`)
  assert(
    JSON.stringify(normalizeDependencyRewrite(github.manifest)) === JSON.stringify(normalizeDependencyRewrite(local.manifest)),
    `${spec.name}: public/local manifests differ beyond dependency rewrites`,
  )
  for (const member of githubEntries.filter((entry) => entry !== 'package/package.json')) {
    const publicHash = createHash('sha256').update(tarBuffer(github.tarball, member)).digest('hex')
    const localHash = createHash('sha256').update(tarBuffer(local.tarball, member)).digest('hex')
    assert(publicHash === localHash, `${spec.name}: public/local member differs: ${member}`)
  }
}

function findDsh() {
  if (process.platform !== 'win32') return { command: 'dsh', prefix: [] }
  const output = run('where.exe', ['dsh.cmd'], { capture: true })
  const candidate = output.split(/\r?\n/u).find((line) => line.trim().toLowerCase().endsWith('dsh.cmd'))
  assert(candidate, 'dsh.cmd was not found on PATH')
  const bin = path.join(path.dirname(candidate.trim()), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return { command: process.execPath, prefix: [bin] }
}

async function loadPackedGatewayClient(profileRequire) {
  const previousWindow = globalThis.window
  const hadLoader = Object.hasOwn(globalThis, '__ModuleLoader__')
  const previousLoader = globalThis.__ModuleLoader__
  let modulesHandoff
  globalThis.window = globalThis
  globalThis.__ModuleLoader__ = { load: (value) => { modulesHandoff = value } }
  try {
    const modulesClient = rootRequire.resolve('@deepseek-ai/dsh-client-modules/client')
    await import(`${pathToFileURL(modulesClient).href}?packed-profile-modules`)
    assert(modulesHandoff?.id === '@deepseek-ai/dsh-client-modules', 'rc.6 client-module handoff was not captured')
    const moduleExports = modulesHandoff.factory(() => {
      throw new Error('client-modules requested an unexpected external')
    })
    assert(typeof moduleExports.ClientModuleSystem === 'function', 'rc.6 ClientModuleSystem is unavailable')
    delete globalThis.__ModuleLoader__

    const id = '@dshapps/dsh-gateway'
    const clientPath = profileRequire.resolve(`${id}/client`)
    const clientUrl = pathToFileURL(clientPath).href
    const [React, ReactJsxRuntime] = await Promise.all([
      import('react'),
      import('react/jsx-runtime'),
    ])
    const system = new moduleExports.ClientModuleSystem({
      modules: [{ id, url: clientUrl, rev: 'phase1-packed-profile' }],
      staticModules: {
        react: React,
        'react/jsx-runtime': ReactJsxRuntime,
        '@deepseek-ai/dsh-client-ui-primitives': {
          Button: () => null,
          StateDot: () => null,
        },
      },
      loadBundle: async () => import(`${clientUrl}?phase1-packed-profile`),
    })
    const clientExports = await system.import(id)
    assert(clientExports.name === id, 'packed Gateway client name export drift')
    assert(typeof clientExports.apply === 'function', 'packed Gateway client apply export is unavailable')
    assert(!Object.hasOwn(clientExports, 'default'), 'packed Gateway client exposed a default export')
    return clientPath
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (hadLoader) globalThis.__ModuleLoader__ = previousLoader
    else delete globalThis.__ModuleLoader__
  }
}

async function verifyPackedHostLifecycle(profileDirectory) {
  const [{ Context }, loaderModule] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/cordis-plugin-loader'),
  ])
  const ctx = new Context()
  const baseUrl = pathToFileURL(path.join(profileDirectory, 'package.json')).href
  await ctx.plugin(loaderModule.Loader, { baseUrl })
  const rows = [
    ['webpage', '@dshapps/webpage'],
    ['gateway', '@dshapps/dsh-gateway'],
    ['gateway-runtime', '@dshapps/dsh-gateway-runtime'],
    ['gateway-analytics', '@dshapps/dsh-gateway-analytics', {
      stateDir: path.join(profileDirectory, 'packed-analytics'),
      pollIntervalMs: 1_000,
    }],
  ]
  const coreRows = [
    ['llm', '@deepseek-ai/dsh-llm'],
    ['settings', '@deepseek-ai/dsh-settings-file', { path: path.join(profileDirectory, 'packed-settings.yaml'), watch: false }],
    ['credentials', '@deepseek-ai/dsh-credentials-local', { path: path.join(profileDirectory, 'packed-credentials.yaml'), watch: false }],
    ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
    ['attachments', '@deepseek-ai/dsh-attachment-local', { dshHome: profileDirectory }],
    ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'],
  ]
  try {
    for (const [id, name, config] of coreRows) await ctx.loader.create({ id, name, ...(config === undefined ? {} : { config }) })
    for (const [id, name, config] of rows) await ctx.loader.create({ id, name, ...(config === undefined ? {} : { config }) })
    await ctx.loader.await()
    for (const [id, name] of rows) {
      const entry = ctx.loader.resolve(id)
      assert(entry.options.name === name, `${id}: Loader name drift`)
      assert(entry.fiber !== undefined, `${id}: packed Host entry did not create a Cordis fiber`)
    }
    const analytics = ctx.get('gatewayAnalytics')
    assert(analytics !== undefined, 'packed Analytics service is unavailable')
    const analyticsStatus = await analytics.status()
    assert(analyticsStatus.availability !== 'disabled', 'packed Analytics worker did not start')
    await fs.stat(path.join(profileDirectory, 'packed-analytics', 'usage.sqlite3'))
    for (const [id] of [...rows].reverse()) await ctx.loader.remove(id)
    for (const [id] of [...coreRows].reverse()) await ctx.loader.remove(id)
    await ctx.loader.await()
    assert([...ctx.loader.entries()].length === 0, 'packed Host Loader entries survived unload')
  } finally {
    await ctx.fiber.dispose()
  }
  return rows.map(([id, name]) => `${id}=${name}`)
}

if (process.env.DSH_GATEWAY_REUSE_RELEASE !== '1') {
  run(process.execPath, ['scripts/release/build-release.mjs'])
}
const releaseManifest = JSON.parse(await fs.readFile(path.join(githubDirectory, 'release-manifest.json'), 'utf8'))
const checksumEntries = new Map((await fs.readFile(path.join(githubDirectory, 'SHA256SUMS'), 'utf8'))
  .trim()
  .split(/\r?\n/u)
  .map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u)
    assert(match, `malformed SHA256SUMS line: ${line}`)
    return [match[2], match[1]]
  }))
assert(releaseManifest.release.tag === releaseTag, 'release tag drift')
assert(releaseManifest.externalArtifacts[0].sha256 === webpage.sha256, 'dsh-webpage provenance drift')
assert(releaseManifest.packages.length === packageSpecs.length, 'release package count drift')
const localWebpage = path.join(localDirectory, webpage.filename)
assert(await sha256(localWebpage) === webpage.sha256, 'local envelope dsh-webpage digest drift')
assert(releaseManifest.localVerification.externalArtifacts[0].localSha256 === webpage.sha256, 'local dsh-webpage manifest digest drift')
assert(releaseManifest.localVerification.packages.length === packageSpecs.length, 'local release package count drift')

for (const spec of packageSpecs) {
  const github = inspectManifest(spec, 'github')
  const local = inspectManifest(spec, 'local')
  assertDependencyClosure(spec, github.manifest, 'github')
  assertDependencyClosure(spec, local.manifest, 'local')
  assertFlavorEquivalence(spec, github, local)
  const recorded = releaseManifest.packages.find((entry) => entry.name === spec.name)
  assert(recorded, `${spec.name}: release manifest entry missing`)
  assert(recorded.url === packageUrl(spec.name), `${spec.name}: release URL drift`)
  assert(recorded.sha256 === await sha256(github.tarball), `${spec.name}: release SHA-256 drift`)
  assert(checksumEntries.get(recorded.filename) === recorded.sha256, `${spec.name}: SHA256SUMS drift`)
  if (spec.key.startsWith('platform-')) {
    const provenance = JSON.parse(tarText(github.tarball, 'package/provenance/cli-proxy-api.json'))
    assert(recorded.upstream?.tag === 'v7.2.131', `${spec.name}: upstream tag missing from release manifest`)
    assert(recorded.upstream?.assetUrl === provenance.upstream.assetUrl, `${spec.name}: upstream asset URL drift`)
    assert(recorded.upstream?.assetSha256 === provenance.upstream.assetSha256, `${spec.name}: upstream asset digest drift`)
    assert(recorded.executable?.sha256 === provenance.executable.sha256, `${spec.name}: executable digest drift`)
  }
}
for (const filename of ['release-manifest.json', 'NOTICE']) {
  assert(checksumEntries.get(filename) === await sha256(path.join(githubDirectory, filename)), `${filename}: SHA256SUMS drift`)
}
assert(checksumEntries.size === packageSpecs.length + 2, 'SHA256SUMS contains an unexpected or missing release file')

const verificationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gateway-pack-'))
const dshHome = path.join(verificationRoot, 'dsh-home')
const outsideCwd = path.join(verificationRoot, 'outside-checkout')
await fs.mkdir(outsideCwd, { recursive: true })
const dsh = findDsh()
const profile = 'gateway-phase1-pack'
const isolatedEnvironment = {
  ...process.env,
  DSH_HOME: dshHome,
  COREPACK_ENABLE_NETWORK: '0',
  npm_config_offline: 'true',
  npm_config_registry: 'http://127.0.0.1:9',
  PNPM_CONFIG_OFFLINE: 'true',
  PNPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
}
const packTarball = path.join(localDirectory, packageFilename('@dshapps/dsh-gateway-pack'))
const log = []
log.push(`verificationRoot=${verificationRoot}`)
log.push(`dsh=${dsh.command} ${dsh.prefix.join(' ')}`)
const dshVersion = run(dsh.command, [...dsh.prefix, '--version'], { cwd: outsideCwd, env: isolatedEnvironment, capture: true }).trim()
assert(dshVersion === '0.1.0-rc.6', `packed install used DSH ${dshVersion}`)
log.push(dshVersion)
const installOutput = run(dsh.command, [...dsh.prefix, 'plugin', '--profile', profile, 'add', packTarball], {
  cwd: outsideCwd,
  env: isolatedEnvironment,
  capture: true,
})
assert(!/registry[.]npmjs[.]org/iu.test(installOutput), 'packed install contacted the npm registry')
assert(!/127[.]0[.]0[.]1:9/iu.test(installOutput), 'packed install attempted the disabled registry')
log.push(installOutput)
const dump = run(dsh.command, [...dsh.prefix, '--profile', profile, '--dump-config'], {
  cwd: outsideCwd,
  env: isolatedEnvironment,
  capture: true,
})
log.push(dump)
for (const id of ['webpage', 'gateway', 'gateway-runtime', 'gateway-analytics']) {
  assert(dump.includes(`id: ${id}`), `DSH dump-config omitted ${id}`)
}

const profileDirectory = path.join(dshHome, 'profiles', profile)
const profileRequire = createRequire(path.join(profileDirectory, 'package.json'))
const hostLifecycle = await verifyPackedHostLifecycle(profileDirectory)
log.push(`packedHostLifecycle=${hostLifecycle.join(',')}`)
log.push('packedHostUnload=PASS')
for (const spec of packageSpecs.filter((entry) => !entry.key.startsWith('platform-'))) {
  const manifestPath = profileRequire.resolve(`${spec.name}/package.json`)
  const installed = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert(installed.version === '0.1.0', `${spec.name}: installed version drift`)
  const loaded = await import(pathToFileURL(profileRequire.resolve(spec.name)).href)
  assert(!Object.hasOwn(loaded, 'default'), `${spec.name}: installed Node entry has a default export`)
}
const platformByHost = {
  'win32-x64': '@dshapps/dsh-gateway-platform-win32-x64',
  'win32-arm64': '@dshapps/dsh-gateway-platform-win32-arm64',
  'darwin-x64': '@dshapps/dsh-gateway-platform-darwin-x64',
  'darwin-arm64': '@dshapps/dsh-gateway-platform-darwin-arm64',
  'linux-x64': '@dshapps/dsh-gateway-platform-linux-x64',
  'linux-arm64': '@dshapps/dsh-gateway-platform-linux-arm64',
}
const selectedPlatform = platformByHost[`${process.platform}-${process.arch}`]
assert(selectedPlatform, `unsupported verification host ${process.platform}-${process.arch}`)
const installedPlatforms = []
for (const spec of packageSpecs.filter((entry) => entry.key.startsWith('platform-'))) {
  try {
    profileRequire.resolve(`${spec.name}/package.json`)
    installedPlatforms.push(spec.name)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
}
assert(JSON.stringify(installedPlatforms) === JSON.stringify([selectedPlatform]), `platform selection installed ${installedPlatforms.join(', ')}`)
const selectedManifestPath = profileRequire.resolve(`${selectedPlatform}/package.json`)
assert(selectedManifestPath.startsWith(profileDirectory), 'selected platform resolved outside disposable profile')
const selectedManifest = JSON.parse(await fs.readFile(selectedManifestPath, 'utf8'))
assert(selectedManifest.os.includes(process.platform), 'installed platform os selection drift')
assert(selectedManifest.cpu.includes(process.arch), 'installed platform cpu selection drift')
const selectedRoot = path.dirname(selectedManifestPath)
const selectedProvenance = JSON.parse(await fs.readFile(path.join(selectedRoot, selectedManifest.dshappsPlatform.provenance), 'utf8'))
const selectedBinary = path.join(selectedRoot, selectedManifest.dshappsPlatform.binary)
assert(await sha256(selectedBinary) === selectedProvenance.executable.sha256, 'installed platform executable digest drift')
assert(selectedProvenance.target.os === process.platform && selectedProvenance.target.cpu === process.arch, 'installed platform provenance target drift')
const selectedLicense = await fs.readFile(path.join(selectedRoot, 'LICENSE'), 'utf8')
assert(/permission is hereby granted/iu.test(selectedLicense), 'installed platform upstream MIT license is missing')
log.push(`selectedPlatform=${selectedPlatform}`)
log.push(`selectedPlatformBinarySha256=${selectedProvenance.executable.sha256}`)
const webpageClient = profileRequire.resolve('@dshapps/webpage/client')
assert(webpageClient.startsWith(profileDirectory), `dsh-webpage/client resolved outside disposable profile: ${webpageClient}`)
const gatewayClient = await loadPackedGatewayClient(profileRequire)
assert(gatewayClient.startsWith(profileDirectory), `dsh-gateway/client resolved outside disposable profile: ${gatewayClient}`)
log.push(`packedGatewayClient=${gatewayClient}`)
log.push('packedGatewayClientHandoff=PASS')

await fs.mkdir(reportDirectory, { recursive: true })
await fs.writeFile(path.join(reportDirectory, 'phase1-packed-install.log'), `${log.join('\n')}\n`, 'utf8')
process.stdout.write(`packed install verified in external directory: ${outsideCwd}\n`)
process.stdout.write(`evidence: ${path.join(reportDirectory, 'phase1-packed-install.log')}\n`)
await fs.rm(verificationRoot, { recursive: true, force: true })
