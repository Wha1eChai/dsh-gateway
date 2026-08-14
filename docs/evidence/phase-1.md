# Phase 1 workspace and supply-chain evidence

Status: Complete / GO. Independent Luna and Sol reviews accepted on 2026-08-14.

## Environment

- Date: 2026-08-14
- OS/architecture: Windows 11 x64
- Node.js: 24.11.1
- pnpm: 11.7.0
- DSH: 0.1.0-rc.6
- dsh-webpage artifact: 0.1.0,
  SHA-256 `d7ebdd1ce65b456492eafc59b2775594dc117d263e5a1b1c0cbbe503cdcda421`
- CLIProxyAPI assets: 7.2.131, six targets pinned in
  `provenance/cli-proxy-api/assets.json`

## Reproducible commands

```text
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 run typecheck
corepack pnpm@11.7.0 run lint
corepack pnpm@11.7.0 run build
corepack pnpm@11.7.0 run test:unit
corepack pnpm@11.7.0 run test:public-api
corepack pnpm@11.7.0 run test:supply-chain
corepack pnpm@11.7.0 run pack:verify
corepack pnpm@11.7.0 run test:security
corepack pnpm@11.7.0 run test:clean-checkout
corepack pnpm@11.7.0 run verify
```

The clean-checkout command exports only non-ignored source files to a new
temporary Git repository, commits the snapshot, uses a new pnpm store, rebuilds
all six pinned platform packages from upstream release assets, and reruns the
Phase 1 aggregate. The nested aggregate explicitly disables recursive clean
verification. The temporary checkout is removed only after success.

## Assertions

- Twenty exact public DSH/Cordis packages resolve only from the checkout's
  installed `node_modules`; private paths, rc.5 references, floating DSH
  ranges, and adjacent `deepseek-harness` imports are rejected.
- Public and local-verification tarballs have identical members and bytes
  except for the declared immutable URL-to-`file:` dependency rewrite.
- The public release manifest records toolchain, Git revision/dirty state,
  source fingerprint, dependency edges, package digests, and nested CPA binary
  provenance. `SHA256SUMS` covers all ten release tarballs, the manifest, and
  NOTICE.
- The local envelope contains dsh-webpage and all ten Gateway tarballs. Its
  Pack installs with offline mode and an invalid registry in a repository-
  external temporary `DSH_HOME`.
- DSH `--dump-config` contains Webpage, Gateway, Runtime, and Analytics rows.
  The public rc.6 Cordis Loader loads/awaits/unloads all four packed Host
  entries, and the rc.6 ClientModuleSystem executes the packed Gateway client
  handoff.
- Exactly one matching OS/CPU package is installed. The other five do not
  resolve; the selected binary digest, provenance target, and upstream MIT
  license are rechecked from the installed profile.
- The Phase 1 security lane rejects lifecycle install scripts, unexpected
  registry dependencies, unsafe tar paths, unknown payload members, source
  maps, local protocols, absolute paths, and secret/content-bearing filenames.

## Generated evidence

The following evidence is intentionally ignored because it contains large
release payloads or machine-local temporary paths. The tracked scripts above
reproduce it:

- `.staging/release/v0.1.0/github/release-manifest.json`
- `.staging/release/v0.1.0/github/SHA256SUMS`
- `.staging/reports/phase1-packed-install.log`
- `.staging/reports/phase1-clean-checkout.log`

No npm publication or GitHub Release is part of Phase 1.
