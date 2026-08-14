# ADR 0002: Reuse `dsh-llm-pi-ai` for model traffic

- Status: Accepted
- Date: 2026-08-14

## Context

CLIProxyAPI already translates provider protocols, manages provider accounts,
refreshes credentials, and performs account-level failover. DSH's public
`@deepseek-ai/dsh-llm-pi-ai` package can describe an OpenAI-compatible route
through `PiAiProviderProfile`, including `api`, `baseURL`, model metadata,
modalities, retry policy, and a value-free `apiKeyEnv` reference. The intended
integration is the official route named `cpa`, not a gateway-owned adapter.

## Decision

Do not implement or register a custom LLM adapter. Configure only the official
`llm-pi-ai` route `cpa` to CPA's data-plane endpoint. Model requests enter
through `ctx.llm`; CPA remains the provider translation, account, refresh, and
failover boundary. The Gateway may use the existing `llm-pi-ai` discovery and
model metadata mechanisms, but it does not create a second model registry or
transport.

Route changes are Host settings operations:

```ts
ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops, expectedRevision)
```

`model.discover` is non-persistent. `model.apply` performs the mutation with a
closed provider/model payload and fails loud if the chosen CPA provider name
conflicts with another profile or live route. It never overwrites, silently
renames, or suffixes the provider. The proxy key and Management key remain
separate credential refs: `llm-pi-ai` resolves the proxy reference for each
`ctx.llm` request, while the Gateway resolves the Management reference only
inside the Host operation that needs it. Neither path falls back to the other.

## Consequences

The gateway inherits DSH streaming, cancellation, modality, and error
semantics. DSH retries only a clearly classified sidecar failure before a
stream starts; it does not replay a stream after output begins or duplicate
CPA account failover. A route's configured model input defaults to text-only;
image input needs explicit metadata.

The Playground uses the typed `probe.run` Host Remote. It necessarily sends a
bounded prompt and optional DSH attachment refs; the Host resolves those refs
and calls `ctx.llm`. The result returns only to the requesting Client. Prompt,
attachment refs, and result never enter operational Remotes, analytics, logs,
the database, or persistence. Client code never calls CPA directly or
constructs a CPA request.

## Rejected alternatives

Rejected: a CPA-specific adapter, any route other than the official `cpa`
settings route, a TypeScript rewrite of CPA's translators, embedding the Go
SDK in the Node process, and putting the route in an agent preset instead of
the host-wide `ctx.llm` seam.

## Verification gate

An rc.6 public-contract check must prove that the packed Gateway works with
`@deepseek-ai/dsh-llm-pi-ai` and its public settings/credentials seams, with no
Gateway-owned adapter registration and only the `cpa` route settings
mutation. It must also prove revision conflict, provider-name conflict,
per-request proxy-ref resolution by `llm-pi-ai`, Host-only Management-key
resolution, and a `probe.run` path that reaches CPA only through `ctx.llm` and
returns the result only to its requesting Client without observer/persistence
side effects.
