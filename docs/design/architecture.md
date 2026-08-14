# dsh-gateway architecture

Status: Phase 5 architecture baseline — implemented; acceptance is being
completed. Compatibility target:
DeepSeek Harness `0.1.0-rc.6`, `@wha1echai/dsh-webpage` `0.1.0`, and
CLIProxyAPI `7.2.131`. Phases 0–4 are complete and the native App is running
in the real DSH Web profile; Phase 6 automation remains the release gate.

## Decision summary

`dsh-gateway` is an ordinary out-of-tree DSH Bundle. It composes an ordinary
Host Plugin, an optional managed-runtime companion, an optional analytics
companion, and a Webpage App contribution. It does not modify DSH or
dsh-webpage, create a second plugin system, or publish an npm package during
the preview phase. Plugin installation, trust, dependency resolution, and
lifecycle remain DSH responsibilities.

CLIProxyAPI is an HTTP sidecar. External mode connects to an operator-selected
instance. Managed mode starts a pinned platform asset as a DSH-owned child
process. Both modes expose the same Host-side gateway service. The first
integration does not embed the Go SDK and does not rewrite CLIProxyAPI.
External mode remains fully usable when neither the managed-runtime nor the
analytics companion is installed.

Model traffic uses the official `@deepseek-ai/dsh-llm-pi-ai` route named `cpa`.
The Gateway only writes that route's settings, including its OpenAI-compatible
CPA data-plane endpoint and model metadata. It does not implement or register a
custom LLM adapter, second transport, or second model registry. CPA owns
provider login, token refresh, account selection, and provider-level failover.
DSH owns route configuration, Host policy, and the bounded transport failure
policy around the sidecar.

## Public seams and ownership

The implementation must use public package exports and generated artifacts.
Repository-local build helpers, source paths, or private DSH internals are not
part of this design.

| Concern | Public seam | Gateway owner and rule |
| --- | --- | --- |
| Model requests | `@deepseek-ai/dsh-llm-pi-ai`, `ctx.llm`, `Config`, `PiAiProviderProfile` | The Gateway writes only the official `cpa` route with `api`, `baseURL`, `models`, and a value-free proxy credential reference. It does not extend or replace the official adapter. |
| Settings | `@deepseek-ai/dsh-settings`, `settingsNamespace`, `ctx.settings.mutate(ns, ops, expectedRevision)` | Non-secret gateway settings use the gateway namespace. Provider persistence uses `ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops, expectedRevision)`. Path operations preserve fields omitted from redacted views; revision conflicts and CPA provider-name conflicts fail loud. |
| Credentials | `@deepseek-ai/dsh-credentials`, `CredentialRef`, `ctx.credentials.resolve(ref)` | Settings carry separate `proxyCredentialRef` and `managementCredentialRef` fields. `llm-pi-ai` resolves the proxy reference for each model request. The Gateway resolves the Management reference only inside the Host operation that needs it; neither path falls back to the other. |
| Child process | `@deepseek-ai/dsh-subprocess`, `SubprocessSpawnSpec`, `SubprocessRuntime`, `ctx.subprocess.spawn()` | The spawn spec is `argv`/`cwd`/`stdio`/`graceMs` plus a scrubbed explicit `env`. There is no subprocess `shell` field. The complete `argv` is passed directly and is never shell interpreted. The child receives only explicit managed bootstrap environment entries. |
| User data root | `@deepseek-ai/dsh-home-paths`, `resolveDshHome()` | One gateway Host service resolves `resolveDshHome()/dsh-gateway/v1` once and passes derived paths to companion services. No plugin-private or current-working-directory data root is allowed. |
| Host Remotes | `@deepseek-ai/dsh-typert-protocol`, `TypertRemoteContribution`, `TypertClientRemote`, `@Remote`, `@RemoteScope` | Host methods are generated Typert contributions and are mounted explicitly by the Client with `ctx.remote.$mount()`. The Client never discovers or calls CPA endpoints directly. |
| Webpage | `@wha1echai/dsh-webpage`, `ctx.pages`, `webpage.app` | The Client registers App ID `wha1echai.gateway` through the `webpage.app` slot at `/apps/wha1echai.gateway`, mounts the generated Remote, and provides `/`, `/accounts`, `/models`, `/requests`, `/playground`, and `/settings`. The Client is not the provider, a server, or an independently installable unit. |

The target release must verify these names against the installed rc.6
declarations and exports. A local checkout from another DSH revision is
mechanism evidence only, not a compatibility promise.

## Host, runtime, analytics, App, and Pack boundaries

The following are ownership roles; the final package names are owned by the
package-topology document.

### Gateway Host service

The Host service owns one `GatewayTarget` state machine and one lifecycle
owner. It validates the selected mode, controls the data-plane and management
clients, exposes sanitized status, and reconciles the DSH route. Its public
responsibilities are:

- validate external endpoint policy or managed-runtime readiness;
- resolve the Management credential reference only at the Host operation that
  needs it;
- maintain the CPA data-plane client and a separately allowlisted management
  client;
- update the `llm-pi-ai` route through settings operations;
- reject an existing provider name that does not match the gateway-owned CPA
  profile instead of overwriting it or inventing a suffixed route;
- expose the generated Host Remote methods listed below;
- dispose child processes, listeners, timers, and in-flight operations.

The data-plane client is not a browser transport. A model request reaches CPA
through the official `cpa` route and `ctx.llm`; an App or prompt cannot supply
an arbitrary upstream URL, authorization header, or provider credential. The
proxy key is resolved by `llm-pi-ai` for that request. A managed CPA child gets
only explicitly selected bootstrap environment entries, never an ambient
credential inheritance.

### Managed-runtime companion

This role owns release metadata, asset verification, atomic staging, current
selection, rollback, readiness, and child-process disposal. Exactly one
managed-runtime owner may be active for one resolved DSH home. The role may be
absent in external mode. Runtime activation never downloads an asset
implicitly. An operator must request an install of an allowlisted release and
the Host must verify the platform, architecture, source, digest, and provenance
before staging it.

### Analytics companion

Analytics consumes the Host-only sanitized CPA usage/health/quota source. It does not
own CPA configuration, credentials, OAuth files, or the model route. Exactly
one collector owner may be active for one resolved DSH home. Sanitized outputs
may include token-category counts, hashed account and API-key identities,
latency, estimated cost, model, provider, route, quota, and account health.
The v0.1 implementation does not add a second request interceptor: request
identity and timing originate in CPA's bounded usage projection.
They never include prompts, images, model output, raw keys or tokens, auth
files, or raw Management API responses.

### Gateway App contribution

The Gateway App is the Client contribution with exact ID
`wha1echai.gateway`, mounted through the dsh-webpage `webpage.app` slot at
`/apps/wha1echai.gateway`. It registers the descriptor, locale, and slot
composition, mounts the generated Remote with `ctx.remote.$mount()`, and
renders the Dashboard, Accounts, Models, Requests, Playground, and Settings
views with explicit loading, unavailable, degraded, and failure states. It
does not import a CPA SDK, call `fetch()` to a CPA management or data endpoint,
receive a management key, or act as a second administration server.

A bounded prompt, optional tool declaration, and optional DSH attachment ref
cross only the typed `gateway.probe` flow; image bytes first enter the narrow
`gateway.uploadImage` method and are immediately converted to an opaque DSH
attachment ref. The Host resolves the ref and invokes `ctx.llm`. Prompt,
attachment content, and model output remain excluded from operational Remotes,
analytics, logs, the database, and other persistence.

### Gateway Pack

The flagship Pack composes the Host Plugin, runtime, analytics, the App
contribution, the compatible DSH Web bundle, and pinned safe defaults. Runtime
and analytics remain optional at the project level: a manual external-mode
composition may omit either, but the one-install flagship Pack carries both
as required package dependencies and patch rows. The Pack contains composition
metadata only. It does not silently enable OAuth, remote management, upstream
dynamic plugins, panel auto-update, or binary updates.

## External and managed modes

| Property | External mode | Managed mode |
| --- | --- | --- |
| Process owner | Operator or another supervisor | Gateway Host through `ctx.subprocess` |
| Endpoint | Explicitly configured and Host policy-checked; no browser HTTP Origin is trusted as approval | Default `http://127.0.0.1:8317`; an alternate loopback port must be persisted before use |
| Binary | Never installed by dsh-gateway | Pinned `7.2.131` platform asset, verified before use |
| CPA state | Not owned by dsh-gateway; only DSH gateway state is local | Private CPA config/auth/log state below the gateway state root |
| Management | Disabled unless a separately configured, approved management endpoint exists | Loopback-only management client with a Host-held credential |
| Failure | Report unreachable, unauthorized, and unhealthy separately | Report spawn, readiness, exit, and unhealthy states separately; no unbounded restart loop |
| Optional companions | Runtime and analytics may both be absent | Runtime required; analytics remains optional |

The data plane and Management API are separate capability clients. Management
availability is not required for a healthy model request. A configured remote
management endpoint never causes the Browser to send a DSH credential to that
endpoint. A Typert Remote connection does not prove a trusted HTTP `Origin`;
the Host never authorizes an operation from a client-supplied Origin, Referer,
Host, or page-origin value.

Managed setup tries `127.0.0.1:8317` first. If the port is occupied, the Host
performs a bounded CPA-compatible probe. A compatible CPA produces an explicit
offer to use that endpoint in external mode; the gateway never adopts it
silently. An incompatible listener fails setup loud. The operator may choose
an alternate loopback port through typed setup, but the Host must persist that
port before spawning CPA and reuse it on restart rather than choosing an
ephemeral port silently.

## Durable state and one DSH_HOME owner

The only gateway root is:

```text
stateDir = resolveDshHome()/dsh-gateway/v1/
```

`stateDir` is the one path passed to the runtime and analytics owners; it is
not inferred independently by those roles.

The owning Host service creates and permission-checks this root, then passes
explicit subdirectories to runtime and analytics roles. Conceptually, the
root contains gateway settings metadata, runtime release staging/current data,
managed CPA configuration and auth files, process diagnostics, and analytics
storage. The exact analytics schema belongs in the analytics data-model
document.

The state root also carries the ownership coordination needed to enforce one
managed runtime and one collector per resolved DSH home. A second owner fails
loud; it does not attach to or replace the first process implicitly.

No role may derive a path from a package name, `process.cwd()`, an implicit
plugin data directory, or a second `$DSH_HOME` interpretation. The managed
CPA YAML has one writer: the Gateway Host service. External edits are either
unsupported or imported through a versioned, validated operation; two writers
must never race the same document.

## Data flows

1. **Model request.** An Agent or Host model consumer calls `ctx.llm`. The
   existing `llm-pi-ai` route sends one OpenAI-compatible request to CPA. CPA
   translates to the selected provider and owns provider account failover.
   The DSH adapter streams normalized chunks, propagates cancellation, and
   does not retry after output has started.
2. **Model discovery and persistence.** `gateway.models` returns candidates
   without persistence. `gateway.applyModels` validates the chosen model
   declaration and image opt-in, rejects a conflicting CPA provider name, and
   applies only the required path operations with
   `ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops,
   expectedRevision)`. The `llm-pi-ai` schema validates the complete candidate
   and the next request observes the committed route.
3. **Managed lifecycle.** An explicit install action verifies and atomically
   stages the asset. The Host resolves the default or persisted alternate port,
   starts CPA with `ctx.subprocess.spawn()` and a complete argv, waits for
   bounded readiness, then applies the route. Stop, restart, and unload
   terminate and join the whole process tree before releasing or replacing it.
4. **OAuth.** The App requests a typed Host operation. The Host launches the
   bounded CPA Codex device-login subprocess with Host-owned binary/config/cwd
   and explicit subprocess fields. Device flow is the default and
   always-supported OAuth flow; it returns only verification instructions and a
   status handle. A local callback is disabled unless the implementation proves
   both a loopback-only listener and a trusted public origin derived by the
   server, never from the Client's HTTP `Origin` or page-origin input. CPA
   retains auth files and refresh tokens.
5. **Operations and analytics.** The Host projects health, release identity,
   route state, allowed request metrics, quota, and account health into
   sanitized Remote results and optional analytics events. Content and secret
   fields do not enter that path.
6. **Playground probe.** The App sends a closed `gateway.probe` request containing
   a route/model selection, bounded prompt, and optional DSH attachment refs.
   The Host resolves the refs and calls `ctx.llm`; it never calls CPA directly.
   The bounded model result returns only to the requesting Client. Prompt,
   attachment refs, and result are excluded from operational Remotes,
   analytics, ordinary logs, the database, and all persistence.

## Analytics, usage queue, and quota boundaries

Analytics is optional and cannot be on the model-request path. If the CPA HTTP
usage queue is consumed, it is a destructive pop with no acknowledgement
operation. The collector therefore has no ack/replay guarantee and must not
expose queue items through a Remote or claim durable delivery after a pop.
There is no RESP fallback and no second queue consumer for one managed target.

The `/auth-files` Management response is Host-internal only. The Host projects
it into a strict allowlisted inventory containing only the minimum internal
`authIndex` and selected safe account identity needed by a supported adapter;
auth-file paths, contents, tokens, key fragments, raw identifiers, and the raw
response are discarded and never returned or persisted.

Version 0.1 ships exactly one Host-internal Codex read adapter for quota. It
may call CPA `POST /v0/management/api-call` only with a fixed,
non-client-parameterized payload:

```text
authIndex: selected from the internal allowlisted auth-file inventory
method: GET
url: https://chatgpt.com/backend-api/wham/usage
headers:
  Authorization: Bearer $TOKEN$
  Content-Type: application/json
  User-Agent: fixed Gateway User-Agent
  Chatgpt-Account-Id: optional value from the selected internal account
```

The adapter enforces the fixed method, URL, headers, and internal selection;
the Client cannot supply an auth index, URL, method, header, or body. The
response is bounded by strict size and schema checks and projected only into
typed quota windows. The raw response is neither returned nor stored. Other
providers report `unsupported` or `unavailable`; the Gateway never fabricates
quota. There is no generic Management `/api-call` Remote.

## Host Remote allowlist

The gateway App mounts generated contributions explicitly. Names below use the
Client `namespace.method` spelling; the generated wire endpoint is
`namespace/method`. The Phase 3 artifact contains exactly these 11 strict
endpoints. Every payload is a closed typed object. There is no arbitrary
Management API proxy.

| Remote method | Effect | Typed result or restriction |
| --- | --- | --- |
| `gateway.status` | Read | Sanitized runtime state, endpoint, credential configuration state, and `localCallbackAvailable: false`; no secret values. |
| `gateway.runtimeInstall` | Write | Host-owned runtime install and sanitized runtime view; no client URL, archive, or executable. |
| `gateway.runtimeStart` | Write | Managed/external runtime start and sanitized runtime view. |
| `gateway.runtimeStop` | Write | Runtime stop and sanitized runtime view. |
| `gateway.runtimeRestart` | Write | Runtime restart and sanitized runtime view. |
| `gateway.models` | Read/probe | Typed `/v1/models` discovery; returns model identity only and defaults `imageInput` to false. |
| `gateway.applyModels` | Write | Closed model metadata plus `expectedRevision`; writes only the official `llm-pi-ai` `cpa` route and preserves explicit image capability. |
| `gateway.oauthDeviceStart` | Write | Bounded Codex device-login start; returns only operation id, verification URI, user code, expiry, and poll interval. |
| `gateway.oauthDeviceStatus` | Read | Sanitized operation state by operation id; no token, auth path, or raw subprocess output. |
| `gateway.oauthDeviceCancel` | Write | Idempotent cancellation of the bounded device operation; no secret-bearing result. |
| `gateway.probe` | Write/probe | Bounded prompt, optional DSH attachment ref, and tools reach the official `ctx.llm` path; only a sanitized result returns to the requesting Client. |

Analytics methods, local-callback methods, generic management calls, and
account actions are not in this Phase 3 allowlist; they remain Phase 4/5 plan
items.

The one-way event allowlist contains only a Host-projected status change, such
as `gateway/status-changed`; raw CPA events are not forwarded. Adding a Remote
or event requires a new security review and generated Typert contribution.

## Explicitly rejected designs

This architecture rejects a custom LLM adapter, any route other than the
official `llm-pi-ai` `cpa` settings route, raw browser access to the CPA
Management API, a generic Management `/api-call`, client-controlled HTTP
Origin authorization, shell-based spawning or a subprocess `shell` field, an
implicit plugin data directory, automatic image modality inference, upstream
auto-update, upstream dynamic plugins, Go SDK embedding in the first slice, a
TypeScript rewrite, and any multi-user security claim. These are product
constraints, not optional implementation details.

## References

- [CLIProxyAPI integration research](https://github.com/Wha1eChai/dsh-webpage/blob/main/docs/research/cliproxyapi-dsh-integration.md)
- [CLIProxyAPI v7.2.131 release](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.131)
- [CLIProxyAPI Management API](https://help.router-for.me/management/api)
- [DeepSeek Harness `dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/llm/llm-pi-ai)
- [DeepSeek Harness settings seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/settings/settings)
- [DeepSeek Harness credential seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/credentials/credentials)
- [DeepSeek Harness subprocess seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/subprocess/subprocess)
- [DeepSeek Harness home-path seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/util/home-paths)
- [DeepSeek Harness Typert protocol](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/typert/protocol)
- [DeepSeek Harness API Remotes](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/api/remotes)
- [dsh-webpage Webpage package](https://github.com/Wha1eChai/dsh-webpage/tree/main/packages/webpage)
