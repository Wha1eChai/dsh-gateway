import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials';

export type CpaErrorCategory =
  | 'configuration'
  | 'credential'
  | 'allowlist'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'http_status'
  | 'content_type'
  | 'invalid_json'
  | 'invalid_shape'
  | 'response_too_large'
  | 'unsupported';

export type CpaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CpaClientOptions {
  baseUrl: string;
  /** External hosts are rejected unless this opt-in is explicit. */
  allowExternalBaseUrl?: boolean;
  proxyApiKey?: string;
  managementKey?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: CpaFetch;
}

export type CpaClientBaseOptions = Omit<CpaClientOptions, 'proxyApiKey' | 'managementKey'>;

export type CpaClientOperation =
  | 'health'
  | 'probe'
  | 'models'
  | 'accountStatus'
  | 'authStatus'
  | 'quota'
  | 'dequeueUsage';

/** The public subset of ctx.credentials used by the per-operation client factory. */
export type CpaCredentialResolver = Pick<CredentialProvider, 'resolve'>;

export interface CpaCredentialRefs {
  proxyCredentialRef?: CredentialRef;
  managementCredentialRef?: CredentialRef;
}

export interface CpaRequestOptions {
  signal?: AbortSignal;
}

export type CpaEndpointMethod = 'GET' | 'POST';

export interface CpaEndpointDescriptor {
  readonly method: CpaEndpointMethod;
  readonly path: string;
  readonly credential: 'none' | 'proxy' | 'management';
}

export interface CpaHealth {
  status: 'ok';
}

export interface CpaModel {
  id: string;
  object: 'model';
  created: number;
  ownedBy: string;
}

export interface CpaModels {
  object: 'list';
  data: CpaModel[];
}

export type CpaAuthHealth = 'healthy' | 'unhealthy' | 'unknown' | 'unavailable';

/** Deliberately excludes authIndex, file names, paths, keys, and tokens. */
export interface CpaAccountStatus {
  providerId: string;
  healthStatus: CpaAuthHealth;
  reasonCode: string;
  accountIdHash?: string;
  observedAtMs?: number;
}

export interface CpaQuotaWindow {
  kind: string;
  unit: string;
  limit: number;
  used: number;
  remaining: number;
  resetAtMs: number;
}

export interface CpaQuota {
  providerId: string;
  windows: CpaQuotaWindow[];
}

/** Host-only selector used to call the fixed quota endpoint; never crosses a Remote. */
export interface CpaQuotaSelection {
  authIndex: string;
  providerId: string;
}

export interface CpaTokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

/** Safe usage metadata only; raw upstream request/auth fields are not retained. */
export interface CpaUsageRecord {
  eventId?: string;
  timestamp?: string;
  latencyMs?: number;
  tokens?: CpaTokenCounts;
  failed?: boolean;
  provider?: string;
  model?: string;
  alias?: string;
  endpoint?: string;
  authType?: string;
  requestId?: string;
  accountIdHash?: string;
  apiKeyIdHash?: string;
}

export interface CpaProbe {
  health: CpaHealth;
  models: CpaModels;
}
