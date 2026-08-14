# Phase 2A `llm-pi-ai` compatibility evidence

Status: Complete / GO on 2026-08-14.

Command:

```text
corepack pnpm@11.7.0 run test:llm-compat
```

The verifier loaded the built public `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6`,
`@deepseek-ai/dsh-llm`, and `@deepseek-ai/dsh-attachment-local` packages through
the real Cordis Loader. One fake CPA route then observed:

- a completed text request;
- a tool call followed by its correlated tool result;
- ordered `stream-A`, `|stream-B` deltas;
- zero outbound requests when a text-only model received an image;
- one `data:image/png` request for an explicitly image-enabled model;
- one aborted, incomplete CPA request after `AbortSignal` cancellation.

`pnpm test:public-api`, `pnpm typecheck`, and `pnpm lint` also passed. No custom
LLM adapter or product runtime code was added.
