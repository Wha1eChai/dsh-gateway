import { CpaClientError } from './errors.js';
import type {
  CpaAccountStatus,
  CpaClientBaseOptions,
  CpaClientOperation,
  CpaClientOptions,
  CpaCredentialRefs,
  CpaCredentialResolver,
  CpaEndpointDescriptor,
  CpaEndpointMethod,
  CpaErrorCategory,
  CpaFetch,
  CpaHealth,
  CpaModels,
  CpaProbe,
  CpaQuota,
  CpaQuotaWindow,
  CpaRequestOptions,
  CpaUsageRecord,
} from './types.js';

export { CpaClientError } from './errors.js';
export type { CpaClientErrorInit, CpaErrorDiagnostic } from './errors.js';
export type {
  CpaAccountStatus,
  CpaAuthHealth,
  CpaClientBaseOptions,
  CpaClientOperation,
  CpaClientOptions,
  CpaCredentialRefs,
  CpaCredentialResolver,
  CpaEndpointDescriptor,
  CpaEndpointMethod,
  CpaErrorCategory,
  CpaFetch,
  CpaHealth,
  CpaModel,
  CpaModels,
  CpaProbe,
  CpaQuota,
  CpaQuotaWindow,
  CpaRequestOptions,
  CpaTokenCounts,
  CpaUsageRecord,
} from './types.js';

export const CPA_FROZEN_VERSION = '7.2.131';
export const DEFAULT_GATEWAY_USER_AGENT = 'dsh-gateway-fake-cpa/0.1';
export const FIXED_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_024 * 1_024;
const MAX_MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;
const MAX_STRING_LENGTH = 8_192;
const MAX_ARRAY_LENGTH = 256;
const MAX_OBJECT_KEYS = 64;
const MAX_QUOTA_BODY_LENGTH = 256 * 1_024;

type CpaRoute =
  | 'health'
  | 'models'
  | 'authStatus'
  | 'quota'
  | 'usageQueue';

const ROUTES: Readonly<Record<CpaRoute, CpaEndpointDescriptor>> = Object.freeze({
  health: { method: 'GET', path: '/healthz', credential: 'none' },
  models: { method: 'GET', path: '/v1/models', credential: 'proxy' },
  authStatus: { method: 'GET', path: '/v0/management/auth-files', credential: 'management' },
  quota: { method: 'POST', path: '/v0/management/api-call', credential: 'management' },
  usageQueue: { method: 'GET', path: '/v0/management/usage-queue?count=10', credential: 'management' },
});

export const CPA_ENDPOINT_ALLOWLIST: readonly CpaEndpointDescriptor[] = Object.freeze(
  Object.values(ROUTES).map((descriptor) => Object.freeze({ ...descriptor })),
);

const ROUTE_BY_ENDPOINT = new Map(
  CPA_ENDPOINT_ALLOWLIST.map((descriptor) => [`${descriptor.method} ${descriptor.path}`, descriptor]),
);

const CREDENTIAL_BY_OPERATION: ReadonlyMap<CpaClientOperation, CpaEndpointDescriptor['credential']> = new Map([
  ['health', 'none'],
  ['probe', 'proxy'],
  ['models', 'proxy'],
  ['accountStatus', 'management'],
  ['authStatus', 'management'],
  ['quota', 'management'],
  ['dequeueUsage', 'management'],
]);

const HEALTH_STATUSES = new Set(['healthy', 'unhealthy', 'unknown', 'unavailable']);
const FORBIDDEN_SECRET_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'auth_file',
  'auth_files',
  'auth_index',
  'body',
  'headers',
  'path',
  'refresh_token',
  'token',
]);

export function isAllowedCpaEndpoint(method: string, path: string): boolean {
  return ROUTE_BY_ENDPOINT.has(`${method.toUpperCase()} ${path}`);
}

export function normalizeCpaBaseUrl(input: string, { allowExternal = false } = {}): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2_048) {
    throw new CpaClientError({ category: 'configuration', code: 'invalid_base_url' });
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CpaClientError({ category: 'configuration', code: 'invalid_base_url' });
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = hostname === 'localhost'
    || hostname === '::1'
    || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
  if (!isLoopback && !allowExternal) {
    throw new CpaClientError({ category: 'configuration', code: 'external_base_url_requires_opt_in' });
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || (url.pathname !== '' && url.pathname !== '/')) {
    throw new CpaClientError({ category: 'configuration', code: 'invalid_base_url' });
  }

  url.pathname = '/';
  return url.toString().replace(/\/$/, '');
}

/**
 * Resolve credentials for exactly one closed CPA operation and return a fresh
 * client for that operation. Callers must not retain the client across Host
 * operations; invoking this factory again is what observes credential rotation.
 */
export async function createCpaClientForOperation(
  operation: CpaClientOperation,
  credentials: CpaCredentialResolver,
  refs: CpaCredentialRefs,
  options: CpaClientBaseOptions,
): Promise<CpaClient> {
  if (credentials === null || typeof credentials !== 'object' || typeof credentials.resolve !== 'function') {
    throw new CpaClientError({ category: 'configuration', code: 'invalid_credential_resolver' });
  }

  const credential = CREDENTIAL_BY_OPERATION.get(operation);
  if (credential === undefined) {
    throw new CpaClientError({ category: 'allowlist', code: 'operation_not_allowlisted' });
  }

  let proxyApiKey: string | undefined;
  let managementKey: string | undefined;
  if (credential === 'proxy') {
    proxyApiKey = await resolveCredentialForOperation(credentials, refs.proxyCredentialRef, 'proxy');
  } else if (credential === 'management') {
    managementKey = await resolveCredentialForOperation(credentials, refs.managementCredentialRef, 'management');
  }

  // Discard raw-key properties supplied by an untyped JavaScript caller. Only
  // this operation's freshly resolved key is copied into the short-lived client.
  const clientOptions = { ...options } as CpaClientOptions;
  delete clientOptions.proxyApiKey;
  delete clientOptions.managementKey;
  if (proxyApiKey !== undefined) clientOptions.proxyApiKey = proxyApiKey;
  if (managementKey !== undefined) clientOptions.managementKey = managementKey;
  return new CpaClient(clientOptions);
}

interface FetchRouteOptions {
  body?: unknown;
  signal: AbortSignal | undefined;
  acceptedStatuses: readonly number[];
}

interface RouteResponse {
  status: number;
  json: unknown;
}

export class CpaClient {
  readonly baseUrl: string;

  private readonly proxyApiKey: string | undefined;
  private readonly managementKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: CpaFetch;

  constructor(options: CpaClientOptions) {
    this.baseUrl = normalizeCpaBaseUrl(options.baseUrl, { allowExternal: options.allowExternalBaseUrl === true });
    this.proxyApiKey = validateCredential(options.proxyApiKey, 'proxy');
    this.managementKey = validateCredential(options.managementKey, 'management');
    this.timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeout');
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_MAX_RESPONSE_BYTES,
      'response size',
    );
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new CpaClientError({ category: 'configuration', code: 'fetch_unavailable' });
    }
    this.fetchImpl = fetchImpl;
  }

  async probe(options: CpaRequestOptions = {}): Promise<CpaProbe> {
    const [health, models] = await Promise.all([
      this.health(options),
      this.models(options),
    ]);
    return { health, models };
  }

  async health(options: CpaRequestOptions = {}): Promise<CpaHealth> {
    const response = await this.fetchJson('health', { acceptedStatuses: [200], signal: options.signal });
    return parseHealth(response.json, 'health');
  }

  async models(options: CpaRequestOptions = {}): Promise<CpaModels> {
    this.requireCredential('proxy');
    const response = await this.fetchJson('models', { acceptedStatuses: [200], signal: options.signal });
    return parseModels(response.json, 'models');
  }

  async accountStatus(options: CpaRequestOptions = {}): Promise<CpaAccountStatus[]> {
    this.requireCredential('management');
    const response = await this.fetchJson('authStatus', { acceptedStatuses: [200], signal: options.signal });
    return parseAccountStatus(response.json, 'authStatus');
  }

  async authStatus(options: CpaRequestOptions = {}): Promise<CpaAccountStatus[]> {
    return this.accountStatus(options);
  }

  async quota(
    input: { authIndex: string; accountId?: string },
    options: CpaRequestOptions = {},
  ): Promise<CpaQuota> {
    this.requireCredential('management');
    const rawAuthIndex = input?.authIndex;
    if (!validateBoundedString(rawAuthIndex, MAX_STRING_LENGTH)) {
      throw new CpaClientError({ category: 'credential', code: 'invalid_auth_selection' });
    }
    const authIndex = rawAuthIndex;
    const rawAccountId = input?.accountId;
    const accountId = rawAccountId === undefined ? undefined : rawAccountId;
    if (accountId !== undefined && !validateBoundedString(accountId, MAX_STRING_LENGTH)) {
      throw new CpaClientError({ category: 'credential', code: 'invalid_account_selection' });
    }
    const innerHeader: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': DEFAULT_GATEWAY_USER_AGENT,
    };
    if (accountId) innerHeader['Chatgpt-Account-Id'] = accountId;
    const response = await this.fetchJson('quota', {
      body: {
        authIndex,
        method: 'GET',
        url: FIXED_WHAM_USAGE_URL,
        header: innerHeader,
      },
      acceptedStatuses: [200],
      signal: options.signal,
    });
    return parseQuotaApiCall(response.json, 'quota');
  }

  async dequeueUsage(options: CpaRequestOptions = {}): Promise<CpaUsageRecord[]> {
    const response = await this.fetchJson('usageQueue', {
      acceptedStatuses: [200],
      signal: options.signal,
    });
    if (!Array.isArray(response.json) || response.json.length > MAX_ARRAY_LENGTH) throw shapeError('usageQueue');
    return response.json.map((item, index) => parseUsageRecord(item, `usageQueue[${index}]`));
  }

  private async fetchJson(route: CpaRoute, options: FetchRouteOptions): Promise<RouteResponse> {
    const descriptor = ROUTES[route];
    const credential = descriptor.credential === 'proxy' ? this.proxyApiKey : descriptor.credential === 'management' ? this.managementKey : undefined;
    const headers = new Headers();
    if (credential !== undefined) headers.set('authorization', `Bearer ${credential}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = options.signal?.aborted === true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) throw this.requestError('aborted', 'request_aborted', descriptor);
      options.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.urlFor(descriptor.path), {
        method: descriptor.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      if (!options.acceptedStatuses.includes(response.status)) {
        throw this.requestError('http_status', 'unexpected_http_status', descriptor, response.status);
      }
      const raw = await this.readResponseText(response, descriptor);
      let json: unknown;
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        throw this.requestError('invalid_json', 'response_is_not_json', descriptor);
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof CpaClientError) throw error;
      if (callerAborted || options.signal?.aborted) {
        throw this.requestError('aborted', 'request_aborted', descriptor);
      }
      if (timedOut) throw this.requestError('timeout', 'request_timed_out', descriptor);
      throw this.requestError('network', 'network_request_failed', descriptor);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async readResponseText(response: Response, descriptor: CpaEndpointDescriptor): Promise<string> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      throw this.requestError('content_type', 'response_content_type_not_json', descriptor, response.status);
    }
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > this.maxResponseBytes) {
        throw this.requestError('response_too_large', 'response_exceeds_limit', descriptor, response.status);
      }
    }

    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) {
        throw this.requestError('response_too_large', 'response_exceeds_limit', descriptor, response.status);
      }
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunks: string[] = [];
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > this.maxResponseBytes) {
        await reader.cancel();
        throw this.requestError('response_too_large', 'response_exceeds_limit', descriptor, response.status);
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  }

  private urlFor(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }

  private requireCredential(kind: 'proxy' | 'management'): void {
    if (kind === 'proxy' && this.proxyApiKey === undefined) {
      throw new CpaClientError({ category: 'credential', code: 'missing_proxy_api_key' });
    }
    if (kind === 'management' && this.managementKey === undefined) {
      throw new CpaClientError({ category: 'credential', code: 'missing_management_key' });
    }
  }

  private requestError(
    category: CpaErrorCategory,
    code: string,
    descriptor: CpaEndpointDescriptor,
    status?: number,
  ): CpaClientError {
    return new CpaClientError({
      category,
      code,
      method: descriptor.method,
      path: descriptor.path,
      ...(status === undefined ? {} : { status }),
    });
  }
}

async function resolveCredentialForOperation(
  credentials: CpaCredentialResolver,
  ref: CpaCredentialRefs['proxyCredentialRef'],
  kind: 'proxy' | 'management',
): Promise<string> {
  if (ref === undefined) {
    throw new CpaClientError({ category: 'credential', code: `missing_${kind}_credential_ref` });
  }
  try {
    const resolved = await credentials.resolve(ref);
    if (resolved === undefined) {
      throw new CpaClientError({ category: 'credential', code: `missing_${kind}_api_key` });
    }
    return resolved.value;
  } catch (error) {
    if (error instanceof CpaClientError) throw error;
    throw new CpaClientError({ category: 'credential', code: `${kind}_credential_resolution_failed` });
  }
}

function validateCredential(value: string | undefined, kind: 'proxy' | 'management'): string | undefined {
  if (value === undefined) return undefined;
  if (!validateBoundedString(value, 4_096)) {
    throw new CpaClientError({ category: 'configuration', code: `invalid_${kind}_credential` });
  }
  return value;
}

function boundedInteger(value: number, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CpaClientError({ category: 'configuration', code: `invalid_${code.replaceAll(' ', '_')}` });
  }
  return value;
}

function validateBoundedString(value: unknown, max = MAX_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasForbiddenSecretKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => FORBIDDEN_SECRET_KEYS.has(key.toLowerCase()));
}

function shapeError(path: string): CpaClientError {
  return new CpaClientError({ category: 'invalid_shape', code: 'response_shape_invalid', path });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length > MAX_OBJECT_KEYS || hasForbiddenSecretKey(value)) {
    throw shapeError(path);
  }
  return value;
}

function requireString(value: unknown, path: string, max = MAX_STRING_LENGTH): string {
  if (!validateBoundedString(value, max)) throw shapeError(path);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw shapeError(path);
  return value;
}

function requireNumber(value: unknown, path: string, { integer = false, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    throw shapeError(path);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw shapeError(path);
  return value;
}

function parseHealth(value: unknown, path: string): CpaHealth {
  const record = requireRecord(value, path);
  if (record.status !== 'ok') throw shapeError(`${path}.status`);
  return { status: 'ok' };
}

function parseModels(value: unknown, path: string): CpaModels {
  const record = requireRecord(value, path);
  if (record.object !== 'list') throw shapeError(`${path}.object`);
  const data = requireArray(record.data, `${path}.data`);
  return {
    object: 'list',
    data: data.map((rawModel, index) => {
      const model = requireRecord(rawModel, `${path}.data[${index}]`);
      if (model.object !== 'model') throw shapeError(`${path}.data[${index}].object`);
      return {
        id: requireString(model.id, `${path}.data[${index}].id`, 128),
        object: 'model',
        created: requireNumber(model.created, `${path}.data[${index}].created`, { integer: true, min: 0 }),
        ownedBy: requireString(model.owned_by, `${path}.data[${index}].owned_by`, 128),
      };
    }),
  };
}

function parseAccountStatus(value: unknown, path: string): CpaAccountStatus[] {
  const record = requireRecord(value, path);
  const files = requireArray(record.files, `${path}.files`);
  return files.map((rawFile, index) => {
    const file = requireObject(rawFile, `${path}.files[${index}]`);
    const provider = file.provider ?? file.provider_id;
    const providerId = requireString(provider, `${path}.files[${index}].provider`, 128);
    const status = requireString(file.status, `${path}.files[${index}].status`, 64).toLowerCase();
    const { healthStatus, reasonCode } = normalizeAuthStatus(status);
    const result: CpaAccountStatus = { providerId, healthStatus, reasonCode };
    if (file.account_id_hash !== undefined) {
      const accountIdHash = requireString(file.account_id_hash, `${path}.files[${index}].account_id_hash`, 256);
      if (!accountIdHash.startsWith('sha256:')) throw shapeError(`${path}.files[${index}].account_id_hash`);
      result.accountIdHash = accountIdHash;
    }
    if (file.modtime !== undefined) {
      const modtime = requireString(file.modtime, `${path}.files[${index}].modtime`, 128);
      const observedAtMs = Date.parse(modtime);
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) throw shapeError(`${path}.files[${index}].modtime`);
      result.observedAtMs = observedAtMs;
    }
    return result;
  });
}

function normalizeAuthStatus(status: string): Pick<CpaAccountStatus, 'healthStatus' | 'reasonCode'> {
  if (status === 'ready' || status === 'healthy') return { healthStatus: 'healthy', reasonCode: 'ready' };
  if (status === 'disabled') return { healthStatus: 'unavailable', reasonCode: 'disabled' };
  if (status === 'error' || status === 'failed') return { healthStatus: 'unhealthy', reasonCode: 'failed' };
  if (status === 'unavailable') return { healthStatus: 'unavailable', reasonCode: 'unavailable' };
  return { healthStatus: 'unknown', reasonCode: 'unknown' };
}

function parseQuotaApiCall(value: unknown, path: string): CpaQuota {
  const wrapper = requireObject(value, path);
  if (Object.keys(wrapper).sort().join(',') !== 'body,header,status_code') throw shapeError(path);
  const status = requireNumber(wrapper.status_code, `${path}.status_code`, { integer: true, min: 100, max: 599 });
  requireObject(wrapper.header, `${path}.header`);
  if (status < 200 || status >= 300) {
    throw new CpaClientError({
      category: 'http_status',
      code: 'quota_upstream_status',
      method: ROUTES.quota.method,
      path: ROUTES.quota.path,
      status,
    });
  }
  const body = requireString(wrapper.body, `${path}.body`, MAX_QUOTA_BODY_LENGTH);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body) as unknown;
  } catch {
    throw new CpaClientError({
      category: 'invalid_json',
      code: 'quota_body_is_not_json',
      method: ROUTES.quota.method,
      path: ROUTES.quota.path,
    });
  }
  return parseWhamQuota(parsedBody, `${path}.body`);
}

function parseWhamQuota(value: unknown, path: string): CpaQuota {
  const record = requireRecord(value, path);
  const rateLimit = requireRecord(record.rate_limit, `${path}.rate_limit`);
  const windows: CpaQuotaWindow[] = [];
  for (const [sourceKey, kind] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ] as const) {
    if (rateLimit[sourceKey] === null || rateLimit[sourceKey] === undefined) continue;
    const window = requireRecord(rateLimit[sourceKey], `${path}.rate_limit.${sourceKey}`);
    const usedPercent = requireNumber(window.used_percent, `${path}.rate_limit.${sourceKey}.used_percent`, { min: 0, max: 100 });
    requireNumber(window.limit_window_seconds, `${path}.rate_limit.${sourceKey}.limit_window_seconds`, { integer: true, min: 1 });
    const resetAtSeconds = requireNumber(window.reset_at, `${path}.rate_limit.${sourceKey}.reset_at`, { min: 0 });
    const resetAtMs = resetAtSeconds * 1_000;
    if (!Number.isSafeInteger(resetAtMs)) throw shapeError(`${path}.rate_limit.${sourceKey}.reset_at`);
    windows.push({
      kind,
      unit: 'percent',
      limit: 100,
      used: usedPercent,
      remaining: 100 - usedPercent,
      resetAtMs,
    });
  }
  if (windows.length === 0) throw shapeError(`${path}.rate_limit`);
  return {
    providerId: 'openai-codex',
    windows,
  };
}

function parseUsageRecord(value: unknown, path: string): CpaUsageRecord {
  const record = requireObject(value, path);
  const output: CpaUsageRecord = {};
  if (record.event_id !== undefined) output.eventId = requireString(record.event_id, `${path}.event_id`, 256);
  if (record.timestamp !== undefined) output.timestamp = requireString(record.timestamp, `${path}.timestamp`, 128);
  if (record.latency_ms !== undefined) output.latencyMs = requireNumber(record.latency_ms, `${path}.latency_ms`, { min: 0 });
  if (record.failed !== undefined) output.failed = requireBoolean(record.failed, `${path}.failed`);
  for (const [sourceKey, outputKey] of [
    ['provider', 'provider'],
    ['model', 'model'],
    ['alias', 'alias'],
    ['endpoint', 'endpoint'],
    ['auth_type', 'authType'],
    ['request_id', 'requestId'],
    ['account_id_hash', 'accountIdHash'],
    ['api_key_id_hash', 'apiKeyIdHash'],
  ] as const) {
    if (record[sourceKey] !== undefined) {
      const valueString = requireString(record[sourceKey], `${path}.${sourceKey}`, 512);
      if ((outputKey === 'accountIdHash' || outputKey === 'apiKeyIdHash') && !valueString.startsWith('sha256:')) {
        throw shapeError(`${path}.${sourceKey}`);
      }
      output[outputKey] = valueString;
    }
  }
  if (record.tokens !== undefined) {
    const tokens = requireObject(record.tokens, `${path}.tokens`);
    const parsedTokens: CpaUsageRecord['tokens'] = {};
    for (const [sourceKey, outputKey] of [
      ['input_tokens', 'inputTokens'],
      ['output_tokens', 'outputTokens'],
      ['reasoning_tokens', 'reasoningTokens'],
      ['cached_tokens', 'cachedTokens'],
      ['total_tokens', 'totalTokens'],
    ] as const) {
      if (tokens[sourceKey] !== undefined) parsedTokens[outputKey] = requireNumber(tokens[sourceKey], `${path}.tokens.${sourceKey}`, { min: 0 });
    }
    output.tokens = parsedTokens;
  }
  return output;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length > MAX_OBJECT_KEYS) throw shapeError(path);
  return value;
}
