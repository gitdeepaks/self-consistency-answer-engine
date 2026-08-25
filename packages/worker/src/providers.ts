import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import {
  assertNever,
  resolveAvailability,
  resolveEvaluatorAvailability,
  resolvePanelAvailability,
  type ProviderAvailability,
  type ProviderId,
} from "@sce/shared"
import { gateway, type LanguageModel } from "ai"

/**
 * Turning an availability decision into a callable model.
 *
 * The *decision* — direct key, gateway, or unusable — lives in `@sce/shared`,
 * because the API has to answer `GET /api/providers` without loading three
 * provider SDKs. The *construction* lives here, in the only process that ever
 * makes a model call. One rule, one place, and the heavy dependencies stay on
 * the worker's side of the queue.
 */

export interface ResolvedProvider extends ProviderAvailability {
  /** null when the provider has no usable credentials. */
  model: LanguageModel | null
}

function directModel(id: ProviderId, modelId: string, apiKey: string): LanguageModel {
  switch (id) {
    case "openai":
      return createOpenAI({ apiKey })(modelId)
    case "anthropic":
      return createAnthropic({ apiKey })(modelId)
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId)
    default:
      return assertNever(id, "directModel")
  }
}

function withModel(availability: ProviderAvailability): ResolvedProvider {
  const { spec, modelId, route } = availability

  switch (route) {
    case "direct": {
      const apiKey = process.env[spec.apiKeyEnv]?.trim()
      if (apiKey === undefined || apiKey.length === 0) {
        // The key vanished between the availability check and here — treat it
        // as unavailable rather than constructing a client that cannot work.
        return { ...availability, route: null, model: null, hint: `${spec.apiKeyEnv} is not set.` }
      }
      return { ...availability, model: directModel(spec.id, modelId, apiKey) }
    }
    case "gateway":
      return { ...availability, model: gateway(`${spec.gatewayPrefix}/${modelId}`) }
    case null:
      return { ...availability, model: null }
    default:
      return assertNever(route, "withModel")
  }
}

export function resolveProvider(id: ProviderId, modelOverride?: string): ResolvedProvider {
  return withModel(resolveAvailability(id, modelOverride))
}

/** Resolve the whole panel, optionally narrowed to a subset of providers. */
export function resolvePanel(only?: readonly ProviderId[]): ResolvedProvider[] {
  return resolvePanelAvailability(only).map(withModel)
}

/** Resolve the evaluator that compares candidates and writes the final answer. */
export function resolveEvaluator(): ResolvedProvider {
  return withModel(resolveEvaluatorAvailability())
}
