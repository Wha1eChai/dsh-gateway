// Executable entrypoint retained under tests/browser for browser-lane discovery.
// The implementation lives in scripts/phase6-hmr.mjs so the lane can be run
// directly without changing the root package scripts owned by another worker.
export { runHmrScenario } from '../../scripts/phase6-hmr.mjs'
