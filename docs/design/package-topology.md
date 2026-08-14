# dsh-gateway package topology

Status: Phase 0 design freeze.

This repository is a private, docs-first design for an out-of-tree DSH gateway
distribution. The implementation target is DSH `0.1.0-rc.6`, Node
`^22.19.0 || >=24.0.0`, and pnpm `11.7.0`. The reference artifacts are
`@wha1echai/dsh-webpage@0.1.0`, CLIProxyAPI `v7.2.131`, and CPAMP
`v1.12.0-rc.2`.

The product boundary is an ordinary DSH host plugin that owns a CPA provider
profile, its configuration, and its settings, while the official
`@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6` package owns the `ctx.llm` transport.
Model traffic goes over HTTP to either an explicitly configured external CPA
endpoint or an optional DSH-managed local CPA process. The external endpoint
path is the baseline. Runtime management and analytics must be absent without
making the baseline gateway unusable.

## Workspace shape

```text
dsh-gateway/
├── packages/
│   ├── gateway/                         # @wha1echai/dsh-gateway
│   ├── runtime/                         # @wha1echai/dsh-gateway-runtime
│   ├── analytics/                       # @wha1echai/dsh-gateway-analytics
│   ├── pack/                            # @wha1echai/dsh-gateway-pack
│   ├── platform-win32-x64/              # pinned CPA asset
│   ├── platform-win32-arm64/            # pinned CPA asset
│   ├── platform-darwin-x64/             # pinned CPA asset
│   ├── platform-darwin-arm64/           # pinned CPA asset
│   ├── platform-linux-x64/              # pinned CPA asset
│   └── platform-linux-arm64/            # pinned CPA asset
├── fixtures/
│   └── fake-cpa/                        # private deterministic HTTP fixture
└── docs/
    └── design/
```

The six platform directories are package artifacts, not six alternative
implementations. `fixtures/fake-cpa` is a test fixture and is never a DSH
plugin, release asset, registry, or runtime fallback.

## Package roles and boundaries

| Package | Lifecycle unit | Owns | May be absent? | Release payload |
| --- | --- | --- | --- | --- |
| `gateway` | installable DSH host plugin; optional `dsh.client` contribution | CPA provider profile/config/settings, model discovery, DSH settings/credentials integration, sanitized Host Remotes, request-completed event | No for the gateway product | Yes |
| `runtime` | optional DSH host plugin | managed CPA process, readiness, private runtime state, platform executable selection, disposal | Yes; external mode remains usable | Yes |
| `analytics` | optional DSH host plugin plus collector/worker entry | gateway-event and HTTP-usage collection, irreversible dimensions, WAL database, raw/hourly/daily/DLQ/quota/health maintenance, Dashboard reads | Yes; no collector or database is started | Yes |
| `pack` | ordinary `dsh.bundle` patch | ordered composition of compatible package rows and safe defaults | The packages it names are installed separately by the existing DSH mechanism | Yes |
| `platform-*` | no DSH lifecycle; Node package data only | one exact CPA executable, provenance, checksum, and notices for one OS/CPU pair | Yes on non-matching hosts; missing matching asset disables managed mode | Yes |
| `fake-cpa` | test process only | deterministic HTTP data-plane, destructive usage-queue, quota, and health responses | Not part of product runtime | No |

`gateway` is the only required product package. Its host side owns and persists
the CPA provider profile/configuration through the public DSH settings seam and
hands that profile to the official `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6`
plugin. Gateway does not implement, register, or replace a `ctx.llm` adapter.
Its optional browser contribution may render a Gateway App through the
existing `dsh-webpage` slots, but the App is never the provider and never
calls CPA directly. Model requests always traverse the official
`dsh-llm-pi-ai` adapter.

`runtime` depends on the concrete gateway runtime registration supplied by
`gateway`; `gateway` does not import `runtime`. In external mode the adapter
uses the configured endpoint. In managed mode it requires the runtime package
to publish a ready local endpoint. There is no generic resolver, provider
registry, or unused abstraction layer between these two packages.

`analytics` consumes the concrete `gateway/request-completed` event and, when
enabled, CPA's v0.1 destructive HTTP usage queue plus Host-only allowlisted
quota/health projections. A `GET /usage-queue` pops an item before analytics
can commit it, so collection is at-most-once and has a crash-loss window.
Analytics exposes that delivery/completeness limitation and degraded state; it
never claims exactly-once or complete history. It retains token-category counts
and irreversible account/API-key dimensions while excluding request/model
content and auth material. The gateway never imports `node:sqlite` and never
waits for analytics to complete.
The analytics worker is a reporting/metering observer, not a provider retry,
account rotation/cooldown actor, or quota gate.

For a managed CPA, the analytics collector is the sole HTTP queue consumer.
`GET /usage-queue` is destructive and has no acknowledgement operation: the
collector pops first, then validates/projects and commits. A process crash
after the pop and before the commit loses that item. Collection is therefore
at-most-once, pop-before-commit, and explicitly marked incomplete/degraded
when the loss window, queue competition, malformed items, or worker failure is
possible. Collection from an external CPA is disabled by default and requires
explicit operator opt-in after a competition warning. Managed and external
collectors must not consume the same queue concurrently. RESP is not a
supported collector transport.

## Required and optional DSH integration

All DSH artifacts are exact `0.1.0-rc.6` dependencies. The implementation may
depend only on the public rc.6 surfaces needed by the package:

- `gateway`: exact model-transport dependency
  `"@deepseek-ai/dsh-llm-pi-ai": "0.1.0-rc.6"`, plus
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`,
  `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-api-remotes`,
  `@deepseek-ai/dsh-api-gateway`, and the compatible Cordis host surface;
- `runtime`: the rc.6 host process/path services and `gateway`; it must use
  DSH subprocess lifecycle semantics rather than shell commands;
- `analytics`: `gateway` event and Host-only collector contracts plus Node
  built-ins for HTTP, worker threads, `node:sqlite`, HMAC/SHA-256, and UTC time;
- the browser half: the exact rc.6 client runtime, slots, web React, and
  schema-form surfaces, plus `@wha1echai/dsh-webpage@0.1.0` as the Pack-level
  Web composition dependency.

No package embeds a second Cordis, DSH client runtime, React runtime, or Go
SDK. The gateway uses the HTTP sidecar contract; it does not embed the
CLIProxyAPI Go SDK and does not rewrite CLIProxyAPI in TypeScript.

The model-transport acceptance is strict: the gateway package manifest and
lockfile contain the exact official `@deepseek-ai/dsh-llm-pi-ai` version above;
the request trace reaches `ctx.llm` through that package; and no Gateway-owned
custom adapter, adapter subclass, adapter replacement, or alternate model
transport is present. Gateway owns only the provider profile/config/settings
that the official adapter consumes.

Every DSH client package exports both `./client` and `./package.json` from its
package root. The rc.6 `clientModules` discovery path must resolve the
`./package.json` export rather than a source checkout. The Gateway App uses the
stable ID `wha1echai.gateway` and the root-scoped routes
`/apps/wha1echai.gateway/*` (Accounts, Models, Requests, Playground, and
Settings); it does not claim a second route namespace or call CPA directly.

## Host OAuth, quota, and account-health scope

Host-side CPA OAuth is in scope for v0.1. The Host exposes the bounded Codex
device flow and a conditional local callback flow through typed operations. The
local callback is offered only when a trusted public server-derived
request-origin seam reports the origin hostname as exactly `localhost` or
`127.0.0.1` and the selected CPA release proves a loopback-only listener. The
client-reported hostname or origin is never authority for this gate and a
missing or untrusted server-derived origin fails closed. Device-flow
instructions and sanitized operation status may cross the Client boundary;
codes, tokens, auth-file paths, and raw CPA responses may not. Gateway-owned
token storage is deferred. Remote callback OAuth and a second/duplicate
provider lifecycle (login, refresh, account selection, or failover) are also
deferred; CPA remains the provider lifecycle owner.

Account health has one strict Host-side source in v0.1: `GET
/v0/management/auth-files`. The Host parses only a bounded redacted projection
(`provider_id`, installation-scoped `account_id_hash`, normalized health
status, bounded reason, and observation time). It never returns or stores the
raw response, auth index, filename/path, token, key, or arbitrary fields.
Missing, unsupported, malformed, or unauthorized source data produces
`unsupported` or `unavailable`; it never produces a fabricated healthy,
zero-quota, or complete result.

Quota has one Host-internal v0.1 adapter for Codex. It may call CPA `POST
/v0/management/api-call` only with this fixed, non-client-parameterized
payload:

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

The optional `Chatgpt-Account-Id` header is omitted when no selected internal
account supplies it. The Host owns auth-file inventory selection; clients
cannot provide `authIndex`, method, URL, headers, or body. The response is
validated against a strict size/schema projection into quota windows, then the
raw response is discarded and is never returned or stored. There is no generic
client `/api-call` remote, no user-controlled URL/method/header/body, and no
quota-reset or account-mutation operation. Other providers report
`unsupported` or `unavailable` and never fabricate quota.

## State directories and ownership

`DSH_HOME` is the host-selected DSH state root. The gateway uses this exact
subtree:

```text
<DSH_HOME>/dsh-gateway/v1/
├── runtime/
│   └── cpa/
│       ├── config.yaml
│       ├── auth/
│       ├── run/
│       └── logs/
└── analytics/
    ├── usage.sqlite3
    ├── usage.sqlite3-wal
    └── usage.sqlite3-shm
```

Ownership is deliberately narrow:

1. DSH owns its settings and credentials stores. `gateway` reads and updates
   them through DSH APIs; it does not edit the settings file directly.
2. `runtime` owns `<DSH_HOME>/dsh-gateway/v1/runtime/cpa/` in managed mode. Its
   supervisor and its CPA child are one logical owner. The supervisor is the
   only DSH writer of `config.yaml`; the child may read/reload it and write
   its own auth/runtime files as part of that owned process boundary. A second
   DSH plugin, browser, manual panel, or external manager must not write this
   directory concurrently.
3. `analytics` owns the SQLite file and its `-wal`/`-shm` siblings. Exactly
   one analytics worker opens the database read/write. The Host, Gateway App,
   runtime, collector client, and test processes use worker messages and never
   open the file. The installation HMAC key lives in DSH credentials, not this
   directory.
4. External sidecar mode owns no CPA state directory. It only stores an
   endpoint policy and credential references in DSH-managed stores.
5. The fixture uses a disposable test temporary directory and cannot resolve
   a production state path.

The managed collector lease is also single-owner state. One analytics package
instance consumes the managed CPA HTTP usage queue. External CPA queue
collection is opt-in and marks completeness as uncertain when another
consumer may compete; it never starts alongside the managed collector for the
same target.

Managed mode binds CPA to loopback and uses the Host-owned persisted port,
defaulting to `8317`; an alternate port must be saved before spawn. The
management key is kept in DSH credentials/Host memory; no key is
returned to the browser, persisted in `settings`, placed in a URL, or written
to analytics. Remote mode requires an explicit administrator-approved origin,
TLS, and a Host-side credential allowlist; it is not the managed default.

## Platform packages and binary provenance

The packed `runtime` manifest declares all six platform packages as immutable
GitHub Release URL `optionalDependencies`. Each platform package also declares
its `os` and `cpu` filters so the package manager can skip non-matching assets.
The source workspace uses exact workspace edges, and the release generator
rewrites them to the URLs frozen below; neither form permits a registry range.

| Package | `os` | `cpu` | Payload |
| --- | --- | --- | --- |
| `@wha1echai/dsh-gateway-platform-win32-x64` | `win32` | `x64` | `CLIProxyAPI_7.2.131_windows_amd64.zip`; managed config disables dynamic plugins |
| `@wha1echai/dsh-gateway-platform-win32-arm64` | `win32` | `arm64` | `CLIProxyAPI_7.2.131_windows_aarch64.zip`; managed config disables dynamic plugins |
| `@wha1echai/dsh-gateway-platform-darwin-x64` | `darwin` | `x64` | `CLIProxyAPI_7.2.131_darwin_amd64.tar.gz`; managed config disables dynamic plugins |
| `@wha1echai/dsh-gateway-platform-darwin-arm64` | `darwin` | `arm64` | `CLIProxyAPI_7.2.131_darwin_aarch64.tar.gz`; managed config disables dynamic plugins |
| `@wha1echai/dsh-gateway-platform-linux-x64` | `linux` | `x64` | `CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz` only |
| `@wha1echai/dsh-gateway-platform-linux-arm64` | `linux` | `arm64` | `CLIProxyAPI_7.2.131_linux_aarch64_no-plugin.tar.gz` only |

The frozen v7.2.131 digest evidence comes from the upstream release asset
[`checksums.txt`](https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.131/checksums.txt).
The six selected assets are pinned by these SHA-256 values; the release
manifest repeats the literal upstream asset name, source release URL, target
OS/CPU, and digest:

| Selected upstream asset family | SHA-256 |
| --- | --- |
| `CLIProxyAPI_7.2.131_darwin_aarch64.tar.gz` | `ec63a4f99da029ed04d8373c17152274d85f524c92c1b2da36b9c70cbadd0afe` |
| `CLIProxyAPI_7.2.131_darwin_amd64.tar.gz` | `3626c427ba0526f6d25d83063195bc418f5b242b108de0778d887e0b8de3323f` |
| `CLIProxyAPI_7.2.131_linux_aarch64_no-plugin.tar.gz` | `c82bd3dfb62da2ff567930d928c8aaf33f384917bdfc197f28ddbf7ff50509f3` |
| `CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz` | `a7e1127d10e908f37fa7bb5f5f4a9aebb26e5baca17c7bd92987df3a0bda9043` |
| `CLIProxyAPI_7.2.131_windows_aarch64.zip` | `a1e0023009493218a202e3e17cb7c51ae836e44b5ae67d0041f835e869477bfe` |
| `CLIProxyAPI_7.2.131_windows_amd64.zip` | `99cc6a185012f01396e2bad3f3ba902bf1455e82fa1630d652ab818b77ed2384` |

Linux platform artifacts must use only the literal upstream `*_no-plugin`
asset names. Windows and macOS artifacts must use the literal standard
upstream asset names, not renamed or guessed variants; their managed CPA
configuration must set the exact upstream field `plugins.enabled: false`.
Managed configuration applies that field on all six platforms, including the
Linux no-plugin builds as defense in depth. Each platform
artifact must contain exactly one executable plus:

- a provenance record with upstream repository, tag `v7.2.131`, release URL,
  literal upstream asset name, source commit when supplied by the release,
  target OS/CPU, and SHA-256;
- the upstream license/notice files and the DSH package README;
- an explicit statement of the platform rule above and the managed
  configuration value `plugins.enabled: false`.

The release gate rejects a missing literal asset name, a floating tag, a
runtime-downloaded checksum, an enabled dynamic plugin setting, or an
executable whose digest is not in the release manifest. Platform packages
contain no JavaScript install hook and no network client. `runtime` reports
“matching binary not installed” and remains inactive if its optional platform
dependency is unavailable; it does not download, extract, replace, or update
anything during activation.

## Build and release artifact rules

The repository is distributed through GitHub Release artifacts only. There is
no npm publication, no npm registry dependency, and no package-hub or fake
registry. `pnpm pack` may be used in CI to create deterministic `.tgz` files,
but `publish` is forbidden and the release is not discoverable through npm.

The release envelope contains package tarballs, a release manifest, a complete
SHA-256 file, and third-party notices. It is the only supported source for the
six platform packages and the Pack. A clean verification environment must be
able to install from those local tarballs without network access.

Every Node package has an explicit `files` allowlist. The allowlists contain
only built JavaScript, declarations, required DSH manifests/patches,
README/license files, and (for `runtime`) provenance metadata. No source
checkout, test fixture, SQLite database, auth file, log, or local absolute
path may enter a release tarball. All package dependency versions are exact;
workspace ranges are rewritten to sibling release artifacts before packing.

The release gate also checks the client package manifests: each package that
contributes `dsh.client` has a built `exports["./client"]` entry and an exact
`exports["./package.json"]` entry. The rc.6 Loader/client-module discovery
must resolve those exports from the packed package. The Gateway client entry
registers the `wha1echai.gateway` App and its
`/apps/wha1echai.gateway/*` route contribution; it does not take over the
shell root or create an independent browser transport.

The following package scripts are forbidden in every manifest: `preinstall`,
`install`, `postinstall`, and any equivalent lifecycle hook. Activation is
side-effect free except for an explicit user-selected managed-runtime start.
That start must use an already installed, hash-verified executable, explicit
argv, a private state directory, readiness timeout, process-tree disposal,
and an auditable version identity.

### One-install Pack manifest

The public preview Pack is installed with exactly:

```text
dsh plugin --profile <name> add https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-pack-0.1.0.tgz
```

Its release
`./package.json` contains immutable GitHub Release asset URLs, never registry
semver ranges or workspace references. The URL and version are fixed as
follows; the release manifest additionally records the SHA-256 for every URL:

```json
{
  "dependencies": {
    "@wha1echai/dsh-webpage": "https://github.com/Wha1eChai/dsh-webpage/releases/download/v0.1.0/wha1echai-dsh-webpage-0.1.0.tgz",
    "@wha1echai/dsh-gateway": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-0.1.0.tgz",
    "@wha1echai/dsh-gateway-runtime": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-runtime-0.1.0.tgz",
    "@wha1echai/dsh-gateway-analytics": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-analytics-0.1.0.tgz"
  }
}
```

The packed runtime manifest owns platform selection transitively:

```json
{
  "optionalDependencies": {
    "@wha1echai/dsh-gateway-platform-win32-x64": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-platform-win32-x64-0.1.0.tgz",
    "@wha1echai/dsh-gateway-platform-win32-arm64": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-platform-win32-arm64-0.1.0.tgz",
    "@wha1echai/dsh-gateway-platform-darwin-x64": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-platform-darwin-x64-0.1.0.tgz",
    "@wha1echai/dsh-gateway-platform-darwin-arm64": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-platform-darwin-arm64-0.1.0.tgz",
    "@wha1echai/dsh-gateway-platform-linux-x64": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-platform-linux-x64-0.1.0.tgz",
    "@wha1echai/dsh-gateway-platform-linux-arm64": "https://github.com/Wha1eChai/dsh-gateway/releases/download/v0.1.0/wha1echai-dsh-gateway-platform-linux-arm64-0.1.0.tgz"
  }
}
```

Both exact manifests are generated for local tests with `file:` tarball
overrides for every sibling URL. Those generated test manifests are
disposable and must not enter public tarballs or replace the release
manifests. The one-install gate runs one `dsh plugin add` against the Pack and
proves that Pack dependencies and the runtime's transitive platform selection
use the listed release assets, with no npm registry lookup, lifecycle
download, or runtime activation download. The release provenance record
stores package name, URL, version, source release, and SHA-256 for
`dsh-webpage`, every Gateway package, and all six platform packages.

## Pack composition

`@wha1echai/dsh-gateway-pack` is an ordinary `dsh.bundle` package. Its patch
uses existing DSH profile/bundle composition in this order:

```text
DSH base / host services
  -> @wha1echai/dsh-webpage@0.1.0
  -> @wha1echai/dsh-gateway@0.1.0
  -> @wha1echai/dsh-gateway-runtime@0.1.0
  -> @wha1echai/dsh-gateway-analytics@0.1.0
```

The Pack has no loader, resolver, installer, supervisor, registry, or
long-lived process of its own. The flagship Pack installs runtime and
analytics as ordinary required package dependencies, while each remains a
separately removable plugin outside the Pack; only the six mutually exclusive
platform packages use `optionalDependencies` plus `os`/`cpu` selection.
Installing only the gateway row gives a working external endpoint mode.
Installing
runtime does not opt into OAuth, remote administrative writes, upstream
dynamic plugins, or automatic updates. Installing analytics creates its
database only after its worker is explicitly activated. Managed CPA collection
then owns the HTTP usage queue; external CPA collection still requires the
separate competition-warning opt-in.

## Explicitly outside this topology

The Phase 0 shape has no fake package registry, npm publication, lifecycle
download, postinstall, upstream auto-update, Redis RESP consumer, account
rotation/account pool/cooldown action, hidden model retry scheduler, remote
admin write surface, dynamic native plugin loader, CPAMP Manager server, or
second storage/control plane. Analytics uses only the v0.1 HTTP usage queue;
CLIProxyAPI remains behind its HTTP boundary and its provider-specific account
refresh/failover remains upstream.

CPAMP `v1.12.0-rc.2` is a UX and Management API reference only. No CPAMP
server, collector, SQLite control-plane schema/SQL, root API path, localStorage
credential handling, installer, Dashboard code, or UI asset is included. If a
later change copies a CPAMP source fragment, it must record the exact source
revision and preserve the CPAMP MIT copyright/license notice in the artifact
containing that fragment. That notice applies only to the copied CPAMP
material; it does not license the independently specified analytics schema,
CLIProxyAPI binaries, provider integrations, DSH code, or third-party assets.
The initial release copies none, so it has no CPAMP attribution beyond this
boundary record.
