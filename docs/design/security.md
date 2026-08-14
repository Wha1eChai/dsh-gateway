# dsh-gateway security model

Status: Phase 6 security baseline — implemented and release-gated. This document defines the
trust boundary for DSH `0.1.0-rc.6`, dsh-webpage `0.1.0`, and CLIProxyAPI
`7.2.131`. Analytics Host/storage and real-Web App checks pass; automated
browser/HMR/full release checks passed as the Phase 6 gate.

## Security claim and assumptions

The gateway protects secrets and management authority from the Webpage Client
and keeps the CPA process behind a Host-controlled boundary. It does not make
the DSH rc.6 Web deployment a multi-user administration service. The target
inherits DSH's trusted single-user Web boundary; a user who can install or
replace DSH plugins, alter the profile, or control the host process is trusted
with the host. No ACL, tenant isolation, federation, or remote-principal
security claim is made in v0.1.

The Browser is treated as an untrusted caller of Host Remote methods. A rc.6
Typert Remote connection does not prove a trusted HTTP `Origin`; `Origin`,
`Referer`, `Host`, and page-origin values supplied by the Client are never
authorization evidence. The managed CPA binary, its release assets, and
provider OAuth policies are separate trust decisions. CPA is trusted to
implement its pinned release contract, but its Management API is
administrator-equivalent and is not trusted as a browser-facing API.

## Assets and exposure rules

| Asset | Owner | Allowed exposure |
| --- | --- | --- |
| DSH settings and revision | `@deepseek-ai/dsh-settings` provider and Gateway Host | Redacted descriptors and typed projections only |
| Provider proxy credential | `proxyCredentialRef` in settings; value in `@deepseek-ai/dsh-credentials` | Reference/badge may cross a Remote; value is resolved only for CPA data-plane use |
| CPA management credential | Separate `managementCredentialRef` in settings; value in DSH credentials | Host-side allowlisted Management client only; never falls back to the proxy credential |
| Provider API keys, OAuth codes, refresh tokens | CPA and its private auth store | Never Client-visible, never URL/query/log/analytics data |
| CPA config/auth files | Managed runtime owner below the private state root | Host/CPA process only; never served as files |
| Playground prompt, DSH attachment refs, model output | Requesting Client and Host `gateway.probe` path | Prompt and attachment refs enter the typed request; the result returns only to that requesting Client. None may enter operational Remotes, analytics, logs, the database, or persistence |
| Release URL, digest, signature, version | Runtime installer | Sanitized release identity and verification state |

No secret value appears in settings profiles, `PiAiProviderProfile` JSON sent
to a Client, Remote errors, process argv, analytics rows, or ordinary logs.
Hashed account/API-key identities are analytics identifiers, not secret values;
raw account identifiers and raw keys remain prohibited.

## Host and Client boundary

The Gateway App has ID `wha1echai.gateway` and is mounted through
the dsh-webpage `webpage.app` slot at `/apps/wha1echai.gateway`. It registers
the descriptor, locale, and slot composition, renders only sanitized runtime,
provider, account, quota, and analytics projections, and does not create a
second HTTP server.

The App imports only generated Typert Remote contributions. A Client assembly
uses `TypertClientRemote` and `ctx.remote.$mount()`; it does not call CPA with
`fetch()`, expose a configurable Management API URL/key pair, or receive a
raw CPA response. Host methods are validated by generated codecs and then by
Gateway policy before any management request is made. Mounting a Typert
Remote does not attest a trusted HTTP Origin, so no security decision may use
the Client's origin claim.

The Phase 5 allowlist is deliberately closed and contains exactly 18 generated
endpoints. Client names use `namespace.method`; generated wire endpoints use
`namespace/method`:

- `gateway.status`;
- `gateway.runtimeInstall`, `gateway.runtimeStart`, `gateway.runtimeStop`,
  and `gateway.runtimeRestart`;
- `gateway.models` and `gateway.applyModels`;
- `gateway.oauthDeviceStart`, `gateway.oauthDeviceStatus`, and
  `gateway.oauthDeviceCancel`;
- `gateway.analyticsStatus`, `gateway.analyticsSummary`,
  `gateway.analyticsTrend`, `gateway.analyticsRequests`,
  `gateway.analyticsQuota`, and `gateway.analyticsAccounts`;
- `gateway.uploadImage`, which accepts only bounded canonical PNG, JPEG, WebP,
  or GIF bytes and returns an opaque DSH attachment ref; and
- `gateway.probe`, which accepts only a bounded model/prompt/tool payload and
  optional DSH attachment ref before invoking `ctx.llm`.

The runtime methods return sanitized state. Model discovery is identity-only;
`applyModels` persists only the official `llm-pi-ai` `cpa` route with explicit
image capability. OAuth results never carry authorization codes, tokens,
auth paths, or raw CPA output. Analytics methods are bounded read-only
projections. Local-callback, generic management, and account-action methods
are absent.

All inputs and outputs are closed typed payloads. No Remote accepts arbitrary
YAML, HTTP headers, Management paths, upstream request bodies, or a generic
`call(path, body)` operation.

The only forwarded event is a Host-projected `gateway/status-changed` event.
CPA event names and payloads are not forwarded verbatim. Every new method or
event requires an allowlist entry, an input/output schema, and a security
review.

The App may send a write-only credential value through an existing DSH
credential UI if that Host surface is present, but dsh-gateway does not echo,
cache, log, or place that value in settings. The gateway's own Remote contract
accepts only value-free credential refs or configured/source state.

## Settings and credentials

`@deepseek-ai/dsh-llm-pi-ai` stores a route declaration, not a key. The
official `cpa` route uses `apiKeyEnv` as a value-free proxy credential
reference; `llm-pi-ai` resolves that reference for the model request through
the DSH credential seam. The Gateway does not resolve the proxy key for a
Management operation. Gateway configuration changes use the Host API:

```ts
ctx.settings.mutate(settingsNamespace('llm-pi-ai'), ops, expectedRevision)
```

`ops` are path-addressed `set`/`unset` operations. They are applied against
the current user section, so a redacted Client view cannot delete a secret it
did not receive. `expectedRevision` is the expected raw-document revision; a
conflict must be reported instead of overwriting another writer. If the chosen
CPA provider name already belongs to a different `llm-pi-ai` profile or live
route, setup/model apply fails loud before mutation; it neither overwrites the
profile nor invents a suffixed name.

The provider proxy key and Management key use two distinct, purpose-specific
credential-reference fields when configured. The `llm-pi-ai` route resolves
only `proxyCredentialRef` per request. The Gateway resolves only
`managementCredentialRef` inside the Host operation that needs it. A missing
reference disables only its dependent operation and never causes fallback to
the other key.

For a managed child, the Host constructs an explicit bootstrap environment
from a scrubbed parent environment and adds only the documented CPA bootstrap
variables required by that process. The child receives no ambient credential
inheritance. Credential values are not passed in `argv` or written to
diagnostics. If CPA requires a file, the Host writes it atomically under the
private state root with restrictive permissions and treats the file as a
secret-bearing asset. The Management key is resolved by the Host only for the
operation that uses it; a child receives a value only when that exact managed
bootstrap contract requires it.

The CPA Management API key is separate from a data-plane provider key. The
official `llm-pi-ai` route resolves the proxy key for the model request; the
Host resolves and attaches the Management key only to the corresponding
allowlisted Host operation. The Management API must not be used to make
ordinary model requests, and a model request must remain usable when
management is unavailable if the data plane is healthy.

## Managed runtime security

Managed mode is loopback-only and defaults to `http://127.0.0.1:8317`. The
Host configures CPA remote management off and rejects a child that binds
outside loopback. The management and data-plane endpoints are checked
independently. A readiness probe has a bounded timeout and distinguishes
spawn failure, endpoint refusal, unauthorized response, and unhealthy CPA.

Before spawn, the Host attempts to own port `8317`. If occupied, it performs a
bounded CPA-compatible probe. A compatible service produces an explicit offer
to configure external mode; it is never adopted automatically. An incompatible
listener fails setup loud. An operator-selected alternate must be loopback,
must be persisted through typed setup before spawn, and must be reused on
restart rather than silently replaced with an ephemeral port.

Exactly one managed runtime owner and one analytics collector owner may be
active for a resolved `DSH_HOME`. Ownership is coordinated below `stateDir`; a
second owner fails loud and cannot attach to, kill, or replace the first.

Installation is explicit and supply-chain checked:

1. The operator selects a release id from the packaged allowlist.
2. The Host checks platform, architecture, source URL, expected SHA-256, and
   the release/signature provenance recorded for that asset.
3. The asset is staged below `stateDir`, where `stateDir` is exactly
   `resolveDshHome()/dsh-gateway/v1`, verified again, and atomically promoted
   only after validation succeeds.
4. The previous verified asset remains available for rollback. A failed
   install never changes the active selection.

There is no upstream auto-update, no control-panel auto-update, no arbitrary
download URL, and no CLIProxyAPI dynamic library plugin in the managed mode.
Dynamic in-process plugins would expand the trusted native-code set and are
disabled. Version changes require a new manifest, verification, compatibility
gate, and explicit operator action.

The child is launched through `@deepseek-ai/dsh-subprocess` with a
`SubprocessSpawnSpec` containing `argv`, `cwd`, `stdio`, `graceMs`, and a
scrubbed explicit `env`. There is no subprocess `shell` field. The complete
`argv` is passed directly and is never shell interpreted. User input never
becomes a shell command, executable name, or unvalidated argv fragment.
Disposal terminates and joins the whole process tree; crash handling reports
state and uses bounded policy rather than an infinite restart loop.

## External mode security

External mode has no binary installer and no child-process authority. Its data
plane endpoint is operator-configured and validated by Host policy. Loopback
is the default. A non-loopback origin requires an explicit operator decision,
an appropriate transport policy, and a separate Management API origin if
management is enabled. A browser HTTP `Origin` never approves or authenticates
that endpoint. The Browser still talks only to DSH Remotes; it never receives
or forwards a DSH credential to the external origin.

External mode remains usable without the managed-runtime and analytics
companions. Runtime methods and analytics methods return typed `unavailable`
results when their owner is absent; status, setup, model apply/discovery,
OAuth where configured, and `gateway.probe` remain independently usable.

The Host uses bounded health probes and reports endpoint, authentication, and
CPA-health failures separately. It does not silently fall back from a failed
approved endpoint to another host, inherit proxy headers, or accept a URL from
a model prompt.

## OAuth device and local callback flows

DSH does not become an OAuth provider or token store. CPA remains responsible
for provider login, callback handling, refresh, auth-file persistence, and
account state. OAuth is opt-in, provider-specific, and subject to provider
Terms review; support for a provider or a subscription login is not an
authorization to pool, resell, or redistribute accounts.

### Device flow

Device flow is the default and always-supported OAuth flow. The Host starts a
bounded CPA Codex device-login subprocess with Host-owned binary/config/cwd and
explicit argv, stdio, environment, and termination grace. It returns only a
short-lived operation id, verification URI, user code, expiry, and polling
interval. The Client asks `gateway.oauthDeviceStatus` for a sanitized state.
The Host rejects expired, cancelled, repeated, or foreign operation ids; CPA's
access and refresh tokens never cross the Remote boundary.

### Local callback flow

Local callback is disabled by default and is not enabled by inspecting the
Client's page origin. It can be enabled only if the implementation proves a
trusted public origin derived by the server (for example, from a DSH server
configuration or server-owned request context), plus all of the following:

- CPA's selected release provides a documented callback flow whose listener
  can be proven to bind to loopback only;
- the Host pins the exact server-derived redirect origin, path, and provider
  for one operation;
- a cryptographically random, one-use state is bound to that operation and
  expires promptly;
- the callback accepts the expected provider result once, then closes the
  listener and reports only sanitized status.

The Host must not enable a callback implementation that binds to `0.0.0.0`,
an unspecified host, or an unverified interface. CPA documentation currently
describes a local callback port whose binding behavior requires a release gate;
if the public server-derived origin or loopback-only binding cannot be proven
for `7.2.131`, local callback is disabled and device flow remains the
supported OAuth path. Remote callback OAuth is out of scope even when CPA
itself can be configured for one.

The Browser may navigate to the approved provider authorization URI. It does
not supply a redirect URI, callback port, state, management key, token, or
trusted origin. The Host rejects callback results with a wrong state,
provider, path, expiry, or operation owner.

## Model inputs and output handling

`GET /v1/models` or equivalent model metadata does not prove image support.
Every model defaults to text-only until the operator explicitly marks image
input in the `PiAiProviderProfile` metadata and the Host accepts that
declaration. No automatic image modality is inferred from a model name,
listing field, or CPA response.

When image input is explicitly enabled, `gateway.probe` accepts only DSH attachment
refs. The Host resolves them through the DSH attachment seam and includes them
in its `ctx.llm` call. The App never submits raw image bytes, base64, filesystem
paths, or CPA requests, and it never calls CPA directly. The bounded model
result returns to that requesting Client because the Playground is the model
consumer. Prompt, attachment refs, and result are never emitted through
operational Remotes, analytics, logs, the database, or any persistence path.

## Usage queue and quota security

The CPA HTTP usage queue is destructive pop with no acknowledgement operation.
If an optional collector consumes an item, v0.1 has no ack/replay guarantee;
the item must not be exposed through a Remote or retained as a raw upstream
event. A second consumer for the same managed target is not supported, and
there is no RESP fallback.

The Host may inspect CPA `/auth-files` only through a strict internal
projection. The projection contains the minimum allowlisted `authIndex` and
selected safe account identity needed by a supported Host adapter. It excludes
auth-file paths and contents, tokens, key fragments, raw account identifiers,
and the raw response; none of those fields can reach the Client, analytics,
logs, the database, or persistence.

Version 0.1 includes exactly one Host-internal Codex read adapter. It may call
CPA `POST /v0/management/api-call` only with this fixed,
non-client-parameterized request shape:

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

The Client cannot choose `authIndex`, URL, method, header, or body. The Host
enforces strict response size and schema bounds and projects only typed quota
windows. The raw response is never returned or stored. Other providers return
`unsupported` or `unavailable`; quota is never fabricated. There is no generic
Management `/api-call` Remote.

## Analytics privacy

Sanitized analytics outputs may include token-category counts, hashed account
and API-key identities, latency, estimated cost, model, provider, route, quota,
and account health. `analytics.summary` and `analytics.trend` aggregate those
fields; `analytics.requests` returns bounded paginated metadata;
`analytics.quota` and `analytics.accountHealth` return sanitized current state.

Analytics collection, storage, Remote payloads, and errors forbid prompt text,
image bytes or refs, model output, raw account/API keys, access or refresh
tokens, OAuth codes, auth-file paths or contents, authorization headers, and
raw Management API responses. Error messages use stable codes and
operator-safe summaries rather than upstream bodies that may contain secrets
or account details. `gateway.probe` content is explicitly excluded from analytics,
operational Remotes, ordinary gateway logs, the database, and persistence.

The worker receives only closed projection messages. Schema v1 contains no
prompt, image, output-content, authorization, credential, token-value, or
auth-file column. The installation HMAC key is provisioned through DSH
credentials and is never placed in SQLite or a package artifact. Analytics
startup, poll, maintenance, and worker failures return unavailable/empty
observations and never alter `ctx.llm` delivery.

## Rejected security shortcuts

The following are explicit non-decisions:

- a custom LLM adapter instead of `dsh-llm-pi-ai`;
- a route other than the official `llm-pi-ai` `cpa` settings route;
- a raw browser Management API, even for a loopback endpoint;
- a generic Management `/api-call` or user-controlled API-call payload;
- client HTTP Origin as authorization evidence;
- shell spawn, a subprocess `shell` field, or command strings assembled from settings;
- an implicit plugin data directory or current-working-directory state;
- automatic image modality;
- upstream auto-update or dynamic plugins;
- remote callback OAuth without a separately designed identity boundary;
- claims that DSH Webpage v0.1 provides multi-user ACL security.

## References

- [CLIProxyAPI integration research](https://github.com/Wha1eChai/dsh-webpage/blob/main/docs/research/cliproxyapi-dsh-integration.md)
- [CLIProxyAPI Management API](https://help.router-for.me/management/api)
- [CLIProxyAPI v7.2.131 release](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.131)
- [DeepSeek Harness credentials seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/credentials/credentials)
- [DeepSeek Harness settings seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/settings/settings)
- [DeepSeek Harness subprocess seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/subprocess/subprocess)
- [DeepSeek Harness home-path seam](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/util/home-paths)
- [DeepSeek Harness Typert protocol](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/typert/protocol)
