import { describe, expect, it, vi } from 'vitest';

import {
  CodexDeviceLoginError,
  CodexDeviceLoginManager,
  CodexDeviceLoginParser,
  createTrustedHostServerOrigin,
  hasTrustedLocalCallbackCapability,
} from './index.js';
import type {
  CodexDeviceLoginHandle,
  CodexDeviceLoginOutcome,
  CodexDeviceLoginSpawnSpec,
  CodexDeviceLoginStream,
} from './index.js';

const DEVICE_OUTPUT = [
  'Starting Codex device authentication...\n',
  'Codex device URL: https://auth.openai.com/codex/device\n',
  'Codex device code: ABCD-EFGH\n',
];

function streamOf(chunks: readonly (string | Uint8Array)[], hold = false): CodexDeviceLoginStream {
  return (async function* (): AsyncGenerator<string | Uint8Array> {
    for (const chunk of chunks) yield chunk;
    if (hold) await new Promise<void>(() => undefined);
  })();
}

interface FakeProcess {
  spec: CodexDeviceLoginSpawnSpec;
  readonly handle: CodexDeviceLoginHandle;
  readonly exit: (outcome?: Partial<CodexDeviceLoginOutcome>) => void;
}

function fakeProcess(chunks: readonly (string | Uint8Array)[] = [], holdStdout = false): FakeProcess {
  let resolveDone!: (outcome: CodexDeviceLoginOutcome) => void;
  const done = new Promise<CodexDeviceLoginOutcome>((resolve) => {
    resolveDone = resolve;
  });
  const terminate = vi.fn(() => resolveDone({ exitCode: null, signal: 'SIGTERM' }));
  const waitForExit = vi.fn(async () => {
    await done;
    return true;
  });
  const handle: CodexDeviceLoginHandle = {
    stdout: streamOf(chunks, holdStdout),
    stderr: streamOf([]),
    done,
    terminate,
    waitForExit,
  };
  let spec: CodexDeviceLoginSpawnSpec = {
    argv: [],
    cwd: '',
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 0,
    env: {},
  };
  return {
    spec,
    handle,
    exit: (outcome = {}) => resolveDone({ exitCode: null, signal: null, ...outcome }),
  };
}

function managerFor(process: FakeProcess, options: Record<string, unknown> = {}): CodexDeviceLoginManager {
  return new CodexDeviceLoginManager({
    subprocess: { spawn: vi.fn((spec: CodexDeviceLoginSpawnSpec) => {
      process.spec = spec;
      return process.handle;
    }) },
    binaryPath: 'C:\\private\\cli-proxy-api.exe',
    configPath: 'C:\\private\\config.yaml',
    cwd: 'C:\\private',
    env: { DSH_TEST_SECRET: 'must-stay-private' },
    timeoutMs: 1_000,
    killGraceMs: 25,
    operationIdFactory: () => 'op-fixed',
    now: () => 1_700_000_000_000,
    ...options,
  });
}

describe('Codex device login parser', () => {
  it('parses the exact v7.2.131 labels across incremental UTF-8 chunks', () => {
    const parser = new CodexDeviceLoginParser({ now: () => 1_700_000_000_000 });
    const bytes = new TextEncoder().encode(DEVICE_OUTPUT.join(''));
    const events = [
      ...parser.feed(bytes.slice(0, 11)),
      ...parser.feed(bytes.slice(11, 49)),
      ...parser.feed(bytes.slice(49)),
      ...parser.finish(),
    ];
    expect(events.find((event) => event.kind === 'ready')).toEqual({
      kind: 'ready',
      details: {
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAtMs: 1_700_000_900_000,
        pollIntervalMs: 5_000,
      },
    });
  });

  it('recognizes exact success lines and ignores the saved-path line', () => {
    const parser = new CodexDeviceLoginParser({ now: () => 1_700_000_000_000 });
    const events = parser.feed([
      ...DEVICE_OUTPUT,
      'Codex authentication successful\n',
      'Authentication saved to C:\\private\\auths\\codex-secret.json\n',
      'Codex device authentication successful!\n',
    ].join(''));
    expect(events.filter((event) => event.kind === 'state')).toEqual([
      { kind: 'state', state: 'success' },
      { kind: 'state', state: 'success' },
    ]);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('parses the fixed failure prefix without retaining its diagnostic text', () => {
    const parser = new CodexDeviceLoginParser();
    const events = parser.feed('Codex device authentication failed: token=private-value path=C:\\private\\auth.json\n');
    expect(events).toEqual([{ kind: 'state', state: 'failed' }]);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('rejects unapproved URLs, malformed expiry, and missing required fields', () => {
    expect(() => new CodexDeviceLoginParser().feed('https://evil.invalid/device\n')).toThrowError(CodexDeviceLoginError);
    expect(() => new CodexDeviceLoginParser().feed('Device code expires in 0 minutes.\n')).toThrowError(CodexDeviceLoginError);
    const parser = new CodexDeviceLoginParser();
    parser.feed('Codex device code: ABCD-EFGH\n');
    expect(() => parser.finish()).not.toThrow();
  });
});

describe('Codex device login manager', () => {
  it('uses the frozen argv and explicit subprocess fields', async () => {
    const process = fakeProcess(DEVICE_OUTPUT);
    const manager = managerFor(process);
    const status = await manager.start();
    expect(process.spec).toEqual({
      argv: ['C:\\private\\cli-proxy-api.exe', '-codex-device-login', '-no-browser', '-config', 'C:\\private\\config.yaml'],
      cwd: 'C:\\private',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 25,
      env: { DSH_TEST_SECRET: 'must-stay-private' },
    });
    expect(status).toMatchObject({ operationId: 'op-fixed', state: 'pending', pollIntervalMs: 5_000 });
    expect(status).not.toHaveProperty('rawOutput');
    await manager.dispose();
  });

  it('enforces one active operation and keeps the operation id stable', async () => {
    const process = fakeProcess(DEVICE_OUTPUT);
    const manager = managerFor(process);
    const started = await manager.start();
    await expect(manager.start()).rejects.toMatchObject({ category: 'duplicate', code: 'operation_already_active' });
    expect(manager.status('op-fixed')?.operationId).toBe(started.operationId);
    await manager.dispose();
  });

  it('cancels with exactly one terminate and one wait, and dispose is idempotent', async () => {
    const process = fakeProcess(DEVICE_OUTPUT);
    const manager = managerFor(process);
    await manager.start();
    await expect(manager.cancel('op-fixed')).resolves.toMatchObject({ state: 'cancelled' });
    await expect(manager.cancel('op-fixed')).resolves.toMatchObject({ state: 'cancelled' });
    expect(vi.mocked(process.handle.terminate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(process.handle.waitForExit)).toHaveBeenCalledTimes(1);
    await manager.dispose();
    expect(vi.mocked(process.handle.terminate)).toHaveBeenCalledTimes(1);
  });

  it('times out before startup fields and terminates the child', async () => {
    vi.useFakeTimers();
    try {
      const process = fakeProcess([], true);
      const manager = managerFor(process, { timeoutMs: 100 });
      const pending = expect(manager.start()).rejects.toMatchObject({ category: 'timeout', code: 'startup_timed_out' });
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(manager.status('op-fixed')).toMatchObject({ state: 'timed_out', error: { category: 'timeout' } });
      expect(vi.mocked(process.handle.terminate)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(process.handle.waitForExit)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts paths, environment, and private output from errors and status', async () => {
    const process = fakeProcess(['private-token-output\n']);
    const manager = managerFor(process);
    await expect(manager.start()).rejects.toMatchObject({ category: 'parse' });
    const serialized = JSON.stringify(manager.status('op-fixed'));
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('cli-proxy-api');
    expect(serialized).not.toContain('config.yaml');
  });

  it('does not treat an exit-0 process without a success marker as successful', async () => {
    const process = fakeProcess(DEVICE_OUTPUT);
    const manager = managerFor(process);
    const started = await manager.start();
    process.exit({ exitCode: 0, signal: null });
    await vi.waitFor(() => expect(manager.status(started.operationId)).toMatchObject({
      state: 'failed',
      error: { category: 'parse', code: 'authentication_failed' },
    }));
  });

  it('returns success only after the exact safe success marker', async () => {
    const process = fakeProcess([
      ...DEVICE_OUTPUT,
      'Codex authentication successful\n',
      'Authentication saved to C:\\private\\auth.json\n',
      'Codex device authentication successful!\n',
    ]);
    const manager = managerFor(process);
    await expect(manager.start()).resolves.toMatchObject({ state: 'pending' });
    await vi.waitFor(() => expect(manager.status('op-fixed')).toMatchObject({ state: 'success' }));
    expect(JSON.stringify(manager.status('op-fixed'))).not.toContain('auth.json');
    await manager.dispose();
  });

  it.each([
    ['success', 'Codex authentication successful\n'],
    ['denied', 'Authorization denied.\n'],
    ['expired', 'Device code expired.\n'],
    ['cancelled', 'Authorization cancelled.\n'],
  ] as const)('terminates and joins the child after a parsed %s terminal marker', async (state, marker) => {
    const process = fakeProcess([...DEVICE_OUTPUT, marker], true);
    const manager = managerFor(process);
    const started = await manager.start();
    await vi.waitFor(() => expect(manager.status(started.operationId)).toMatchObject({ state }));
    await vi.waitFor(() => expect(process.handle.waitForExit).toHaveBeenCalledTimes(1));
    expect(process.handle.terminate).toHaveBeenCalledTimes(1);
    await manager.dispose();
    expect(process.handle.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('local callback capability gate', () => {
  it('requires the opaque Host server-origin seam and only accepts localhost/127.0.0.1', () => {
    const trusted = createTrustedHostServerOrigin('http://localhost:3210');
    expect(trusted).toBeDefined();
    if (trusted === undefined) throw new Error('test trusted origin setup failed');
    expect(hasTrustedLocalCallbackCapability({ trustedServerOrigin: trusted, browserOrigin: 'https://attacker.invalid' })).toBe(true);
    expect(hasTrustedLocalCallbackCapability({ browserOrigin: 'http://localhost:3210' })).toBe(false);
    expect(createTrustedHostServerOrigin('https://127.0.0.2:3210')).toBeUndefined();
    expect(createTrustedHostServerOrigin('http://localhost:3210/callback')).toBeUndefined();
  });
});
