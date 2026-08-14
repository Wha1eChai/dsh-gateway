# dsh-gateway dependency map

This map freezes the dependency direction and the Phase 0 implementation
order. It is intentionally narrower than the feature surface advertised by
CLIProxyAPI. The supported first boundary is DSH `0.1.0-rc.6` plus an
HTTP-compatible CPA endpoint. Model transport is the official
`@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6` package; Gateway owns its provider
profile/config/settings and does not supply a custom `ctx.llm` adapter.
CLIProxyAPI `v7.2.131` is a pinned managed runtime asset, not a TypeScript or
Go library dependency.

## Dependency graph

```text
DSH rc.6 host / LLM / settings / credentials / remotes
  |
  +--> official @deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6
  |                                                 |
  +--> gateway ------------------------------------+
  |      |                                          |
  |      +--> optional dsh-webpage client surface   +--> runtime (optional)
  |      +--> gateway/request-completed             |      +--> one platform package
  |      +--> external CPA HTTP endpoint            |
  |                                                 +--> analytics (optional)
  |                                                        +--> CPA HTTP usage queue
  |                                                        +--> sanitized quota/health reads
  |                                                        +--> node:sqlite worker
  |
  +--> dsh-webpage v0.1.0 -------------------------------> pack (ordinary dsh.bundle)
                                                           |
                                                           +--> gateway (required row)
                                                           +--> runtime (required by flagship Pack)
                                                           +--> analytics (required by flagship Pack)

fake-cpa fixture --test-only HTTP server--> official llm-pi-ai route / Host contract tests
```

The arrows are build/runtime edges, not a new resolver. `runtime` depends on
the concrete gateway registration surface, so the gateway can be built and
installed alone. `gateway` does not import runtime or analytics. `analytics`
depends on the gateway event and Host-only collector contracts, but is not a
model data-plane dependency. Platform packages are data-only optional
dependencies of `runtime`; they are not plugins and never load code into the
DSH process.

## Edge contract

| From | To | Exact reason | Must not become |
| --- | --- | --- | --- |
| `gateway` | DSH rc.6 LLM/settings/credentials/remotes | own one CPA provider profile/config/settings, configure the official exact `dsh-llm-pi-ai` route, resolve credentials, expose sanitized Host operations | a Gateway-owned `ctx.llm` adapter, browser-owned CPA client, or settings-file writer |
| official `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6` | DSH `ctx.llm` | provide the only model adapter and consume Gateway's provider profile | a custom adapter, adapter subclass/replacement, or second model transport |
| `gateway` | CPA HTTP data plane | configure the official route for one CPA HTTP call, with normalized streaming and abort policy | a Go SDK embed, a TypeScript CPA rewrite, or a RESP client |
| `runtime` | `gateway` | publish one ready managed endpoint and lifecycle status | a second provider implementation or account router |
| `runtime` | one `platform-*` package | select an already installed, exact OS/CPU executable | a network installer or postinstall hook |
| `analytics` | `gateway` | receive terminal timing events and Host-only sanitized usage/quota/health projections | request/response body capture or a model retry loop |
| `analytics` | CPA HTTP usage queue | destructively pop usage with one explicit consumer, normalize before commit, and report at-most-once/crash-loss/completeness state | an acknowledgement protocol, exactly-once claim, RESP, a hidden competing consumer, or account control |
| `analytics` | Node built-ins | `DatabaseSync`, `Worker`, WAL, HMAC/SHA-256, UTC time | an ORM, server database, Redis, or CPAMP control plane |
| `pack` | package tarballs and dsh-webpage | ordinary ordered profile composition | a super-plugin, package resolver, or installer |
| `fake-cpa` | gateway tests | deterministic health/model/stream/error responses | a fake package registry or production fallback |

## Exact capability boundaries

### Gateway data plane

Gateway configures the official exact `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6`
route for a configured external endpoint without runtime or analytics. The
endpoint and route policy live in DSH settings; secret values are resolved
from DSH credentials at operation time. Model discovery uses the public
data-plane model surface when available and treats the result as an advisory
catalog. Management availability is reported separately from data-plane
availability. Gateway implements no `ctx.llm` adapter; the official package is
the only adapter on the request path.

One official adapter invocation is one provider attempt. The official adapter
may perform a bounded retry only for a pre-chunk transport failure where no
upstream response has started. Once a stream has emitted a chunk, a failure is
terminal and is not replayed. DSH does not select CPA accounts, reset upstream
quotas, refresh provider OAuth, or rotate credentials. Those behaviors remain
the selected upstream gateway's boundary except for the bounded Host-side CPA
OAuth entrypoints specified below; Phase 0 does not duplicate the provider
lifecycle.

The browser receives only sanitized Host Remote results. It never receives a
management key, proxy key, raw upstream headers, auth files, request bodies,
or arbitrary Management API method access. An App is a view over the Host
contract and cannot bypass the official `ctx.llm` path for model traffic.

### Host OAuth, account health, and quota

Host-side CPA OAuth is in scope for v0.1. The Host exposes the Codex device
flow and a conditional local callback flow through typed operations. The local
callback is allowed only when the Host has a trusted server-derived request-
origin seam that independently reports the origin hostname as exactly
`localhost` or `127.0.0.1`, and the selected CPA release proves a loopback-only
listener. A browser-supplied page-origin claim is never sufficient and is not
trusted for this gate.
Gateway-owned token storage is deferred. Remote callback OAuth and duplicate
provider lifecycle (login, refresh, account selection, or failover) are
deferred; CPA remains the provider lifecycle owner. No OAuth code, token,
auth-file path, or raw CPA response crosses the Client boundary.

Account health has one strict Host-side source: `GET
/v0/management/auth-files`. The Host emits only a bounded redacted projection
containing provider, installation-scoped account hash, normalized health
status, bounded reason, and observation time. It discards raw fields,
authIndex, filenames/paths, keys, tokens, and arbitrary JSON. Unsupported,
missing, malformed, or unauthorized input becomes `unsupported` or
`unavailable`; it never becomes fabricated healthy or zero-valued health.

Quota has one Host-internal Codex read adapter. It may call CPA `POST
/v0/management/api-call` only with this fixed payload, where every angle-
bracketed value is resolved by Host policy and is not client input:

```json
{
  "authIndex": "<selected from the internal allowlisted auth-file inventory>",
  "method": "GET",
  "url": "https://chatgpt.com/backend-api/wham/usage",
  "headers": {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "<fixed Gateway User-Agent>",
    "Chatgpt-Account-Id": "<optional selected internal account>"
  }
}
```

The optional account header is omitted when no selected internal account
supplies it. The Host validates a strict size/schema projection into quota
windows and discards the raw response. There is no generic client `/api-call`
remote and no user-controlled authIndex, URL, method, header, or body. Other
providers report `unsupported` or `unavailable`; the Host never fabricates
quota.

### Optional managed runtime

When `mode=managed`, `runtime` must:

1. resolve the matching optional platform package already installed in the
   release envelope;
2. create/use `<DSH_HOME>/dsh-gateway/v1/runtime/cpa/` with private permissions;
3. bind the child to loopback and the persisted configured port (default
   `8317`);
4. pass explicit argv and a scrubbed environment through DSH process services;
5. wait for a bounded health response before reporting ready; and
6. terminate and join the complete process tree on disposal.

If any step fails, managed mode is unavailable with a diagnostic. The official
adapter does not silently switch to another binary, download an asset, rotate
a credential, or change the external endpoint. External mode remains
available when configured.

The runtime manager is the single DSH writer for its CPA `config.yaml` and
private state subtree. A manual CLIProxyAPI panel, a second manager plugin,
or a browser request must not concurrently edit it. Management writes, if
ever enabled by a later accepted scope, must be serialized by that manager and
allowlisted; Phase 0 exposes no remote administrative write feature.

### Optional analytics

`gateway` emits a bounded, allowlisted `gateway/request-completed` event after
the request reaches a terminal result. The event retains route/provider/model,
outcome, `time_to_first_token_ms`, `duration_ms`, request units, and a stable
correlation identity. The v0.1 collector enriches that request from CPA's HTTP
usage queue with available input/output/cache-read/cache-write/reasoning token
counts plus irreversible `account_id_hash` and `api_key_id_hash` dimensions.
It also records read-only sanitized quota and account-health snapshots. The
quota source is the Host-internal fixed Codex adapter above; account health is
the strict redacted `/v0/management/auth-files` projection above.

For a managed CPA, the DSH analytics collector is the sole HTTP queue
consumer. CPA `GET /usage-queue` destructively pops an item and provides no
acknowledgement. The collector therefore pops before normalization/commit;
collection is at-most-once and a crash after pop but before commit can lose the
item. The collector reports queue delivery as `at_most_once` and exposes
completeness as `unknown`, `competition_possible`, or `crash_loss_possible`,
with collector status `healthy`, `degraded`, `unavailable`, or `disabled`.
It never claims exactly-once or complete history. Collection from an external
CPA is disabled by default and requires an explicit opt-in plus a competition
warning: another consumer can split the queue and make the Dashboard
incomplete. RESP is unsupported. No raw key, auth index, token value, prompt,
image, output, auth file, refresh token, or raw Management response enters
worker messages or SQLite.

One `DatabaseSync` worker performs dedupe/enrichment, dead-letter writes, raw
30-day detail, one-year hourly and daily rollups, pricing snapshots, quota and
account-health history, and P50/P95 latency buckets. Worker failure, queue
pressure, destructive-pop crash-loss detection, migration failure, or database
unavailability marks analytics degraded and never changes the model request
result. A sanitized dead-letter can be retried after commit, but the popped
CPA queue item itself cannot be re-acknowledged or replayed by the collector.

The analytics contract is specified in
[analytics-data-model.md](analytics-data-model.md). Its Dashboard supports
request/success-rate, token, estimated-cost, latency, dimension, recent
sanitized detail, account-health, and quota-history reads. It is not a provider
invoice, credential ledger, account router, quota-reset mechanism, or cooldown
controller.

## Build order and gates

The dependency order is also the Phase 0 implementation order:

1. **Freeze the gateway wire contract.** Define the official
   `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6` provider profile/config/settings,
   model normalization, error classes, abort behavior, event envelope,
   credential references, OAuth operations, fixed Codex quota adapter, strict
   account-health projection, and sanitized remote methods. Build against
   exact rc.6 types; do not implement a Gateway `ctx.llm` adapter.
2. **Build `fake-cpa`.** Cover model listing, streamed text, terminal errors,
   malformed responses, abort, pre-/post-chunk failures, destructive
   `GET /usage-queue` with no ack, pop-before-commit crash loss, token
   categories, hashed-dimension inputs, fixed Codex `/api-call` rejection of
   client parameters, strict auth-files/quota projections, and
   unsupported/unavailable states. The fixture is an ordinary local HTTP
   server. It does not implement RESP, account rotation/cooldown actions,
   registry discovery, or provider policy.
3. **Build `gateway`.** Prove external endpoint mode against the fixture and
   an already-running endpoint. Prove that the exact official
   `dsh-llm-pi-ai` package supplies the `ctx.llm` adapter, the Gateway only
   owns profile/config/settings, and no custom adapter or alternate model
   transport is present. Prove device OAuth and gated local callback flow
   through Host operations, with Gateway token storage deferred.
4. **Build `runtime`.** Prove explicit argv, readiness timeout, process-tree
   disposal, private state ownership, and missing-platform diagnostics with a
   harmless child before testing a CPA binary. Then validate the pinned
   v7.2.131 asset for each supported OS/CPU artifact.
5. **Build `analytics`.** Implement HTTP-only collector modes, destructive
   at-most-once queue consumption with pop-before-commit loss accounting,
   explicit completeness/degraded statuses, worker protocol, migration `1`,
   WAL, irreversible dimensions, cross-source dedupe/enrichment, dead letters,
   immutable build-time pricing snapshots, request/token-category pricing
   event snapshots, 30-day raw detail, one-year hourly/daily rollups, latency
   percentiles, strict quota/account-health history, and retention
   maintenance. Run it with the fixture and with analytics absent.
6. **Build the browser contribution and `pack`.** The optional App consumes
   Host Remotes and existing Webpage slots. The flagship Pack patch composes
   DSH base, Webpage, gateway, runtime, and analytics as required rows; users
   who want only external mode install gateway/Webpage without that Pack. The
   Pack contains no executable orchestration.
7. **Assemble release artifacts.** Pack all packages from a clean checkout,
   generate the public Pack `./package.json` with exact immutable GitHub Release
   tarball URLs (including dsh-webpage `v0.1.0` and six optional platform
   packages), record release URL/version/SHA-256 provenance, generate a local
   test manifest with `file:` overrides, and run one `dsh plugin add`. Verify
   no npm registry or runtime activation download. The release must work with
   the complete flagship Pack and, separately, with the gateway/Webpage-only
   external-mode composition.

No step may reverse these edges by making gateway import runtime/analytics,
making analytics open a database in the Host thread, or making Pack implement
installation policy.

## Capability-to-package acceptance map

| Acceptance behavior | Required package path | Evidence required |
| --- | --- | --- |
| External CPA works without managed process | `gateway` + DSH rc.6 | fake-cpa/real-sidecar adapter test; no `runtime` import or binary |
| Gateway remains usable with analytics omitted | `gateway` only | clean profile with no analytics package and successful stream |
| Managed local CPA is optional | `gateway` + `runtime` + matching platform | readiness, hash, loopback, disposal, and missing-asset tests |
| Analytics is optional and non-blocking | `gateway` + optional `analytics` | worker failure/backpressure test leaves model result unchanged |
| HTTP collection has one explicit consumer | `analytics` + gateway Host collector | managed sole-consumer test; external opt-in and competition warning; RESP rejected |
| Sanitized analytics retain approved metadata | `analytics` schema/read model | token/dimension/pricing/latency/recent-detail/account-health/quota fixtures; forbidden-content scan |
| Analytics retention is complete | `analytics` maintenance | raw 30 days; hourly/daily/quota/account-health one year; DLQ policy |
| Pack is ordinary DSH composition | `pack` + existing DSH loader | `dump-config`/profile evidence shows ordered plugin rows, no resolver |
| No network installation | release envelope | offline install; no lifecycle scripts; missing asset is a diagnostic |
| No duplicate state writers | runtime/analytics ownership rules | concurrent-writer and worker-only SQLite checks |
| No raw sensitive content in analytics | `gateway` event + `analytics` schema | schema/query scan and fixture event assertion |

## Deferred or rejected edges

These are not dependencies waiting to be invented in Phase 0:

- CLIProxyAPI Go SDK embedding and a TypeScript rewrite;
- Gateway-owned token storage, remote callback OAuth, account pooling, account
  rotation, and hidden provider failover; bounded Host-side CPA device login
  and the fail-closed local callback operation remain v0.1 scope;
- RESP usage ingestion; v0.1 supports only the CPA HTTP usage queue;
- concurrent managed/external queue consumers, silent external collection, or
  completeness claims after a queue-competition warning;
- upstream Management API proxying, quota reset, arbitrary config/auth writes,
  account rotation/cooldown actions, dynamic native plugins, panel
  auto-update, or remote admin by default;
- a fake registry, marketplace, npm publication, postinstall downloader,
  package resolver, super-plugin, or second extension system;
- a CPAMP Manager server, CPAMP SQLite control plane, or CPAMP UI copy;
- generic persistence, ACL, Space, federation, CRDT, Supervisor, or resource
  abstractions not exercised by the concrete gateway slice.

## License and provenance boundary

CLIProxyAPI `v7.2.131` is an upstream MIT-licensed executable asset. Each
platform package must carry its upstream notice and exact provenance; the DSH
package license and any other dependencies remain separately attributable.

CPAMP `v1.12.0-rc.2` is not a dependency. It is a UX and Management API
reference for usage, account-health, and quota presentation. Its MIT license
covers CPAMP implementation material only if that material is copied and its
notice is preserved. Schema version 1, the collector, rollups, pricing model,
dead letters, and Dashboard queries are independently specified here; the
Phase 0 release copies no CPAMP code, SQL/schema text, assets, API paths,
server, installer, or UI. The CPAMP reference cannot be used as a blanket
license for CLIProxyAPI, provider OAuth/account use, DSH code, or third-party
UI assets.
