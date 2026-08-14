#!/usr/bin/env node

import { runScenarios } from '../tests/browser/phase6-gateway.e2e.mjs'

if (process.env.DSH_GATEWAY_PHASE6_REUSE_RELEASE !== '1') {
  process.env.DSH_GATEWAY_PHASE6_REBUILD = '1'
}

await runScenarios()
