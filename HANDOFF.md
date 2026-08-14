# HANDOFF

## Goal

Deliver dsh-gateway v0.1 as a public, out-of-tree DSH Bundle that composes a
CLIProxyAPI gateway, optional managed runtime, optional SQLite analytics, and a
native dsh-webpage App without modifying DeepSeek Harness.

## Current Phase

Phase 0 documentation baseline is complete and has a GO review. No code or
package scaffolding has been created; Phase 1 is ready to start after the root
commit and public remote are created.

## Completed

- dsh-webpage v0.1.0 was publicly released and its packed-install gate passed.
- CLIProxyAPI v7.2.131 and CPA-Manager-Plus v1.12.0-rc.2 were audited.
- DSH rc.6 public settings, credentials, subprocess, llm-pi-ai, Typert Remote,
  home-path, and Webpage slot seams were mapped.
- The local dsh-gateway repository was initialized on `main`.
- Phase 0 architecture, security, analytics, topology, plan, testing, and ADR
  documents were frozen; the final focused Sol re-review returned GO.

## Pending

1. Commit the docs-only baseline and create the public GitHub repository.
2. Begin Phase 1 workspace and supply-chain implementation.
3. Run the Phase 2A `llm-pi-ai` compatibility gate before runtime Phase 2B.

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
- Phase 1–6 implementation commands remain planned and unverified.

## Next Step

Create and push the docs-only root commit, then start the Phase 1 workspace and
supply-chain gate.

## Risks / Rollback

- The local DeepSeek Harness checkout is rc.5-era source; implementation must
  lock every public import against installed rc.6 declarations and exports.
- OAuth and remote administration are security gates, not implied by a working
  model endpoint.
- Until the public remote is created, rollback is simply removing the new
  repository; no Gateway runtime or package state exists.
