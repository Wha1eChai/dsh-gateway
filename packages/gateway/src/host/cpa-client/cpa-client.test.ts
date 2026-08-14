import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CPA_ENDPOINT_ALLOWLIST,
  CpaClient,
  CpaClientError,
  createCpaClientForOperation,
  type CpaCredentialResolver,
  type CpaFetch,
  isAllowedCpaEndpoint,
  normalizeCpaBaseUrl,
} from './index.js';

interface FakeCpaServer {
  readonly url: string;
  readonly requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }>;
  close(): Promise<void>;
  setBehavior(path: string, behavior: Record<string, unknown>): FakeCpaServer;
  enqueueBehavior(path: string, behavior: Record<string, unknown>): FakeCpaServer;
}

interface FakeCpaModule {
  startFakeCpa(options?: Record<string, unknown>): Promise<FakeCpaServer>;
}

const fakeCpaModuleUrl = new URL('../../../../../tests/fixtures/fake-cpa/index.js', import.meta.url).href;
const fixtures: FakeCpaServer[] = [];

async function startFixture(options: Record<string, unknown> = {}): Promise<FakeCpaServer> {
  const fixture = await import(/* @vite-ignore */ fakeCpaModuleUrl) as unknown as FakeCpaModule;
  return fixture.startFakeCpa(options);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function makeClient(baseUrl: string, options: Record<string, unknown> = {}): CpaClient {
  return new CpaClient({
    baseUrl,
    proxyApiKey: 'proxy-secret-value',
    managementKey: 'management-secret-value',
    ...(options as Partial<ConstructorParameters<typeof CpaClient>[0]>),
  });
}

function errorOf(error: unknown): CpaClientError {
  expect(error).toBeInstanceOf(CpaClientError);
  return error as CpaClientError;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

describe('typed CPA client', () => {
  it('uses the fake fixture only for the real health/models-compatible slice', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const client = makeClient(fixture.url);

    const probe = await client.probe();
    expect(probe.health).toEqual({ status: 'ok' });
    expect(probe.models.data.map((model) => model.id)).toEqual(['fake-text-model', 'fake-vision-model']);
    expect(fixture.requests.map((request) => request.path).sort()).toEqual(['/healthz', '/v1/models']);

    // The fixture still requires its older plural `headers` request and direct
    // quota response, so the real singular `header` contract fails closed.
    const fixtureQuotaMismatch = errorOf(await client.quota({ authIndex: 'fixture-auth-0' }).catch((error: unknown) => error));
    expect(fixtureQuotaMismatch.category).toBe('http_status');
    expect(fixtureQuotaMismatch.status).toBe(400);
    const quotaRequest = fixture.requests.find((request) => request.path === '/v0/management/api-call');
    expect(quotaRequest?.body).toMatchObject({
      authIndex: 'fixture-auth-0',
      header: { Authorization: 'Bearer $TOKEN$' },
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/wham/usage',
    });
    expect((quotaRequest?.body as { headers?: unknown } | undefined)?.headers).toBeUndefined();

    // These fake-only endpoints are deliberately not part of the real client contract.
    for (const endpoint of [
      ['GET', '/version'],
      ['GET', '/v1/capabilities'],
      ['POST', '/v0/management/oauth/device/start'],
      ['POST', '/v0/management/oauth/device/poll'],
      ['GET', '/codex-auth-url'],
      ['GET', '/get-auth-status?state=opaque'],
      ['DELETE', '/oauth-session?state=opaque'],
    ] as const) {
      expect(isAllowedCpaEndpoint(endpoint[0], endpoint[1])).toBe(false);
    }
  });

  it('re-resolves only the credential required by each fresh operation client', async () => {
    const proxyRef = credentialRef('DSH_GATEWAY_PROXY');
    const managementRef = credentialRef('DSH_GATEWAY_MANAGEMENT');
    let proxyValue = 'rotated-proxy-1';
    let managementValue = 'rotated-management-1';
    const resolve = vi.fn<CpaCredentialResolver['resolve']>(async (ref) => {
      if (ref === proxyRef) return { value: proxyValue, source: 'test' };
      if (ref === managementRef) return { value: managementValue, source: 'test' };
      return undefined;
    });
    const credentials: CpaCredentialResolver = { resolve };
    const observed: Array<{ path: string; authorization: string | null }> = [];
    const operationFetch: CpaFetch = async (input, init) => {
      const url = new URL(input.toString());
      const authorization = new Headers(init?.headers).get('authorization');
      observed.push({ path: url.pathname, authorization });
      if (url.pathname === '/healthz') return jsonResponse({ status: 'ok' });
      if (url.pathname === '/v1/models') return jsonResponse({ object: 'list', data: [] });
      if (url.pathname === '/v0/management/auth-files') return jsonResponse({ files: [] });
      throw new Error('unexpected test URL');
    };
    const refs = { proxyCredentialRef: proxyRef, managementCredentialRef: managementRef };
    const clientOptions = { baseUrl: 'http://127.0.0.1:8317', fetch: operationFetch };

    const healthClient = await createCpaClientForOperation('health', credentials, refs, clientOptions);
    await healthClient.health();
    expect(resolve).not.toHaveBeenCalled();

    const firstModelsClient = await createCpaClientForOperation('models', credentials, refs, clientOptions);
    await firstModelsClient.models();
    proxyValue = 'rotated-proxy-2';
    const secondModelsClient = await createCpaClientForOperation('models', credentials, refs, clientOptions);
    await secondModelsClient.models();
    expect(secondModelsClient).not.toBe(firstModelsClient);

    const managementClient = await createCpaClientForOperation('accountStatus', credentials, refs, clientOptions);
    await managementClient.accountStatus();
    managementValue = 'rotated-management-2';
    const rotatedManagementClient = await createCpaClientForOperation('accountStatus', credentials, refs, clientOptions);
    await rotatedManagementClient.accountStatus();

    expect(resolve.mock.calls.map(([ref]) => ref)).toEqual([
      proxyRef,
      proxyRef,
      managementRef,
      managementRef,
    ]);
    expect(observed).toEqual([
      { path: '/healthz', authorization: null },
      { path: '/v1/models', authorization: 'Bearer rotated-proxy-1' },
      { path: '/v1/models', authorization: 'Bearer rotated-proxy-2' },
      { path: '/v0/management/auth-files', authorization: 'Bearer rotated-management-1' },
      { path: '/v0/management/auth-files', authorization: 'Bearer rotated-management-2' },
    ]);

    const unallowlisted = errorOf(await createCpaClientForOperation(
      'toString' as never,
      credentials,
      refs,
      clientOptions,
    ).catch((error: unknown) => error));
    expect(unallowlisted.category).toBe('allowlist');

    const resolverFailure = errorOf(await createCpaClientForOperation(
      'quota',
      { resolve: async () => { throw new Error('rotated-management-2 must not leak'); } },
      refs,
      clientOptions,
    ).catch((error: unknown) => error));
    expect(resolverFailure.category).toBe('credential');
    expect(JSON.stringify(resolverFailure)).not.toContain('rotated-management-2');
  });

  it('uses the exact real quota wrapper and projects only safe WHAM fields', async () => {
    const calls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    let mode: 'success' | 'malformed-body' | 'upstream-error' = 'success';
    const quotaFetch: CpaFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ headers: new Headers(init?.headers), body });
      if (mode === 'malformed-body') {
        return jsonResponse({ status_code: 200, header: {}, body: '{private-token-not-json' });
      }
      if (mode === 'upstream-error') {
        return jsonResponse({
          status_code: 401,
          header: { authorization: 'Bearer wrapper-secret' },
          body: JSON.stringify({ error: 'upstream-secret-body' }),
        });
      }
      return jsonResponse({
        status_code: 200,
        header: {
          authorization: 'Bearer wrapper-secret',
          'set-cookie': 'private-cookie',
        },
        body: JSON.stringify({
          plan_type: 'plus',
          email: 'private@example.invalid',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
              reset_after_seconds: 60,
              reset_at: 1_700_000_000,
            },
            secondary_window: {
              used_percent: 40.5,
              limit_window_seconds: 604_800,
              reset_after_seconds: 120,
              reset_at: 1_700_000_100,
            },
          },
        }),
      });
    };
    const client = makeClient('http://127.0.0.1:8317', { fetch: quotaFetch });

    const quota = await client.quota({ authIndex: 'internal-auth-index', accountId: 'private-account-id' });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer management-secret-value');
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['authIndex', 'header', 'method', 'url']);
    expect(calls[0]?.body).toEqual({
      authIndex: 'internal-auth-index',
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/wham/usage',
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'dsh-gateway-fake-cpa/0.1',
        'Chatgpt-Account-Id': 'private-account-id',
      },
    });
    expect(quota).toEqual({
      providerId: 'openai-codex',
      windows: [
        { kind: 'primary', unit: 'percent', limit: 100, used: 25, remaining: 75, resetAtMs: 1_700_000_000_000 },
        { kind: 'secondary', unit: 'percent', limit: 100, used: 40.5, remaining: 59.5, resetAtMs: 1_700_000_100_000 },
      ],
    });
    expect(JSON.stringify(quota)).not.toMatch(/private|cookie|wrapper|email|header|body/i);

    mode = 'malformed-body';
    const malformedBody = errorOf(await client.quota({ authIndex: 'internal-auth-index' }).catch((error: unknown) => error));
    expect(malformedBody.category).toBe('invalid_json');
    expect(JSON.stringify(malformedBody)).not.toContain('private-token-not-json');

    mode = 'upstream-error';
    const upstreamError = errorOf(await client.quota({ authIndex: 'internal-auth-index' }).catch((error: unknown) => error));
    expect(upstreamError.category).toBe('http_status');
    expect(upstreamError.status).toBe(401);
    expect(JSON.stringify(upstreamError)).not.toMatch(/wrapper-secret|upstream-secret-body/);
  });

  it('uses the real auth-files and management usage-queue shapes with separated credentials', async () => {
    const calls: Array<{ url: URL; headers: Headers; body: string | undefined }> = [];
    const realFetch: CpaFetch = async (input, init) => {
      const url = new URL(input.toString());
      const headers = new Headers(init?.headers);
      calls.push({ url, headers, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.pathname === '/healthz') return jsonResponse({ status: 'ok' });
      if (url.pathname === '/v1/models') {
        if (headers.get('authorization') !== 'Bearer proxy-secret-value') {
          return jsonResponse({ error: 'missing proxy key' }, 401);
        }
        return jsonResponse({ object: 'list', data: [{ id: 'real-model', object: 'model', created: 0, owned_by: 'real-cpa' }] });
      }
      if (url.pathname === '/v0/management/auth-files') {
        return jsonResponse({ files: [{
          provider: 'openai-codex',
          auth_index: 'internal-only',
          path: 'C:\\private\\auth.json',
          email: 'secret@example.invalid',
          status: 'ready',
          status_message: 'raw-secret-message',
          modtime: '2026-08-14T00:00:00.000Z',
        }] });
      }
      if (url.pathname === '/v0/management/usage-queue' && url.searchParams.get('count') === '10') {
        return jsonResponse([{
          event_id: 'safe-event',
          auth_index: 'internal-only',
          api_key: 'raw-upstream-key',
          provider: 'openai',
          model: 'real-model',
          latency_ms: 10,
          request_id: 'request-1',
          account_id_hash: 'sha256:account',
          tokens: { input_tokens: 2, total_tokens: 2 },
        }]);
      }
      throw new Error('unexpected test URL');
    };
    const client = makeClient('http://127.0.0.1:8317', { fetch: realFetch });

    const probe = await client.probe();
    expect(probe.health).toEqual({ status: 'ok' });
    expect(probe.models.data[0]?.id).toBe('real-model');

    await expect(client.accountStatus()).resolves.toEqual([{
      providerId: 'openai-codex',
      healthStatus: 'healthy',
      reasonCode: 'ready',
      observedAtMs: Date.parse('2026-08-14T00:00:00.000Z'),
    }]);
    await expect(client.quotaSelections()).resolves.toEqual([{
      authIndex: 'internal-only',
      providerId: 'openai-codex',
    }]);
    await expect(client.dequeueUsage()).resolves.toEqual([{
      eventId: 'safe-event',
      provider: 'openai',
      model: 'real-model',
      latencyMs: 10,
      requestId: 'request-1',
      accountIdHash: 'sha256:account',
      tokens: { inputTokens: 2, totalTokens: 2 },
    }]);

    const authCall = calls.find(({ url }) => url.pathname === '/v0/management/auth-files');
    const usageCall = calls.find(({ url }) => url.pathname === '/v0/management/usage-queue');
    const modelsCall = calls.find(({ url }) => url.pathname === '/v1/models');
    expect(authCall?.headers.get('authorization')).toBe('Bearer management-secret-value');
    expect(usageCall?.headers.get('authorization')).toBe('Bearer management-secret-value');
    expect(usageCall?.url.search).toBe('?count=10');
    expect(modelsCall?.headers.get('authorization')).toBe('Bearer proxy-secret-value');
    expect(JSON.stringify(await client.accountStatus())).not.toContain('private');
    expect(JSON.stringify(await client.dequeueUsage())).not.toContain('raw-upstream-key');
  });

  it('fails closed for the unimplemented fake/version/OAuth HTTP claims', () => {
    const client = makeClient('http://127.0.0.1:8317');
    expect('version' in client).toBe(false);
    expect('capabilities' in client).toBe(false);
    expect('startDeviceOAuth' in client).toBe(false);
    expect('pollDeviceOAuth' in client).toBe(false);
    expect('cancelDeviceOAuth' in client).toBe(false);
    expect(CPA_ENDPOINT_ALLOWLIST.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /healthz',
      'GET /v1/models',
      'GET /v0/management/auth-files',
      'POST /v0/management/api-call',
      'GET /v0/management/usage-queue?count=10',
    ]);
  });

  it('classifies malformed JSON, content types, shapes, and HTTP statuses without upstream text', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const client = makeClient(fixture.url);

    fixture.enqueueBehavior('/healthz', { malformed: { body: '{not-json', contentType: 'application/json' } });
    const malformedJson = errorOf(await client.health().catch((error: unknown) => error));
    expect(malformedJson.category).toBe('invalid_json');
    expect(malformedJson.message).not.toContain('not-json');

    fixture.enqueueBehavior('/v1/models', { malformed: { body: '{}', contentType: 'text/plain' } });
    const wrongContentType = errorOf(await client.models().catch((error: unknown) => error));
    expect(wrongContentType.category).toBe('content_type');

    // The fake's {data:...} response is intentionally not accepted as real {files:...}.
    fixture.enqueueBehavior('/v0/management/auth-files', {
      malformed: {
        body: JSON.stringify({ data: [{ path: 'token-path-should-not-leak' }] }),
        contentType: 'application/json',
      },
    });
    const malformedShape = errorOf(await client.accountStatus().catch((error: unknown) => error));
    expect(malformedShape.category).toBe('invalid_shape');
    expect(JSON.stringify(malformedShape)).not.toContain('token-path-should-not-leak');

    fixture.enqueueBehavior('/v1/models', {
      error: { status: 401, code: 'upstream-secret-code', message: 'management-secret-value' },
    });
    const statusError = errorOf(await client.models().catch((error: unknown) => error));
    expect(statusError.category).toBe('http_status');
    expect(statusError.status).toBe(401);
    expect(statusError.message).not.toContain('management-secret-value');
    expect(JSON.stringify(statusError)).not.toContain('upstream-secret-code');
  });

  it('composes bounded timeout and caller abort signals on the real health route', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const timeoutClient = makeClient(fixture.url, { timeoutMs: 50 });
    fixture.enqueueBehavior('/healthz', { delayMs: 150, abortObservable: true });
    const timeoutError = errorOf(await timeoutClient.health().catch((error: unknown) => error));
    expect(timeoutError.category).toBe('timeout');
    expect(timeoutError.code).toBe('request_timed_out');

    const abortController = new AbortController();
    const abortClient = makeClient(fixture.url, { timeoutMs: 500 });
    fixture.enqueueBehavior('/healthz', { delayMs: 150 });
    const pending = abortClient.health({ signal: abortController.signal });
    setTimeout(() => abortController.abort(), 10);
    const abortError = errorOf(await pending.catch((error: unknown) => error));
    expect(abortError.category).toBe('aborted');
    expect(abortError.code).toBe('request_aborted');
  });

  it('requires loopback or explicit external base URLs and rejects unallowlisted paths', () => {
    expect(normalizeCpaBaseUrl('http://127.0.0.1:8317/')).toBe('http://127.0.0.1:8317');
    expect(normalizeCpaBaseUrl('https://example.invalid/', { allowExternal: true })).toBe('https://example.invalid');
    expect(() => normalizeCpaBaseUrl('https://example.invalid/')).toThrowError(CpaClientError);
    expect(() => normalizeCpaBaseUrl('http://127.0.0.1:8317/?key=secret')).toThrowError(CpaClientError);
    expect(isAllowedCpaEndpoint('GET', '/v1/models')).toBe(true);
    expect(isAllowedCpaEndpoint('GET', '/v0/management/config')).toBe(false);
    expect(isAllowedCpaEndpoint('GET', '/usage-queue')).toBe(false);
    expect(isAllowedCpaEndpoint('POST', '/v1/chat/completions')).toBe(false);
  });
});
