# Phase 3 evidence — provider, OAuth, Host/Remote, and App foundation

Status: Complete / GO.

Environment: Windows 11 x64; Node 24.11.1; pnpm 11.7.0; DSH 0.1.0-rc.6;
dsh-webpage 0.1.0; CLIProxyAPI 7.2.131.

## Commands and observed results

| Command | Result |
| --- | --- |
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm exec vitest run packages/gateway/src/host/provider/provider.test.ts packages/gateway/src/host/oauth/oauth.test.ts packages/gateway/src/host/cpa-client/cpa-client.test.ts --config vitest.config.ts` | 35 tests passed after the OAuth terminal-process regression fix |
| `pnpm test:unit` | 11 fake-CPA tests and 55 Vitest tests passed in the clean-checkout aggregate |
| `node scripts/verify-phase3.mjs` | PASS: built Loader entry, 2 discovered models, official `cpa` provider, text probe, 11 generated Remote descriptors, and clean unload |
| `pnpm pack:verify` | PASS: repository-external offline packed install, Host lifecycle, and client bundle import |

The focused OAuth evidence matches CLIProxyAPI v7.2.131's exact device-login
labels, derives the bounded 15-minute expiry and 5-second poll interval, and
keeps local callback capability fail-closed without the trusted server-derived
origin seam. Parser/manager errors and status projections do not retain private
paths, tokens, or raw subprocess output.

The focused Luna gate review found one lifecycle STOP: a parsed terminal OAuth
marker could leave a still-running CPA child behind. The manager now terminates
and joins on every parsed terminal state, disposal awaits any outstanding join,
and four regression cases cover success, denied, expired, and cancelled.

## Generated Remote allowlist

The built `@wha1echai/dsh-gateway` Remote contribution contains exactly these
11 strict endpoints:

1. `gateway.status`
2. `gateway.runtimeInstall`
3. `gateway.runtimeStart`
4. `gateway.runtimeStop`
5. `gateway.runtimeRestart`
6. `gateway.models`
7. `gateway.applyModels`
8. `gateway.oauthDeviceStart`
9. `gateway.oauthDeviceStatus`
10. `gateway.oauthDeviceCancel`
11. `gateway.probe`

The Client mounts this generated contribution through `ctx.remote.$mount()`.
The current App is the minimal `wha1echai.gateway` foundation: descriptor,
locale, Webpage slot registration, sanitized runtime status, loading and
unavailable states, and clean disposal. Full dashboard routes, Playground,
browser, and HMR acceptance remain planned Phase 5/6 work.

## Compatibility limitation

rc.6 Typert generation needs the narrow
`patches/dsh-typert-generator-0.1.0-rc.6.patch` build-only compatibility patch
so the generator recognizes installed official protocol declarations for this
out-of-tree package. This is a known build limitation, not a runtime fork,
protocol fork, or alternate transport. Revisit it when the upstream generator
provides the required recognition behavior.

## Gate boundary and next phase

Phase 3 GO covers the provider bridge, explicit model capability, bounded
device OAuth, fail-closed callback capability, strict Host BFF, generated
Remote artifact, official `ctx.llm` text probe, Loader unload, and packed
client import. It does not claim browser/HMR/full `pnpm verify`, analytics, or
the complete App. The next phase is Phase 4 Analytics.
