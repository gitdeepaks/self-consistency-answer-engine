import {
  EVALUATOR,
  GATEWAY_API_KEY_ENV,
  PROVIDERS,
  PROVIDER_LIST,
  type ProviderId,
  type ProviderSpec,
} from "./models.ts"
import type { ProviderHealth } from "./schemas.ts"

/**
 * How a provider is reached, decided from configuration alone.
 *
 * This module deliberately contains no reference to the AI SDK. The API needs
 * to answer "which panel members are usable right now" on `GET /api/providers`,
 * and the worker needs to build a client — but only the worker should carry the
 * provider SDKs. Splitting the *decision* (here) from the *construction* (in
 * `@sce/worker`) keeps that dependency on one side of the queue without
 * duplicating the rule that decides it.
 */

export type Route = "direct" | "gateway"

/** The subset of the environment this module reads. Injectable, so it is testable. */
export type EnvSource = Readonly<Record<string, string | undefined>>

export interface ProviderAvailability {
  spec: ProviderSpec
  /** The model id that would actually be called. */
  modelId: string
  /** null when the provider has no usable credentials. */
  route: Route | null
  /** Operator-facing reason the provider is unusable, or null when it is fine. */
  hint: string | null
}

function read(env: EnvSource, name: string): string | null {
  const value = env[name]?.trim()
  return value !== undefined && value.length > 0 ? value : null
}

/**
 * Pick how to reach a provider.
 *
 * Preference order is the provider's own API key, then the Vercel AI Gateway
 * (one key for all three), then unavailable. Resolution happens per call rather
 * than once at boot so that editing `.env` and restarting is the only step
 * needed to bring a provider online.
 */
export function resolveAvailability(
  id: ProviderId,
  modelOverride?: string,
  env: EnvSource = process.env,
): ProviderAvailability {
  const spec = PROVIDERS[id]
  const modelId = modelOverride ?? read(env, spec.modelEnv) ?? spec.defaultModel

  if (read(env, spec.apiKeyEnv)) return { spec, modelId, route: "direct", hint: null }
  if (read(env, GATEWAY_API_KEY_ENV)) return { spec, modelId, route: "gateway", hint: null }

  return {
    spec,
    modelId,
    route: null,
    hint: `Set ${spec.apiKeyEnv} (or ${GATEWAY_API_KEY_ENV}) to enable ${spec.label}.`,
  }
}

/** Resolve the whole panel, optionally narrowed to a subset of providers. */
export function resolvePanelAvailability(
  only?: readonly ProviderId[],
  env: EnvSource = process.env,
): ProviderAvailability[] {
  const wanted = only && only.length > 0 ? new Set(only) : null
  return PROVIDER_LIST.filter((spec) => !wanted || wanted.has(spec.id)).map((spec) =>
    resolveAvailability(spec.id, undefined, env),
  )
}

/**
 * Resolve the evaluator that compares candidates and writes the final answer.
 *
 * The model id is always passed explicitly — `EVALUATOR_MODEL`, or the
 * evaluator's own default. Letting it fall through to `resolveAvailability`'s
 * lookup would pick up `ANTHROPIC_MODEL`, silently demoting the evaluator to
 * whatever the *panel's* Claude is set to. The evaluator is deliberately a
 * stronger model than the panel member from the same vendor, and that
 * distinction has to survive configuration.
 */
export function resolveEvaluatorAvailability(env: EnvSource = process.env): ProviderAvailability {
  const modelId = read(env, EVALUATOR.modelEnv) ?? EVALUATOR.defaultModel
  return resolveAvailability(EVALUATOR.provider, modelId, env)
}

export function toHealth(availability: ProviderAvailability): ProviderHealth {
  return {
    id: availability.spec.id,
    label: availability.spec.label,
    model: availability.modelId,
    color: availability.spec.color,
    available: availability.route !== null,
    route: availability.route,
    hint: availability.hint,
  }
}
