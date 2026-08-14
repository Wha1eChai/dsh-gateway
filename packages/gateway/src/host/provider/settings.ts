import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings';

import { ProviderBridgeError } from './errors.js';
import { createCpaProviderRoute, normalizeCpaProviderBaseURL } from './profile.js';
import type {
  CpaProviderProfileInput,
  CpaProviderRoute,
  CpaProviderSettingsInput,
  CpaProviderSettingsPlan,
} from './types.js';

export const LLM_PI_AI_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('llm-pi-ai');

const MANAGED_ROUTE_KEYS = ['api', 'baseURL', 'apiKeyEnv', 'models'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidDescriptor(path: string): never {
  throw new ProviderBridgeError({ code: 'invalid_settings_descriptor', path });
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => jsonEqual(leftRecord[key], rightRecord[key]));
}

function sectionProviders(section: unknown, path: string): Record<string, unknown> | undefined {
  if (section === undefined) return undefined;
  if (!isRecord(section)) invalidDescriptor(path);
  if (section.providers === undefined) return undefined;
  if (!isRecord(section.providers)) invalidDescriptor(`${path}.providers`);
  return section.providers;
}

function validateDescriptor(descriptor: SettingsDescriptor): void {
  if (!isRecord(descriptor)) invalidDescriptor('descriptor');
  if (descriptor.ns !== LLM_PI_AI_SETTINGS_NAMESPACE) {
    throw new ProviderBridgeError({ code: 'settings_namespace_mismatch' });
  }
  if (!Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0) invalidDescriptor('descriptor.revision');
  sectionProviders(descriptor.user, 'descriptor.user');
  sectionProviders(descriptor.value, 'descriptor.value');
}

function routeIsExact(route: unknown, profile: CpaProviderRoute['profile']): boolean {
  if (!isRecord(route)) return false;
  const keys = Object.keys(route).sort();
  const expectedKeys = [...MANAGED_ROUTE_KEYS].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && jsonEqual(route, profile);
}

function routeHasOwnedIdentity(route: unknown, profile: CpaProviderRoute['profile']): route is Record<string, unknown> {
  if (!isRecord(route)) return false;
  const keys = Object.keys(route).sort();
  const expectedKeys = [...MANAGED_ROUTE_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  if (route.api !== profile.api || route.apiKeyEnv !== profile.apiKeyEnv) return false;
  if (typeof route.baseURL !== 'string') return false;
  try {
    return normalizeCpaProviderBaseURL(route.baseURL) === profile.baseURL;
  } catch {
    return false;
  }
}

function routeFrom(section: unknown, path: string): { present: boolean; value: unknown } {
  const providers = sectionProviders(section, path);
  if (providers === undefined) return { present: false, value: undefined };
  return Object.prototype.hasOwnProperty.call(providers, 'cpa')
    ? { present: true, value: providers.cpa }
    : { present: false, value: undefined };
}

interface ExistingRouteState {
  readonly noOp: boolean;
  readonly userRoute?: Record<string, unknown>;
}

function assertNoProviderConflict(descriptor: SettingsDescriptor | undefined, route: CpaProviderRoute): ExistingRouteState {
  if (descriptor === undefined) return { noOp: false };
  validateDescriptor(descriptor);
  const userRoute = routeFrom(descriptor.user, 'descriptor.user');
  if (userRoute.present) {
    if (!routeHasOwnedIdentity(userRoute.value, route.profile)) {
      throw new ProviderBridgeError({ code: 'provider_conflict', provider: route.provider });
    }
    return {
      noOp: routeIsExact(userRoute.value, route.profile),
      userRoute: userRoute.value,
    };
  }

  // A route supplied by the composition/base layer or another writer is not
  // ours. Refuse before creating a second interpretation of the same `cpa`
  // provider name. Unrelated providers are never inspected or rewritten.
  const resolvedRoute = routeFrom(descriptor.value, 'descriptor.value');
  if (resolvedRoute.present) {
    throw new ProviderBridgeError({ code: 'provider_conflict', provider: route.provider });
  }
  return { noOp: false };
}

function routeOps(route: CpaProviderRoute, existingRoute?: Record<string, unknown>): readonly SettingsPathOp[] {
  const profile = route.profile;
  const ops: SettingsPathOp[] = [];
  if (existingRoute === undefined || existingRoute.api !== profile.api) {
    ops.push({ op: 'set', path: ['providers', route.provider, 'api'], value: profile.api });
  }
  if (existingRoute === undefined || existingRoute.baseURL !== profile.baseURL) {
    ops.push({ op: 'set', path: ['providers', route.provider, 'baseURL'], value: profile.baseURL });
  }
  if (existingRoute === undefined || existingRoute.apiKeyEnv !== profile.apiKeyEnv) {
    ops.push({ op: 'set', path: ['providers', route.provider, 'apiKeyEnv'], value: profile.apiKeyEnv });
  }
  if (existingRoute === undefined || !jsonEqual(existingRoute.models, profile.models)) {
    ops.push({ op: 'set', path: ['providers', route.provider, 'models'], value: profile.models });
  }
  return Object.freeze(ops);
}

/**
 * Plan a redacted-view-safe update for the official `llm-pi-ai` `cpa` route.
 * The plan only sets route leaves, so unrelated providers and fields omitted
 * from a redacted view remain untouched. A visible or resolved conflicting
 * `cpa` route is refused rather than overwritten or renamed.
 */
export function planCpaProviderSettings(input: CpaProviderSettingsInput): CpaProviderSettingsPlan {
  const route = createCpaProviderRoute(input);
  const existing = assertNoProviderConflict(input.descriptor, route);
  const expectedRevision = input.expectedRevision ?? input.descriptor?.revision;
  const plan: CpaProviderSettingsPlan = {
    namespace: LLM_PI_AI_SETTINGS_NAMESPACE,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ops: existing.noOp ? Object.freeze([]) : routeOps(route, existing.userRoute),
    route,
    changed: !existing.noOp,
  };
  return plan;
}

/** Return only the exact mutation operations, after conflict validation. */
export function planCpaProviderOps(input: CpaProviderSettingsInput): readonly SettingsPathOp[] {
  return planCpaProviderSettings(input).ops;
}

/** Narrower alias used by callers that already call the operation a mutation. */
export const planCpaSettingsMutation = planCpaProviderSettings;

export type CpaProviderSettingsBaseInput = CpaProviderProfileInput;
