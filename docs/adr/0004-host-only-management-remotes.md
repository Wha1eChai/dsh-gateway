# ADR 0004: Expose management through Host-only generated Remotes

- Status: Accepted
- Date: 2026-08-14

## Context

CLIProxyAPI's Management API can mutate provider configuration, auth files,
API keys, routing, usage controls, and OAuth state. A management key is
administrator authority. The dsh-webpage App is a single-user UI contribution,
not a multi-user ACL boundary. Its exact App ID is `wha1echai.gateway`,
mounted under `/apps/wha1echai.gateway`, with routes `/`, `/accounts`,
`/models`, `/requests`, `/playground`, and `/settings` contributed through
Webpage slots.

## Decision

The App uses only generated Typert Remote contributions. The Host owns the
allowlist and the Client mounts the generated contribution through
`TypertClientRemote` and `ctx.remote.$mount()`. Mounting a Typert Remote does
not prove a trusted HTTP `Origin`; the Host never trusts a Client-supplied
Origin, Referer, Host, or page-origin value. The closed and exact v0.1
allowlist is:

- `gateway.status` and `gateway.setup`;
- `runtime.install`, `runtime.start`, `runtime.stop`, and `runtime.restart`;
- `model.discover` and `model.apply`;
- `oauth.deviceStart`, `oauth.localCallbackStart`, `oauth.status`, and
  `oauth.cancel`;
- `analytics.summary`, `analytics.trend`, `analytics.requests`,
  `analytics.quota`, and `analytics.accountHealth`;
- Playground `probe.run`, whose Host implementation calls `ctx.llm` and
  resolves only DSH attachment refs.

It forwards only a Host-projected status event. Every method has a closed typed
input and output; no generic Management proxy exists. In particular, there is
no generic Management `/api-call` Remote.

The `llm-pi-ai` `cpa` route resolves the proxy credential for each model
request. For a Management operation, the Gateway resolves the separate
Management credential inside the Host and attaches it only to that fixed
operation. No browser code receives a CPA Management API URL/key pair, raw
management endpoint, arbitrary YAML, arbitrary path, raw header, provider
credential, token, or upstream response.
Analytics responses may contain token-category counts, hashed account/API-key
identities, latency, estimated cost, model/provider/route, quota, and account
health. They exclude prompts, images, model output, raw keys/tokens, auth files,
and raw Management responses. `probe.run` necessarily carries a bounded prompt
and optional DSH attachment refs; its result is returned only to the
requesting Client and never becomes an operational Remote, analytics field,
log, database row, or persisted value.

The Host may read CPA `/auth-files` only through a strict internal projection
containing the minimum allowlisted `authIndex` and selected safe account
identity needed by a supported adapter. Paths, contents, tokens, key
fragments, raw identifiers, and the raw response are discarded and never
cross a Remote or persistence boundary.

Version 0.1 ships one Host-internal Codex read adapter for quota. It may call
CPA `POST /v0/management/api-call` only with a fixed,
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

The Host rejects any client attempt to choose the auth index, URL, method,
header, or body. It applies strict size/schema validation and returns only a
typed quota-window projection; the raw response is never returned or stored.
Other providers return `unsupported` or `unavailable`, never fabricated
quota.

## Consequences

Every new method requires a generated descriptor, closed input/output schema,
allowlist entry, and security review. Management unavailability does not
disable healthy model traffic. Usage-queue consumption is a destructive pop
with no ack/replay guarantee; the Gateway does not expose queue items or claim
acknowledgement semantics. The App cannot be reused as a general CPA console
without a new authority decision.

## Rejected alternatives

Rejected: raw browser Management API access, a generic `gateway.call(path,
body)` Remote, any generic Management `/api-call` Remote, client-controlled
HTTP Origin authorization, passing management keys through Client state, and
claiming multi-user administration security.

## Verification gate

Client compilation and runtime tests must show that only the exact selected
Typert contribution is mounted, under `wha1echai.gateway` Webpage slots, and
that a Client Origin is not trusted. Forbidden paths, arbitrary URLs, secrets,
and raw CPA payloads must be rejected before a Management request. Contract
tests must enumerate every method above, reject unknown fields and methods,
verify all five analytics privacy projections, and prove `probe.run` traverses
`ctx.llm`; its prompt/attachment refs and result must not reach an operational
Remote, analytics, logs, the database, or persistence.

Quota contract tests must prove strict `/auth-files` projection, internal
auth-index selection, the exact fixed Codex `/v0/management/api-call` payload,
rejection of client URL/method/header/body controls, bounded schema projection
without raw-response retention, and `unsupported`/`unavailable` for other
providers. Usage-queue tests must model destructive pop with no ack/replay
claim.
