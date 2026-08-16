# HANDOFF

## Goal

Deliver dsh-gateway v0.1 as a public, out-of-tree DSH Bundle that composes a
CLIProxyAPI gateway, optional managed runtime, optional SQLite analytics, and a
native dsh-webpage App without modifying DeepSeek Harness.

## Current Phase

Phases 0–6 are complete / GO. The v0.1.0 preview prerelease and both project
and upstream DeepSeek Harness Discussions are public.

## Completed

- dsh-webpage v0.1.0 was publicly released and its packed-install gate passed.
- CLIProxyAPI v7.2.131 and CPA-Manager-Plus v1.12.0-rc.2 were audited.
- DSH rc.6 public settings, credentials, subprocess, llm-pi-ai, Typert Remote,
  home-path, and Webpage slot seams were mapped.
- The local dsh-gateway repository was initialized on `main`.
- Phase 0 architecture, security, analytics, topology, plan, testing, and ADR
  documents were frozen; the final focused Sol re-review returned GO.
- Docs-only root commit `27090af` is pushed to the public repository:
  `https://github.com/Wha1eChai/dsh-gateway`.
- The pnpm workspace now contains Gateway, Runtime, Analytics, Pack, six
  platform packages, and a deterministic fake CPA fixture.
- Public and local-verification release generators rewrite every workspace
  edge to immutable GitHub URLs or explicit `file:` tarballs and emit a
  URL/version/SHA-256 manifest.
- A repository-external temporary DSH profile installed the single local Pack
  with offline mode and an invalid registry, resolved both packed client
  exports, and produced all four expected `dump-config` rows.
- A clean committed source snapshot with a fresh pnpm store rebuilt all pinned
  upstream assets, reran the nested aggregate, and remained Git-clean.
- The official built `dsh-llm-pi-ai` rc.6 Loader path passed text, tool
  round-trip, ordered streaming, explicit image opt-in, and abort against the
  fake CPA without a custom adapter.
- `ctx.cpaRuntime` now owns one managed/external runtime per Cordis fiber,
  including verified install, state/lock/process lifecycle, credential
  re-resolution, and secret cleanup.
- The typed CPA client exposes only frozen real routes and resolves proxy or
  management credentials separately for each operation.
- A real Windows CPA v7.2.131 process passed health, models, auth-files, usage
  queue, termination, and port-release smoke through DSH subprocess-local.
- The Phase 3 provider bridge normalizes CPA models, preserves explicit image
  capability only, writes the official `cpa` settings route, and keeps the
  existing `ctx.llm` path.
- Bounded Codex device OAuth matches CLIProxyAPI v7.2.131 labels, derives
  15-minute/5-second limits, scrubs private output, and keeps local callback
  capability fail-closed without a trusted server-derived origin.
- Generated Typert Host/Remote artifacts expose exactly 11 `gateway.*`
  endpoints; the strict Host BFF and minimal `dshapps.gateway` App
  foundation mount and dispose cleanly.
- Phase 3 evidence passed: build/typecheck/lint; focused provider/OAuth/CPA
  tests 35/35 after the terminal-process fix; clean-checkout unit (11 fake-CPA
  plus 55 Vitest); the built Loader
  verifier (2 models, official `cpa`, text probe, 11 Remotes, unload); and
  external offline `pack:verify` (Host lifecycle and client import).
- Phase 3 commit `7359eb3` is pushed to public `origin/main`.
- The optional analytics companion now owns a single `node:sqlite` worker,
  WAL schema v1, receipt dedupe/dead letters, rollups, retention, bounded reads,
  and redacted usage, account-health, and quota projections.
- Managed mode consumes CPA's destructive HTTP usage queue; external mode
  requires explicit opt-in and reports possible competition/incompleteness.
- The fixed Host-only Codex quota path selects an internal CPA auth index and
  stores only projected quota windows; no generic Management API reaches Web.
- Phase 4 evidence passed 28 analytics tests, 23 focused quota/client tests,
  83 aggregate Vitest tests, the actual built and packed workers, exact tarball
  inspection, real CPA smoke, and a clean 161-file checkout.
- A focused Luna gate review found four P1 defects; all are covered by
  regressions: destructive dequeue latches after a write failure, collector
  lease ownership is atomic and generation-bound, fractional Codex quota is
  persisted, and source/worker faults become typed unavailable state.
- The six-route native Gateway App, 18-endpoint generated Remote allowlist,
  ECharts Dashboard, model capability editor, account/request views, runtime
  settings, and one-shot text/tool/image Playground are implemented.
- A real 3080 profile and a repository-external packed rc.6 Browser profile
  passed App navigation, deep links, reload/history, conversation DOM
  identity, model apply, text/image probes, opaque attachment upload, optional
  analytics states, and browser-visible image-data negative checks.
- The Browser gate found and verified the fix for a missing `attachments`
  Host injection. The focused regression was red before the fix and green
  after it.
- Real client HMR passed atomic replacement, render-crash containment,
  recovery, graph uniqueness, timer/Remote cleanup, conversation identity,
  and unrelated Webpage Inspector survival without a document reload.
- The full release aggregate and a repository-external clean source checkout
  passed for 182 files. Browser and HMR fixtures are self-contained and no
  longer borrow files or helpers from adjacent source checkouts.

## Pending

1. Monitor release feedback and reproduce concrete reports before expanding
   scope. Do not publish npm packages without a new release decision.

## Decisions / Constraints

- Use `ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops, revision)`;
  there is no settings-scope `mutate()` API.
- Credentials follow three paths: `llm-pi-ai` resolves the proxy ref per
  request, Gateway resolves the Management ref per Host operation, and only
  managed bootstrap values enter the scrubbed CPA child environment.
- Subprocess uses a complete argv array plus explicit cwd, stdio, `graceMs`,
  and scrubbed environment; argv is never shell-interpreted.
- `/v1/models` does not prove image capability; unknown models remain text-only
  until explicitly marked.
- Custom client APIs use generated Typert Remote contributions and
  `ctx.remote.$mount()`, never an arbitrary browser HTTP proxy.
- State lives under `resolveDshHome()/dsh-gateway/v1`; DSH has no automatic
  plugin-private data-directory service.
- Device OAuth is the default. Local callback remains disabled until a public,
  server-derived trusted-origin seam is proven; Client-reported origin is not
  security evidence.
- Codex quota uses one fixed Host-only `wham/usage` projection through CPA;
  there is no generic `/api-call` Remote and unsupported providers stay typed
  as unsupported/unavailable.
- The HTTP usage queue is destructive pop with no acknowledgement, so the
  collector is explicitly at-most-once and reports its crash-loss window.

## Verification

- Local Markdown links, fences, trailing whitespace, and fenced JSON passed.
- No obvious secret patterns were found.
- CLIProxyAPI v7.2.131 six-platform asset names and SHA-256 values were checked
  against the upstream release `checksums.txt`.
- All initial and follow-up Sol STOP findings were resolved; final result: GO.
- Phase 6 evidence is recorded in `docs/evidence/phase-6.md`; packed Browser,
  HMR, security, integration, real CPA, and the final aggregate are green.
- Phase 1 frozen install, typecheck, lint, build, fake CPA tests, public API
  probe, six-platform supply-chain verification, and packed external-profile
  install passed locally on Windows x64, Node 24.11.1, pnpm 11.7.0, DSH rc.6.
- Evidence is generated under `.staging/release/v0.1.0/` and
  `.staging/reports/phase1-packed-install.log`; these generated artifacts are
  intentionally ignored by Git.
- Phase 2A through Phase 6 evidence is recorded under `docs/evidence/`. The narrow
  `patches/dsh-typert-generator-0.1.0-rc.6.patch` is a known rc.6 build-only
  compatibility limitation for out-of-tree generation, not a runtime fork.
- A bounded Luna Phase 3 review found and verified the fix for terminal OAuth
  markers leaving a child alive; all parsed terminal states now terminate and
  join exactly once, and disposal awaits the same idempotent join.

## Next Step

Monitor the public feedback threads:

```text
cd D:\coding\programs\dsh\dsh-gateway
https://github.com/Wha1eChai/dsh-gateway/discussions/1
https://github.com/deepseek-ai/deepseek-harness/discussions/1480
```

Recovery state: the Phase 6 gate is committed on public `origin/main`. The
verified release envelope is generated under `.staging/release/v0.1.0/`.
Preserve unrelated worktree changes and keep the existing global 3080 profile
running.

## Risks / Rollback

- The local DeepSeek Harness checkout is rc.5-era source; implementation must
  lock every public import against installed rc.6 declarations and exports.
- OAuth and remote administration are security gates, not implied by a working
  model endpoint.
- The trusted server-derived origin seam for local callback remains absent;
  device flow is the supported path.
- Browser, HMR, clean checkout, aggregate, and public URL installation
  evidence are green. No v0.1 implementation or publication action remains.
- Pricing is intentionally unpriced until a trusted immutable snapshot with
  provenance is selected; token metrics remain valid.
- Phase 2A is recoverable from public commit `4e4485c`. Phase 2B tests clean up
  all runtime processes and private configs; generated release/cache data is under ignored
  `.staging/` and `packages/platform/*/vendor/` paths.
