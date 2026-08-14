# Phase 6 evidence — packed public preview

- Status: Complete / GO
- Date: 2026-08-14
- Environment: Windows 11 x64; Node 24.11.1; pnpm 11.7.0; DSH
  0.1.0-rc.6; dsh-webpage 0.1.0; CLIProxyAPI 7.2.131

## Delivered acceptance

- The ordinary Gateway Pack installs into a repository-external disposable
  DSH profile from generated tarballs and resolves all package roots inside
  that profile.
- The real root-path Web App passes direct routes, deep links, reload,
  back/forward navigation, all six Gateway views, conversation DOM identity,
  model discovery/apply, text probe, opaque image upload, and image probe.
- Client HMR atomically replaces the Gateway bundle without a document reload,
  duplicate App/Remote registration, stale timers, or loss of the unrelated
  Webpage Inspector. A deterministic render crash is contained by the owning
  slot and the next replacement recovers.
- Package security checks cover all 10 release tarballs and 182 source files.
  The six pinned CPA binaries retain platform metadata, upstream license,
  source URL, and SHA-256 provenance.

## Verification

```text
corepack pnpm@11.7.0 pack:verify
corepack pnpm@11.7.0 test:security
corepack pnpm@11.7.0 test:browser
corepack pnpm@11.7.0 test:hmr
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:clean-checkout
corepack pnpm@11.7.0 verify
```

Observed results:

- fake CPA 12/12; aggregate Vitest 90/90; analytics 28/28; focused
  quota/client 23/23;
- official `llm-pi-ai` text, tools, ordered streaming, explicit image input,
  and abort passed on the real rc.6 path;
- packed install, exact 18-endpoint Loader integration, real Windows CPA
  7.2.131 smoke, and package security checks passed;
- Browser passed with no page or console errors and no image base64 in DOM,
  URL, localStorage, or sessionStorage;
- HMR passed replacement, crash containment, recovery, graph uniqueness, and
  lifecycle cleanup without navigation or document reload;
- clean source checkout verification passed for 182 files. The durable log is
  `.staging/reports/phase1-clean-checkout.log`; packed-install evidence is
  `.staging/reports/phase1-packed-install.log`.

The clean-checkout lane found and drove two portability fixes before GO: the
browser image fixture is now embedded instead of borrowed from an adjacent
Harness checkout, and HMR now reuses this repository's packed Browser harness
instead of a dsh-webpage source helper. A Loader fixture was also updated to
load the attachment service required by the image-upload Remote.

## Gate decision

GO. Phase 6 is self-contained, repository-external, root-path-only, and uses
ordinary DSH Plugin/Bundle composition. No npm package has been published.
The next action is the GitHub preview prerelease and public Discussion.
