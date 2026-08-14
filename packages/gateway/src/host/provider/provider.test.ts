import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { describe, expect, it } from 'vitest';

import {
  CPA_PROVIDER_API,
  CPA_PROVIDER_ID,
  LLM_PI_AI_SETTINGS_NAMESPACE,
  ProviderBridgeError,
  buildCpaProviderProfile,
  normalizeCpaModels,
  normalizeDiscoveredModels,
  normalizeCpaProviderBaseURL,
  planCpaProviderSettings,
  type CpaProviderSettingsInput,
} from './index.js';

const endpoint = 'http://127.0.0.1:8317/';
const proxyCredentialRef = credentialRef('DSH_GATEWAY_PROXY');

function modelsPayload(): unknown {
  return {
    object: 'list',
    data: [
      { id: 'zeta', object: 'model', created: 3, owned_by: 'fixture' },
      { id: 'alpha', object: 'model', created: 2, owned_by: 'fixture' },
      { id: 'zeta', object: 'model', created: 1, owned_by: 'different-duplicate' },
    ],
  };
}

function profileInput(overrides: Partial<CpaProviderSettingsInput> = {}): CpaProviderSettingsInput {
  return {
    endpoint,
    proxyCredentialRef,
    models: [
      { id: 'vision-model', name: 'Vision model', imageInput: true },
      { id: 'vision-name-only' },
      { id: 'text-model' },
    ],
    ...overrides,
  };
}

describe('provider bridge pure slice', () => {
  it('rejects malformed /v1/models data without retaining the payload', () => {
    const error = (() => {
      try {
        normalizeCpaModels({ object: 'list', data: [{ id: 'bad', object: 'model' }] });
      } catch (value) {
        return value;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ProviderBridgeError);
    expect((error as ProviderBridgeError).code).toBe('invalid_models_response');
    expect((error as ProviderBridgeError).path).toBe('models.data[0].created');
    expect(JSON.stringify(error)).not.toContain('bad');
  });

  it('sorts models and deduplicates by id while keeping the first declaration', () => {
    const normalized = normalizeCpaModels(modelsPayload());
    expect(normalized.data).toEqual([
      { id: 'alpha', object: 'model', created: 2, ownedBy: 'fixture' },
      { id: 'zeta', object: 'model', created: 3, ownedBy: 'fixture' },
    ]);
    expect(normalizeDiscoveredModels(modelsPayload())).toEqual([
      { id: 'alpha', name: 'alpha' },
      { id: 'zeta', name: 'zeta' },
    ]);
  });

  it('writes exact cpa route fields with explicit image capability only', () => {
    const route = buildCpaProviderProfile(profileInput()).profile;
    expect(route).toEqual({
      api: CPA_PROVIDER_API,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKeyEnv: 'DSH_GATEWAY_PROXY',
      models: [
        { id: 'text-model', name: 'text-model', input: ['text'] },
        { id: 'vision-model', name: 'Vision model', input: ['text', 'image'] },
        { id: 'vision-name-only', name: 'vision-name-only', input: ['text'] },
      ],
    });
    expect(Object.keys(route).sort()).toEqual(['api', 'apiKeyEnv', 'baseURL', 'models']);
    expect(normalizeCpaProviderBaseURL('https://example.test/v1/')).toBe('https://example.test/v1');
  });

  it('supports a separate explicit image capability registry and rejects unknown ids', () => {
    expect(buildCpaProviderProfile({
      endpoint,
      proxyCredentialRef,
      models: [{ id: 'text-model' }, { id: 'image-model' }],
      imageModels: ['image-model'],
    }).profile.models.find((model) => model.id === 'image-model')?.input).toEqual(['text', 'image']);

    expect(() => buildCpaProviderProfile({
      endpoint,
      proxyCredentialRef,
      models: [{ id: 'text-model' }],
      imageModels: ['missing-model'],
    })).toThrowError(expect.objectContaining({ code: 'unknown_image_model', model: 'missing-model' }));
  });

  it('refuses invalid endpoint and credential references', () => {
    expect(() => buildCpaProviderProfile({
      endpoint: 'https://user:password@example.test',
      proxyCredentialRef,
      models: [{ id: 'text-model' }],
    })).toThrowError(expect.objectContaining({ code: 'invalid_endpoint' }));
    expect(() => buildCpaProviderProfile({
      endpoint,
      proxyCredentialRef: 'not-a-credential-ref',
      models: [{ id: 'text-model' }],
    })).toThrowError(expect.objectContaining({ code: 'invalid_credential_ref' }));
    expect(() => buildCpaProviderProfile({
      endpoint: 'https://example.test/custom',
      proxyCredentialRef,
      models: [{ id: 'text-model' }],
    })).toThrowError(expect.objectContaining({ code: 'invalid_endpoint' }));
  });

  it('plans deterministic leaf ops, carries descriptor revision, and preserves unrelated data', () => {
    const plan = planCpaProviderSettings({
      ...profileInput(),
      descriptor: {
        ns: settingsNamespace('llm-pi-ai'),
        schema: {},
        value: {
          providers: {
            other: { endpoint: 'https://other.invalid', hidden: 'keep' },
          },
        },
        revision: 17,
        user: {
          providers: {
            other: { endpoint: 'https://other.invalid', hidden: 'keep' },
          },
        },
        applies: 'live',
      },
    });

    expect(plan.namespace).toBe(LLM_PI_AI_SETTINGS_NAMESPACE);
    expect(plan.expectedRevision).toBe(17);
    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      { op: 'set', path: ['providers', 'cpa', 'api'], value: 'openai-completions' },
      { op: 'set', path: ['providers', 'cpa', 'baseURL'], value: 'http://127.0.0.1:8317/v1' },
      { op: 'set', path: ['providers', 'cpa', 'apiKeyEnv'], value: 'DSH_GATEWAY_PROXY' },
      {
        op: 'set',
        path: ['providers', 'cpa', 'models'],
        value: [
          { id: 'text-model', name: 'text-model', input: ['text'] },
          { id: 'vision-model', name: 'Vision model', input: ['text', 'image'] },
          { id: 'vision-name-only', name: 'vision-name-only', input: ['text'] },
        ],
      },
    ]);
    expect(plan.ops.every((op) => op.path.slice(0, 2).join('/') === 'providers/cpa')).toBe(true);
  });

  it('refuses an existing conflicting cpa provider visible in the user view', () => {
    const input = profileInput({
      descriptor: {
        ns: LLM_PI_AI_SETTINGS_NAMESPACE,
        schema: {},
        value: { providers: {} },
        revision: 4,
        user: {
          providers: {
            cpa: {
              api: 'anthropic-messages',
              baseURL: 'https://another.invalid/v1',
              apiKeyEnv: 'OTHER_KEY',
              models: [{ id: 'other', name: 'other', input: ['text'] }],
            },
          },
        },
        applies: 'live',
      },
    });
    expect(() => planCpaProviderSettings(input)).toThrowError(
      expect.objectContaining({ code: 'provider_conflict', provider: CPA_PROVIDER_ID }),
    );
  });

  it('updates models for an owned cpa route while keeping identity fields fixed', () => {
    const currentRoute = {
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKeyEnv: 'DSH_GATEWAY_PROXY',
      models: [{ id: 'old-model', name: 'old-model', input: ['text'] }],
    };
    const plan = planCpaProviderSettings({
      ...profileInput(),
      descriptor: {
        ns: LLM_PI_AI_SETTINGS_NAMESPACE,
        schema: {},
        value: { providers: { cpa: currentRoute } },
        revision: 6,
        user: { providers: { cpa: currentRoute } },
        applies: 'live',
      },
    });

    expect(plan.changed).toBe(true);
    expect(plan.ops).toEqual([
      {
        op: 'set',
        path: ['providers', 'cpa', 'models'],
        value: plan.route.profile.models,
      },
    ]);
  });

  it('refuses an otherwise matching cpa route with an extra field', () => {
    const input = profileInput({
      descriptor: {
        ns: LLM_PI_AI_SETTINGS_NAMESPACE,
        schema: {},
        value: { providers: {} },
        revision: 7,
        user: {
          providers: {
            cpa: {
              api: 'openai-completions',
              baseURL: 'http://127.0.0.1:8317/v1',
              apiKeyEnv: 'DSH_GATEWAY_PROXY',
              models: [{ id: 'old-model', name: 'old-model', input: ['text'] }],
              headers: { 'x-foreign': 'keep' },
            },
          },
        },
        applies: 'live',
      },
    });
    expect(() => planCpaProviderSettings(input)).toThrowError(
      expect.objectContaining({ code: 'provider_conflict', provider: 'cpa' }),
    );
  });

  it('refuses a cpa route from the resolved/base view and does not suffix it', () => {
    const input = profileInput({
      descriptor: {
        ns: LLM_PI_AI_SETTINGS_NAMESPACE,
        schema: {},
        value: { providers: { cpa: { api: 'openai-completions' } } },
        revision: 5,
        user: { providers: {} },
        applies: 'live',
      },
    });
    expect(() => planCpaProviderSettings(input)).toThrowError(
      expect.objectContaining({ code: 'provider_conflict', provider: 'cpa' }),
    );
  });

  it('returns a no-op for an exact owned route and never replaces hidden fields', () => {
    const route = buildCpaProviderProfile(profileInput()).profile;
    const plan = planCpaProviderSettings({
      ...profileInput(),
      descriptor: {
        ns: LLM_PI_AI_SETTINGS_NAMESPACE,
        schema: {},
        value: { providers: route },
        revision: 9,
        user: { providers: { cpa: route } },
        applies: 'live',
      },
    });
    expect(plan.changed).toBe(false);
    expect(plan.ops).toEqual([]);
    expect(plan.expectedRevision).toBe(9);
    expect(plan.ops.some((op) => op.op === 'unset')).toBe(false);
  });
});
