import type {
  CodexDeviceLoginErrorCategory,
  CodexDeviceLoginErrorDiagnostic,
} from './types.js';

export interface CodexDeviceLoginErrorInit {
  readonly category: CodexDeviceLoginErrorCategory;
  readonly code: string;
  readonly exitCode?: number;
}

/** Public errors contain only fixed classifications and optional exit facts. */
export class CodexDeviceLoginError extends Error {
  readonly category: CodexDeviceLoginErrorCategory;
  readonly code: string;
  readonly exitCode: number | undefined;
  readonly diagnostic: CodexDeviceLoginErrorDiagnostic;

  constructor(init: CodexDeviceLoginErrorInit) {
    super(`Codex device login ${init.category}: ${init.code}`);
    this.name = 'CodexDeviceLoginError';
    this.category = init.category;
    this.code = init.code;
    this.exitCode = init.exitCode;
    this.diagnostic = {
      category: init.category,
      code: init.code,
      ...(init.exitCode === undefined ? {} : { exitCode: init.exitCode }),
    };
  }

  toJSON(): CodexDeviceLoginErrorDiagnostic {
    return this.diagnostic;
  }
}
