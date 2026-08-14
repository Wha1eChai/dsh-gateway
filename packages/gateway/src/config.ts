import z from '@deepseek-ai/schemastery'

export const DEFAULT_CPA_ENDPOINT = 'http://127.0.0.1:8317'
export const DEFAULT_PROXY_CREDENTIAL_REF = 'DSH_GATEWAY_PROXY_KEY'
export const DEFAULT_MANAGEMENT_CREDENTIAL_REF = 'DSH_GATEWAY_MANAGEMENT_KEY'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Value-free Host configuration; secret values stay in ctx.credentials. */
export interface Config {
  readonly endpoint: string
  readonly allowExternalEndpoint: boolean
  readonly proxyCredentialRef: string
  readonly managementCredentialRef: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().default(DEFAULT_CPA_ENDPOINT),
  allowExternalEndpoint: z.boolean().default(false),
  proxyCredentialRef: z.string().pattern(CREDENTIAL_REF_PATTERN).default(DEFAULT_PROXY_CREDENTIAL_REF),
  managementCredentialRef: z.string().pattern(CREDENTIAL_REF_PATTERN).default(DEFAULT_MANAGEMENT_CREDENTIAL_REF),
})
