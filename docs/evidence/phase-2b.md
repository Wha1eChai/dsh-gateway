# Phase 2B runtime and CPA client evidence

Status: Complete / GO on 2026-08-14.

Implemented:

- managed/external runtime state machine, verified binary installation, owner
  lock, readiness, crash/stop/restart, and Cordis fiber disposal;
- `ctx.cpaRuntime` as the single optional managed runtime owner;
- exact `-config` CPA argv and private loopback YAML;
- proxy and management credential re-resolution on every managed start, with
  channel separation and private config cleanup;
- typed real CPA allowlist for health, models, auth-files, quota, and the
  destructive management usage queue;
- per-operation Gateway credential resolution without a client singleton.

Verification:

```text
pnpm test:unit        # 28 passed
pnpm test:integration # real CPA PASS
pnpm test:public-api  # rc.6 public boundary PASS
pnpm typecheck
pnpm build
pnpm test:supply-chain
pnpm test:security
```

The real integration result was:

```json
{"status":"PASS","platform":"win32-x64","cpaVersion":"7.2.131","models":0,"authFiles":0,"usageQueue":0}
```

No custom LLM adapter, generic Management API proxy, OAuth HTTP fiction, or
persisted secret-bearing snapshot was introduced.
