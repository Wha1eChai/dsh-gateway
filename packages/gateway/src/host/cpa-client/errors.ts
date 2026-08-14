import type { CpaErrorCategory } from './types.js';

export interface CpaErrorDiagnostic {
  readonly category: CpaErrorCategory;
  readonly code: string;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly status: number | undefined;
}

export interface CpaClientErrorInit {
  category: CpaErrorCategory;
  code: string;
  method?: string;
  path?: string;
  status?: number;
}

/**
 * Errors intentionally contain only stable categories and fixed route metadata.
 * Upstream bodies, credentials, URLs with caller data, and Error causes are not
 * retained because they can contain management secrets or provider tokens.
 */
export class CpaClientError extends Error {
  readonly category: CpaErrorCategory;
  readonly code: string;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly status: number | undefined;
  readonly diagnostic: CpaErrorDiagnostic;

  constructor(init: CpaClientErrorInit) {
    super(`CPA client ${init.category}: ${init.code}`);
    this.name = 'CpaClientError';
    this.category = init.category;
    this.code = init.code;
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.diagnostic = {
      category: init.category,
      code: init.code,
      method: init.method,
      path: init.path,
      status: init.status,
    };
  }

  toJSON(): CpaErrorDiagnostic {
    return this.diagnostic;
  }
}

