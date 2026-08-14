import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pnpmCli = process.env.npm_execpath

if (!pnpmCli) throw new Error('verify must be launched through pnpm')

function pnpm(args) {
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} exited ${result.status}`)
}

pnpm(['install', '--frozen-lockfile'])
for (const script of [
  'build',
  'typecheck',
  'lint',
  'test:unit',
  'test:public-api',
  'test:llm-compat',
  'test:supply-chain',
  'pack:verify',
  'test:security',
]) pnpm(['run', script])

// The real CPA executable is an intentionally ignored, provenance-verified
// release input. The outer aggregate runs the complete integration lane; the
// source-only clean-checkout aggregate can only repeat the built Loader gate.
if (process.env.DSH_GATEWAY_CLEAN_VERIFY === '1') {
  pnpm(['exec', 'node', 'scripts/verify-phase3.mjs'])
} else {
  pnpm(['run', 'test:integration'])
}

if (process.env.DSH_GATEWAY_CLEAN_VERIFY !== '1') pnpm(['run', 'test:clean-checkout'])

process.stdout.write('Gateway aggregate verification passed\n')
