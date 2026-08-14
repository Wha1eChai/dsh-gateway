# HANDOFF

## Goal

Deliver dsh-gateway v0.1 as a public, out-of-tree DSH Bundle that composes a
CLIProxyAPI gateway, optional managed runtime, optional SQLite analytics, and a
native dsh-webpage App without modifying DeepSeek Harness.

## Current Phase

Phases 0–2B are complete / GO. Provider bridge and OAuth Phase 3 are next.

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

## Pending

1. Commit and push the accepted Phase 2B Gate.
2. Implement model discovery/provider settings and Codex device OAuth.

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
- Phase 1 frozen install, typecheck, lint, build, fake CPA tests, public API
  probe, six-platform supply-chain verification, and packed external-profile
  install passed locally on Windows x64, Node 24.11.1, pnpm 11.7.0, DSH rc.6.
- Evidence is generated under `.staging/release/v0.1.0/` and
  `.staging/reports/phase1-packed-install.log`; these generated artifacts are
  intentionally ignored by Git.
- Phase 2A and 2B evidence is recorded under `docs/evidence/`; Phases 3–6
  remain planned and unverified.

## Next Step

Commit and push Phase 2B, then begin the Phase 3 provider bridge and subprocess
device OAuth without changing the proven official LLM transport path.

## Risks / Rollback

- The local DeepSeek Harness checkout is rc.5-era source; implementation must
  lock every public import against installed rc.6 declarations and exports.
- OAuth and remote administration are security gates, not implied by a working
  model endpoint.
- Phase 2A is recoverable from public commit `4e4485c`. Phase 2B tests clean up
  all runtime processes and private configs; generated release/cache data is under ignored
  `.staging/` and `packages/platform/*/vendor/` paths.
