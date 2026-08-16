import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  packageFilename,
  packageSpecs,
  packageUrl,
  portableFileSpecifier,
  releaseTag,
  version,
  webpage,
} from './release-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stagingRoot = path.join(root, '.staging', 'release', releaseTag)
const githubDirectory = path.join(stagingRoot, 'github')
const localDirectory = path.join(stagingRoot, 'local')
const sourceDirectory = path.join(stagingRoot, 'sources')
const cacheDirectory = path.join(root, '.staging', 'cache')
const webpageTarball = path.join(cacheDirectory, webpage.filename)
const localWebpageTarball = path.join(localDirectory, webpage.filename)
const localZodTarball = path.join(localDirectory, 'zod-4.4.3.tgz')
const pnpmCli = process.env.npm_execpath
assert(pnpmCli, 'release build must be launched through pnpm')

/** @returns {{ cli: string, prefix: string[] } | null} */
function tryCorepackPnpm() {
  const prefix = ['pnpm@11.7.0']
  const nodeDir = path.dirname(process.execPath)
  const candidates = [
    path.join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ]
  for (const corepackCli of candidates) {
    if (!existsSync(corepackCli)) continue
    try {
      const version = execFileSync(process.execPath, [corepackCli, ...prefix, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (version === '11.7.0') return { cli: path.resolve(corepackCli), prefix }
    } catch {
      // try the next Corepack install layout
    }
  }
  return null
}

/** Invoke pnpm 11.7.0 explicitly; npm_execpath under corepack may resolve 11.0.9. */
function runPnpm(args, options = {}) {
  const corepack = tryCorepackPnpm()
  if (corepack) {
    return run(process.execPath, [corepack.cli, ...corepack.prefix, ...args], options)
  }
  return run(process.execPath, [pnpmCli, ...args], options)
}

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
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr ?? ''}`)
  }
  return result.stdout ?? ''
}

async function sha256(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

async function ensureWebpageTarball() {
  await fs.mkdir(cacheDirectory, { recursive: true })
  let valid = false
  try {
    valid = await sha256(webpageTarball) === webpage.sha256
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (valid) return

  const siblingWebpage = path.join(root, '..', 'dsh-webpage', 'packages', 'webpage')
  try {
    await fs.access(siblingWebpage)
    runPnpm(['--dir', siblingWebpage, 'pack', '--pack-destination', cacheDirectory], { capture: true })
    const entries = await fs.readdir(cacheDirectory)
    const packed = entries.find((entry) => entry.startsWith('dshapps-webpage-') && entry.endsWith('.tgz'))
    assert(packed, 'sibling dsh-webpage pack did not emit a tarball')
    const packedPath = path.join(cacheDirectory, packed)
    if (packedPath !== webpageTarball) {
      await fs.rm(webpageTarball, { force: true })
      await fs.rename(packedPath, webpageTarball)
    }
    assert(await sha256(webpageTarball) === webpage.sha256, 'sibling dsh-webpage SHA-256 drift; update release-contract.mjs webpage.sha256')
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const response = await fetch(webpage.url, { redirect: 'follow' })
  assert(response.ok, `cannot download pinned dsh-webpage artifact: HTTP ${response.status}`)
  const temporary = `${webpageTarball}.part`
  await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()))
  assert(await sha256(temporary) === webpage.sha256, 'dsh-webpage SHA-256 mismatch')
  await fs.rename(temporary, webpageTarball)
}

function isExcluded(entryPath) {
  return entryPath.split(path.sep).some((part) =>
    ['node_modules', '.cache', '.staging'].includes(part))
    || /[.]test[.](?:d[.]ts|js|js[.]map)$/u.test(entryPath)
}

async function stageSource(spec, flavor, dependencyFiles) {
  const source = path.join(root, spec.directory)
  const destination = path.join(sourceDirectory, flavor, spec.key)
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, {
    recursive: true,
    filter: (entryPath) => !isExcluded(path.relative(source, entryPath)),
  })

  const manifestPath = path.join(destination, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert(manifest.name === spec.name, `${spec.directory}: package name drift`)
  assert(manifest.version === version, `${spec.directory}: version drift`)

  const own = (name) => flavor === 'github'
    ? packageUrl(name)
    : portableFileSpecifier(dependencyFiles.get(name))
  if (spec.key === 'runtime') {
    for (const name of Object.keys(manifest.optionalDependencies)) {
      manifest.optionalDependencies[name] = own(name)
    }
  } else if (spec.key === 'analytics') {
    manifest.dependencies['@dshapps/dsh-gateway'] = own('@dshapps/dsh-gateway')
  } else if (spec.key === 'pack') {
    manifest.dependencies['@dshapps/webpage'] = flavor === 'github'
      ? webpage.url
      : portableFileSpecifier(localWebpageTarball)
    for (const name of [
      '@dshapps/dsh-gateway',
      '@dshapps/dsh-gateway-runtime',
      '@dshapps/dsh-gateway-analytics',
    ]) manifest.dependencies[name] = own(name)
  }
  if (spec.key === 'gateway' && flavor === 'local') {
    manifest.dependencies.zod = portableFileSpecifier(localZodTarball)
  }

  // Build-only workspace and fixture dependencies never belong to release manifests.
  delete manifest.devDependencies

  const serialized = JSON.stringify(manifest)
  assert(!serialized.includes('workspace:'), `${spec.name}: workspace dependency leaked into ${flavor} manifest`)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return destination
}

async function packSource(spec, flavor, dependencyFiles) {
  const outputDirectory = flavor === 'github' ? githubDirectory : localDirectory
  const staged = await stageSource(spec, flavor, dependencyFiles)
  const report = JSON.parse(runPnpm([
    'pack',
    '--json',
    '--pack-destination',
    outputDirectory,
  ], { cwd: staged, capture: true }))
  assert(path.basename(report?.filename ?? '') === packageFilename(spec.name), `${spec.name}: unexpected tarball name ${report?.filename}`)
  const tarball = path.join(outputDirectory, packageFilename(spec.name))
  dependencyFiles.set(spec.name, tarball)
  const packedManifest = JSON.parse(await fs.readFile(path.join(staged, 'package.json'), 'utf8'))
  const dependencies = []
  for (const group of ['dependencies', 'optionalDependencies']) {
    for (const [name, specifier] of Object.entries(packedManifest[group] ?? {})) {
      dependencies.push({ group, name, specifier })
    }
  }
  const entry = {
    name: spec.name,
    version,
    filename: report.filename,
    url: packageUrl(spec.name),
    sha256: await sha256(tarball),
    bytes: (await fs.stat(tarball)).size,
    sourceDirectory: spec.directory,
    dependencies,
  }
  if (spec.key.startsWith('platform-')) {
    const provenance = JSON.parse(await fs.readFile(path.join(staged, 'provenance', 'cli-proxy-api.json'), 'utf8'))
    entry.upstream = provenance.upstream
    entry.target = provenance.target
    entry.executable = provenance.executable
  }
  return entry
}

async function buildFlavor(flavor) {
  const outputDirectory = flavor === 'github' ? githubDirectory : localDirectory
  await fs.rm(outputDirectory, { recursive: true, force: true })
  await fs.mkdir(outputDirectory, { recursive: true })
  if (flavor === 'local') {
    await fs.cp(webpageTarball, localWebpageTarball)
    const zodRoot = path.dirname(fileURLToPath(import.meta.resolve('zod/package.json')))
    runPnpm(['pack', '--pack-destination', localDirectory], { cwd: zodRoot, capture: true })
    assert(await fs.stat(localZodTarball).then(() => true, () => false), 'local zod tarball was not created')
  }
  const dependencyFiles = new Map()
  const results = []
  const order = flavor === 'local'
    ? [
        ...packageSpecs.filter((spec) => spec.key.startsWith('platform-')),
        ...packageSpecs.filter((spec) => spec.key === 'gateway'),
        ...packageSpecs.filter((spec) => ['runtime', 'analytics'].includes(spec.key)),
        ...packageSpecs.filter((spec) => spec.key === 'pack'),
      ]
    : packageSpecs
  for (const spec of order) results.push(await packSource(spec, flavor, dependencyFiles))
  return results
}

function currentToolVersion(command, args) {
  return run(command, args, { capture: true }).trim()
}

async function sourceIdentity() {
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { capture: true })
    .split('\0')
    .filter(Boolean)
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(await fs.readFile(path.join(root, file)))
    hash.update('\0')
  }
  return {
    gitRevision: run('git', ['rev-parse', 'HEAD'], { capture: true }).trim(),
    dirty: run('git', ['status', '--porcelain'], { capture: true }).trim().length > 0,
    fingerprintSha256: hash.digest('hex'),
    files: files.length,
  }
}

// Capture the source envelope before build and packaging steps create transient
// files. Release provenance must describe the input checkout, not build state.
const releaseSource = await sourceIdentity()

run(process.execPath, ['scripts/platform/build-platform-packages.mjs'])
runPnpm(['run', 'build'])
await ensureWebpageTarball()
await fs.rm(sourceDirectory, { recursive: true, force: true })
const githubPackages = await buildFlavor('github')
const localPackages = await buildFlavor('local')
const pnpmVersion = (() => {
  const corepack = tryCorepackPnpm()
  if (corepack) {
    return execFileSync(process.execPath, [corepack.cli, ...corepack.prefix, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  }
  return currentToolVersion(process.execPath, [pnpmCli, '--version'])
})()
assert(pnpmVersion === '11.7.0', `release build used pnpm ${pnpmVersion}`)
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
assert(nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 19), `unsupported Node ${process.version}`)

const manifest = {
  schemaVersion: 1,
  release: {
    repository: 'https://github.com/dshapps/dsh-gateway',
    tag: releaseTag,
    version,
  },
  toolchain: {
    node: process.version,
    pnpm: pnpmVersion,
  },
  source: releaseSource,
  externalArtifacts: [webpage],
  packages: githubPackages,
  localVerification: {
    externalArtifacts: [{
      ...webpage,
      localFilename: webpage.filename,
      localSha256: await sha256(localWebpageTarball),
    }],
    packages: localPackages.map(({ name, version, filename, sha256, bytes, dependencies }) => ({
      name,
      version,
      filename,
      sha256,
      bytes,
      dependencies,
    })),
  },
}
await fs.writeFile(path.join(githubDirectory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await fs.cp(path.join(root, 'NOTICE'), path.join(githubDirectory, 'NOTICE'))
const sums = [
  ...githubPackages.map((entry) => `${entry.sha256}  ${entry.filename}`),
  `${await sha256(path.join(githubDirectory, 'release-manifest.json'))}  release-manifest.json`,
  `${await sha256(path.join(githubDirectory, 'NOTICE'))}  NOTICE`,
].sort()
await fs.writeFile(path.join(githubDirectory, 'SHA256SUMS'), `${sums.join('\n')}\n`)
await fs.rm(sourceDirectory, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify({ githubDirectory, localDirectory, packages: githubPackages.length }, null, 2)}\n`)
