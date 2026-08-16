import { run } from '@dshapps/app-check'

const mode = process.argv.find(arg => arg.startsWith('--'))
await run('packages/gateway', mode)
