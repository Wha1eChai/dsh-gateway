import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Stable client fiber name for HMR and diagnostics. */
export const name = '@wha1echai/dsh-gateway'

/** Phase 1 client entry intentionally contributes no UI before Host contracts exist. */
export function apply(_ctx: ClientContext): void {}

