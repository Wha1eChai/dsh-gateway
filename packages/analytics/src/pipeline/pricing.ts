import type { PricingRule, RequestObservation } from '../contracts.js'

const WILDCARD = '*'
const DIMENSIONS = ['routeId', 'providerId', 'modelId', 'accountIdHash', 'apiKeyIdHash'] as const
type PricingDimension = typeof DIMENSIONS[number]

export interface PricingMatchInput {
  readonly routeId: string
  readonly providerId: string
  readonly modelId: string
  readonly accountIdHash: string | null
  readonly apiKeyIdHash: string | null
  readonly occurredAtMs: number
}

export type PricingState = 'priced' | 'partial' | 'unpriced'

export interface PricingEstimate {
  readonly pricingState: PricingState
  readonly currency: string | null
  readonly estimatedCostMicros: number | null
  readonly knownCostMicros: number
  readonly snapshotVersion: string | null
  readonly ruleId: string | null
  readonly missingComponents: readonly string[]
}

/** Immutable, deterministic matcher for a bundled pricing snapshot. */
export class PricingRuleMatcher {
  readonly rules: readonly PricingRule[]

  constructor(rules: readonly PricingRule[]) {
    const frozen = rules.map(validateRule)
    validateOverlaps(frozen)
    this.rules = Object.freeze(frozen)
  }

  match(input: PricingMatchInput): PricingRule | null {
    if (!Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) return null
    const matches = this.rules.filter((rule) => isEffective(rule, input.occurredAtMs) && matchesDimensions(rule, input))
    if (matches.length === 0) return null
    const specificity = Math.max(...matches.map(specificityOf))
    return matches.find((rule) => specificityOf(rule) === specificity) ?? null
  }

  estimate(observation: RequestObservation): PricingEstimate {
    const rule = this.match(observation)
    return estimatePricing(observation, rule)
  }
}

export function estimatePricing(observation: RequestObservation, rule: PricingRule | null): PricingEstimate {
  if (rule === null) return {
    pricingState: 'unpriced',
    currency: null,
    estimatedCostMicros: null,
    knownCostMicros: 0,
    snapshotVersion: null,
    ruleId: null,
    missingComponents: ['pricing_rule'],
  }

  const missingComponents: string[] = []
  let knownCostMicros = 0
  let knownComponents = 0

  const request = componentCost(observation.requestUnits, rule.requestUnitPriceMicros, 'request_units', false)
  knownCostMicros += request.cost
  knownComponents += request.known ? 1 : 0
  if (request.missing) missingComponents.push(request.name)

  const tokenComponents: readonly [string, number | null, number | null][] = [
    ['input_tokens', observation.inputTokens, rule.inputTokenPriceMicrosPerMillion],
    ['output_tokens', observation.outputTokens, rule.outputTokenPriceMicrosPerMillion],
    ['cache_read_tokens', observation.cacheReadTokens, rule.cacheReadTokenPriceMicrosPerMillion],
    ['cache_write_tokens', observation.cacheWriteTokens, rule.cacheWriteTokenPriceMicrosPerMillion],
    ['reasoning_tokens', observation.reasoningTokens, rule.reasoningTokenPriceMicrosPerMillion],
  ]
  for (const [name, count, price] of tokenComponents) {
    const component = componentCost(count, price, name, true)
    knownCostMicros += component.cost
    knownComponents += component.known ? 1 : 0
    if (component.missing) missingComponents.push(component.name)
  }

  const unknown = missingComponents.length > 0
  const state: PricingState = !unknown && knownComponents > 0
    ? 'priced'
    : knownComponents > 0
      ? 'partial'
      : 'unpriced'
  return {
    pricingState: state,
    currency: rule.currency,
    estimatedCostMicros: state === 'priced' ? knownCostMicros : null,
    knownCostMicros,
    snapshotVersion: rule.snapshotVersion,
    ruleId: rule.ruleId,
    missingComponents: Object.freeze(missingComponents),
  }
}

export const matchPricingRule = (rules: readonly PricingRule[], input: PricingMatchInput): PricingRule | null =>
  new PricingRuleMatcher(rules).match(input)

function componentCost(
  count: number | null,
  price: number | null,
  name: string,
  perMillion: boolean,
): { readonly cost: number; readonly known: boolean; readonly missing: boolean; readonly name: string } {
  if (count === null) {
    if (price === null || price === 0) return { cost: 0, known: false, missing: false, name }
    return { cost: 0, known: false, missing: true, name }
  }
  if (count === 0 && price === null) return { cost: 0, known: false, missing: false, name }
  if (price === null) return { cost: 0, known: false, missing: true, name }
  const cost = perMillion ? microsPerMillion(count, price) : multiplyMicros(count, price)
  return { cost, known: true, missing: false, name }
}

function microsPerMillion(count: number, price: number): number {
  return safeBigIntToNumber((BigInt(count) * BigInt(price) + 500_000n) / 1_000_000n)
}

function multiplyMicros(count: number, price: number): number {
  return safeBigIntToNumber(BigInt(count) * BigInt(price))
}

function safeBigIntToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('pricing estimate exceeds safe integer range')
  return Number(value)
}

function validateRule(rule: PricingRule): PricingRule {
  if (!rule || typeof rule !== 'object') throw new TypeError('pricing rule must be an object')
  for (const key of ['snapshotVersion', 'ruleId', 'currency', 'sourceName', 'sourceUrl', 'sourceVersion', 'sourceSha256', 'releaseVersion'] as const) {
    if (typeof rule[key] !== 'string' || rule[key].length === 0 || rule[key].length > 512) throw new TypeError(`invalid pricing rule ${key}`)
  }
  for (const dimension of DIMENSIONS) {
    if (typeof rule[dimension] !== 'string' || rule[dimension].length === 0 || rule[dimension].length > 512) {
      throw new TypeError(`invalid pricing rule ${dimension}`)
    }
  }
  for (const key of ['requestUnitPriceMicros', 'inputTokenPriceMicrosPerMillion', 'outputTokenPriceMicrosPerMillion',
    'cacheReadTokenPriceMicrosPerMillion', 'cacheWriteTokenPriceMicrosPerMillion', 'reasoningTokenPriceMicrosPerMillion'] as const) {
    const value = rule[key]
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`invalid pricing rule ${key}`)
  }
  if (!Number.isSafeInteger(rule.effectiveFromMs) || rule.effectiveFromMs < 0 ||
      (rule.effectiveToMs !== null && (!Number.isSafeInteger(rule.effectiveToMs) || rule.effectiveToMs <= rule.effectiveFromMs))) {
    throw new TypeError('invalid pricing rule effective window')
  }
  if (!Number.isSafeInteger(rule.generatedAtMs) || rule.generatedAtMs < 0) throw new TypeError('invalid pricing rule generatedAtMs')
  if (rule.requestUnitPriceMicros === null && rule.inputTokenPriceMicrosPerMillion === null &&
      rule.outputTokenPriceMicrosPerMillion === null && rule.cacheReadTokenPriceMicrosPerMillion === null &&
      rule.cacheWriteTokenPriceMicrosPerMillion === null && rule.reasoningTokenPriceMicrosPerMillion === null) {
    throw new TypeError('pricing rule has no prices')
  }
  return Object.freeze({ ...rule })
}

function validateOverlaps(rules: readonly PricingRule[]): void {
  for (let index = 0; index < rules.length; index += 1) {
    const left = rules[index]
    if (!left) continue
    for (let rightIndex = index + 1; rightIndex < rules.length; rightIndex += 1) {
      const right = rules[rightIndex]
      if (!right || specificityOf(left) !== specificityOf(right)) continue
      if (!windowsOverlap(left, right) || !dimensionsOverlap(left, right)) continue
      throw new Error(`equal-specificity pricing overlap: ${left.ruleId}/${right.ruleId}`)
    }
  }
}

function specificityOf(rule: PricingRule): number {
  return DIMENSIONS.reduce((count, dimension) => count + (rule[dimension] === WILDCARD ? 0 : 1), 0)
}

function windowsOverlap(left: PricingRule, right: PricingRule): boolean {
  const leftTo = left.effectiveToMs ?? Number.MAX_SAFE_INTEGER
  const rightTo = right.effectiveToMs ?? Number.MAX_SAFE_INTEGER
  return left.effectiveFromMs < rightTo && right.effectiveFromMs < leftTo
}

function dimensionsOverlap(left: PricingRule, right: PricingRule): boolean {
  return DIMENSIONS.every((dimension) => left[dimension] === WILDCARD || right[dimension] === WILDCARD || left[dimension] === right[dimension])
}

function isEffective(rule: PricingRule, atMs: number): boolean {
  return atMs >= rule.effectiveFromMs && (rule.effectiveToMs === null || atMs < rule.effectiveToMs)
}

function matchesDimensions(rule: PricingRule, input: PricingMatchInput): boolean {
  return DIMENSIONS.every((dimension) => rule[dimension] === WILDCARD || rule[dimension] === input[dimension])
}
