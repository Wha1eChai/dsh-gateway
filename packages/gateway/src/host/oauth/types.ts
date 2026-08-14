export type CodexDeviceLoginState =
  | 'starting'
  | 'pending'
  | 'success'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'timed_out'
  | 'failed';

export type CodexDeviceLoginErrorCategory =
  | 'configuration'
  | 'duplicate'
  | 'not_found'
  | 'disposed'
  | 'cancelled'
  | 'spawn'
  | 'nonzero_exit'
  | 'timeout'
  | 'parse';

export interface CodexDeviceLoginErrorDiagnostic {
  readonly category: CodexDeviceLoginErrorCategory;
  readonly code: string;
  readonly exitCode?: number;
}

export interface CodexDeviceLoginDetails {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
}

export interface CodexDeviceLoginStatus {
  readonly operationId: string;
  readonly provider: 'openai-codex';
  readonly state: CodexDeviceLoginState;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly expiresAtMs?: number;
  readonly pollIntervalMs?: number;
  readonly error?: CodexDeviceLoginErrorDiagnostic;
}

export interface CodexDeviceLoginSpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdio: {
    readonly stdin: 'ignore';
    readonly stdout: 'pipe';
    readonly stderr: 'pipe';
  };
  readonly graceMs: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface CodexDeviceLoginOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface CodexDeviceLoginStream extends AsyncIterable<Uint8Array | string> {}

export interface CodexDeviceLoginHandle {
  readonly stdout: CodexDeviceLoginStream | undefined;
  readonly stderr: CodexDeviceLoginStream | undefined;
  readonly done: Promise<CodexDeviceLoginOutcome>;
  terminate(): void;
  waitForExit(): Promise<boolean>;
}

/** Structural subset of `ctx.subprocess` needed by the device-login consumer. */
export interface CodexDeviceLoginSubprocess {
  spawn(spec: CodexDeviceLoginSpawnSpec): CodexDeviceLoginHandle;
}

export interface CodexDeviceLoginManagerOptions {
  readonly subprocess: CodexDeviceLoginSubprocess;
  readonly binaryPath: string;
  readonly configPath: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly rawOutputMaxBytes?: number;
  readonly now?: () => number;
  readonly operationIdFactory?: () => string;
}
