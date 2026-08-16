# dsh-gateway Agent Guide

## Scope

This repository delivers an out-of-tree DSH Bundle that integrates
CLIProxyAPI as a managed or external AI gateway and contributes its UI through
`dsh-webpage`.

- DSH Plugins remain the only install, dependency, trust, and lifecycle unit.
- Reuse DSH `llm-pi-ai`; do not add a second LLM adapter or browser-to-CPA
  transport.
- Gateway, runtime, analytics, platform assets, and pack remain separate
  packages. The pack only composes ordinary plugins.
- Keep `dsh-webpage` generic. Gateway product code belongs in this repository.
- v0.1 assumes one trusted user and loopback or a user-managed secure tunnel.
  Do not claim multi-user ACL security.

## Frozen Compatibility

- DeepSeek Harness: `0.1.0-rc.6`
- dsh-webpage: `@dshapps/webpage@0.2.0`
- CLIProxyAPI: `7.2.131`
- CPA-Manager-Plus reference: `1.12.0-rc.2`
- Node.js: `^22.19.0 || >=24.0.0`
- pnpm: `11.7.0`

Changing any frozen version requires focused compatibility and packed-install
verification. Do not import DeepSeek Harness repository-internal build scripts
or unpublished source paths.

## Package Ownership

- `packages/gateway`: Host BFF, Provider bridge, OAuth, and Webpage App.
- `packages/runtime`: platform asset selection, private install, and CPA process
  lifecycle.
- `packages/analytics`: optional SQLite worker, collection, rollups, pricing,
  and quota projections.
- `packages/platform/*`: pinned CPA binary, upstream license, provenance, and
  fixed managed config.
- `packages/pack`: ordinary `dsh.bundle` composition only.
- `tests/fixtures/fake-cpa`: deterministic protocol fixture, never production
  behavior hidden behind a fake-only path.

Central manifests, public Host contracts, generated Typert allowlists,
migrations, and release manifests have one owner at a time. Parallel workers
must use disjoint write scopes.

## Product Acceptance

The primary acceptance path is a fresh-profile golden path:

1. Install the Pack without manually downloading CPA.
2. Install and start the managed runtime with no pre-existing Gateway
   credentials.
3. Generate private loopback proxy and management credentials through the DSH
   credential provider without exposing values to Web.
4. Complete Codex device login.
5. Discover and apply models to `llm-pi-ai.providers.cpa`.
6. Send a real text request through `ctx.llm`; test image input only for a
   model explicitly marked image-capable.

Do not treat fixture success, a healthy `/healthz`, generated credentials, or
an empty `/v1/models` response as proof that a user account is connected.
Browser-visible completion states must come from successful Host results.

## Security Boundaries

- Browser remotes are a strict generated allowlist. Never expose a generic CPA
  Management API proxy.
- Never return or persist proxy keys, management keys, access/refresh tokens,
  auth files, raw OAuth responses, prompts, images, or full model outputs in
  analytics or operational logs.
- Resolve credentials per operation. Managed first start may create missing
  writable credentials; external mode must not invent or overwrite them.
- Managed CPA binds loopback only. Do not open firewalls, enable remote
  management, invoke shell download scripts, or add runtime self-update.
- Unknown models are text-only until the user explicitly opts into image
  input.
- Local callback OAuth stays fail-closed until DSH exposes a trusted
  server-derived origin. Device flow is the supported default.

## Implementation Conventions

- Use TypeScript, ESM for Node entries, CJS for the DSH browser handoff, CSS
  Modules, DSH UI primitives, and `--dsw-*` semantic tokens.
- Keep product copy Chinese-first with complete English locale entries.
- Node package entries expose named `apply`; do not add default exports.
- Use `node:sqlite` from a dedicated worker; do not add a native SQLite npm
  dependency or install scripts.
- Platform packages use `os`, `cpu`, and `optionalDependencies`; never add
  `postinstall`.
- Use `apply_patch` for source edits. Preserve unrelated worktree changes.
- Build outputs, downloaded upstream assets, and release staging stay ignored.
  Do not commit `.staging/`, temporary DSH homes, auth data, or credentials.

## Verification

Use the pinned package manager:

```text
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 lint
corepack pnpm@11.7.0 test:unit
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:analytics
corepack pnpm@11.7.0 test:browser
corepack pnpm@11.7.0 test:hmr
corepack pnpm@11.7.0 pack:verify
corepack pnpm@11.7.0 verify
```

Run proportionate focused checks while iterating, then `verify` before a
release claim. A packed-install test must run outside the source checkout and
must not resolve workspace paths, old `lib`, or global development
dependencies. On Windows x64, `scripts/verify-managed-first-run.mjs` must prove
empty credentials → real CPA install/start → authenticated proxy and
management APIs.

## Docs, Handoff, and Releases

- Long-lived architecture belongs in `docs/design/` and irreversible decisions
  in `docs/adr/`.
- Current phase, exact verification state, next command, and recovery notes
  belong only in `HANDOFF.md`.
- Update testing/security/limitations when behavior changes; do not create an
  ADR for routine implementation details.
- Do not publish npm packages, change repository visibility, create tags or
  releases, or post upstream Discussions unless the user explicitly requests
  that external action.
- The existing global DSH `web` profile on port 3080 is shared user state.
  Preserve it unless the user asks for deployment or restart, and validate
  exact profile paths before editing.
