import { randomUUID } from 'node:crypto';

import { CodexDeviceLoginError } from './errors.js';
import { CodexDeviceLoginParser } from './parser.js';
import type {
  CodexDeviceLoginDetails,
  CodexDeviceLoginHandle,
  CodexDeviceLoginManagerOptions,
  CodexDeviceLoginState,
  CodexDeviceLoginStatus,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_RAW_OUTPUT_MAX_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_KILL_GRACE_MS = 30 * 1_000;
const MAX_PATH_LENGTH = 4_096;

interface Operation {
  readonly operationId: string;
  readonly handle: CodexDeviceLoginHandle;
  readonly parser: CodexDeviceLoginParser;
  readonly ready: Promise<CodexDeviceLoginDetails>;
  readonly resolveReady: (details: CodexDeviceLoginDetails) => void;
  readonly rejectReady: (error: CodexDeviceLoginError) => void;
  state: CodexDeviceLoginState;
  details: CodexDeviceLoginDetails | undefined;
  error: CodexDeviceLoginError | undefined;
  terminationPromise: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readySettled: boolean;
  terminal: boolean;
  successObserved: boolean;
  rawTail: string;
  rawTailBytes: number;
  readonly timeoutAtMs: number;
}

/** Bounded one-operation manager for the frozen CLIProxyAPI device flow. */
export class CodexDeviceLoginManager {
  private readonly options: Required<Pick<CodexDeviceLoginManagerOptions, 'binaryPath' | 'configPath' | 'cwd'>>
    & Omit<CodexDeviceLoginManagerOptions, 'binaryPath' | 'configPath' | 'cwd'>;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly rawOutputMaxBytes: number;
  private readonly now: () => number;
  private readonly operationIdFactory: () => string;
  private operation: Operation | undefined;
  private disposed = false;

  constructor(options: CodexDeviceLoginManagerOptions) {
    validateOptions(options);
    this.options = {
      ...options,
      env: options.env === undefined ? {} : { ...options.env },
    };
    this.timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'invalid_timeout');
    this.killGraceMs = boundedInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 1, MAX_KILL_GRACE_MS, 'invalid_kill_grace');
    this.rawOutputMaxBytes = boundedInteger(options.rawOutputMaxBytes ?? DEFAULT_RAW_OUTPUT_MAX_BYTES, 1_024, 256 * 1_024, 'invalid_output_limit');
    this.now = options.now ?? Date.now;
    this.operationIdFactory = options.operationIdFactory ?? randomUUID;
  }

  async start(): Promise<CodexDeviceLoginStatus> {
    this.assertUsable();
    if (this.operation !== undefined && !this.operation.terminal) {
      throw new CodexDeviceLoginError({ category: 'duplicate', code: 'operation_already_active' });
    }

    const operationId = this.nextOperationId();
    let handle: CodexDeviceLoginHandle;
    try {
      handle = this.options.subprocess.spawn({
        argv: [this.options.binaryPath, '-codex-device-login', '-no-browser', '-config', this.options.configPath],
        cwd: this.options.cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.killGraceMs,
        env: { ...(this.options.env ?? {}) },
      });
    } catch {
      throw new CodexDeviceLoginError({ category: 'spawn', code: 'subprocess_spawn_failed' });
    }

    let resolveReady!: (details: CodexDeviceLoginDetails) => void;
    let rejectReady!: (error: CodexDeviceLoginError) => void;
    const ready = new Promise<CodexDeviceLoginDetails>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const operation: Operation = {
      operationId,
      handle,
      parser: new CodexDeviceLoginParser({ now: this.now, maxOutputBytes: this.rawOutputMaxBytes }),
      ready,
      resolveReady,
      rejectReady,
      state: 'starting',
      details: undefined,
      error: undefined,
      terminationPromise: undefined,
      timer: undefined,
      readySettled: false,
      terminal: false,
      successObserved: false,
      rawTail: '',
      rawTailBytes: 0,
      timeoutAtMs: this.now() + this.timeoutMs,
    };
    this.operation = operation;

    this.monitorStdout(operation);
    this.monitorStderr(operation);
    this.monitorDone(operation);
    operation.timer = setTimeout(() => {
      void this.failOperation(operation, 'timed_out', new CodexDeviceLoginError({ category: 'timeout', code: 'startup_timed_out' }));
    }, this.timeoutMs);

    try {
      await operation.ready;
      if (operation.terminal) return this.snapshot(operation);
      operation.state = 'pending';
      this.scheduleExpiry(operation);
      return this.snapshot(operation);
    } catch (error) {
      if (operation.terminationPromise !== undefined) await operation.terminationPromise;
      throw error;
    }
  }

  status(operationId?: string): CodexDeviceLoginStatus | undefined {
    const operation = this.operation;
    if (operation === undefined) return undefined;
    if (operationId !== undefined && operationId !== operation.operationId) {
      throw new CodexDeviceLoginError({ category: 'not_found', code: 'operation_not_found' });
    }
    this.expireIfNeeded(operation);
    return this.snapshot(operation);
  }

  async cancel(operationId: string): Promise<CodexDeviceLoginStatus> {
    this.assertUsable();
    const operation = this.requireOperation(operationId);
    if (!operation.terminal) {
      operation.state = 'cancelled';
      operation.terminal = true;
      operation.error = new CodexDeviceLoginError({ category: 'cancelled', code: 'operation_cancelled' });
      this.clearTimer(operation);
      this.rejectReady(operation, operation.error);
      await this.terminateAndWait(operation);
    }
    return this.snapshot(operation);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const operation = this.operation;
    if (operation !== undefined) {
      if (!operation.terminal) {
        operation.state = 'cancelled';
        operation.terminal = true;
        operation.error = new CodexDeviceLoginError({ category: 'cancelled', code: 'manager_disposed' });
        this.rejectReady(operation, operation.error);
      }
      await this.terminateAndWait(operation);
    }
    if (operation?.timer !== undefined) clearTimeout(operation.timer);
  }

  private monitorStdout(operation: Operation): void {
    const stream = operation.handle.stdout;
    if (stream === undefined) {
      void this.failOperation(operation, 'failed', new CodexDeviceLoginError({ category: 'parse', code: 'stdout_unavailable' }));
      return;
    }
    void this.consumeStream(operation, stream, true);
  }

  private monitorStderr(operation: Operation): void {
    const stream = operation.handle.stderr;
    if (stream !== undefined) void this.consumeStream(operation, stream, false);
  }

  private async consumeStream(operation: Operation, stream: AsyncIterable<Uint8Array | string>, parse: boolean): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: parse });
    try {
      for await (const chunk of stream) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        this.recordRaw(operation, text);
        if (parse && !operation.terminal) {
          const events = operation.parser.feed(text);
          this.applyParserEvents(operation, events);
        }
      }
      if (parse && !operation.terminal) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          this.recordRaw(operation, tail);
          this.applyParserEvents(operation, operation.parser.feed(tail));
        }
        this.applyParserEvents(operation, operation.parser.finish());
        if (!operation.terminal && !operation.readySettled) {
          void this.failOperation(operation, 'failed', new CodexDeviceLoginError({ category: 'parse', code: 'required_fields_missing' }));
        }
      }
    } catch (error) {
      if (!parse) return;
      if (!operation.terminal) {
        const parseError = error instanceof CodexDeviceLoginError && error.category === 'parse'
          ? error
          : new CodexDeviceLoginError({ category: 'parse', code: 'output_stream_invalid' });
        void this.failOperation(operation, 'failed', parseError);
      }
    }
  }

  private monitorDone(operation: Operation): void {
    void operation.handle.done.then(
      (outcome) => {
        operation.terminationPromise ??= Promise.resolve();
        if (operation.terminal) return;
        if (outcome.exitCode !== 0 || outcome.signal !== null) {
          void this.failOperation(operation, 'failed', new CodexDeviceLoginError({
            category: 'nonzero_exit',
            code: 'subprocess_nonzero_exit',
            ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
          }));
          return;
        }
        if (!operation.readySettled) {
          try {
            this.applyParserEvents(operation, operation.parser.finish());
          } catch (error) {
            const parseError = error instanceof CodexDeviceLoginError && error.category === 'parse'
              ? error
              : new CodexDeviceLoginError({ category: 'parse', code: 'required_fields_missing' });
            void this.failOperation(operation, 'failed', parseError);
            return;
          }
        }
        if (!operation.readySettled) {
          void this.failOperation(operation, 'failed', new CodexDeviceLoginError({ category: 'parse', code: 'required_fields_missing' }));
          return;
        }
        if (!operation.successObserved) {
          void this.failOperation(operation, 'failed', new CodexDeviceLoginError({ category: 'parse', code: 'authentication_failed' }));
          return;
        }
        operation.state = 'success';
        operation.terminal = true;
        this.clearTimer(operation);
      },
      () => {
        operation.terminationPromise ??= Promise.resolve();
        if (!operation.terminal) {
          void this.failOperation(operation, 'failed', new CodexDeviceLoginError({ category: 'spawn', code: 'subprocess_failed' }));
        }
      },
    );
  }

  private applyParserEvents(operation: Operation, events: readonly { kind: string; details?: CodexDeviceLoginDetails; state?: 'success' | 'failed' | 'denied' | 'expired' | 'cancelled' }[]): void {
    for (const event of events) {
      if (event.kind === 'ready' && event.details !== undefined && !operation.readySettled) {
        operation.details = event.details;
        operation.state = 'pending';
        operation.readySettled = true;
        operation.resolveReady(event.details);
        this.scheduleExpiry(operation);
      } else if (event.kind === 'state' && event.state !== undefined && !operation.terminal) {
        operation.state = event.state;
        operation.terminal = true;
        if (event.state === 'success') {
          operation.successObserved = true;
        } else if (event.state === 'failed') {
          operation.error = new CodexDeviceLoginError({ category: 'parse', code: 'authentication_failed' });
        }
        this.clearTimer(operation);
        if (event.state !== 'success') {
          this.rejectReadyIfPending(operation, operation.error ?? new CodexDeviceLoginError({ category: 'parse', code: `login_${event.state}` }));
        }
        void this.terminateAndWait(operation);
      }
    }
  }

  private async failOperation(operation: Operation, state: CodexDeviceLoginState, error: CodexDeviceLoginError): Promise<void> {
    if (operation.terminal) return;
    operation.state = state;
    operation.terminal = true;
    operation.error = error;
    this.clearTimer(operation);
    this.rejectReadyIfPending(operation, error);
    if (state === 'timed_out' || state === 'expired' || state === 'failed') await this.terminateAndWait(operation);
  }

  private scheduleExpiry(operation: Operation): void {
    if (operation.details === undefined || operation.terminal) return;
    this.clearTimer(operation);
    const now = this.now();
    const expiresIn = operation.details.expiresAtMs - now;
    const timeoutIn = operation.timeoutAtMs - now;
    const timedOut = timeoutIn <= expiresIn;
    const delay = Math.max(1, Math.min(expiresIn, timeoutIn));
    operation.timer = setTimeout(() => {
      const state = timedOut ? 'timed_out' : 'expired';
      const error = timedOut
        ? new CodexDeviceLoginError({ category: 'timeout', code: 'operation_timed_out' })
        : new CodexDeviceLoginError({ category: 'timeout', code: 'device_code_expired' });
      void this.failOperation(operation, state, error).then(async () => {
        if (operation.terminationPromise === undefined) await this.terminateAndWait(operation);
      });
    }, delay);
  }

  private expireIfNeeded(operation: Operation): void {
    if (!operation.terminal && operation.details !== undefined && this.now() >= operation.details.expiresAtMs) {
      void this.failOperation(operation, 'expired', new CodexDeviceLoginError({ category: 'timeout', code: 'device_code_expired' })).then(async () => {
        if (operation.terminationPromise === undefined) await this.terminateAndWait(operation);
      });
    }
  }

  private async terminateAndWait(operation: Operation): Promise<void> {
    if (operation.terminationPromise !== undefined) return operation.terminationPromise;
    operation.terminationPromise = (async () => {
      try {
        operation.handle.terminate();
        await operation.handle.waitForExit();
      } catch {
        // The public state is already deterministic; subprocess details stay private.
      }
    })();
    return operation.terminationPromise;
  }

  private rejectReadyIfPending(operation: Operation, error: CodexDeviceLoginError): void {
    if (operation.readySettled) return;
    this.rejectReady(operation, error);
  }

  private rejectReady(operation: Operation, error: CodexDeviceLoginError): void {
    if (operation.readySettled) return;
    operation.readySettled = true;
    operation.rejectReady(error);
  }

  private clearTimer(operation: Operation): void {
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
      operation.timer = undefined;
    }
  }

  private snapshot(operation: Operation): CodexDeviceLoginStatus {
    const details = operation.details;
    return {
      operationId: operation.operationId,
      provider: 'openai-codex',
      state: operation.state,
      ...(details === undefined ? {} : {
        verificationUri: details.verificationUri,
        userCode: details.userCode,
        expiresAtMs: details.expiresAtMs,
        pollIntervalMs: details.pollIntervalMs,
      }),
      ...(operation.error === undefined ? {} : { error: operation.error.diagnostic }),
    };
  }

  private recordRaw(operation: Operation, text: string): void {
    const bytes = new TextEncoder().encode(text).byteLength;
    operation.rawTail += text;
    operation.rawTailBytes += bytes;
    while (operation.rawTailBytes > this.rawOutputMaxBytes) {
      const first = operation.rawTail.codePointAt(0);
      if (first === undefined) break;
      const firstText = String.fromCodePoint(first);
      operation.rawTail = operation.rawTail.slice(firstText.length);
      operation.rawTailBytes -= new TextEncoder().encode(firstText).byteLength;
    }
  }

  private requireOperation(operationId: string): Operation {
    if (typeof operationId !== 'string' || operationId.length === 0 || this.operation?.operationId !== operationId) {
      throw new CodexDeviceLoginError({ category: 'not_found', code: 'operation_not_found' });
    }
    return this.operation;
  }

  private nextOperationId(): string {
    const operationId = this.operationIdFactory();
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
      throw new CodexDeviceLoginError({ category: 'configuration', code: 'invalid_operation_id' });
    }
    return operationId;
  }

  private assertUsable(): void {
    if (this.disposed) throw new CodexDeviceLoginError({ category: 'disposed', code: 'manager_disposed' });
  }
}

export function createCodexDeviceLoginManager(options: CodexDeviceLoginManagerOptions): CodexDeviceLoginManager {
  return new CodexDeviceLoginManager(options);
}

function validateOptions(options: CodexDeviceLoginManagerOptions): void {
  if (options === null || typeof options !== 'object' || options.subprocess === undefined || typeof options.subprocess.spawn !== 'function') {
    throw new CodexDeviceLoginError({ category: 'configuration', code: 'invalid_subprocess' });
  }
  for (const value of [options.binaryPath, options.configPath, options.cwd]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
      throw new CodexDeviceLoginError({ category: 'configuration', code: 'invalid_process_configuration' });
    }
  }
}

function boundedInteger(value: number, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CodexDeviceLoginError({ category: 'configuration', code });
  }
  return value;
}
