# Phase 4 evidence — analytics

Date: 2026-08-14
Environment: Windows 11 x64; Node 24.11.1; pnpm 11.7.0; DSH 0.1.0-rc.6

## Result

Phase 4 is GO. The analytics companion is optional and failure-isolated. It
uses one worker-owned `node:sqlite` connection with WAL, a checksummed schema
v1 migration, receipt-based dedupe, dead letters, rollups, bounded read models,
retention, and sanitized health/quota projections. It is not on the model path.

## Verification

```text
corepack pnpm@11.7.0 run test:analytics
PASS: 4 files, 28 tests
PASS: built worker; requests=1; unpriced=1; schemaColumns=49

corepack pnpm@11.7.0 run test:quota
PASS: 3 files, 23 tests; fixed internal auth selection, fixed WHAM payload, bounded strict
projection, source polling, and unavailable/unsupported behavior

corepack pnpm@11.7.0 run pack:verify
PASS: exact analytics payload, generated Host Typert export, repository-external
offline Pack install, Host lifecycle, actual packed worker database, and worker asset resolution
```

The full current-phase aggregate passed with 11 fake-CPA and 83 Vitest tests,
real CPA v7.2.131 smoke, the 11-endpoint Loader check, packed worker startup,
and a clean 161-file checkout. A focused Luna review identified four P1 gate
defects; regression fixes now stop destructive dequeue after the first worker
write failure, enforce one collector lease, persist fractional Codex quota, and
return typed unavailable state. The browser Remote count remains 11 because
analytics has no browser API in this phase.

## Privacy and limitations

- Schema inspection found no prompt, image, output-content, authorization,
  credential, token-value, or auth-file columns.
- The random 256-bit installation HMAC key is held by DSH credentials.
- External queue collection is disabled unless explicitly opted in.
- CPA's destructive HTTP queue is at-most-once; completeness state reports the
  possible loss/competition instead of claiming exactly-once delivery.
- The immutable pricing snapshot is empty until a trusted source is adopted;
  token usage remains visible and cost is unpriced rather than fabricated.
- Browser analytics remotes and Dashboard rendering are Phase 5 work.
- Schema v1 has not been released; the pre-gate local schema checksum is not a
  supported migration source and can be removed with the disposable preview DB.
