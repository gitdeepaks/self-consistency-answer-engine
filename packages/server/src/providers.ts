import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import {
  EVALUATOR,
  GATEWAY_API_KEY_ENV,
  PROVIDERS,
  PROVIDER_LIST,
  type ProviderHealth,
  type ProviderId,
  type ProviderSpec,
} from "@sce/shared"
import { gateway, type LanguageModel } from "ai"

export type Route = "direct" | "gateway"

export interface ResolvedProvider {
  spec: ProviderSpec
  modelId: string
  route: Route | null
  /** null when the provider has no usable credentials. */
  model: LanguageModel | null
  /** Operator-facing reason the provider is unusable. */
  hint: string | null
}

function directModel(spec: ProviderSpec, modelId: string, apiKey: string): LanguageModel {
  switch (spec.id) {
    case "openai":
      return createOpenAI({ apiKey })(modelId)
    case "anthropic":
      return createAnthropic({ apiKey })(modelId)
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId)
  }
}

function gatewayKey(): string | undefined {
  return process.env[GATEWAY_API_KEY_ENV]?.trim() || undefined
}

/**
 * Pick how to reach a provider.
 *
 * Preference order is the provider's own API key, then the Vercel AI Gateway
 * (one key for all three), then unavailable. Resolution happens per call rather
 * than once at boot so that editing `.env` and restarting is the only step
 * needed to bring a provider online.
 */
export function resolveProvider(id: ProviderId, modelOverride?: string): ResolvedProvider {
  const spec = PROVIDERS[id]
  const modelId = modelOverride ?? process.env[spec.modelEnv]?.trim() ?? spec.defaultModel

  const apiKey = process.env[spec.apiKeyEnv]?.trim()
  if (apiKey) {
    return { spec, modelId, route: "direct", model: directModel(spec, modelId, apiKey), hint: null }
  }

  if (gatewayKey()) {
    return {
      spec,
      modelId,
      route: "gateway",
      model: gateway(`${spec.gatewayPrefix}/${modelId}`),
      hint: null,
    }
  }

  return {
    spec,
    modelId,
    route: null,
    model: null,
    hint: `Set ${spec.apiKeyEnv} (or ${GATEWAY_API_KEY_ENV}) to enable ${spec.label}.`,
  }
}

/** Resolve the evaluator that compares candidates and writes the final answer. */
export function resolveEvaluator(): ResolvedProvider {
  const modelId = process.env[EVALUATOR.modelEnv]?.trim() ?? EVALUATOR.defaultModel
  return resolveProvider(EVALUATOR.provider, modelId)
}

/** Resolve the whole panel, optionally narrowed to a subset of providers. */
export function resolvePanel(only?: ProviderId[]): ResolvedProvider[] {
  const wanted = only && only.length > 0 ? new Set(only) : null
  return PROVIDER_LIST.filter((spec) => !wanted || wanted.has(spec.id)).map((spec) =>
    resolveProvider(spec.id),
  )
}

export function toHealth(resolved: ResolvedProvider): ProviderHealth {
  return {
    id: resolved.spec.id,
    label: resolved.spec.label,
    model: resolved.modelId,
    color: resolved.spec.color,
    available: resolved.model !== null,
    route: resolved.route,
    hint: resolved.hint,
  }
}
