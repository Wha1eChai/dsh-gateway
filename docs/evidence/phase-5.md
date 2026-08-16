# Phase 5 evidence — native Gateway App

- Status: Complete / GO
- Date: 2026-08-14
- Environment: Windows 11 x64; Node 24.11.1; pnpm 11.7.0; DSH
  0.1.0-rc.6; dsh-webpage 0.1.0; CLIProxyAPI fixture pinned to 7.2.131

## Delivered behavior

- `dshapps.gateway` contributes Dashboard, Accounts, Models, Requests,
  Playground, and Settings through the existing `webpage.app` slot.
- Eighteen generated `gateway.*` Remotes expose only runtime control, model
  configuration, device OAuth, bounded analytics reads, image attachment
  upload, and the `ctx.llm` probe.
- The Playground supports text, the fixed safe tool declaration, explicit
  image-capable models, cancellation, and opaque DSH attachment refs.
- Model image capability survives discovery because the owned
  `llm-pi-ai.providers.cpa` route is re-read before presenting discovered
  models.
- Dashboard reads are optional and failure-isolated; closing the App stops its
  polling and leaves the existing conversation tree mounted.

## Verification

```text
corepack pnpm@11.7.0 test:unit
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 lint
node scripts/verify-phase3.mjs
$env:DSH_GATEWAY_PHASE6_REUSE_RELEASE='1'; node scripts/phase6-browser.mjs
```

Observed results:

- fake CPA: 11/11; aggregate Vitest: 90/90 after the attachment-injection
  regression;
- build, typecheck, lint, public API, supply-chain, and the built Loader path
  passed; the Loader exposed 18 Remote endpoints and unloaded cleanly;
- a real local DSH Web profile on port 3080 mounted the App and navigated all
  six routes without current page errors;
- the repository-external packed browser profile passed launcher/direct deep
  link/reload/back-forward, conversation DOM identity, model discovery/apply,
  text and image probes, opaque upload, no image base64 in DOM/URL/storage,
  stable optional-analytics states, and no page or console errors.

The browser lane first exposed a real missing Host dependency: the image
Remote accessed `ctx.attachments` without declaring `attachments` in the
plugin `inject` list. A focused regression was red before the fix and green
after it. The packed browser scenario then completed the original file-upload
path successfully.

## Gate decision

GO. Phase 5 does not add a browser-to-CPA transport, management proxy, custom
LLM adapter, or persistent prompt/image/output store. HMR, final aggregate,
and public preview publication remain Phase 6 work.
