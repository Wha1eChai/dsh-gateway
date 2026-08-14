export type ProviderBridgeErrorCode =
  | 'invalid_models_response'
  | 'invalid_model'
  | 'invalid_endpoint'
  | 'invalid_credential_ref'
  | 'invalid_model_capability'
  | 'unknown_image_model'
  | 'invalid_settings_descriptor'
  | 'settings_namespace_mismatch'
  | 'provider_conflict'
  | 'provider_unavailable';

export type ProviderUnavailableReason =
  | 'endpoint_unavailable'
  | 'unauthorized'
  | 'incompatible'
  | 'invalid_response'
  | 'unsupported';

export interface ProviderBridgeErrorInit {
  readonly code: ProviderBridgeErrorCode;
  readonly path?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reason?: ProviderUnavailableReason;
}

export interface ProviderBridgeErrorDiagnostic {
  readonly code: ProviderBridgeErrorCode;
  readonly path: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly reason: ProviderUnavailableReason | undefined;
}

/**
 * Public provider failures retain only bounded structural identifiers. Raw
 * responses, endpoints, credential values, and Error causes are deliberately
 * not retained because this error may cross a Host boundary.
 */
export class ProviderBridgeError extends Error {
  readonly code: ProviderBridgeErrorCode;
  readonly path: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly reason: ProviderUnavailableReason | undefined;
  readonly diagnostic: ProviderBridgeErrorDiagnostic;

  constructor(init: ProviderBridgeErrorInit) {
    super(`provider bridge ${init.code}`);
    this.name = 'ProviderBridgeError';
    this.code = init.code;
    this.path = init.path;
    this.provider = init.provider;
    this.model = init.model;
    this.reason = init.reason;
    this.diagnostic = {
      code: init.code,
      path: init.path,
      provider: init.provider,
      model: init.model,
      reason: init.reason,
    };
  }

  toJSON(): ProviderBridgeErrorDiagnostic {
    return this.diagnostic;
  }
}
