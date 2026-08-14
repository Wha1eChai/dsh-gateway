import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageFilename, packageSpecs, releaseTag } from './release/release-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDirectory = path.join(root, '.staging', 'release', releaseTag, 'github')

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 1 security check failed: ${message}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: options.buffer ? undefined : 'utf8',
    shell: false,
    stdio: 'pipe',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr?.toString() ?? ''}`)
  return result.stdout
}

function tarEntries(tarball) {
  return run('tar', ['-tzf', tarball]).split(/\r?\n/u).filter(Boolean)
}

function tarText(tarball, member) {
  return run('tar', ['-xOzf', tarball, member])
}

const packageManifestPaths = [
  ...packageSpecs.map((spec) => path.join(root, spec.directory, 'package.json')),
  path.join(root, 'tests', 'fixtures', 'fake-cpa', 'package.json'),
]
for (const manifestPath of packageManifestPaths) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  for (const name of ['preinstall', 'install', 'postinstall']) {
    assert(manifest.scripts?.[name] === undefined, `${manifest.name} declares ${name}`)
  }
  for (const [name, value] of Object.entries(manifest.peerDependencies ?? {})) {
    assert(/^\d+[.]\d+[.]\d+(?:-rc[.]\d+)?$/u.test(value), `${manifest.name} has non-exact peer ${name}@${value}`)
  }
  for (const [group, dependencies] of Object.entries({
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
  })) {
    for (const [name, value] of Object.entries(dependencies ?? {})) {
      assert(name.startsWith('@wha1echai/'), `${manifest.name} has unexpected ${group} registry edge ${name}@${value}`)
      assert(value === 'workspace:*' || /^https:\/\/github[.]com\/[^\s]+[.]tgz$/u.test(value), `${manifest.name} has unsafe ${group} edge ${name}@${value}`)
    }
  }
}

const sourceFiles = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  .split('\0')
  .filter(Boolean)
assert(sourceFiles.every((file) => !/(?:^|\/)(?:node_modules|lib|vendor|\.cache|\.staging)(?:\/|$)/u.test(file)), 'generated/cache/vendor path is tracked or unignored')
assert(sourceFiles.every((file) => !/(?:^|\/)(?:\.env(?:[.]|$)|auth-files?|credentials?|tokens?|prompts?|outputs?)(?:\/|$)/iu.test(file)), 'secret/content-bearing filename entered the source envelope')

const releaseManifestPath = path.join(releaseDirectory, 'release-manifest.json')
const releaseManifest = JSON.parse(await fs.readFile(releaseManifestPath, 'utf8'))
assert(releaseManifest.packages.length === packageSpecs.length, 'release manifest package closure drift')
for (const spec of packageSpecs) {
  const tarball = path.join(releaseDirectory, packageFilename(spec.name))
  const entries = tarEntries(tarball)
  for (const entry of entries) {
    assert(entry.startsWith('package/'), `${spec.name} has an absolute/non-package tar member: ${entry}`)
    assert(!entry.includes('..'), `${spec.name} has a parent-path tar member: ${entry}`)
    assert(!/(?:^|\/)(?:\.env|auth|credentials|tokens|logs?|prompts?|images?|outputs?|.*[.]sqlite(?:3)?)(?:\/|$)/iu.test(entry), `${spec.name} leaked a sensitive payload member: ${entry}`)
  }
  const manifest = JSON.parse(tarText(tarball, 'package/package.json'))
  const manifestText = JSON.stringify(manifest)
  assert(!manifestText.includes('workspace:'), `${spec.name} release manifest leaked workspace protocol`)
  assert(!manifestText.includes('file:'), `${spec.name} release manifest leaked local file protocol`)
  assert(!/[A-Z]:[\\/]/u.test(manifestText), `${spec.name} release manifest leaked an absolute Windows path`)
  assert(!manifestText.includes('/home/'), `${spec.name} release manifest leaked an absolute POSIX home path`)
  for (const name of ['preinstall', 'install', 'postinstall']) {
    assert(manifest.scripts?.[name] === undefined, `${spec.name} packed manifest declares ${name}`)
  }
}

process.stdout.write(`Phase 1 package security boundary passed for ${packageSpecs.length} release tarballs and ${sourceFiles.length} source files\n`)
