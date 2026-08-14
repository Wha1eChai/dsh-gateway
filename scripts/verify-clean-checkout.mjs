import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCli = process.env.npm_execpath
if (!pnpmCli) throw new Error('clean-checkout verification must be launched through pnpm')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    stdio: 'pipe',
  })
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${output}`)
  return output
}

const sourceFiles = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  .split('\0')
  .filter(Boolean)
  .sort()
const verificationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gateway-clean-'))
const checkout = path.join(verificationRoot, 'checkout')
const store = path.join(verificationRoot, 'pnpm-store')
const reportPath = path.join(root, '.staging', 'reports', 'phase1-clean-checkout.log')
await fs.mkdir(checkout, { recursive: true })
for (const file of sourceFiles) {
  const source = path.join(root, file)
  const destination = path.join(checkout, file)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
}

const log = [`verificationRoot=${verificationRoot}`, `sourceFiles=${sourceFiles.length}`]
try {
  log.push(run('git', ['init', '--initial-branch=main'], { cwd: checkout }))
  log.push(run('git', ['config', 'user.name', 'dsh-gateway verifier'], { cwd: checkout }))
  log.push(run('git', ['config', 'user.email', 'verifier@invalid.local'], { cwd: checkout }))
  log.push(run('git', ['add', '--all'], { cwd: checkout }))
  log.push(run('git', ['commit', '-m', 'verification snapshot'], { cwd: checkout }))
  const cleanEnvironment = {
    ...process.env,
    DSH_GATEWAY_CLEAN_VERIFY: '1',
    npm_config_store_dir: store,
    PNPM_CONFIG_STORE_DIR: store,
  }
  log.push(run(process.execPath, [pnpmCli, 'install', '--frozen-lockfile'], {
    cwd: checkout,
    env: cleanEnvironment,
  }))
  log.push(run(process.execPath, [pnpmCli, 'run', 'verify'], {
    cwd: checkout,
    env: cleanEnvironment,
  }))
  const cleanManifest = JSON.parse(await fs.readFile(
    path.join(checkout, '.staging', 'release', 'v0.1.0', 'github', 'release-manifest.json'),
    'utf8',
  ))
  if (cleanManifest.source.dirty !== false) throw new Error('clean release manifest reported a dirty source tree')
  log.push(`cleanReleaseSource=${JSON.stringify(cleanManifest.source)}`)
  const status = run('git', ['status', '--porcelain'], { cwd: checkout }).trim()
  if (status) throw new Error(`clean checkout became dirty after verification:\n${status}`)
  log.push('cleanGitStatus=PASS')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${log.join('\n')}\n`, 'utf8')
  process.stdout.write(`clean source checkout verification passed: ${sourceFiles.length} files\n`)
  process.stdout.write(`evidence: ${reportPath}\n`)
  await fs.rm(verificationRoot, { recursive: true, force: true })
} catch (error) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${log.join('\n')}\n${error instanceof Error ? error.stack : String(error)}\n`, 'utf8')
  throw error
}
