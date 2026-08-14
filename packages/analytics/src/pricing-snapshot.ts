import type { PricingRule } from './contracts.js'

/**
 * Immutable release input. Phase 4 deliberately starts empty: an unknown
 * model keeps token metrics while cost remains unknown instead of guessing.
 * A release generator may replace this file only with source/version/SHA
 * provenance and pricing tests.
 */
export const BUNDLED_PRICING_SNAPSHOT = {
  schemaVersion: 1,
  snapshotVersion: 'dsh-gateway-v0.1.0-empty',
  generatedAtMs: 0,
  rules: [] as readonly PricingRule[],
} as const
