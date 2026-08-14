# ADR 0005: Use one DSH_HOME owner and explicit subprocess lifecycle

- Status: Accepted
- Date: 2026-08-14

## Context

DSH has no automatic plugin-private data-directory service. Gateway runtime,
CPA auth/config files, release staging, and optional analytics need stable
ownership and cleanup. A managed CPA process must not inherit ambient secrets
or survive plugin disposal.

## Decision

The Gateway Host resolves the only `stateDir` as:

```text
stateDir = resolveDshHome()/dsh-gateway/v1
```

It creates and permission-checks the root once, derives child paths, and passes
those paths to companion roles. The managed CPA config has one writer. The
root coordinates at most one managed-runtime owner and at most one analytics
collector owner for that resolved DSH home; a second owner fails loud. The
runtime uses `@deepseek-ai/dsh-subprocess` with a `SubprocessSpawnSpec`
containing exactly `argv`, `cwd`, `stdio`, `graceMs`, and a scrubbed explicit
`env`. There is no subprocess `shell` field: the complete `argv` is passed
directly and is never shell interpreted. The child receives only explicit
managed bootstrap environment entries; no ambient parent secret is inherited.

Install is explicit, pinned, digest-verified, atomically staged, and
rollback-capable. Stop/unload terminates and joins the full process tree.

## Consequences

Runtime and analytics cannot silently create parallel state roots. External
mode does not claim ownership of CPA's existing state and remains usable when
both companions are absent. A process crash is reported and handled by bounded
policy; it does not trigger an unbounded restart or version rotation.

## Rejected alternatives

Rejected: package-name or current-working-directory state, an implicit plugin
data directory, shell command strings, a subprocess `shell` field, inherited
process environments, credentials in `argv`, and multiple writers to the same
CPA YAML.

## Verification gate

Lifecycle checks must assert the exact root, the exact spawn spec fields
(`argv`/`cwd`/`stdio`/`graceMs`/scrubbed explicit `env`), direct non-shell argv
execution, credential scrubbing, loopback readiness, and process-tree
disposal on normal unload and child failure. Cross-process checks must prove
second runtime and collector owners fail without replacing the active owner,
while an external-only profile acquires neither ownership.
