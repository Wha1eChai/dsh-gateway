import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai';

import { ProviderBridgeError } from './errors.js';
import { normalizeCpaModels } from './models.js';
import type {
  CpaPiAiProviderProfile,
  CpaProviderProfileInput,
  CpaProviderRoute,
  ProviderModelCapability,
} from './types.js';

const PROVIDER_ID = 'cpa' as const;
const PROVIDER_API = 'openai-completions' as const;
const MAX_MODEL_NAME = 256;
const MAX_IMAGE_CAPABILITIES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidModel(path: string): never {
  throw new ProviderBridgeError({ code: 'invalid_model', path });
}

function requiredModelId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) invalidModel(path);
  return value;
}

function optionalName(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_NAME) invalidModel(path);
  return value;
}

function normalizeEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2_048) {
    throw new ProviderBridgeError({ code: 'invalid_endpoint' });
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderBridgeError({ code: 'invalid_endpoint' });
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.hostname.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0) {
    throw new ProviderBridgeError({ code: 'invalid_endpoint' });
  }

  const path = url.pathname.replace(/\/+$/u, '');
  if (path === '' || path === '/') {
    url.pathname = '/v1';
  } else if (path === '/v1') {
    url.pathname = '/v1';
  } else {
    throw new ProviderBridgeError({ code: 'invalid_endpoint' });
  }
  return url.toString().replace(/\/$/u, '');
}

function normalizeCredentialRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ProviderBridgeError({ code: 'invalid_credential_ref' });
  }
  try {
    return credentialRef(value);
  } catch {
    throw new ProviderBridgeError({ code: 'invalid_credential_ref' });
  }
}

function normalizeCapabilities(input: CpaProviderProfileInput['models']): ProviderModelCapability[] {
  if (isRecord(input) && input.object === 'list') {
    return normalizeCpaModels(input).data.map(({ id }) => ({ id }));
  }
  if (!Array.isArray(input) || input.length > 256) {
    throw new ProviderBridgeError({ code: 'invalid_model_capability', path: 'models' });
  }

  const byId = new Map<string, ProviderModelCapability>();
  for (const [index, value] of input.entries()) {
    const path = `models[${index}]`;
    if (!isRecord(value)) throw new ProviderBridgeError({ code: 'invalid_model_capability', path });
    const id = requiredModelId(value.id, `${path}.id`);
    const name = optionalName(value.name, `${path}.name`);
    if (value.imageInput !== undefined && typeof value.imageInput !== 'boolean') {
      throw new ProviderBridgeError({ code: 'invalid_model_capability', path: `${path}.imageInput` });
    }
    // Endpoint order decides which duplicate declaration survives; sorting is
    // performed only after this first-declaration dedupe.
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        ...(name === undefined ? {} : { name }),
        ...(value.imageInput === undefined ? {} : { imageInput: value.imageInput }),
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function normalizeImageModels(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGE_CAPABILITIES) {
    throw new ProviderBridgeError({ code: 'invalid_model_capability', path: 'imageModels' });
  }
  const ids = new Set<string>();
  for (const [index, id] of value.entries()) {
    ids.add(requiredModelId(id, `imageModels[${index}]`));
  }
  return [...ids].sort();
}

function buildModels(
  capabilities: readonly ProviderModelCapability[],
  imageModels: readonly string[],
): PiAiModelProfile[] {
  const imageIds = new Set(imageModels);
  const knownIds = new Set(capabilities.map(({ id }) => id));
  for (const id of imageModels) {
    if (!knownIds.has(id)) {
      throw new ProviderBridgeError({ code: 'unknown_image_model', model: id });
    }
  }

  return capabilities.map((model) => {
    const imageInput = model.imageInput === true || imageIds.has(model.id);
    return {
      id: model.id,
      name: model.name ?? model.id,
      input: imageInput ? ['text', 'image'] : ['text'],
    };
  });
}

/**
 * Build the only provider route this package owns. The returned profile is a
 * closed `llm-pi-ai` route: no arbitrary protocol, endpoint, headers, or
 * provider-specific fields can enter the generated settings payload.
 */
export function createCpaProviderRoute(input: CpaProviderProfileInput): CpaProviderRoute {
  const capabilities = normalizeCapabilities(input.models);
  const imageModels = normalizeImageModels(input.imageModels);
  const profile: CpaPiAiProviderProfile = {
    api: PROVIDER_API,
    baseURL: normalizeEndpoint(input.endpoint),
    apiKeyEnv: normalizeCredentialRef(input.proxyCredentialRef),
    models: buildModels(capabilities, imageModels),
  };
  return {
    provider: PROVIDER_ID,
    profile,
  };
}

/** Alias emphasizing that the profile is the official pi-ai route shape. */
export const buildCpaProviderProfile = createCpaProviderRoute;

export function normalizeCpaProviderBaseURL(endpoint: string): string {
  return normalizeEndpoint(endpoint);
}

export const CPA_PROVIDER_ID = PROVIDER_ID;
export const CPA_PROVIDER_API = PROVIDER_API;
