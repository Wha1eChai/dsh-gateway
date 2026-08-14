# ADR 0003: Keep CLIProxyAPI behind an HTTP sidecar

- Status: Accepted
- Date: 2026-08-14

## Context

CLIProxyAPI is a server product with a documented HTTP data plane and
Management API. Its current Go SDK documentation and v7 module version are
not a stable TypeScript/Node integration contract, and embedding it would
couple native packaging, OAuth, config watching, and in-process trust to DSH.

## Decision

Use one HTTP sidecar contract for both modes. External mode connects to an
operator-selected, Host-policy-checked instance and never installs or starts a
binary. Managed mode starts the pinned CLIProxyAPI `7.2.131` platform asset
as a Host-owned child process after an explicit verified install. The Host
uses separate data-plane and Management API clients; a model request does not
depend on the Management API. A browser HTTP `Origin`, Typert Remote
connection, or other Client-supplied origin value is not endpoint trust or
authorization evidence.

Managed mode defaults to `http://127.0.0.1:8317`. If the port is occupied, the
Host performs a bounded CPA-compatible probe. A compatible service yields an
explicit external-mode offer; an incompatible listener fails setup loud. An
operator-selected alternate loopback port is persisted before spawn and reused
on restart. The Host never silently adopts an existing service or chooses an
ephemeral replacement.

CPA owns provider login, account selection, refresh, and failover. dsh-gateway
owns endpoint policy, readiness, lifecycle, and the official `llm-pi-ai` `cpa`
route settings. Management access is through fixed Host operations only; this
ADR does not authorize a generic Management `/api-call` or arbitrary HTTP
passthrough.

## Consequences

The external PoC proves request, stream, model, health, and credential
semantics without committing to binary distribution. Managed mode adds
install, digest, rollback, process, and callback gates while retaining the
same route behavior. External mode remains usable without runtime or
analytics. Version upgrades require a new compatibility review. The official
route resolves the proxy credential per model request; the Host resolves a
Management credential only for the operation that uses it.

## Rejected alternatives

Rejected: Go SDK embedding for the first slice, a separate Go shim as the
default, a TypeScript/Go rewrite of CLIProxyAPI, a browser-trusted Origin
assumption, and arbitrary Management HTTP passthrough.

## Verification gate

Both modes must pass the same Host route contract for the official `cpa`
settings route. Managed mode must prove default-port ownership, compatible
occupied-port probing, persisted alternate port reuse, loopback binding,
readiness, explicit release verification, and complete tree disposal. External
mode must prove Host policy checks that do not rely on Client Origin, separate
health/authorization failures, and operation without runtime or analytics
companions.
