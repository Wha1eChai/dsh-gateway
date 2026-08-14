# dsh-gateway v0.1 testing strategy

## Purpose and evidence status

This document defines the executable verification contract for the six
implementation phases after the documentation baseline. It distinguishes
phase-scoped evidence from future product/release claims. The documentation
Phase 0 gate is **Complete / GO**; Phase 1 implementation verification has
passed locally and awaits independent Gate acceptance.

Use these labels exactly:

- `PLANNED / UNVERIFIED`: required, but no accepted command artifact exists.
- `COMPLETED`: the exact command ran in the pinned environment and its output
  or artifact is linked. Code inspection and review never create this status.
- `PARTIAL`: a phase-scoped artifact passed but a later required lane is still
  missing.
- `BLOCKED`: the command could not run; preserve the exact error and the next
  concrete retry command.

`pnpm install --frozen-lockfile` is the environment prerequisite once a
lockfile exists. Always record `node --version`, `pnpm --version`, OS, DSH
version, dsh-webpage version, CLIProxyAPI version, date, and source revision.
Do not call a package check reproducible if the frozen install did not pass.

## Compatibility and API policy

The only supported integration target is the installed public API of DSH
`0.1.0-rc.6`. Public declarations and exports are the source of truth for
imports, signatures, settings, credentials, subprocess, `llm-pi-ai`, Typert
Remote, home-path, and dsh-webpage seams. Local source checkouts, private
exports, guessed names, and rc.5 behavior are not acceptable evidence.

Phase 2A is a pre-runtime investment hard gate. The probe must use the real
built official `@deepseek-ai/dsh-llm-pi-ai` package, public DSH `0.1.0-rc.6`
exports/client path, and a deterministic fake or external CPA HTTP endpoint.
The same path must prove all five behaviors: a bounded text request, ordered
streaming deltas, tool declaration plus tool-call/result round trip, image
input only after explicit model capability opt-in, and abort/cancellation
before completion. The CPA fixture must observe the request/response; a fake
`ctx.llm`, mock adapter, or source-checkout import is not evidence.

If any one of these fails, the result is a **hard STOP before Phase 2B**:
record the exact failure, do not implement or propose a second LLM adapter or
adapter fallback, and wait for an explicit compatibility/scope decision.
`/v1/models` is discovery only and cannot prove image support. This gate is
not marked verified by a future plan, code inspection, or a passing mock.

## Root command contract

Phase 1 established the root scripts below. Commands for later phases use an
explicit non-zero “intentionally unavailable until Phase N” sentinel until
their real lane replaces it; such a sentinel is neither a skip nor a pass.
Focused selectors may be recorded in addition to the root command, but a
mocked substitute does not satisfy the corresponding lane.

| Command | Purpose | Required phases | Status |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | Reproducible dependency installation from the release envelope; no registry/runtime download | 1, 6 | COMPLETED for Phase 1 |
| `pnpm test:public-api` | Verify imports/exports and runtime seams against installed public rc.6 only, including the packed `./client` export | 1, 2A, 2B, 3, 6 | COMPLETED for Phase 1; later phases extend it |
| `pnpm test:supply-chain` | Verify lockfile policy, package allowlists, provenance, licenses, digests, and install-script policy | 1, 6 | COMPLETED for Phase 1 |
| `pnpm test:clean-checkout` | Export a clean committed source snapshot with a fresh pnpm store and rerun the Phase 1 aggregate | 1, 6 | COMPLETED for Phase 1 |
| `pnpm typecheck` | Type and public-contract checks | 1–6 | COMPLETED for Phase 1; later phases extend it |
| `pnpm lint` | Source, manifest, generated-file, and policy lint | 1–6 | COMPLETED for Phase 1; later phases extend it |
| `pnpm build` | Build all owned packages and generated client/remote artifacts | 1–6 | COMPLETED for Phase 1; later phases extend it |
| `pnpm test:unit` | Pure contracts, validators, state transitions, redaction, and read models | 2–5 | PARTIAL: fake CPA fixture has 11 passing tests; product units begin in Phase 2 |
| `pnpm test:integration` | Real rc.6 Loader, DSH client, runtime, provider, OAuth, analytics, and Pack composition after the 2A gate | 2B–6 | PLANNED / UNVERIFIED |
| `pnpm test:llm-compat` | Phase 2A real built official `llm-pi-ai` plus fake/external CPA text/tools/stream/image-opt-in/abort gate | 2A, 5, 6 | COMPLETED / GO for Phase 2A |
| `pnpm test:oauth` | Device and localhost callback login lifecycle | 3, 5, 6 | PLANNED / UNVERIFIED |
| `pnpm test:analytics` | SQLite migrations, writes, aggregates, restart, redaction, and failure isolation | 4, 5, 6 | PLANNED / UNVERIFIED |
| `pnpm test:quota` | Fixed Codex quota adapter, immutable pricing snapshot, strict projection, unsupported/unavailable states, and no generic `/api-call` | 3–6 | PLANNED / UNVERIFIED |
| `pnpm test:browser` | Real root-path App, Playground, remotes, negative cases, and security-visible behavior | 5, 6 | PLANNED / UNVERIFIED |
| `pnpm test:hmr` | Client replacement, disposal, duplicate prevention, and crash containment | 2B, 5, 6 | PLANNED / UNVERIFIED |
| `pnpm test:security` | Host/browser boundary, callback, redaction, process, path, and package security checks | 1–6 | COMPLETED for the Phase 1 package/provenance boundary; later phases extend it |
| `pnpm pack:verify` | Exact tarballs and repository-external DSH rc.6 profile install/load | 1, 6 | COMPLETED for Phase 1; Phase 6 adds real product behavior |
| `pnpm verify` | Aggregate every lane required by the current implemented phase; skipped implemented lanes fail, and the Phase 6 release gate expands it to all lanes | 1–6 | COMPLETED for Phase 1; final release aggregate remains planned |

## Required verification lanes

| Lane | Command(s) | Minimum evidence | Status |
| --- | --- | --- | --- |
| Environment and frozen install | `node --version`; `pnpm --version`; `pnpm install --frozen-lockfile` | Versions, OS, frozen/offline-install log, URL/version/SHA manifest, lockfile result | COMPLETED for Phase 1 on Windows x64, Node 24.11.1, pnpm 11.7.0 |
| Public rc.6 API | `pnpm test:public-api`; `pnpm pack:verify`; later `pnpm test:integration` | Import/export report and real rc.6 Loader/profile proof; no private/local source resolution; packed `./client` handoff executes | COMPLETED for Phase 1; product integration remains planned |
| Workspace and supply chain | `pnpm test:supply-chain`; `pnpm typecheck`; `pnpm lint`; `pnpm build`; `pnpm pack:verify` | Lockfile policy, one-install envelope, exact payloads, local generated-file overrides, no install/runtime download, licenses, provenance URLs/platform/architecture/SHA-256 | COMPLETED for Phase 1 |
| Phase 2A `llm-pi-ai` hard gate | `pnpm test:public-api`; `pnpm test:llm-compat` | Real built official package plus fake/external CPA proves text/tools/ordered stream/explicit image opt-in/abort; any failure stops before 2B | COMPLETED / GO |
| Runtime state machine | `pnpm test:unit`; `pnpm test:integration`; `pnpm test:hmr` | Transition matrix for managed/external modes, readiness, failure, stop/dispose, restart, replacement, exact spawn spec, and unrelated-Plugin survival | PLANNED / UNVERIFIED |
| Credential paths | `pnpm test:unit`; `pnpm test:integration`; `pnpm test:security` | Independent proof for proxy ref/request, management ref/operation, managed-child explicit env; no fallback or value exposure | PLANNED / UNVERIFIED |
| Provider and model capability | `pnpm test:unit`; `pnpm test:integration` | Provider discovery, explicit capability registry, negative `/v1/models` image inference, account/failover fixtures | PLANNED / UNVERIFIED |
| OAuth | `pnpm test:oauth`; `pnpm test:security`; `pnpm test:integration` | Device-default artifact; local callback fail-closed without server-derived origin seam; client-origin rejection; cancellation/expiry/refresh errors; no token leakage | PLANNED / UNVERIFIED |
| Typert Remotes | `pnpm test:unit`; `pnpm test:integration`; `pnpm test:browser`; `pnpm test:security` | Generated schema/mount report proving `ctx.remote.$mount()`, allowlist enforcement, undeclared-action rejection, and no arbitrary proxy | PLANNED / UNVERIFIED |
| Analytics and usage queue | `pnpm test:analytics`; `pnpm test:integration`; `pnpm test:security` | Destructive pop/no-ack at-most-once, crash-after-pop loss, degraded/completeness state, post-DB dedupe, migrations, aggregates, redaction, failure isolation | PLANNED / UNVERIFIED |
| Pricing and quota | `pnpm test:quota`; `pnpm test:analytics`; `pnpm test:security` | Immutable bundled pricing snapshot; fixed internal Codex payload/projection; strict size/schema; unsupported/unavailable valid; raw response and generic `/api-call` absent | PLANNED / UNVERIFIED |
| Native dsh-webpage App | `pnpm test:integration`; `pnpm test:browser`; `pnpm test:llm-compat` | Real App/Loader composition, frozen ID/routes, packed `./client` export, full `ctx.llm` Playground, degraded/unavailable states, conversation preservation | PLANNED / UNVERIFIED |
| Browser and HMR | `pnpm test:browser`; `pnpm test:hmr` | Root-path navigation, direct/reload/degraded/error cases, no secret DOM/storage, HMR replacement without reload/duplicates/stale slots, crash containment | PLANNED / UNVERIFIED |
| Security | `pnpm test:security`; `pnpm test:browser`; `pnpm test:supply-chain` | Boundary report for secrets, OAuth callbacks, shell/process, path traversal, HTML/navigation, logs/SQLite/tarballs, dependency and binary provenance | PARTIAL: Phase 1 package/provenance boundary passed; runtime/browser security remains planned |
| Packed public preview | `pnpm pack:verify`; `pnpm verify` | Exact tarballs, clean repository-external DSH rc.6 profile/Loader/CLI, one Pack composition, browser/HMR/security artifacts | PARTIAL: Phase 1 package/profile subset passed; Phase 6 browser/HMR/security remains planned |
| Aggregate release gate | `pnpm verify` | Output linking every required lane for the implemented phase; Phase 6 expands to all release lanes | COMPLETED for Phase 1; final release aggregate remains planned |

## Phase test strategy and scenarios

### Phase 0 — documentation baseline

Phase 0 was documentation-only. On 2026-08-14 the main thread completed local
Markdown link, fence, trailing-whitespace, fenced-JSON, and secret-pattern
checks; independently inspected the pinned CPA asset names/checksums; and
resolved every blocking finding from two Sol review passes. The final focused
re-review returned GO. No runtime or package claim belongs to that evidence;
all Phase 2A–6 product lanes below remain `PLANNED / UNVERIFIED` until their
own phases run.

### Phase 1 — workspace and supply chain

Status on 2026-08-14: Complete / GO. The aggregate passed on Windows x64 with
Node 24.11.1, pnpm 11.7.0, and DSH 0.1.0-rc.6, and independent Luna/Sol reviews
accepted the Gate. Generated evidence lives under ignored
`.staging/release/v0.1.0/` and
`.staging/reports/phase1-packed-install.log`; the executable evidence is the
tracked generator and verifier that reproduce those artifacts.

Required scenarios:

- frozen installation under the pinned Node/pnpm toolchain;
- public rc.6 import/export probe that fails on private exports, local source
  paths, rc.5 packages, or floating DSH ranges;
- typecheck/lint/build of every workspace package;
- exact packed payload allowlists with no source checkout, auth file, secret,
  prompt, image, model output, or development-only file;
- platform binary provenance: upstream release, immutable GitHub tarball URL,
  platform, architecture, SHA-256, exact upstream license, and version match;
- platform policy: Linux accepts only the `no-plugin` asset; Windows and macOS
  use the standard upstream executable names and a config assertion that
  disables dynamic plugins. A dynamic plugin load or gateway-renamed platform
  executable fails the lane;
- dependency and install-script audit with each exception explicitly scoped;
- one install from a clean temporary directory outside this checkout, using
  only immutable GitHub tarball dependencies plus enumerated local generated
  file overrides; no npm registry or runtime download;
- package-root and packed `./client` export resolution from that temporary
  directory, not this repo.

The lane fails on a transitive dependency that cannot be reproduced, a broad
install-script approval, a binary without provenance/license, or any package
that resolves an adjacent checkout.

### Phase 2A — `llm-pi-ai` compatibility hard gate before runtime

Status on 2026-08-14: Complete / GO. `pnpm test:llm-compat` exercised one
official built rc.6 Loader route and the fake CPA observed all outbound model
requests. Evidence is summarized in `docs/evidence/phase-2a.md`.

Run this phase with the real built official `@deepseek-ai/dsh-llm-pi-ai`
package and the public installed rc.6 client path. Use a deterministic fake or
external CPA HTTP endpoint that records requests and emits controlled responses;
do not start the managed-runtime package or invest in runtime supervision for
this gate.

Required scenarios, all on the same `ctx.llm` route:

- bounded text request reaches the fake/external CPA and returns the expected
  text result;
- streaming emits ordered deltas and clean completion/error semantics;
- tool declaration and tool-call/result round trip preserve tool name, call
  ID, arguments, result, and completion semantics;
- a model marked image-capable by explicit profile metadata accepts a DSH
  attachment, while a model discovered only through `/v1/models` is rejected
  before attachment dispatch;
- abort/cancellation stops the in-flight request before completion and does
  not replay it or silently route through another adapter.

The evidence must include the CPA fixture's observed request/response and the
public package resolution path. Any failure is a hard STOP before Phase 2B;
record the exact diagnostic and do not add an adapter fallback.

### Phase 2B — runtime and client

Model the runtime as an explicit state machine. The minimum states are
`disabled`, `starting`, `ready`, `degraded`, `stopping`, `stopped`, and
`failed`; external mode may enter `ready` only after endpoint health and
credential-reference validation. Record allowed transitions and the invariant
that one owner has at most one live child process and one active DSH
contribution.

Required scenarios:

- managed start with an exact complete argv array that is not shell
  interpreted; explicit `cwd`, `stdio`, termination `graceMs`, and scrubbed
  environment are captured and asserted. No boolean no-shell assertion by
  itself satisfies this contract;
- external endpoint validation and a clear unavailable/degraded state;
- readiness timeout, malformed health response, child exit, explicit stop,
  Plugin disposal, and bounded restart/backoff;
- stale process and duplicate-start prevention;
- settings revision conflict using
  `ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops, revision)`;
- three independent credential paths: `llm-pi-ai` proxy credential ref/request
  for model traffic, Gateway management credential ref/operation for
  allowlisted management, and managed-child explicit env construction from
  resolved values. Missing one path never falls back to another;
- real rc.6 Loader installation/unload/HMR replacement with unrelated Apps
  left alive;
- the Phase 2A result is consumed without re-registering or falling back to a
  custom LLM adapter.

Phase 2B cannot begin until Phase 2A is GO. Runtime/client failures stop the
phase and preserve the exact evidence status.

### Phase 3 — provider and OAuth

Required scenarios:

- provider/model discovery with deterministic duplicate and unavailable
  diagnostics;
- `/v1/models` reports model identity only; image input remains disabled until
  an explicit verified capability entry exists;
- Codex device login is the default: start, user-code display, pending,
  success, denial, expiry, cancellation, and retry;
- localhost callback login is fail-closed until a public server-derived
  trusted-origin seam exists. Without that seam the Host returns typed
  unavailable and does not start a listener, even when a Client claims a
  localhost origin. When the seam exists, test random state/PKCE where the
  public API supports it, loopback-only binding, exact state validation,
  one-shot callback, timeout, cancellation, and safe shutdown;
- a client-supplied `Origin` or page-origin field is never trusted authority;
  test forged localhost, non-loopback, missing, and conflicting origins;
- refresh/failover remains CPA-owned and gateway status mirrors only the
  value-free result;
- expired/missing credential references produce a safe host error without
  exposing token material to browser, logs, analytics, or error payloads;
- quota behavior uses the Host-internal Codex read adapter only. Other
  providers return typed `unsupported` or `unavailable` and are not assigned a
  fabricated quota;
- generated OAuth/provider remotes reject unknown actions and invalid input.

No remote callback OAuth, arbitrary origin, browser-held refresh token, or
gateway-side duplicate provider lifecycle is in scope.

### Phase 4 — analytics

Required scenarios:

- create and migrate the SQLite schema under
  `resolveDshHome()/dsh-gateway/v1`;
- record request ID, timestamp, provider/model, status, token counts, cost,
  latency, account-health and quota facts with stable indexes;
- aggregate by time/model/provider/account without storing prompts, images,
  model output, auth files, credentials, proxy keys, or management keys;
- exercise the CPA HTTP usage queue as destructive pop with no ack: one pop is
  consumed at most once, there is no requeue/ack retry, and a crash after pop
  before DB receipt creates an observable loss window rather than a false
  exactly-once claim;
- set collector completeness to degraded/unknown or incomplete after that
  crash and when an external competitor may consume the queue; do not claim
  complete history in either case;
- prove dedupe begins only after the database receives the typed record and
  commits its receipt. Pre-pop/in-memory dedupe must not suppress a later
  record;
- verify the Host-internal Codex quota adapter emits only the fixed CPA
  `POST /v0/management/api-call` payload:

  ```text
  authIndex: internal allowlisted auth-file inventory selection
  method: GET
  url: https://chatgpt.com/backend-api/wham/usage
  headers: Authorization: Bearer $TOKEN$; Content-Type: application/json;
           fixed Gateway User-Agent; optional selected Chatgpt-Account-Id
  ```

  The test must reject client URL/method/header/body parameters, enforce the
  selected internal `authIndex`, bound response size, validate a closed schema,
  project only quota windows, and prove raw response bytes are absent from
  Remote output, logs, SQLite, and persistence;
- verify the pricing snapshot is bundled, versioned, hashed, immutable at
  runtime, and never fetched or edited. Unknown/partial pricing remains a
  typed unknown/partial estimate while token counts stay visible;
- concurrent writes, transaction rollback, process restart, migration from
  the previous schema, and database lock/backoff behavior;
- unavailable/disabled analytics does not block or alter `ctx.llm` delivery;
- query remotes return bounded, typed, read-only results and do not expose raw
  request payloads; quota for non-Codex providers is typed `unsupported` or
  `unavailable`, never fabricated.

Retention and pricing/quota assumptions must be documented in the data model
and tested as policy, not hidden in a UI query. There is no generic `/api-call`
Remote and no account-action, quota-reset, or cooldown operation.

### Phase 5 — dsh-webpage App

Required scenarios:

- App and optional companion Plugins load through the existing dsh-webpage
  composition and route/slot contract;
- the App identity is exactly `wha1echai.gateway`, its base route is
  `/apps/wha1echai.gateway`, and its subroutes are `/accounts`, `/models`,
  `/requests`, `/playground`, and `/settings`;
- the packed gateway `./package.json` export map resolves the built `./client`
  entry from a clean profile. A source path, deep import, or missing export is
  a failure;
- launcher/settings/runtime/provider/OAuth/analytics views show loading,
  ready, degraded, failed, and unavailable states deterministically;
- Playground sends a real request through `ctx.llm`, rendering streaming
  deltas, tool-call lifecycle, and explicit image-capable model input;
- prompt, attachment refs/content, and result are accepted/returned only by
  the typed requesting `probe.run` flow. Negative tests prove operational
  Remotes, analytics, logs, SQLite, and other persistence never receive them;
- leaving the gateway App preserves the existing conversation and unrelated
  local state;
- all browser actions call generated, allowlisted Typert Remotes mounted via
  `ctx.remote.$mount()`; there is no arbitrary `/proxy` endpoint;
- malformed remote input, unknown model, unavailable runtime, provider
  expiry, analytics outage, and App error render safe bounded messages;
- a keyless deterministic UI snapshot covers the operations/Playground path.

The App must not take over the stock shell, add a second SPA fallback, place
secrets in DOM/storage/URL, or redefine the DSH client transport.

### Phase 6 — packed public preview

Run one install from a fresh temporary directory/profile outside this
repository. The install must consume immutable GitHub tarball dependencies
whose URL, version, and SHA-256 are recorded in the release manifest, plus
explicitly enumerated local generated-file overrides only. Disable registry
access after the release envelope is staged and assert that no npm or runtime
download occurs.

- build and pack exact workspace artifacts, then verify package payloads and
  provenance manifests;
- install one ordinary DSH Pack into an isolated DSH `0.1.0-rc.6` profile;
- verify real Loader/CLI discovery, package roots, plugin order, runtime
  lifecycle, and Typert Remote mounts;
- start the root-path Web App in Chromium and exercise login states, runtime
  transitions, model selection, stream/tool/image Playground flows, analytics,
  safe errors, and conversation preservation;
- rebuild a copied fixture and verify client HMR replacement once, no document
  reload, no duplicate registration, no stale runtime/remote, and bounded
  render-crash containment;
- verify the package `./client` export and the frozen App ID/routes from the
  packed artifact, not only the source workspace;
- run security and dependency/binary checks against the packed artifact, not
  only the source workspace;
- run `pnpm verify` with every required lane present and linked.

The packed gate is repository-external by construction. A local workspace
resolution or a synthetic mock Loader is only a diagnostic and cannot turn
this lane green.

## Behavioral acceptance matrix

| ID | Scenario | Lane(s) | Minimum assertion/artifact | Status |
| --- | --- | --- | --- | --- |
| T-01 | Public rc.6 API boundary | public-api, integration | Imports/exports and runtime seams resolve from installed rc.6 only; private/local/rc.5 resolution fails | COMPLETED for Phase 1; later integration extends it |
| T-02 | Reproducible one-install supply chain | supply-chain, pack | Clean outside-checkout install from immutable GitHub tarballs plus hashed local generated-file overrides; URL/version/SHA, no npm/runtime download | COMPLETED for Phase 1 |
| T-03 | Phase 2B runtime state and spawn contract | unit, integration, HMR, security | Valid/invalid transitions, readiness, stop/dispose, child exit, bounded restart, exact argv/cwd/stdio/graceMs/scrubbed env, no shell interpretation | PLANNED / UNVERIFIED |
| T-04 | Phase 2A `llm-pi-ai` hard gate | llm-compat, public-api | Real built official package plus fake/external CPA proves text, tools, ordered stream, explicit image opt-in, and abort on one public rc.6 path; failure STOPs before 2B; no adapter fallback | COMPLETED / GO |
| T-05 | Explicit model capability | unit, integration, security | `/v1/models` cannot infer image support; explicit opt-in succeeds and unsupported/inferred capability is rejected before attachment dispatch | PLANNED / UNVERIFIED |
| T-06 | Three credential paths | unit, integration, security | Proxy ref/request, management ref/operation, and managed-child explicit env resolve independently; no cross-fallback or value exposure | PLANNED / UNVERIFIED |
| T-07 | Provider capability and account state | unit, integration | Model discovery, unknown/unavailable/failover states, and CPA-owned refresh/failover are deterministic | PLANNED / UNVERIFIED |
| T-08 | Codex device OAuth default | oauth, security, browser | Device flow is default; pending/success/denial/expiry/cancel/retry; no token reaches browser/log/analytics | PLANNED / UNVERIFIED |
| T-09 | Local callback fail-closed | oauth, security, browser | No public server-derived origin seam means typed unavailable/no listener; client origin is rejected; with seam, loopback/state/one-shot/timeout checks pass | PLANNED / UNVERIFIED |
| T-10 | Probe and Typert Remote boundary | unit, integration, browser, security | Generated allowlist mounts through `ctx.remote.$mount()`; prompt/attachment/result use only requesting typed `probe.run`; unknown action, arbitrary proxy, and operational-content leakage are rejected | PLANNED / UNVERIFIED |
| T-11 | Destructive usage queue semantics | analytics, integration, security | Pop/no-ack at-most-once, crash-after-pop loss window, degraded/completeness state, competition warning, and post-DB-receipt-only dedupe | PLANNED / UNVERIFIED |
| T-12 | Analytics, pricing, and quota correctness | quota, analytics, integration, security | Immutable bundled pricing; fixed internal Codex quota payload and strict projection; raw response absent; unsupported/unavailable valid; no generic `/api-call` | PLANNED / UNVERIFIED |
| T-13 | Native App identity and client export | integration, browser, public-api | `wha1echai.gateway`, `/apps/wha1echai.gateway` plus frozen subroutes, and packed `./package.json` `./client` export resolve; no route takeover | PLANNED / UNVERIFIED |
| T-14 | Browser boundary and HMR | browser, HMR, security | No secret DOM/storage/URL, safe navigation/callback, direct/reload/error cases, one replacement, no stale/duplicate remotes, bounded crash | PLANNED / UNVERIFIED |
| T-15 | Packed public preview | pack, integration, browser, security | Repository-external rc.6 profile loads exact Pack and passes platform plugin policy, runtime/App/HMR/security checks | PLANNED / UNVERIFIED |

## Evidence record template

Create one record per lane or behavioral ID in the phase evidence area or CI
artifact index. A completed row must be reproducible from its command and
artifact; review text alone is not evidence.

```text
Lane/ID: <for example: Phase 2A llm-pi-ai hard gate / T-04>
Phase: <0 / 1 / 2A / 2B / 3 / 4 / 5 / 6>
Status: <PLANNED / UNVERIFIED | COMPLETED | PARTIAL | BLOCKED>
Environment: DSH 0.1.0-rc.6; dsh-webpage 0.1.0; CLIProxyAPI 7.2.131;
  Node <version>; pnpm 11.7.0; OS <value>
Command: <exact command and focused selector, if any>
Result: <pass/fail/blocked, counts, and exact diagnostic>
Artifact: <log/report/screenshot/tarball/provenance path or link>
Date/revision: <date and source revision>
Notes: <flake, exclusion, security limitation, or follow-up>
Gate impact: <GO / STOP / does not gate this phase>
```

For a blocked lane, preserve the exact error and add the next concrete retry
command. Never convert `BLOCKED`, `PARTIAL`, or `PLANNED / UNVERIFIED` to
`COMPLETED` because implementation looks correct.

## Coverage and release bars

The unit lane must report 100% statements, branches, functions, and lines for
each owned executable implementation file unless the repository explicitly
defines an equivalent metric. Generated files, fixtures, and test-only helpers
may be excluded only when the coverage report names the exclusion. A project
average is insufficient.

Browser snapshots must be deterministic and keyless: no wall clock, generated
identifier, ad hoc component key, live network response, or secret-bearing
fixture. Record fixed viewport, locale, and fixture data. A missing or
unreviewed snapshot artifact leaves the lane unverified.

The release gate is green only when:

- frozen install, public rc.6 API, supply-chain, typecheck, lint, build, unit,
  real Loader/integration, llm compatibility, OAuth, analytics, quota,
  browser, HMR, security, and packed-install lanes are all `COMPLETED`;
- every implementation file meets the per-file coverage bar;
- T-04 proves text, tools, ordered streaming, explicit image opt-in, and
  abort on the same real `ctx.llm` path, with no Phase 2A hard-stop condition;
- Phase 2B evidence exists only after Phase 2A is GO; no future work is
  considered verified by this document;
- the Typert Remote allowlist, OAuth boundary, analytics redaction, and packed
  provenance artifacts are linked;
- the browser snapshot is stable, root-path scope is explicit, and the clean
  profile is repository-external; and
- `pnpm verify` passes without skipping a required lane and independent
  standards/spec review has no unresolved STOP finding.

No public-preview or publication claim may be made before these conditions are
met and the plan, evidence records, relevant design docs, and `HANDOFF.md` are
updated by the phase owner/main thread.
