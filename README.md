# dsh-gateway

A DSH-native AI gateway and operations App built around CLIProxyAPI.

`dsh-gateway` is an ordinary out-of-tree DeepSeek Harness Bundle. It connects
the existing DSH `llm-pi-ai` provider to a managed or external CLIProxyAPI,
keeps credentials and administration on the Host side, and contributes a
native App through [dsh-webpage](https://github.com/Wha1eChai/dsh-webpage).

## v0.1 goal

- initialize and supervise a pinned, platform-specific CLIProxyAPI binary;
- connect an existing external CLIProxyAPI without the runtime package;
- discover models and explicitly opt vision-capable models into image input;
- support Codex device login, with localhost callback login enabled only when
  DSH exposes a trusted server-derived request-origin seam;
- provide a DSH-native Playground that exercises the full `ctx.llm` path;
- provide request, token, cost, latency, account-health, and quota analytics;
- install the complete experience through one ordinary DSH Pack.

The browser never receives proxy keys, management keys, OAuth tokens, auth
files, or raw Management API responses. Playground content traverses only the
typed `probe.run` request/response path for the requesting client; prompts,
attachment content, and model output are never written to operational remotes,
analytics, logs, or persistent storage. Managed mode binds loopback only. The
first release inherits DSH `0.1.0-rc.6`'s trusted single-user Web boundary and
does not claim multi-user ACL security.

## Architecture boundaries

- DSH Plugins remain the only install, trust, dependency, and lifecycle unit.
- `llm-pi-ai` remains the only model transport; this project does not register
  or silently fall back to a custom LLM adapter. A failed compatibility gate
  stops the phase and requires a new public architecture decision.
- CLIProxyAPI owns provider login, account selection, refresh, and failover.
- Gateway exposes only generated, allowlisted Typert remotes to the App.
- Runtime and analytics are independently installable companions rather than
  features embedded into dsh-webpage. The flagship one-install Pack includes
  both as required dependencies; a manual external-mode composition may omit
  either companion.
- No npm package is published during the preview phase.

The native App is addressable at `/apps/wha1echai.gateway` with Accounts,
Models, Requests, Playground, and Settings subroutes.

## Frozen compatibility target

| Component | Version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.6` |
| dsh-webpage | `0.1.0` |
| CLIProxyAPI | `7.2.131` |
| CPA-Manager-Plus reference | `1.12.0-rc.2` |
| Node.js | `^22.19.0 || >=24.0.0` |
| pnpm | `11.7.0` |

## Documents

- [Architecture](./docs/design/architecture.md)
- [Security model](./docs/design/security.md)
- [Analytics data model](./docs/design/analytics-data-model.md)
- [Package topology](./docs/design/package-topology.md)
- [Dependency map](./docs/design/dependency-map.md)
- [v0.1 execution plan](./docs/plan/phase-0.1-gateway.md)
- [Testing strategy](./docs/testing.md)
- [Phase 1 evidence](./docs/evidence/phase-1.md)
- [Current handoff](./HANDOFF.md)

## Current status

Phase 0 and Phase 1 are complete and independently reviewed. The workspace,
six-platform supply chain, release rewriting, public API probes, clean-checkout
verification, and repository-external one-Pack installation passed their Gate.
Phase 2A is also complete: the official rc.6 `llm-pi-ai` path passed text,
tools, ordered streaming, explicit image opt-in, and abort against the fake
CPA. Runtime Phase 2B is next. No public installable Gateway release exists
yet.

## Deferred

Federation, multi-user ACLs, CRDT collaboration, account rotation policies,
automatic cooldown/reset actions, RESP usage ingestion, dynamic upstream
plugins, upstream panel auto-update, remote callback OAuth, and npm publication
are outside v0.1.
