# Phase 0.1 — dsh-gateway execution plan

## Status and release boundary

| Item | Decision |
| --- | --- |
| Plan status | **Phases 0–6 — Complete / GO**; GitHub preview publication is the next action. |
| Code status | Runtime, provider/OAuth, optional SQLite analytics, and the six-route native Gateway App are implemented. |
| Release shape | Public, out-of-tree DSH Bundle/Pack preview composed from ordinary DSH Plugins; no DeepSeek Harness source changes and no npm publication in this preview. |
| Pinned compatibility | DeepSeek Harness `0.1.0-rc.6`; dsh-webpage `0.1.0`; CLIProxyAPI `7.2.131`; CPA-Manager-Plus `1.12.0-rc.2` as a reference only. |
| Toolchain | Node `^22.19.0 || >=24.0.0`; pnpm `11.7.0`; Windows 11 is the primary release verification environment. Managed-platform policy is Linux `no-plugin` only; Windows/macOS use standard upstream executable names with dynamic plugins disabled by configuration. |
| Trust boundary | DSH rc.6's trusted single-user Web boundary is inherited. v0.1 does not claim multi-user ACL security. |
| Data boundary | The browser receives no proxy keys, management keys, OAuth tokens, auth files, prompts, images, or model outputs except the rendered result needed by the existing `ctx.llm` UI path. |

The v0.1 slice initializes or connects to CLIProxyAPI, drives the existing
`llm-pi-ai` provider path, exposes an operations surface through generated
Typert Remotes, and provides a dsh-webpage App with a Playground and analytics
views. Managed mode is loopback-only; external mode requires an explicitly
configured endpoint. CLIProxyAPI remains the owner of provider login, account
selection, refresh, and failover.

The release does not include federation, multi-user authorization, CRDT
collaboration, account rotation policies, automatic cooldown/reset actions,
RESP usage ingestion, dynamic upstream plugins, upstream panel auto-update,
remote callback OAuth, a second LLM adapter, or npm publication.

The native App identity and route contract are frozen for this slice:

```text
App ID:       wha1echai.gateway
Base route:   /apps/wha1echai.gateway
Subroutes:    /accounts, /models, /requests, /playground, /settings
```

The gateway package's `./package.json` export map must expose the built Client
entry as `./client` (for example, `./dist/client.js` after build). The App is
loaded through that public export; a source-file path, deep private import, or
browser-side package fallback is not a valid substitute.

## Phase 2A non-negotiable compatibility gate

Phase 2A is a pre-runtime investment gate. It must use the real built official
`@deepseek-ai/dsh-llm-pi-ai` package and the public DSH `0.1.0-rc.6` client
surface against a deterministic fake/external CPA HTTP endpoint. It must prove
one complete text request, ordered streaming, tool declaration and
tool-call/result round trip, explicit image opt-in, and abort/cancellation.
The fixture must observe the CPA request and response so a mocked `ctx.llm`
or a gateway-owned adapter cannot satisfy the gate.

**Hard stop:** if any Phase 2A capability fails, stop before Phase 2B runtime
or client investment. Record the exact failing command and diagnostic, do not
add an adapter fallback or propose a second LLM adapter, and request an
explicit compatibility/scope decision before implementation continues.
`/v1/models` alone never proves image capability; image input is available only
for a model with an explicit verified capability declaration.

## Dependency edges

The phase order is binding. A later phase may not bypass an earlier public
contract or replace an unavailable proof with a mock-only result.

```text
approved scope + dsh-webpage preflight
  -> Phase 0 docs / ADR / evidence contract
    -> installed DSH rc.6 public-API probe
      -> Phase 1 workspace, package topology, and supply-chain gate
        -> Phase 2A llm-pi-ai text/tools/stream/image/abort hard gate
          -> Phase 2B runtime state machine and client integration
              -> Phase 3 provider/model capability, OAuth, and generated Host/Remote gate
                -> Phase 4 SQLite analytics and redacted event pipeline
                  -> Phase 5 dsh-webpage App and full ctx.llm Playground
                    -> Phase 6 browser/HMR/security/packed public preview
```

Supporting edges:

- DSH Plugin lifecycle and disposal own installation, withdrawal, runtime
  shutdown, and replacement. No parallel lifecycle or hidden singleton may
  outlive the owning Plugin.
- Settings writes use the public rc.6 form
  `ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops, revision)`; a
  settings-scope `mutate()` shortcut is not a supported API.
- Credential handling has three non-interchangeable paths: (1) the
  `llm-pi-ai` proxy credential ref/request for CPA data-plane model traffic;
  (2) the Gateway management credential ref for an allowlisted Host operation;
  and (3) the managed-child path, where the Host explicitly resolves only the
  required values into a scrubbed child environment. No path falls back to
  another path, and no value reaches the browser, argv, logs, analytics, or
  settings projections.
- Managed subprocesses must not execute a shell. Do not treat a boolean
  no-shell setting alone as evidence: the contract test must prove that the
  exact argv is passed without shell interpretation and that argv, cwd, stdio,
  termination `graceMs`, and scrubbed environment are explicit. Managed mode
  binds loopback only.
- Custom browser APIs are generated Typert Remote contributions mounted with
  `ctx.remote.$mount()`, allowlisted by contract, and never implemented as an
  arbitrary browser HTTP proxy.
- Prompt, attachment refs/content, and model result cross only the typed
  requesting `gateway.probe` flow. They are forbidden from operational Remotes,
  analytics, logs, database rows, or other persistence.
- Local callback OAuth is fail-closed until DSH exposes a public,
  server-derived trusted-origin seam. A client-supplied `Origin` is invalid
  authority. Device flow is the default and remains the available remote-capable
  path when that seam is absent.
- The HTTP usage queue is destructive pop with no acknowledgement. Collection
  is at-most-once: a crash after pop and before the database receives the
  record can lose it. The collector must expose degraded/completeness state;
  dedupe begins only after a record is received by the database, never before
  pop or solely in memory.
- The release uses one install from a clean directory outside this checkout.
  Non-local dependencies are immutable GitHub tarballs recorded with URL,
  version, and SHA-256. Explicit local generated-file overrides are permitted
  only for generated release artifacts and are themselves enumerated and
  hashed. No npm registry or runtime download is allowed.
- Runtime state is under `resolveDshHome()/dsh-gateway/v1`; DSH provides no
  automatic Plugin-private data directory.
- The real rc.6 Loader/profile and a repository-external packed install are
  required for integration and release evidence. Mocks may isolate unit
  behavior but cannot satisfy those gates.

## Frozen analytics, pricing, and quota contracts

The CPA HTTP usage queue is a destructive pop with no acknowledgement API.
The collector is therefore at-most-once, not exactly-once: an event removed
by pop can be lost if the collector crashes before the database receives it.
That loss window must set an explicit degraded/completeness state and remain
visible in diagnostics. Dedupe is allowed only after the database receives a
typed record and commits its receipt; in-memory keys and pre-pop keys are not
dedupe evidence. Managed mode has one collector owner. External collection is
opt-in and warns that another consumer can make history incomplete.

Pricing is a bundled immutable snapshot with a version and SHA-256 recorded
in the release manifest. It is not fetched, edited, or replaced at runtime.
Missing or incomplete pricing yields an unknown/partial estimate while
preserving token counts; it never becomes fabricated zero cost.

Quota v0.1 has one Host-internal Codex read adapter. It may call CPA
`POST /v0/management/api-call` only with a fixed, non-client-parameterized
payload whose values are constrained as follows:

```text
authIndex: selected only from the internal allowlisted auth-file inventory
method:    GET
url:       https://chatgpt.com/backend-api/wham/usage
headers:   Authorization: Bearer $TOKEN$
           Content-Type: application/json
           User-Agent: fixed Gateway User-Agent
           Chatgpt-Account-Id: optional selected internal account
```

The adapter strictly bounds response size, validates a closed schema, and
projects only quota windows. It never returns or stores the raw response.
There is no generic `/api-call` Remote and no user-controlled URL, method,
header, or body. Providers other than Codex may return typed
`unsupported`/`unavailable` quota state; both are valid and must not be
coerced into zero or a fabricated quota.

## Phase gates

| Phase | Status | Depends on | Deliverables | Stop/go gate |
| --- | --- | --- | --- | --- |
| 0. Documentation baseline | **Complete / GO** | Approved scope and dsh-webpage preflight | Scope boundary, architecture/design links, dependency map, package topology, ADR decisions, this phased plan, testing contract, acceptance matrix, evidence template, and HANDOFF update by the main thread | **GO** only after main-thread review accepts the docs as internally consistent. **STOP** on an unresolved public API, capability, licensing, security, or upstream-change contract. This pass does not commit or push. |
| 1. Workspace and supply chain | **Complete / GO** | Phase 0 GO | pnpm workspace; exact manifests and exports; public rc.6 API probe; package allowlists; platform binary provenance and upstream licenses; reproducible install/build scaffolding | **GO** when frozen install, public-only rc.6 imports/exports, typecheck, lint, build, package payload, provenance, and supply-chain checks pass. **STOP** on a private/local rc.5 import, floating DSH dependency, adjacent-checkout dependency, broad install-script approval, missing license/digest, or unreviewed executable. |
| 2A. `llm-pi-ai` compatibility hard gate | **Complete / GO** | Phase 1 GO | Real built official `@deepseek-ai/dsh-llm-pi-ai` public-contract probe against fake/external CPA: text, tools, stream, explicit image opt-in, and abort | **GO** only when all five behaviors pass on the same real path. **STOP before Phase 2B and all runtime/client investment** on any failure; no adapter fallback. |
| 2B. Runtime and client | **Complete / GO** | Phase 2A GO | Managed/external runtime state machine; process supervisor; readiness/health; settings and three-path credential handoff; DSH client installation; real `ctx.llm` request path | **GO** when all state transitions, disposal/restart behavior, and real rc.6 Loader/client lifecycle pass. **STOP** on shell execution, shell-interpreted argv, implicit process fields, leaked secret, duplicate lifecycle, or private API. |
| 3. Provider and OAuth | **Complete / GO** | Phase 2B GO | Model discovery and explicit capability registry; official `cpa` settings bridge; bounded Codex device login; fail-closed local callback capability; strict Host BFF; generated Typert Host/Remote artifacts; minimal `wha1echai.gateway` App foundation | **GO**: provider/model discovery, explicit image capability, bounded device flow, fail-closed callback capability, official `ctx.llm` probe, generated 11-endpoint allowlist, Loader unload, and packed client import passed. Browser, HMR, full App routes, analytics, and full aggregate remain later-phase work. |
| 4. Analytics | **Complete / GO** | Phase 3 GO | Optional SQLite plugin; checksummed migration; worker-owned WAL store and collector lease; redacted usage, token, latency, health and quota projections; rollups/retention; typed Host read surface; failure isolation | **GO**: 28 analytics tests, 23 quota/client tests, built-worker verification, exact tarball payload, repository-external packed worker, clean checkout, and full current-phase aggregate passed. Unknown pricing remains explicitly unpriced; analytics failure is off the model path. |
| 5. dsh-webpage App | **Complete / GO** | Phases 2–4 GO; provider/OAuth and analytics contracts | Native App package; launcher/settings/runtime/provider/OAuth/analytics views; full-path Playground using `ctx.llm`; unavailable/degraded states; generated Typert Remotes mounted by `ctx.remote.$mount()`; no browser proxy | **GO**: the real packed Browser passed all six routes, conversation preservation, model apply, text/image probes, opaque attachment upload, optional analytics states, and the 18-endpoint generated Remote boundary. |
| 6. Packed public preview | **Complete / GO** | Phases 1–5 GO | Exact tarballs/Pack; clean repository-external profile; real rc.6 Loader/CLI composition; browser acceptance; client HMR; security audit; final provenance, docs, and aggregate report | **GO**: all required lanes passed; HMR had no duplicate/stale lifecycle, browser/security assertions passed, and packed installation plus the 182-file clean checkout resolved outside this repository. |

Phase status is not evidence status. A phase cannot become `Complete` from code
inspection or review alone. Every phase record must include the exact command,
pinned environment, result, and artifact; an unavailable command remains
`BLOCKED` with its exact error and retry command.

## Per-phase execution, documentation, commit, and push discipline

### Luna worker ownership

The parent agent assigns one Luna worker to each implementation phase with a
disjoint write scope: workspace/supply chain (1), compatibility gate/runtime
and client (2A/2B),
provider/OAuth (3), analytics (4), App (5), and packed preview plus final
acceptance (6). A worker may inspect shared contracts but edits only its
assigned implementation/tests/evidence files. The parent thread owns
integration, conflict resolution, gate decisions, and the independent review;
workers do not silently widen a phase when a dependency is missing.

Every phase owner follows this sequence:

1. Before implementation, read this plan, `docs/testing.md`, the relevant
   design/ADR documents, and `HANDOFF.md`; verify the worktree and record the
   phase as `Planned` or `In Progress`. Add the phase evidence placeholder
   without promoting any unrun lane.
2. Implement only the phase's owned scope. Keep public API assumptions tied to
   installed rc.6 declarations/exports and record any deviation as a decision
   before coding around it.
3. Run the phase commands and focused regression scenarios in `docs/testing.md`.
   Capture tool versions, source revision, logs/reports/screenshots/tarballs,
   and exact diagnostics. A mock, code review, or green subset does not replace
   a required real Loader, browser, HMR, security, or packed-install artifact.
4. Update this plan, `docs/testing.md`, the relevant evidence/design records,
   and `HANDOFF.md` with status, concrete refs, observed result, open risks, and
   the gate decision. Keep the acceptance matrix synchronized.
5. Request independent standards/spec review. Resolve STOP findings before the
   gate. The main thread owns the final GO/STOP decision.
6. Only after GO, create an intentional phase commit and push the branch. Record
   commit hash, remote/branch, and artifact locations in the phase record. A
   phase commit must contain its code, tests, and documentation updates, not a
   later backfilled evidence claim.

## Phase evidence records

Use this record in the phase plan and the linked evidence file. Phases 0–3 are
recorded as complete; Phases 4–6 remain unverified.

```text
Phase: 0
Status: Complete / GO
Implementation refs: none; documentation-only gate
Evidence refs: README.md; HANDOFF.md; docs/design/*; docs/plan/phase-0.1-gateway.md; docs/testing.md
Commands: PowerShell local Markdown link/fence/trailing-whitespace check; fenced JSON parse; secret-pattern scan; upstream CPA release asset/checksum inspection; independent Sol contract review
Observed result: all static checks passed; all nine original Sol STOP findings and four follow-up consistency findings were resolved; final focused Sol re-review returned GO on 2026-08-14
Open risks/decisions: public rc.6 API probes, the llm-pi-ai compatibility proof, trusted-origin availability, and implementation security tests remain future gates
Gate decision: GO; Phase 1 may begin only after the docs-only root commit is pushed
Commit/push: this record is included in the repository's docs-only root phase commit
```

```text
Phase: 1
Status: Complete / GO
Implementation refs: package.json; pnpm-workspace.yaml; packages/*; packages/platform/*; provenance/cli-proxy-api/assets.json; scripts/release/*; scripts/platform/*; tests/fixtures/fake-cpa
Evidence refs: docs/evidence/phase-1.md; .staging/release/v0.1.0/github/release-manifest.json; .staging/release/v0.1.0/github/SHA256SUMS; .staging/reports/phase1-packed-install.log; .staging/reports/phase1-clean-checkout.log; scripts/verify-public-api.mjs; tests/public-api/contract.ts
Commands: pnpm install --frozen-lockfile; pnpm test:public-api; pnpm test:supply-chain; pnpm typecheck; pnpm lint; pnpm build; pnpm pack:verify; pnpm test:security; pnpm test:clean-checkout; pnpm verify
Observed result: frozen install, typecheck, lint, build, 11 fake-CPA tests, 20-package public API/Loader handoff probe, six-platform provenance verification, rewritten release tarballs, Phase 1 security, an offline/invalid-registry repository-external DSH Pack install, and a clean committed source snapshot with a fresh pnpm store all passed on Windows x64 with Node 24.11.1 and pnpm 11.7.0
Open risks/decisions: Phase 2A is intentionally unavailable and must not be counted as skipped or passing
Gate decision: GO; the complete aggregate and focused Luna/Sol reviews passed on 2026-08-14
Commit/push: this record is included in the Phase 1 Gate commit pushed to the public repository
```

```text
Phase: 2A
Status: Complete / GO
Implementation refs: scripts/verify-llm-compat.mjs; tests/fixtures/fake-cpa
Evidence refs: docs/evidence/phase-2a.md; CPA-observed PASS records emitted by pnpm test:llm-compat
Commands: pnpm test:public-api; pnpm test:llm-compat; pnpm typecheck
Observed result: the same real rc.6 Loader route passed text, tool call/result, ordered streaming, pre-dispatch text-only image rejection, image-enabled attachment delivery, and observable abort
Open risks/decisions: no official-path compatibility blocker and no custom adapter; runtime behavior remains Phase 2B work
Gate decision: GO on 2026-08-14
Commit/push: this record is included in the Phase 2A Gate commit pushed to the public repository
```

```text
Phase: 2B
Status: Complete / GO
Implementation refs: packages/runtime/src/index.ts; packages/gateway/src/host/cpa-client; packages/gateway/src/index.ts; scripts/verify-real-cpa.mjs
Evidence refs: docs/evidence/phase-2b.md; focused runtime/client tests; real CPA PASS record
Commands: pnpm test:unit; pnpm test:integration; pnpm test:public-api; pnpm typecheck; pnpm lint; pnpm build; pnpm test:supply-chain; pnpm test:security
Observed result: 28 workspace tests passed; CPA v7.2.131 started through DSH subprocess-local and passed health/models/auth-files/usage/termination; public API, build, supply chain, and security checks passed
Open risks/decisions: provider settings mutation and device OAuth intentionally remain Phase 3; no custom adapter or generic management proxy was introduced
Gate decision: GO on 2026-08-14
Commit/push: this record is included in the Phase 2B Gate commit pushed to the public repository
```

```text
Phase: 3
Status: Complete / GO
Implementation refs: packages/gateway/src/host/provider; packages/gateway/src/host/oauth; packages/gateway/src/host/cpa-client; packages/gateway/src/host/gateway-service.ts; packages/gateway/src/client; packages/gateway/package.json; scripts/verify-phase3.mjs
Evidence refs: docs/evidence/phase-3.md; built Loader verifier; generated lib/typert.host.js and lib/typert.remote-client.js; external packed-install verifier
Commands: pnpm build; pnpm typecheck; pnpm lint; pnpm exec vitest run packages/gateway/src/host/provider/provider.test.ts packages/gateway/src/host/oauth/oauth.test.ts packages/gateway/src/host/cpa-client/cpa-client.test.ts --config vitest.config.ts; pnpm test:unit; node scripts/verify-phase3.mjs; pnpm pack:verify
Observed result: build/typecheck/lint passed; focused provider/OAuth/CPA tests passed 35/35 after the terminal-process regression fix; the clean-checkout unit aggregate passed with 11 fake-CPA tests and 55 Vitest tests; the Phase 3 Loader verifier passed with 2 models, official cpa registration, a text probe, 11 generated Remote descriptors, and clean unload; packed verification passed with an external offline install, Host lifecycle, and client bundle import
Open risks/decisions: local callback remains fail-closed without a trusted server-derived origin; browser/HMR/full aggregate and the full App remain later-phase work; rc.6 Typert generator needs the narrow build-only patch recorded in docs/evidence/phase-3.md, which is not a runtime fork
Gate decision: GO; Phase 4 Analytics is the next phase
Commit/push: `7359eb3` (`feat: add gateway provider and OAuth bridge`) pushed to public `origin/main`
```

```text
Phase: 4
Status: Complete / GO
Implementation refs: packages/analytics/src; packages/gateway/src/host/gateway-service.ts; packages/gateway/src/host/cpa-client; scripts/verify-analytics.mjs; scripts/clean-analytics-build.mjs
Evidence refs: docs/evidence/phase-4.md; built worker PASS record; external packed-install report
Commands: pnpm test:analytics; pnpm test:quota; pnpm typecheck; pnpm lint; pnpm pack:verify; pnpm test:security
Observed result: 28 analytics and 23 quota/client tests passed; the fixed Host-only Codex quota selector/projector, fractional percent persistence, single-owner lease, failure latch, and typed unavailable state passed; the built and packed workers created schema v1 and closed; the 161-file clean checkout and full current-phase aggregate passed
Open risks/decisions: schema v1 is still an unreleased preview, so the pre-gate local checksum is intentionally not migrated; the immutable pricing snapshot is empty until a trusted versioned source is adopted; the destructive CPA queue remains explicitly at-most-once; the Browser receives no analytics Remote until Phase 5
Gate decision: GO on 2026-08-14
Commit/push: this record is included in the Phase 4 gate commit pushed to public `origin/main`
```

```text
Phase: 5
Status: Complete / GO
Implementation refs: packages/gateway/src/client; packages/gateway/src/host/contracts.ts; packages/gateway/src/host/gateway-service.ts
Evidence refs: docs/evidence/phase-5.md; built Loader output; repository-external packed Browser output
Commands: pnpm test:unit; pnpm test:integration; pnpm test:browser; pnpm test:security; pnpm typecheck; pnpm lint; pnpm build
Observed result: 90 aggregate Host tests after the injection regression; 18 generated Remotes; real 3080 smoke; packed rc.6 Browser passed six routes, deep link/reload/history, conversation identity, text/image Playground, and no secret-bearing image data in browser-visible persistence
Open risks/decisions: local callback remains fail-closed; Browser request/response is one-shot in v0.1 while the underlying official compatibility lane separately proves ordered streaming and abort
Gate decision: GO on 2026-08-14
Commit/push: included in the Phase 5 gate commit pushed to public origin/main
```

```text
Phase: 6
Status: Complete / GO
Implementation refs: packages/pack; scripts/phase6-browser.mjs; scripts/phase6-hmr.mjs; tests/browser
Evidence refs: docs/evidence/phase-6.md; .staging/reports/phase1-packed-install.log; .staging/reports/phase1-clean-checkout.log
Commands: pnpm install --frozen-lockfile; pnpm test:browser; pnpm test:hmr; pnpm test:security; pnpm pack:verify; pnpm verify
Observed result: 12 fake-CPA, 90 aggregate unit, 28 analytics, and 23 quota/client tests passed; Browser, HMR, exact packed Loader, real CPA, security, external install, and 182-file clean checkout passed
Open risks/decisions: root-path-only deployment and fail-closed remote callback remain documented v0.1 limits; npm publication remains deferred
Gate decision: GO on 2026-08-14
Commit/push: recorded by the Phase 6 gate commit on public origin/main
```

## Acceptance matrix

| ID | Acceptance outcome | Implementation surface | Required evidence | Status |
| --- | --- | --- | --- | --- |
| G-01 | All DSH integration uses only public DSH `0.1.0-rc.6` declarations/exports and runtime seams; no local rc.5 source or private import is required. | Workspace manifests, API probe, client/runtime installation | `pnpm test:public-api` report plus real rc.6 Loader/profile log | COMPLETED / GO for Phase 1 |
| G-02 | One clean install outside the checkout is reproducible from immutable GitHub tarball dependencies and local generated-file overrides only; each dependency records URL, version, and SHA-256, with no npm/runtime download. | Pack envelope, manifests, generated artifacts, installer | Frozen/offline install, URL/version/SHA manifest, payload and install-script report | COMPLETED / GO for Phase 1 |
| G-03 | Managed and external runtime modes have deterministic lifecycle states, readiness/health, stop/dispose, failure, and restart behavior; process launch uses exact argv/cwd/stdio/graceMs/scrubbed env and never shell-interpreted argv. | Runtime state machine and supervisor | Unit transition matrix plus real Loader/integration lifecycle log and spawn-spec assertion | COMPLETED / GO |
| G-04 | **Phase 2A hard gate:** the real built official `llm-pi-ai` package plus fake/external CPA proves text, tools, ordered streaming, explicit image opt-in, and abort on one public rc.6 path. Failure stops before Phase 2B and permits no adapter fallback. | Public rc.6 client/LLM path and deterministic CPA fixture | `pnpm test:llm-compat` CPA-observed real-path report | COMPLETED / GO |
| G-05 | Model discovery does not infer vision from `/v1/models`; image input is enabled only by an explicit verified capability declaration. | Model registry and provider capability metadata | Focused provider tests plus `scripts/verify-phase3.mjs` | COMPLETED / GO for Phase 3 |
| G-06 | The three credential paths remain separate: `llm-pi-ai` proxy ref/request, Gateway management ref/operation, and managed-child explicit env. Missing one path never falls back to another. | Route, Host management client, child environment builder | Focused CPA/provider tests and existing runtime evidence | COMPLETED / GO for Phases 2B–3 |
| G-07 | Device OAuth is the default; local callback remains unavailable until a public server-derived trusted-origin seam exists, and a client-supplied origin is rejected as authority. | OAuth coordinator, request-origin validation, callback capability gate | Focused OAuth tests and parser/redaction assertions | COMPLETED / GO for Phase 3 |
| G-08 | Prompt, attachment refs/content, and model result cross only the typed requesting `gateway.probe` flow; operational Remotes, analytics, logs, DB, and persistence reject/exclude them. | Probe schema/Host handler, Remote projections, analytics/log boundaries | Generated strict codecs, Host probe result projection, Browser negative assertions, and analytics tests | COMPLETED / GO |
| G-09 | The destructive HTTP usage queue is at-most-once with no ack: crash-after-pop loss is visible as degraded/incomplete, and dedupe starts only after DB receipt. | Collector, worker ingest, completeness state | Queue pop/no-ack, crash-window, competition, post-receipt dedupe tests | COMPLETED / GO |
| G-10 | Pricing is an immutable bundled snapshot. The Host-internal Codex quota adapter uses only the fixed allowlisted `POST /v0/management/api-call` payload; other providers may return typed unsupported/unavailable and no generic `/api-call` remote exists. | Pricing asset, quota adapter, management allowlist, typed quota result | `pnpm test:quota` fixed-payload/schema/size/projection and no-generic-proxy report | COMPLETED / GO |
| G-11 | The native App uses ID `wha1echai.gateway`, base `/apps/wha1echai.gateway`, frozen subroutes, and the package `./package.json` `./client` export; it does not take over the shell or reset conversation state. | App manifest, `package.json` exports, route/slot composition | Phase 5 packed Browser and client export evidence | COMPLETED / GO |
| G-12 | Client HMR replaces gateway contributions exactly once, leaves unrelated Apps and conversation state alive, and contains render failure at the owning boundary. | DSH client lifecycle/HMR integration and App boundary | `pnpm test:hmr` before/after log and browser artifact | COMPLETED / GO |
| G-13 | A clean, repository-external DSH rc.6 profile loads the exact packed public preview with the Linux no-plugin / Windows-macOS standard-name-plus-disabled-plugin policy and all provenance requirements. | Pack descriptor, platform assets/config, profile setup, release scripts | `pnpm pack:verify` artifact plus `pnpm verify` aggregate | COMPLETED / GO |

## Stop conditions and required deviation record

Stop implementation and preserve the exact blocker if any of the following
occurs:

- public rc.6 declarations/exports cannot support the required seam, or a
  private API/local source checkout is proposed as a workaround;
- Phase 2A cannot prove text, tools, streaming, explicit image opt-in, and
  abort through the real built official `llm-pi-ai` plus fake/external CPA;
  this stops work before Phase 2B and forbids an adapter fallback;
- an upstream DSH change, second LLM adapter, second SPA fallback, or arbitrary
  HTTP proxy appears necessary;
- managed execution would use a shell, shell-interpreted argv, implicit argv /
  cwd / stdio / `graceMs`, non-loopback bind, inherited ambient environment,
  or unbounded restart loop;
- credentials, OAuth tokens, auth files, prompts, images, model output, proxy
  keys, or management keys could reach the browser, logs, analytics, tarball,
  or error telemetry;
- an undeclared remote action can be mounted, prompt/attachment/result content
  leaves the typed requesting probe flow, OAuth callback relies on client
  origin or runs without the public trusted-origin seam, or a browser action
  bypasses generated Typert Remotes;
- analytics loss or migration failure changes model delivery semantics, hides
  destructive-queue loss/completeness, or dedupes before DB receipt;
- pricing is fetched or mutated at runtime, quota fabricates availability, or
  any generic/user-parameterized `/api-call` path exists;
- a platform asset uses a non-standard Windows/macOS name, enables dynamic
  plugins, or the Linux no-plugin policy is not explicit;
- real rc.6 Loader, browser/HMR, security, or repository-external packed
  installation evidence is unavailable, flaky, or not tied to pinned versions;
- a package or binary lacks exact provenance, license, digest, or payload
  allowlist.

Record every deviation before implementation continues:

```text
Decision: <short title>
Reason: <why the approved plan is insufficient>
Evidence: <exact command, diagnostic, or artifact>
Impact: <scope, API, compatibility, security, licensing, and evidence impact>
Owner/date: <name and date>
Plan/ADR update: <link or “required before implementation continues”>
Gate decision: <STOP / GO>
```

The Phase 0 gate reached `Complete / GO` after the main-thread and independent
reviews recorded above. Later deviations use this template and stop only their
own affected phase until the required plan/ADR update is accepted.
