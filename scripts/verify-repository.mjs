import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const mode = process.argv[2]
const validModes = new Set(['lint', 'supply-chain'])

if (!validModes.has(mode)) {
  throw new Error(`usage: verify-repository.mjs <${[...validModes].join('|')}>`)
}

const ignoredDirectories = new Set([
  '.git',
  '.cache',
  '.staging',
  '.tmp',
  'coverage',
  'lib',
  'node_modules',
  'playwright-report',
  'test-results',
  'vendor',
])

function walk(directory, predicate, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) walk(path, predicate, output)
    else if (predicate(path)) output.push(path)
  }
  return output
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workspaceManifests() {
  return walk(root, (path) => path.endsWith('package.json'))
    .map((path) => ({ path, data: readJson(path) }))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function verifyLint() {
  const textExtensions = new Set([
    '.css', '.js', '.json', '.md', '.mjs', '.ts', '.tsx', '.yaml', '.yml',
  ])
  for (const path of walk(root, (file) => {
    const extension = file.slice(file.lastIndexOf('.'))
    return textExtensions.has(extension)
  })) {
    const content = readFileSync(path, 'utf8')
    assert(!/[ \t]+$/mu.test(content), `${relative(root, path)} has trailing whitespace`)
  }

  for (const { path, data } of workspaceManifests()) {
    for (const name of ['preinstall', 'install', 'postinstall']) {
      assert(data.scripts?.[name] === undefined, `${relative(root, path)} declares ${name}`)
    }
  }

  for (const path of walk(resolve(root, 'packages'), (file) =>
    /[\\/]src[\\/].+\.(?:ts|tsx)$/u.test(file))) {
    const content = readFileSync(path, 'utf8')
    assert(!/^export\s+default\b/mu.test(content), `${relative(root, path)} exports default`)
  }

  process.stdout.write('repository lint checks passed\n')
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}

function verifySupplyChain() {
  const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  assert(/allowBuilds:\r?\n\s+'@deepseek-ai\/dsh-subprocess-local': true\r?\n\s+'@google\/genai': false\r?\n\s+node-pty: true\r?\n\s+protobufjs: false/u.test(workspace), 'pnpm allowBuilds allowlist/denylist drift')
  assert(existsSync(resolve(root, 'pnpm-lock.yaml')), 'pnpm-lock.yaml is missing')

  for (const { path, data } of workspaceManifests()) {
    for (const name of ['preinstall', 'install', 'postinstall']) {
      assert(data.scripts?.[name] === undefined, `${relative(root, path)} declares ${name}`)
    }
  }

  run(process.execPath, ['scripts/platform/build-platform-packages.mjs'])
  run(process.execPath, ['scripts/platform/verify-platform-packages.mjs'])
  run(process.execPath, ['--test', 'tests/supply-chain/platform.test.mjs'])
  process.stdout.write('repository supply-chain checks passed\n')
}

if (mode === 'lint') verifyLint()
if (mode === 'supply-chain') verifySupplyChain()
