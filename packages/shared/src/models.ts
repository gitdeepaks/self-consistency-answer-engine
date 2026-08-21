/**
 * Static registry of the model panel used for self-consistency sampling.
 *
 * Every id here is overridable through env vars so the panel can be retuned
 * without touching code (see `resolvePanel` in @sce/server).
 */

export const PROVIDER_IDS = ["openai", "anthropic", "google"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface ProviderSpec {
  /** Stable provider key, also used as the env-var prefix. */
  id: ProviderId
  /** Human readable name shown in the CLI. */
  label: string
  /** Env var holding the provider's own API key. */
  apiKeyEnv: string
  /** Env var that overrides the default model id. */
  modelEnv: string
  /** Default model id for the provider's native API. */
  defaultModel: string
  /** Prefix used when routing through the Vercel AI Gateway fallback. */
  gatewayPrefix: string
  /** Accent colour used by the CLI. */
  color: string
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-5.5",
    gatewayPrefix: "openai",
    color: "#10a37f",
  },
  anthropic: {
    id: "anthropic",
    label: "Claude",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-5",
    gatewayPrefix: "anthropic",
    color: "#d97757",
  },
  google: {
    id: "google",
    label: "Gemini",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    modelEnv: "GOOGLE_MODEL",
    defaultModel: "gemini-3.7-flash",
    gatewayPrefix: "google",
    color: "#4285f4",
  },
}

export const PROVIDER_LIST: ProviderSpec[] = PROVIDER_IDS.map((id) => PROVIDERS[id])

/** The evaluator that synthesises the final answer. Claude by default. */
export const EVALUATOR = {
  provider: "anthropic" as ProviderId,
  modelEnv: "EVALUATOR_MODEL",
  defaultModel: "claude-opus-5",
} as const

export const GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY"
