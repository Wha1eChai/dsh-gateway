import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import {
  FIXED_AUTH_CODE,
  FIXED_DEVICE_CODE,
  FIXED_GATEWAY_USER_AGENT,
  FIXED_LOCAL_STATE,
  FIXED_USER_CODE,
  FIXED_WHAM_USAGE_URL,
  startFakeCpa,
} from '../index.js';

async function jsonResponse(response) {
  return response.json();
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for fixture state');
}

async function withFixture(t, options, callback) {
  const fixture = await startFakeCpa(options);
  t.after(async () => fixture.close());
  return callback(fixture);
}

test('rejects an explicit Fetch-forbidden port before starting', async () => {
  await assert.rejects(startFakeCpa({ port: 6000 }), /port 6000 is forbidden by Fetch/);
});

test('starts on loopback and exposes deterministic health, capability, and model probes', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    assert.equal(fixture.address.host, '127.0.0.1');
    assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await jsonResponse(await fetch(`${fixture.url}/healthz`));
    assert.deepEqual(health, {
      status: 'ok',
      version: '0.1.0-fixture',
      capabilities: {
        protocol: 'openai-compatible',
        chat_completions: true,
        responses: true,
        streaming: true,
        tools: true,
        images: 'explicit-opt-in',
        management: ['auth-files', 'usage-queue', 'fixed-api-call'],
        oauth: ['device', 'local-callback'],
      },
      loopback_only: true,
    });
    assert.deepEqual(await jsonResponse(await fetch(`${fixture.url}/version`)), {
      name: 'fake-cpa',
      version: '0.1.0-fixture',
      protocol: 'openai-compatible',
    });
    const capabilities = await jsonResponse(await fetch(`${fixture.url}/v1/capabilities`));
    assert.equal(capabilities.models['fake-vision-model'].image_input, true);
    const models = await jsonResponse(await fetch(`${fixture.url}/v1/models`));
    assert.deepEqual(models.data.map(({ id, object, created, owned_by, ...rest }) => ({ id, object, created, owned_by, rest })), [
      { id: 'fake-text-model', object: 'model', created: 0, owned_by: 'fake-cpa', rest: {} },
      { id: 'fake-vision-model', object: 'model', created: 0, owned_by: 'fake-cpa', rest: {} },
    ]);
    assert.equal((await fetch(`${fixture.url}/__fake-control`)).status, 404);
  });
});

test('serves text and records the observed OpenAI request and response', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    const response = await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-text-model', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello from fake CPA.');
    assert.equal(body.choices[0].finish_reason, 'stop');
    const observed = await fixture.waitForRequest({ path: '/v1/chat/completions', method: 'POST' });
    assert.deepEqual(observed.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(observed.response.status, 200);
    assert.equal(observed.response.body.choices[0].message.content, 'Hello from fake CPA.');
  });
});

test('emits ordered streaming deltas and a terminal done marker', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    const response = await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-text-model', stream: true, messages: [{ role: 'user', content: 'stream' }] }),
    });
    assert.equal(response.status, 200);
    const lines = (await response.text()).split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(lines.at(-1), 'data: [DONE]');
    const events = lines.slice(0, -1).map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events.map((event) => event.choices[0].delta.content).filter(Boolean), ['Hello from', ' fake CPA.']);
    assert.equal(events.at(-1).choices[0].finish_reason, 'stop');
    assert.equal(fixture.getLastRequest('/v1/chat/completions').response.events.length, 3);
  });
});

test('supports tool declaration/result round trips and requires explicit image opt-in', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
    const first = await jsonResponse(await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-text-model', messages: [{ role: 'user', content: 'weather' }], tools }),
    }));
    const toolCall = first.choices[0].message.tool_calls[0];
    assert.equal(toolCall.id, 'call_fake_001');
    assert.equal(toolCall.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(toolCall.function.arguments), { city: 'San Francisco' });
    assert.equal(first.choices[0].finish_reason, 'tool_calls');

    const second = await jsonResponse(await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-text-model',
        messages: [
          { role: 'user', content: 'weather' },
          { role: 'assistant', content: null, tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: toolCall.id, content: '72 degrees' },
        ],
        tools,
      }),
    }));
    assert.equal(second.choices[0].message.content, 'Tool result received.');

    const streamedTool = await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-text-model', stream: true, messages: [{ role: 'user', content: 'weather' }], tools }),
    });
    const streamedToolEvents = (await streamedTool.text()).split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(streamedToolEvents.map((event) => event.choices[0].finish_reason).filter(Boolean), ['tool_calls']);
    assert.equal(streamedToolEvents[1].choices[0].delta.tool_calls[0].function.arguments, '{"city":"San Francisco"}');

    const image = [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }];
    const rejected = await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-text-model', messages: [{ role: 'user', content: image }] }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'image_input_not_enabled');

    const accepted = await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-vision-model', messages: [{ role: 'user', content: image }] }),
    });
    assert.equal(accepted.status, 200);
  });
});

test('observes an aborted delayed request without replaying it', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    fixture.setBehavior('/v1/chat/completions', { delayMs: 500, abortObservable: true });
    const controller = new AbortController();
    const request = fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-text-model', messages: [{ role: 'user', content: 'abort' }] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await assert.rejects(request);
    await waitUntil(() => fixture.getLastRequest('/v1/chat/completions')?.aborted === true);
    const observed = fixture.getLastRequest('/v1/chat/completions');
    assert.equal(observed.abortObservable, true);
    assert.equal(observed.response.completed, false);
    assert.equal(fixture.requests.filter((item) => item.path === '/v1/chat/completions').length, 1);
  });
});

test('returns only the allowlisted auth-files projection', async (t) => {
  await withFixture(t, {
    authFiles: [{ authIndex: 'internal-0', accountId: 'fixture-account', providerId: 'openai-codex', healthStatus: 'healthy', reasonCode: 'ok', observedAtMs: 123 }],
  }, async (fixture) => {
    const result = await jsonResponse(await fetch(`${fixture.url}/v0/management/auth-files`));
    assert.deepEqual(result, {
      data: [{
        provider_id: 'openai-codex',
        account_id_hash: 'sha256:55b47e1bd7721b5f779ed06721903800d5e9797d2ef285d3e83be0ce3ca167ed',
        health_status: 'healthy',
        reason_code: 'ok',
        observed_at_ms: 123,
      }],
    });
    assert.equal('authIndex' in result.data[0], false);
    assert.equal('accountId' in result.data[0], false);
    assert.equal('token' in result.data[0], false);
  });
});

test('pops usage items destructively and offers no acknowledgement route', async (t) => {
  await withFixture(t, { usageQueue: [{ event_id: 'first' }, { event_id: 'second' }] }, async (fixture) => {
    assert.deepEqual(await jsonResponse(await fetch(`${fixture.url}/usage-queue`)), { event_id: 'first' });
    assert.deepEqual(await jsonResponse(await fetch(`${fixture.url}/usage-queue`)), { event_id: 'second' });
    assert.equal((await fetch(`${fixture.url}/usage-queue`)).status, 204);
    assert.equal((await fetch(`${fixture.url}/usage-queue/ack`, { method: 'POST' })).status, 404);
  });
});

test('accepts only the fixed Codex wham usage api-call payload', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    const fixed = {
      authIndex: fixture.allowlistedAuthIndices[0],
      method: 'GET',
      url: FIXED_WHAM_USAGE_URL,
      headers: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': FIXED_GATEWAY_USER_AGENT,
      },
    };
    const accepted = await fetch(`${fixture.url}/v0/management/api-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixed),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      provider_id: 'openai-codex',
      quota_windows: [{ kind: 'messages', unit: 'request', limit: 100, used: 25, remaining: 75, reset_at_ms: 1_700_000_000_000 }],
    });

    for (const mutation of [
      { ...fixed, url: 'https://example.invalid/arbitrary' },
      { ...fixed, method: 'POST' },
      { ...fixed, headers: { ...fixed.headers, 'X-Arbitrary': 'nope' } },
      { ...fixed, authIndex: 'not-allowlisted' },
    ]) {
      const rejected = await fetch(`${fixture.url}/v0/management/api-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mutation),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, 'fixed_payload_required');
    }
  });
});

test('exposes bounded device and one-shot local callback OAuth fixtures without tokens', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    const start = await jsonResponse(await fetch(`${fixture.url}/v0/management/oauth/device/start`, { method: 'POST' }));
    assert.deepEqual(start, {
      status: 'started',
      device_code: FIXED_DEVICE_CODE,
      user_code: FIXED_USER_CODE,
      verification_uri: 'https://example.invalid/fixture-device',
      expires_in: 600,
      interval: 5,
    });
    assert.equal('access_token' in start, false);
    assert.equal((await fetch(`${fixture.url}/v0/management/oauth/device/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: FIXED_DEVICE_CODE }),
    })).status, 428);
    fixture.setOAuthState({ deviceStatus: 'success' });
    const authorized = await jsonResponse(await fetch(`${fixture.url}/v0/management/oauth/device/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: FIXED_DEVICE_CODE }),
    }));
    assert.deepEqual(authorized, { status: 'authorized', provider_id: 'openai-codex', account_id_hash: 'sha256:a1d53e698d2f03d396bb2e7e09a64612d3bbab3dd4de7e8c2206b32432f79070' });

    assert.equal((await fetch(`${fixture.url}/oauth/callback?state=${FIXED_LOCAL_STATE}&code=${FIXED_AUTH_CODE}`)).status, 503);
    fixture.setOAuthState({ localEnabled: true });
    assert.equal((await fetch(`${fixture.url}/oauth/callback?state=wrong&code=${FIXED_AUTH_CODE}`)).status, 400);
    assert.deepEqual(await jsonResponse(await fetch(`${fixture.url}/oauth/callback?state=${FIXED_LOCAL_STATE}&code=${FIXED_AUTH_CODE}`)), {
      status: 'authorized', provider_id: 'openai-codex',
    });
    assert.equal((await fetch(`${fixture.url}/oauth/callback?state=${FIXED_LOCAL_STATE}&code=${FIXED_AUTH_CODE}`)).status, 409);
  });
});

test('keeps malformed, oversized, error, and crash controls programmatic-only', async (t) => {
  await withFixture(t, {}, async (fixture) => {
    fixture.enqueueBehavior('/v1/chat/completions', { error: { status: 503, code: 'upstream_down', message: 'deterministic failure' } });
    const error = await fetch(`${fixture.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-text-model' }) });
    assert.equal(error.status, 503);
    assert.equal((await error.json()).error.code, 'upstream_down');

    fixture.enqueueBehavior('/v1/chat/completions', { malformed: true });
    const malformed = await fetch(`${fixture.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-text-model' }) });
    assert.equal(malformed.status, 200);
    await assert.rejects(malformed.json());

    fixture.enqueueBehavior('/v1/chat/completions', { oversizedBytes: 1_048_577 });
    const oversized = await fetch(`${fixture.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-text-model' }) });
    assert.equal(oversized.status, 200);
    assert.equal((await oversized.arrayBuffer()).byteLength, 1_048_577);

    fixture.enqueueBehavior('/v1/chat/completions', { crash: true });
    await assert.rejects(fetch(`${fixture.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-text-model' }) }));
    assert.equal((await fetch(`${fixture.url}/__control?error=503`)).status, 404);
  });
});

test('CLI prints a ready record and remains loopback-only', async () => {
  const cliPath = join(import.meta.dirname, '..', 'cli.js');
  const child = spawn(process.execPath, [cliPath, '--port', '0'], { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not become ready: ${stderr}`)), 3_000);
    child.stdout.on('data', () => {
      const line = stdout.split('\n').find((entry) => entry.length > 0);
      if (!line) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}`));
    });
  });
  assert.equal(ready.event, 'ready');
  assert.equal(ready.host, '127.0.0.1');
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code === 0 || signal === 'SIGTERM', true);
});
