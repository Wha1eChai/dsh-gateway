import type { CpaModel, CpaModels } from '../cpa-client/types.js';

import { ProviderBridgeError } from './errors.js';
import type { ProviderModelCapability } from './types.js';

const MAX_MODELS = 256;
const MAX_MODEL_ID = 128;
const MAX_OWNER = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(path: string): never {
  throw new ProviderBridgeError({ code: 'invalid_models_response', path });
}

function requiredString(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(path);
  return value;
}

function requiredCreated(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(path);
  return value;
}

function compareModels(left: CpaModel, right: CpaModel): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function freezeModel(model: CpaModel): CpaModel {
  return Object.freeze(model);
}

/**
 * Normalize the typed or raw `/v1/models` response. Required wire fields are
 * checked again at this boundary, duplicate ids keep their first endpoint
 * declaration, and the resulting list is sorted by model id using code-point
 * independent string comparison.
 */
export function normalizeCpaModels(input: unknown): CpaModels {
  if (!isRecord(input) || input.object !== 'list' || !Array.isArray(input.data)) invalid('models');
  if (input.data.length > MAX_MODELS) invalid('models.data');

  const byId = new Map<string, CpaModel>();
  for (const [index, raw] of input.data.entries()) {
    const path = `models.data[${index}]`;
    if (!isRecord(raw) || raw.object !== 'model') invalid(`${path}.object`);
    const id = requiredString(raw.id, `${path}.id`, MAX_MODEL_ID);
    const created = requiredCreated(raw.created, `${path}.created`);
    const rawOwnedBy = raw.owned_by ?? raw.ownedBy;
    const ownedBy = requiredString(rawOwnedBy, `${path}.owned_by`, MAX_OWNER);
    if (raw.owned_by !== undefined && raw.ownedBy !== undefined && raw.owned_by !== raw.ownedBy) {
      invalid(`${path}.owned_by`);
    }
    if (!byId.has(id)) {
      byId.set(id, freezeModel({ id, object: 'model', created, ownedBy }));
    }
  }

  const data = [...byId.values()].sort(compareModels);
  return Object.freeze({ object: 'list', data: Object.freeze(data) as unknown as CpaModel[] });
}

/**
 * Convert a normalized listing into the LLM discovery vocabulary. Discovery
 * carries identity only: it does not claim image, context, or reasoning
 * capability.
 */
export function normalizeDiscoveredModels(input: unknown): readonly ProviderModelCapability[] {
  const models = normalizeCpaModels(input);
  return Object.freeze(models.data.map(({ id }) => Object.freeze({ id, name: id })));
}

/** Backwards-readable alias for callers that use the endpoint terminology. */
export const normalizeModels = normalizeCpaModels;
