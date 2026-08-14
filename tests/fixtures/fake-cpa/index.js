import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_VERSION = '0.1.0-fixture';
export const DEFAULT_MODEL_ID = 'fake-text-model';
export const DEFAULT_IMAGE_MODEL_ID = 'fake-vision-model';
export const FIXED_GATEWAY_USER_AGENT = 'dsh-gateway-fake-cpa/0.1';
export const FIXED_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const FIXED_DEVICE_CODE = 'fixture-device-code';
export const FIXED_USER_CODE = 'FIXTURE-0001';
export const FIXED_LOCAL_STATE = 'fixture-local-state';
export const FIXED_AUTH_CODE = 'fixture-auth-code';

const MAX_BEHAVIOR_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVED_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const BEHAVIOR_PATHS = new Set([
  '/healthz',
  '/version',
  '/v1/capabilities',
  '/v1/models',
  '/v1/chat/completions',
  '/v1/responses',
  '/usage-queue',
  '/v0/management/auth-files',
  '/v0/management/api-call',
  '/v0/management/oauth/device/start',
  '/v0/management/oauth/device/poll',
  '/v0/management/oauth/local/callback',
  '/oauth/callback',
]);
const OAUTH_STATUSES = new Set(['pending', 'success', 'denied', 'expired', 'cancelled']);
const HEALTH_STATUSES = new Set(['healthy', 'unhealthy', 'unknown', 'unavailable']);

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, name, { max = 256, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new TypeError(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${max} characters`);
  }
  return value;
}

function boundedInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function fixedAccountHash(accountId) {
  return `sha256:${createHash('sha256').update(accountId).digest('hex')}`;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127\./.test(host);
}

function normalizeBehavior(behavior = {}) {
  if (!isObject(behavior)) throw new TypeError('behavior must be an object');
  const allowed = new Set([
    'delayMs',
    'streamDelayMs',
    'error',
    'malformed',
    'oversizedBytes',
    'crash',
    'abortObservable',
    'responseText',
    'streamDeltas',
    'toolArguments',
    'failAfterChunks',
  ]);
  for (const key of Object.keys(behavior)) {
    if (!allowed.has(key)) throw new TypeError(`unsupported behavior control: ${key}`);
  }
  const result = {};
  if (behavior.delayMs !== undefined) {
    result.delayMs = boundedInteger(behavior.delayMs, 'delayMs', { max: 30_000 });
  }
  if (behavior.streamDelayMs !== undefined) {
    result.streamDelayMs = boundedInteger(behavior.streamDelayMs, 'streamDelayMs', { max: 30_000 });
  }
  if (behavior.error !== undefined && behavior.error !== null) {
    if (!isObject(behavior.error)) throw new TypeError('error behavior must be an object or null');
    const errorKeys = new Set(['status', 'code', 'message']);
    if (Object.keys(behavior.error).some((key) => !errorKeys.has(key))) {
      throw new TypeError('error behavior contains an unsupported field');
    }
    result.error = {
      status: boundedInteger(behavior.error.status ?? 500, 'error.status', { min: 400, max: 599 }),
      code: boundedString(behavior.error.code ?? 'fixture_error', 'error.code', { max: 64 }),
      message: boundedString(behavior.error.message ?? 'fixture error', 'error.message', { max: 256 }),
    };
  } else if (behavior.error === null) {
    result.error = null;
  }
  if (behavior.malformed !== undefined) {
    if (typeof behavior.malformed === 'boolean') {
      result.malformed = behavior.malformed;
    } else if (isObject(behavior.malformed)) {
      const malformedKeys = new Set(['body', 'contentType']);
      if (Object.keys(behavior.malformed).some((key) => !malformedKeys.has(key))) {
        throw new TypeError('malformed behavior contains an unsupported field');
      }
      result.malformed = {
        body: boundedString(behavior.malformed.body ?? '{malformed-json', 'malformed.body', { max: MAX_BEHAVIOR_BYTES }),
        contentType: boundedString(behavior.malformed.contentType ?? 'application/json', 'malformed.contentType', { max: 128 }),
      };
    } else {
      throw new TypeError('malformed behavior must be a boolean, object, or omitted');
    }
  }
  if (behavior.oversizedBytes !== undefined) {
    result.oversizedBytes = boundedInteger(behavior.oversizedBytes, 'oversizedBytes', {
      min: DEFAULT_MAX_RESPONSE_BYTES + 1,
      max: MAX_BEHAVIOR_BYTES,
    });
  }
  for (const key of ['crash', 'abortObservable']) {
    if (behavior[key] !== undefined && typeof behavior[key] !== 'boolean') {
      throw new TypeError(`${key} must be a boolean`);
    }
    if (behavior[key] !== undefined) result[key] = behavior[key];
  }
  if (behavior.responseText !== undefined) {
    result.responseText = boundedString(behavior.responseText, 'responseText', { max: 32_768, allowEmpty: true });
  }
  if (behavior.streamDeltas !== undefined) {
    if (!Array.isArray(behavior.streamDeltas) || behavior.streamDeltas.length > 64) {
      throw new TypeError('streamDeltas must be an array with at most 64 entries');
    }
    result.streamDeltas = behavior.streamDeltas.map((delta, index) =>
      boundedString(delta, `streamDeltas[${index}]`, { max: 4096, allowEmpty: true }),
    );
  }
  if (behavior.toolArguments !== undefined) {
    if (!isObject(behavior.toolArguments)) throw new TypeError('toolArguments must be an object');
    result.toolArguments = clone(behavior.toolArguments);
  }
  if (behavior.failAfterChunks !== undefined) {
    result.failAfterChunks = boundedInteger(behavior.failAfterChunks, 'failAfterChunks', { min: 1, max: 64 });
  }
  return result;
}

function normalizePath(path) {
  if (typeof path !== 'string') throw new TypeError('path must be a string');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!BEHAVIOR_PATHS.has(normalized)) throw new TypeError(`unsupported fixture behavior path: ${normalized}`);
  return normalized;
}

function normalizeAuthFile(file, index) {
  if (!isObject(file)) throw new TypeError(`authFiles[${index}] must be an object`);
  const authIndex = boundedString(file.authIndex ?? `fixture-auth-${index}`, `authFiles[${index}].authIndex`, { max: 128 });
  const accountId = boundedString(file.accountId ?? `fixture-account-${index}`, `authFiles[${index}].accountId`, { max: 128 });
  const providerId = boundedString(file.providerId ?? 'openai-codex', `authFiles[${index}].providerId`, { max: 128 });
  const accountIdHash = boundedString(file.accountIdHash ?? fixedAccountHash(accountId), `authFiles[${index}].accountIdHash`, { max: 128 });
  const healthStatus = file.healthStatus ?? 'healthy';
  if (!HEALTH_STATUSES.has(healthStatus)) throw new TypeError(`authFiles[${index}].healthStatus is invalid`);
  const reasonCode = boundedString(file.reasonCode ?? 'ok', `authFiles[${index}].reasonCode`, { max: 64 });
  const observedAtMs = boundedInteger(file.observedAtMs ?? 0, `authFiles[${index}].observedAtMs`);
  return { authIndex, accountId, providerId, accountIdHash, healthStatus, reasonCode, observedAtMs };
}

function projectionOfAuthFile(file) {
  return {
    provider_id: file.providerId,
    account_id_hash: file.accountIdHash,
    health_status: file.healthStatus,
    reason_code: file.reasonCode,
    observed_at_ms: file.observedAtMs,
  };
}

function normalizeModels(models) {
  const source = models ?? [
    { id: DEFAULT_MODEL_ID, ownedBy: 'fake-cpa' },
    { id: DEFAULT_IMAGE_MODEL_ID, ownedBy: 'fake-cpa' },
  ];
  if (!Array.isArray(source) || source.length === 0 || source.length > 64) {
    throw new TypeError('models must be a non-empty array with at most 64 entries');
  }
  return source.map((model, index) => {
    if (typeof model === 'string') return { id: boundedString(model, `models[${index}]`, { max: 128 }), ownedBy: 'fake-cpa' };
    if (!isObject(model)) throw new TypeError(`models[${index}] must be a string or object`);
    return {
      id: boundedString(model.id, `models[${index}].id`, { max: 128 }),
      ownedBy: boundedString(model.ownedBy ?? 'fake-cpa', `models[${index}].ownedBy`, { max: 128 }),
    };
  });
}

function normalizeQuotaResponse(response) {
  if (!isObject(response)) throw new TypeError('quotaResponse must be an object');
  const encoded = JSON.stringify(response);
  if (encoded.length > DEFAULT_MAX_RESPONSE_BYTES) throw new TypeError('quotaResponse is too large');
  return clone(response);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function hasImageInput(payload) {
  if (!isObject(payload)) return false;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const messageImage = messages.some((message) => {
    if (!isObject(message) || !Array.isArray(message.content)) return false;
    return message.content.some((part) => isObject(part) && ['image_url', 'input_image'].includes(part.type));
  });
  if (messageImage) return true;
  const input = Array.isArray(payload.input) ? payload.input : [];
  return input.some((item) => isObject(item) && Array.isArray(item.content)
    && item.content.some((part) => isObject(part) && ['image_url', 'input_image'].includes(part.type)));
}

function hasToolResult(payload) {
  return Array.isArray(payload?.messages) && payload.messages.some(
    (message) => isObject(message) && ['tool', 'function'].includes(message.role),
  );
}

function toolDeclaration(payload) {
  if (!Array.isArray(payload?.tools)) return undefined;
  return payload.tools.find(
    (tool) => isObject(tool) && tool.type === 'function' && isObject(tool.function) && typeof tool.function.name === 'string',
  );
}

function safeHeaderRecord(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value)]));
}

function responseHeaders(contentType) {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

export class FakeCpaServer extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!isObject(options)) throw new TypeError('options must be an object');
    this.host = options.host ?? DEFAULT_HOST;
    if (!isLoopbackHost(this.host)) throw new TypeError('fake CPA only binds loopback hosts');
    this.port = boundedInteger(options.port ?? 0, 'port', { max: 65_535 });
    this.version = boundedString(options.version ?? DEFAULT_VERSION, 'version', { max: 64 });
    this.maxRequestBytes = boundedInteger(options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES, 'maxRequestBytes', {
      min: 1024,
      max: 16 * 1024 * 1024,
    });
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes', {
      min: 1024,
      max: 16 * 1024 * 1024,
    });
    this.fixedUserAgent = boundedString(options.fixedUserAgent ?? FIXED_GATEWAY_USER_AGENT, 'fixedUserAgent', { max: 128 });
    this.managementToken = options.managementToken === undefined ? undefined : boundedString(options.managementToken, 'managementToken', { max: 256 });
    this.models = normalizeModels(options.models);
    this.imageModels = new Set((options.imageModels ?? [DEFAULT_IMAGE_MODEL_ID]).map((model, index) =>
      boundedString(model, `imageModels[${index}]`, { max: 128 }),
    ));
    this.authFiles = (options.authFiles ?? [{}]).map(normalizeAuthFile);
    this.authFileByIndex = new Map(this.authFiles.map((file) => [file.authIndex, file]));
    this.quotaResponse = normalizeQuotaResponse(options.quotaResponse ?? {
      provider_id: 'openai-codex',
      quota_windows: [
        { kind: 'messages', unit: 'request', limit: 100, used: 25, remaining: 75, reset_at_ms: 1_700_000_000_000 },
      ],
    });
    this.usageQueue = (options.usageQueue ?? []).map((item, index) => {
      if (!isObject(item)) throw new TypeError(`usageQueue[${index}] must be an object`);
      const encoded = JSON.stringify(item);
      if (encoded.length > 256 * 1024) throw new TypeError(`usageQueue[${index}] is too large`);
      return clone(item);
    });
    this._oauth = {
      deviceStatus: options.oauth?.deviceStatus ?? 'pending',
      localEnabled: options.oauth?.localEnabled ?? false,
      localStatus: options.oauth?.localStatus ?? 'pending',
      localConsumed: false,
    };
    this._validateOauthState();
    this._server = createServer((request, response) => {
      this._handle(request, response).catch((error) => this._handleUnexpectedError(request, response, error));
    });
    this._sockets = new Set();
    this._server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.once('close', () => this._sockets.delete(socket));
    });
    this._requests = [];
    this._sequence = 0;
    this._behaviors = new Map();
    this._behaviorQueues = new Map();
    this._running = false;
  }

  get url() {
    if (!this._running) throw new Error('fake CPA server is not started');
    return `http://${this.host}:${this.port}`;
  }

  get baseUrl() {
    return this.url;
  }

  get address() {
    if (!this._running) return undefined;
    return { host: this.host, port: this.port };
  }

  get requests() {
    return clone(this._requests);
  }

  get observations() {
    return this.requests;
  }

  get allowlistedAuthIndices() {
    return this.authFiles.map((file) => file.authIndex);
  }

  get oauthState() {
    return clone(this._oauth);
  }

  async start() {
    if (this._running) return this;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this._server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this._server.off('error', onError);
        const actual = this._server.address();
        this.port = typeof actual === 'object' && actual ? actual.port : this.port;
        this._running = true;
        resolve();
      };
      this._server.once('error', onError);
      this._server.once('listening', onListening);
      this._server.listen({ host: this.host, port: this.port });
    });
    return this;
  }

  async close() {
    if (!this._running) return;
    for (const socket of this._sockets) socket.destroy();
    await new Promise((resolve, reject) => {
      this._server.close((error) => (error ? reject(error) : resolve()));
    });
    this._running = false;
  }

  setBehavior(pathOrOptions, behavior) {
    const { path, controls } = this._splitBehaviorArguments(pathOrOptions, behavior);
    this._behaviors.set(path, normalizeBehavior(controls));
    return this;
  }

  configureBehavior(pathOrOptions, behavior) {
    return this.setBehavior(pathOrOptions, behavior);
  }

  enqueueBehavior(pathOrOptions, behavior) {
    const { path, controls } = this._splitBehaviorArguments(pathOrOptions, behavior);
    const queue = this._behaviorQueues.get(path) ?? [];
    queue.push(normalizeBehavior(controls));
    this._behaviorQueues.set(path, queue);
    return this;
  }

  clearBehavior(path) {
    const normalized = normalizePath(path);
    this._behaviors.delete(normalized);
    this._behaviorQueues.delete(normalized);
    return this;
  }

  enqueueUsage(item) {
    if (!isObject(item)) throw new TypeError('usage item must be an object');
    if (JSON.stringify(item).length > 256 * 1024) throw new TypeError('usage item is too large');
    this.usageQueue.push(clone(item));
    return this;
  }

  setOAuthState(state = {}) {
    if (!isObject(state)) throw new TypeError('OAuth state must be an object');
    if (state.deviceStatus !== undefined) this._oauth.deviceStatus = state.deviceStatus;
    if (state.localStatus !== undefined) this._oauth.localStatus = state.localStatus;
    if (state.localEnabled !== undefined) this._oauth.localEnabled = state.localEnabled;
    if (state.localConsumed !== undefined) this._oauth.localConsumed = state.localConsumed;
    this._validateOauthState();
    return this;
  }

  async waitForRequest({ path, method, timeoutMs = 2_000, predicate } = {}) {
    const expectedPath = path === undefined ? undefined : normalizePath(path);
    const expectedMethod = method?.toUpperCase();
    const matching = this._requests.find((request) => this._matchesRequest(request, expectedPath, expectedMethod, predicate));
    if (matching) return clone(matching);
    boundedInteger(timeoutMs, 'timeoutMs', { min: 1, max: 60_000 });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('request', onRequest);
        reject(new Error(`timed out waiting for ${expectedMethod ?? '*'} ${expectedPath ?? '*'}`));
      }, timeoutMs);
      const onRequest = (request) => {
        if (!this._matchesRequest(request, expectedPath, expectedMethod, predicate)) return;
        clearTimeout(timer);
        this.off('request', onRequest);
        resolve(clone(request));
      };
      this.on('request', onRequest);
    });
  }

  getLastRequest(path) {
    const expectedPath = normalizePath(path);
    const matching = [...this._requests].reverse().find((request) => request.path === expectedPath);
    return matching ? clone(matching) : undefined;
  }

  _splitBehaviorArguments(pathOrOptions, behavior) {
    if (typeof pathOrOptions === 'string') return { path: normalizePath(pathOrOptions), controls: behavior ?? {} };
    if (isObject(pathOrOptions) && typeof pathOrOptions.path === 'string') {
      const { path, ...controls } = pathOrOptions;
      return { path: normalizePath(path), controls };
    }
    throw new TypeError('setBehavior requires a path and behavior controls');
  }

  _validateOauthState() {
    if (!OAUTH_STATUSES.has(this._oauth.deviceStatus) || !OAUTH_STATUSES.has(this._oauth.localStatus)) {
      throw new TypeError('OAuth status must be pending, success, denied, expired, or cancelled');
    }
    if (typeof this._oauth.localEnabled !== 'boolean' || typeof this._oauth.localConsumed !== 'boolean') {
      throw new TypeError('OAuth localEnabled/localConsumed must be boolean');
    }
  }

  _matchesRequest(request, path, method, predicate) {
    return (path === undefined || request.path === path)
      && (method === undefined || request.method === method)
      && (predicate === undefined || predicate(request));
  }

  _nextBehavior(path) {
    const queue = this._behaviorQueues.get(path);
    if (queue?.length) return queue.shift();
    return this._behaviors.get(path) ?? {};
  }

  _recordRequest(request, url, bodyResult) {
    const sequence = ++this._sequence;
    const observation = {
      id: `fixture-request-${String(sequence).padStart(4, '0')}`,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: safeHeaderRecord(request.headers),
      body: bodyResult.parsed,
      rawBody: bodyResult.raw.length <= MAX_OBSERVED_BODY_BYTES ? bodyResult.raw : undefined,
      requestTooLarge: bodyResult.tooLarge,
      abortObservable: false,
      aborted: false,
      response: undefined,
    };
    this._requests.push(observation);
    this.emit('request', clone(observation));
    return observation;
  }

  _attachLifecycle(request, response, observation) {
    const markAborted = () => {
      if (observation.response?.completed) return;
      observation.aborted = true;
      observation.response ??= { completed: false, aborted: true };
      observation.response.aborted = true;
      this.emit('response-aborted', clone(observation));
    };
    request.once('aborted', markAborted);
    response.once('close', () => {
      if (!response.writableEnded) markAborted();
    });
  }

  _complete(observation, status, headers, rawBody, { events } = {}) {
    const contentType = headers['content-type'] ?? '';
    let body;
    if (rawBody.length <= MAX_OBSERVED_BODY_BYTES && contentType.includes('json')) {
      body = parseJson(rawBody);
    }
    if (body === undefined && rawBody.length <= MAX_OBSERVED_BODY_BYTES) body = rawBody;
    observation.response = {
      status,
      headers: clone(headers),
      body,
      bytes: Buffer.byteLength(rawBody),
      completed: true,
      ...(events ? { events: clone(events) } : {}),
    };
    this.emit('response', clone(observation));
  }

  async _readBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return { raw: '', parsed: undefined, tooLarge: false };
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      const onAborted = () => reject(new Error('request aborted while reading body'));
      request.once('aborted', onAborted);
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size <= this.maxRequestBytes) chunks.push(chunk);
        else tooLarge = true;
      });
      request.once('error', reject);
      request.once('end', () => {
        request.off('aborted', onAborted);
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ raw, parsed: tooLarge ? undefined : parseJson(raw), tooLarge });
      });
    });
  }

  async _delay(request, response, observation, delayMs) {
    if (!delayMs) return true;
    if (observation.aborted) return false;
    return new Promise((resolve) => {
      let finished = false;
      const timer = setTimeout(() => finish(true), delayMs);
      const finish = (continueResponse) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        request.off('aborted', onAbort);
        response.off('close', onClose);
        resolve(continueResponse);
      };
      const onAbort = () => finish(false);
      const onClose = () => {
        if (!response.writableEnded) finish(false);
      };
      request.once('aborted', onAbort);
      response.once('close', onClose);
      if (request.aborted || response.destroyed) finish(false);
    });
  }

  async _applyBehavior(request, response, observation, behavior, { stream = false } = {}) {
    if (behavior.abortObservable) observation.abortObservable = true;
    if (!(await this._delay(request, response, observation, behavior.delayMs ?? 0))) return true;
    if (observation.aborted || response.destroyed) return true;
    if (behavior.crash) {
      observation.response = { completed: false, crashed: true, aborted: true };
      request.socket.destroy();
      return true;
    }
    if (behavior.error) {
      this._sendJson(response, observation, behavior.error.status, {
        error: { code: behavior.error.code, message: behavior.error.message },
      });
      return true;
    }
    if (behavior.oversizedBytes) {
      const body = 'x'.repeat(behavior.oversizedBytes);
      this._sendRaw(response, observation, 200, body, responseHeaders('application/json'));
      return true;
    }
    if (behavior.malformed) {
      const malformed = typeof behavior.malformed === 'object'
        ? behavior.malformed
        : { body: stream ? 'data: {"malformed"\n\n' : '{malformed-json', contentType: stream ? 'text/event-stream' : 'application/json' };
      this._sendRaw(response, observation, 200, malformed.body, responseHeaders(malformed.contentType));
      return true;
    }
    return false;
  }

  _sendRaw(response, observation, status, body, headers) {
    if (response.destroyed || response.writableEnded) return;
    const finalHeaders = { ...headers, 'content-length': String(Buffer.byteLength(body)) };
    response.writeHead(status, finalHeaders);
    response.end(body);
    this._complete(observation, status, finalHeaders, body);
  }

  _sendJson(response, observation, status, payload) {
    const body = JSON.stringify(payload);
    this._sendRaw(response, observation, status, body, responseHeaders('application/json; charset=utf-8'));
  }

  async _handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${this.host}:${this.port}`}`);
    const bodyResult = await this._readBody(request);
    const observation = this._recordRequest(request, url, bodyResult);
    this._attachLifecycle(request, response, observation);
    if (bodyResult.tooLarge) {
      this._sendJson(response, observation, 413, { error: { code: 'request_too_large', message: 'request body exceeds fixture limit' } });
      return;
    }
    if (observation.aborted) return;
    const behavior = this._nextBehavior(url.pathname);
    const body = bodyResult.parsed;
    if (request.method === 'GET' && url.pathname === '/healthz') return this._handleHealth(request, response, observation, behavior);
    if (request.method === 'GET' && url.pathname === '/version') return this._handleVersion(request, response, observation, behavior);
    if (request.method === 'GET' && url.pathname === '/v1/capabilities') return this._handleCapabilities(request, response, observation, behavior);
    if (request.method === 'GET' && url.pathname === '/v1/models') return this._handleModels(request, response, observation, behavior);
    if (request.method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) {
      if (body === undefined) {
        this._sendJson(response, observation, 400, { error: { code: 'invalid_json', message: 'request body must be valid JSON' } });
        return;
      }
      return url.pathname === '/v1/chat/completions'
        ? this._handleChat(request, response, observation, body, behavior)
        : this._handleResponses(request, response, observation, body, behavior);
    }
    if (request.method === 'GET' && url.pathname === '/usage-queue') return this._handleUsageQueue(request, response, observation, behavior);
    if (request.method === 'GET' && url.pathname === '/v0/management/auth-files') return this._handleAuthFiles(request, response, observation, behavior);
    if (request.method === 'POST' && url.pathname === '/v0/management/api-call') return this._handleApiCall(request, response, observation, body, behavior);
    if (request.method === 'POST' && url.pathname === '/v0/management/oauth/device/start') return this._handleDeviceStart(request, response, observation, behavior);
    if (request.method === 'POST' && url.pathname === '/v0/management/oauth/device/poll') return this._handleDevicePoll(request, response, observation, body, behavior);
    if (request.method === 'GET' && ['/v0/management/oauth/local/callback', '/oauth/callback'].includes(url.pathname)) {
      return this._handleLocalCallback(request, response, observation, url, behavior);
    }
    this._sendJson(response, observation, 404, { error: { code: 'not_found', message: 'fixture route not found' } });
  }

  async _handleHealth(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    this._sendJson(response, observation, 200, {
      status: 'ok',
      version: this.version,
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
  }

  async _handleVersion(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    this._sendJson(response, observation, 200, { name: 'fake-cpa', version: this.version, protocol: 'openai-compatible' });
  }

  async _handleCapabilities(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    this._sendJson(response, observation, 200, {
      version: this.version,
      models: Object.fromEntries(this.models.map((model) => [model.id, {
        text: true,
        tools: true,
        image_input: this.imageModels.has(model.id),
      }])),
    });
  }

  async _handleModels(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    this._sendJson(response, observation, 200, {
      object: 'list',
      data: this.models.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: model.ownedBy })),
    });
  }

  async _handleChat(request, response, observation, payload, behavior) {
    const validation = this._validateModelPayload(payload);
    if (validation) {
      this._sendJson(response, observation, validation.status, { error: { code: validation.code, message: validation.message } });
      return;
    }
    if (await this._applyBehavior(request, response, observation, behavior, { stream: payload.stream === true })) return;
    const model = payload.model;
    const tool = toolDeclaration(payload);
    const toolResult = hasToolResult(payload);
    const id = `chatcmpl-fake-${String(observation.id.split('-').pop()).padStart(4, '0')}`;
    const text = toolResult ? 'Tool result received.' : (behavior.responseText ?? 'Hello from fake CPA.');
    const args = JSON.stringify(behavior.toolArguments ?? { city: 'San Francisco' });
    if (payload.stream === true) {
      const chunks = tool && !toolResult
        ? [
          { id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fake_001', type: 'function', function: { name: tool.function.name, arguments: '' } }] }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] },
        ]
        : (behavior.streamDeltas ?? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))])
          .filter((delta) => delta.length > 0)
          .map((delta, index) => ({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: delta }, finish_reason: null }] }));
      chunks.push({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: tool && !toolResult ? 'tool_calls' : 'stop' }] });
      await this._sendSse(request, response, observation, chunks, behavior, payload.stream_options?.include_usage === true ? { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } : undefined);
      return;
    }
    const message = tool && !toolResult
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fake_001', type: 'function', function: { name: tool.function.name, arguments: args } }] }
      : { role: 'assistant', content: text };
    this._sendJson(response, observation, 200, {
      id,
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message, finish_reason: tool && !toolResult ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
  }

  async _handleResponses(request, response, observation, payload, behavior) {
    const validation = this._validateModelPayload(payload, { responses: true });
    if (validation) {
      this._sendJson(response, observation, validation.status, { error: { code: validation.code, message: validation.message } });
      return;
    }
    if (await this._applyBehavior(request, response, observation, behavior, { stream: payload.stream === true })) return;
    const model = payload.model;
    const text = behavior.responseText ?? 'Hello from fake CPA.';
    const id = `resp-fake-${String(observation.id.split('-').pop()).padStart(4, '0')}`;
    if (payload.stream === true) {
      const chunks = (behavior.streamDeltas ?? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))])
        .filter((delta) => delta.length > 0)
        .map((delta) => ({ type: 'response.output_text.delta', response_id: id, delta }));
      chunks.push({ type: 'response.completed', response: { id, status: 'completed', model } });
      await this._sendSse(request, response, observation, chunks, behavior);
      return;
    }
    this._sendJson(response, observation, 200, {
      id,
      object: 'response',
      created_at: 0,
      model,
      status: 'completed',
      output_text: text,
      output: [{ type: 'message', id: `${id}-message`, role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
  }

  _validateModelPayload(payload, { responses = false } = {}) {
    if (!isObject(payload)) return { status: 400, code: 'invalid_request', message: 'request body must be an object' };
    if (typeof payload.model !== 'string' || payload.model.length === 0 || payload.model.length > 128) {
      return { status: 400, code: 'invalid_model', message: 'model must be a bounded non-empty string' };
    }
    if (!responses && payload.tools !== undefined && !Array.isArray(payload.tools)) {
      return { status: 400, code: 'invalid_tools', message: 'tools must be an array' };
    }
    if (hasImageInput(payload) && !this.imageModels.has(payload.model)) {
      return { status: 400, code: 'image_input_not_enabled', message: 'image input requires explicit model capability opt-in' };
    }
    return undefined;
  }

  async _sendSse(request, response, observation, events, behavior, usage) {
    if (response.destroyed || response.writableEnded) return;
    const headers = {
      ...responseHeaders('text/event-stream; charset=utf-8'),
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
    };
    response.writeHead(200, headers);
    const rawEvents = [];
    for (let index = 0; index < events.length; index += 1) {
      if (observation.aborted || response.destroyed) return;
      if (behavior.failAfterChunks !== undefined && index + 1 >= behavior.failAfterChunks) {
        request.socket.destroy();
        observation.response = { completed: false, crashed: true, aborted: true, events: clone(rawEvents) };
        return;
      }
      if (!(await this._delay(request, response, observation, behavior.streamDelayMs ?? 0))) return;
      const event = clone(events[index]);
      rawEvents.push(event);
      const line = `data: ${JSON.stringify(event)}\n\n`;
      if (!response.write(line)) await new Promise((resolve) => response.once('drain', resolve));
    }
    if (usage) {
      const usageLine = `data: ${JSON.stringify({ id: events[0]?.id, object: 'chat.completion.chunk', choices: [], usage })}\n\n`;
      response.write(usageLine);
    }
    response.end('data: [DONE]\n\n');
    this._complete(observation, 200, headers, `${rawEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}${usage ? `data: ${JSON.stringify({ id: events[0]?.id, object: 'chat.completion.chunk', choices: [], usage })}\n\n` : ''}data: [DONE]\n\n`, { events: rawEvents });
  }

  async _handleUsageQueue(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    const item = this.usageQueue.shift();
    if (item === undefined) {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      this._complete(observation, 204, { 'cache-control': 'no-store' }, '');
      return;
    }
    this._sendJson(response, observation, 200, item);
  }

  _managementAuthorized(request) {
    if (this.managementToken === undefined) return true;
    return request.headers.authorization === `Bearer ${this.managementToken}`;
  }

  async _handleAuthFiles(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    if (!this._managementAuthorized(request)) {
      this._sendJson(response, observation, 401, { error: { code: 'management_unauthorized', message: 'management authorization required' } });
      return;
    }
    this._sendJson(response, observation, 200, { data: this.authFiles.map(projectionOfAuthFile) });
  }

  async _handleApiCall(request, response, observation, payload, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    if (!this._managementAuthorized(request)) {
      this._sendJson(response, observation, 401, { error: { code: 'management_unauthorized', message: 'management authorization required' } });
      return;
    }
    const failure = this._validateFixedApiCall(payload);
    if (failure) {
      this._sendJson(response, observation, 400, { error: { code: 'fixed_payload_required', message: failure } });
      return;
    }
    this._sendJson(response, observation, 200, clone(this.quotaResponse));
  }

  _validateFixedApiCall(payload) {
    if (!isObject(payload)) return 'request body must be an object';
    if (Object.keys(payload).sort().join(',') !== 'authIndex,headers,method,url') return 'only the fixed Codex usage payload is accepted';
    if (!this.authFileByIndex.has(payload.authIndex)) return 'authIndex is not in the internal allowlist';
    if (payload.method !== 'GET' || payload.url !== FIXED_WHAM_USAGE_URL) return 'method or url is not the fixed Codex usage target';
    if (!isObject(payload.headers)) return 'headers must be an object';
    const headerKeys = Object.keys(payload.headers).sort();
    const allowedHeaderKeys = ['Authorization', 'Content-Type', 'User-Agent'];
    const selected = this.authFileByIndex.get(payload.authIndex);
    if (payload.headers['Chatgpt-Account-Id'] !== undefined) allowedHeaderKeys.push('Chatgpt-Account-Id');
    if (headerKeys.join(',') !== allowedHeaderKeys.sort().join(',')) return 'headers are not the fixed Gateway header set';
    if (payload.headers.Authorization !== 'Bearer $TOKEN$') return 'Authorization must use the fixture token marker';
    if (payload.headers['Content-Type'] !== 'application/json') return 'Content-Type must be application/json';
    if (payload.headers['User-Agent'] !== this.fixedUserAgent) return 'User-Agent is not the fixed Gateway User-Agent';
    if (payload.headers['Chatgpt-Account-Id'] !== undefined && payload.headers['Chatgpt-Account-Id'] !== selected.accountId) {
      return 'Chatgpt-Account-Id is not the selected internal account';
    }
    return undefined;
  }

  async _handleDeviceStart(request, response, observation, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    if (!this._managementAuthorized(request)) {
      this._sendJson(response, observation, 401, { error: { code: 'management_unauthorized', message: 'management authorization required' } });
      return;
    }
    this._sendJson(response, observation, 200, {
      status: 'started',
      device_code: FIXED_DEVICE_CODE,
      user_code: FIXED_USER_CODE,
      verification_uri: 'https://example.invalid/fixture-device',
      expires_in: 600,
      interval: 5,
    });
  }

  async _handleDevicePoll(request, response, observation, payload, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    if (!this._managementAuthorized(request)) {
      this._sendJson(response, observation, 401, { error: { code: 'management_unauthorized', message: 'management authorization required' } });
      return;
    }
    if (!isObject(payload) || Object.keys(payload).length !== 1 || payload.device_code !== FIXED_DEVICE_CODE) {
      this._sendJson(response, observation, 400, { error: { code: 'invalid_device_state', message: 'fixture device state is invalid' } });
      return;
    }
    const status = this._oauth.deviceStatus;
    if (status === 'pending') {
      this._sendJson(response, observation, 428, { status: 'authorization_pending' });
    } else if (status === 'success') {
      this._sendJson(response, observation, 200, { status: 'authorized', provider_id: 'openai-codex', account_id_hash: this.authFiles[0].accountIdHash });
    } else {
      this._sendJson(response, observation, 400, { status: status === 'cancelled' ? 'cancelled' : `authorization_${status}` });
    }
  }

  async _handleLocalCallback(request, response, observation, url, behavior) {
    if (await this._applyBehavior(request, response, observation, behavior)) return;
    if (!this._oauth.localEnabled) {
      this._sendJson(response, observation, 503, { error: { code: 'local_callback_unavailable', message: 'local callback fixture is disabled' } });
      return;
    }
    if (this._oauth.localConsumed) {
      this._sendJson(response, observation, 409, { error: { code: 'callback_already_consumed', message: 'callback state was already consumed' } });
      return;
    }
    if (url.searchParams.get('state') !== FIXED_LOCAL_STATE) {
      this._sendJson(response, observation, 400, { error: { code: 'oauth_state_mismatch', message: 'callback state does not match' } });
      return;
    }
    if (url.searchParams.get('code') !== FIXED_AUTH_CODE) {
      this._sendJson(response, observation, 400, { error: { code: 'oauth_code_invalid', message: 'fixture authorization result is invalid' } });
      return;
    }
    this._oauth.localConsumed = true;
    this._oauth.localStatus = 'success';
    this._sendJson(response, observation, 200, { status: 'authorized', provider_id: 'openai-codex' });
  }

  _handleUnexpectedError(request, response, error) {
    if (response.destroyed || response.writableEnded) return;
    const observation = this._requests.at(-1);
    if (observation) observation.error = error instanceof Error ? error.message : String(error);
    this._sendJson(response, observation ?? { response: undefined }, 500, { error: { code: 'fixture_internal_error', message: 'fixture request failed' } });
  }
}

export function createFakeCpaServer(options = {}) {
  return new FakeCpaServer(options);
}

export const createFakeCpa = createFakeCpaServer;

export async function startFakeCpa(options = {}) {
  const server = createFakeCpaServer(options);
  await server.start();
  return server;
}

export default createFakeCpaServer;
