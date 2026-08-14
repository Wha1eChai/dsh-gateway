import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings';
import type { PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import type { CpaModels } from '../cpa-client/types.js';

/** A model capability is an explicit operator declaration, never name-derived. */
export interface ProviderModelCapability {
  readonly id: string;
  readonly name?: string;
  /** True only when an independently verified capability entry opts images in. */
  readonly imageInput?: boolean;
}

export type ProviderModelInput = ProviderModelCapability | CpaModels;

/** The closed route profile written into `llm-pi-ai.providers.cpa`. */
export type CpaPiAiProviderProfile = Required<Pick<
  PiAiProviderProfile,
  'api' | 'baseURL' | 'apiKeyEnv' | 'models'
>>;

export interface CpaProviderRoute {
  readonly provider: 'cpa';
  readonly profile: CpaPiAiProviderProfile;
}

export interface CpaProviderProfileInput {
  /** CPA root endpoint, not an arbitrary model-provider endpoint. */
  readonly endpoint: string;
  /** Value-free DSH credential reference consumed by the official adapter. */
  readonly proxyCredentialRef: CredentialRef | string;
  /** Strict `/v1/models` listing or a closed model capability list. */
  readonly models: ProviderModelInput | readonly ProviderModelCapability[];
  /** Explicit image capability ids; omitted ids remain text-only. */
  readonly imageModels?: readonly string[];
}

export interface CpaProviderSettingsInput extends CpaProviderProfileInput {
  /** Redacted descriptor read from the `llm-pi-ai` settings namespace. */
  readonly descriptor?: SettingsDescriptor;
  /** Explicit revision wins; otherwise the descriptor revision is used. */
  readonly expectedRevision?: number;
}

export interface CpaProviderSettingsPlan {
  readonly namespace: SettingsNamespace;
  readonly expectedRevision?: number;
  readonly ops: readonly SettingsPathOp[];
  readonly route: CpaProviderRoute;
  readonly changed: boolean;
}
