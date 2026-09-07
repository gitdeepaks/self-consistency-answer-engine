import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "./models.ts"
import { DEFAULT_PROMPT_SET_ID, promptSetIdSchema, type PromptSetId } from "./prompts.ts"
import { z } from "zod"

/**
 * Panels as configuration.
 *
 * The product thesis is that a panel of independent models, compared by an
 * evaluator, beats any one of them. That is a claim about a *configuration* —
 * which models, how many, sampled how often, judged by whom — and a claim you
 * cannot test if the configuration is three hard-coded provider ids.
 *
 * So a panel is data with an id. Swapping a member, adding a fourth, changing
 * the evaluator or sampling one model three times are all edits to a record
 * here, and the id lands on the run, which is what lets Phase 7 report quality
 * per panel instead of per release.
 *
 * Two deliberate limits:
 *
 *   - A panel names providers and *optionally* pins a model. Left unpinned, the
 *     provider's env-configured model wins, so a panel does not go stale every
 *     time a vendor renames a checkpoint.
 *   - `samples` above one is n-of-1 self-consistency: the same model asked the
 *     same question repeatedly, which is the honest baseline the multi-model
 *     panel has to beat. It is why `Candidate` no longer requires one row per
 *     provider per run.
 */

export const MAX_PANEL_MEMBERS = 8
export const MAX_MEMBER_SAMPLES = 5

export const panelMemberSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** Pin a model id, or null to use whatever the environment configures. */
  model: z.string().trim().min(1).max(200).nullable().default(null),
  /** How many independent samples to draw from this member. */
  samples: z.number().int().min(1).max(MAX_MEMBER_SAMPLES).default(1),
})
export type PanelMember = z.infer<typeof panelMemberSchema>

export const panelEvaluatorSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1).max(200).nullable().default(null),
})
export type PanelEvaluator = z.infer<typeof panelEvaluatorSchema>

export const panelConfigSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "A panel id may only contain a-z 0-9 . _ -"),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
    members: z.array(panelMemberSchema).min(1).max(MAX_PANEL_MEMBERS),
    evaluator: panelEvaluatorSchema,
    /** Sampling temperature for every member, or null for the model default. */
    temperature: z.number().min(0).max(2).nullable().default(null),
    promptSetId: promptSetIdSchema.default(DEFAULT_PROMPT_SET_ID),
  })
  .refine((panel) => totalSamples(panel.members) <= MAX_PANEL_MEMBERS, {
    message: `A panel may draw at most ${MAX_PANEL_MEMBERS} candidates in total`,
    path: ["members"],
  })
export type PanelConfig = z.infer<typeof panelConfigSchema>

function totalSamples(members: readonly PanelMember[]): number {
  return members.reduce((total, member) => total + member.samples, 0)
}

/**
 * One seat at the panel: a member, resolved to the candidate rows it produces.
 *
 * `label` is what disambiguates two samples of the same model in every surface
 * that shows candidates side by side — and, since the evaluator returns one
 * review per label, it is also what keeps reviews aligned 1:1 with candidates.
 */
export interface PanelSeat {
  readonly provider: ProviderId
  readonly label: string
  /** Null when the panel did not pin one and the environment decides. */
  readonly model: string | null
  /** 1-based index of this sample within its member. */
  readonly sample: number
}

/**
 * Expand a panel into the seats it fills.
 *
 * A single-sample member keeps the provider's plain label ("Claude"), because
 * suffixing every panel in the product with "#1" to serve the rare
 * self-consistency case would be a worse trade than the branch here.
 */
export function panelSeats(panel: PanelConfig): PanelSeat[] {
  const seats: PanelSeat[] = []
  for (const member of panel.members) {
    const spec = PROVIDERS[member.provider]
    for (let sample = 1; sample <= member.samples; sample += 1) {
      seats.push({
        provider: member.provider,
        label: member.samples === 1 ? spec.label : `${spec.label} #${sample}`,
        model: member.model,
        sample,
      })
    }
  }
  return seats
}

/* ------------------------------------------------------------- the registry */

function panel(config: z.input<typeof panelConfigSchema>): PanelConfig {
  // Parsed rather than asserted, so a malformed built-in fails at import time
  // instead of at the first run that happens to use it.
  return panelConfigSchema.parse(config)
}

export const DEFAULT_PANEL_ID = "trio"

/**
 * The built-in panels.
 *
 * `trio` is the product's default and the control arm of every experiment.
 * The rest exist to be measured against it: `duo` asks what the third member is
 * worth, `quad` what a second sample of one member is worth, and
 * `self-consistency-3` is the single-model baseline the whole thesis claims to
 * beat — same model, three samples, same evaluator, so the only variable left
 * is model diversity.
 */
export const PANELS: Readonly<Record<string, PanelConfig>> = {
  trio: panel({
    id: "trio",
    label: "Trio",
    description: "One answer from each provider, synthesised by the evaluator. The default panel.",
    members: [{ provider: "openai" }, { provider: "anthropic" }, { provider: "google" }],
    evaluator: { provider: "anthropic" },
  }),
  duo: panel({
    id: "duo",
    label: "Duo",
    description: "Two members instead of three — the cheap arm, and the test of what the third is worth.",
    members: [{ provider: "openai" }, { provider: "anthropic" }],
    evaluator: { provider: "anthropic" },
  }),
  quad: panel({
    id: "quad",
    label: "Quad",
    description: "The trio plus a second independent sample from OpenAI.",
    members: [{ provider: "openai", samples: 2 }, { provider: "anthropic" }, { provider: "google" }],
    evaluator: { provider: "anthropic" },
  }),
  "self-consistency-3": panel({
    id: "self-consistency-3",
    label: "Self-consistency ×3",
    description:
      "One model sampled three times at a raised temperature: the single-model baseline the panel has to beat.",
    members: [{ provider: "openai", samples: 3 }],
    evaluator: { provider: "anthropic" },
    temperature: 0.8,
  }),
}

export const PANEL_LIST: readonly PanelConfig[] = Object.values(PANELS)

export function resolvePanelConfig(id: string | null): PanelConfig | null {
  if (id === null) return PANELS[DEFAULT_PANEL_ID] ?? null
  return PANELS[id] ?? null
}

/**
 * The default panel, narrowed to the providers a caller asked for.
 *
 * `POST /runs` has always accepted a `providers` subset, and that request is
 * older than panels — so it is honoured by filtering the default panel rather
 * than by inventing an unregistered one. A caller who narrows the panel opts
 * out of experiment assignment (see `startRun`): their run is not a sample of
 * anything.
 */
export function narrowPanel(panelConfig: PanelConfig, only: readonly ProviderId[]): PanelConfig {
  const wanted = new Set(only)
  const members = panelConfig.members.filter((member) => wanted.has(member.provider))
  return members.length === 0 ? panelConfig : { ...panelConfig, members }
}

/* ------------------------------------------------------------- experiments */

/**
 * A live A/B test between panels.
 *
 * Assignment is by **tenant**, not by run: a workspace whose answers came from
 * a different panel on every request would produce noise rather than data, and
 * would look broken to the people using it. One cohort, one panel, for the life
 * of the experiment.
 */
export const experimentVariantSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "A variant id may only contain a-z 0-9 . _ -"),
  panelId: z.string().trim().min(1).max(60),
  /** Relative share of tenants. Weights need not sum to anything in particular. */
  weight: z.number().int().min(1).max(1000).default(1),
})
export type ExperimentVariant = z.infer<typeof experimentVariantSchema>

export const experimentSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "An experiment id may only contain a-z 0-9 . _ -"),
    label: z.string().trim().min(1).max(120),
    /** What this experiment is expected to show. Read in the admin console. */
    hypothesis: z.string().trim().min(1).max(400),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime().nullable().default(null),
    variants: z.array(experimentVariantSchema).min(2).max(8),
  })
  .refine((experiment) => new Set(experiment.variants.map((v) => v.id)).size === experiment.variants.length, {
    message: "Variant ids must be unique inside an experiment",
    path: ["variants"],
  })
  .refine((experiment) => experiment.variants.every((variant) => variant.panelId in PANELS), {
    message: "Every variant must name a registered panel",
    path: ["variants"],
  })
  .refine(
    (experiment) => experiment.endsAt === null || Date.parse(experiment.endsAt) > Date.parse(experiment.startsAt),
    { message: "An experiment cannot end before it starts", path: ["endsAt"] },
  )
export type Experiment = z.infer<typeof experimentSchema>

/**
 * The experiment list, as an operator supplies it.
 *
 * A JSON array in configuration rather than rows in a table: an experiment is a
 * deliberate act by whoever is running the release, it needs a code review of
 * the hypothesis as much as of the weights, and making it deployable-by-button
 * would put the panel every customer's answers come from behind a form. Ids
 * must be unique so assignment is reproducible.
 */
export const experimentListSchema = z
  .array(experimentSchema)
  .max(20)
  .refine((experiments) => new Set(experiments.map((e) => e.id)).size === experiments.length, {
    message: "Experiment ids must be unique",
  })

export function isExperimentActive(experiment: Experiment, now: Date): boolean {
  const at = now.getTime()
  if (at < Date.parse(experiment.startsAt)) return false
  return experiment.endsAt === null || at < Date.parse(experiment.endsAt)
}

/**
 * A stable, well-mixed 32-bit hash of a cohort key.
 *
 * Assignment has to be **stable** — the same tenant landing in the same cohort
 * on every request, in every replica, across restarts — which rules out
 * anything seeded or random. It does not have to be cryptographic: nobody
 * gains anything from predicting which panel answers their question.
 *
 * FNV-1a does the accumulation and a finalizer does the mixing, and the
 * finalizer is not optional. FNV-1a's low bits are close to worthless: its
 * prime is odd, so the bottom bit of the digest is just the parity of the input
 * bytes — and `hash % 2` over two experiment ids of different parity assigns
 * *every* tenant to opposite arms, which silently confounds one experiment with
 * the other. The avalanche step below is what makes the low bits carry the same
 * entropy as the high ones, and there is a test that fails without it.
 */
export function hashCohort(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }

  // The `lowbias32` finalizer: two multiply-xorshift rounds, chosen for having
  // the lowest measured bias of the 32-bit mixers in common use.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * Which arm this tenant is in, or null if the experiment is not running.
 *
 * Hashing `experimentId:tenantId` rather than the tenant alone is what keeps
 * two concurrent experiments independent: hashing the tenant alone would put
 * the same workspaces in the "first" arm of everything, and a correlation like
 * that turns two clean results into one confounded one.
 */
export function assignVariant(
  experiment: Experiment,
  tenantId: string,
  now: Date,
): ExperimentVariant | null {
  if (!isExperimentActive(experiment, now)) return null

  const total = experiment.variants.reduce((sum, variant) => sum + variant.weight, 0)
  if (total <= 0) return null

  let cursor = hashCohort(`${experiment.id}:${tenantId}`) % total
  for (const variant of experiment.variants) {
    if (cursor < variant.weight) return variant
    cursor -= variant.weight
  }
  // Unreachable while the weights sum to `total`, and returning the last
  // variant is still a correct assignment if that ever stops being true.
  return experiment.variants[experiment.variants.length - 1] ?? null
}

/** The run's arm, as it is stored and reported. */
export interface RunAssignment {
  readonly panelId: string
  readonly experimentId: string | null
  readonly variantId: string | null
}

/**
 * Pick the panel for one run.
 *
 * The first active experiment that assigns this tenant wins, and the rest are
 * ignored: a run belongs to at most one experiment, because a run in two
 * overlapping experiments is a data point neither of them can use.
 */
export function assignPanel(
  experiments: readonly Experiment[],
  tenantId: string,
  now: Date,
  fallbackPanelId: string = DEFAULT_PANEL_ID,
): RunAssignment {
  for (const experiment of experiments) {
    const variant = assignVariant(experiment, tenantId, now)
    if (variant !== null) {
      return { panelId: variant.panelId, experimentId: experiment.id, variantId: variant.id }
    }
  }
  return { panelId: fallbackPanelId, experimentId: null, variantId: null }
}

/** The panel a run says it used, described for a UI. */
export interface PanelSummary {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly promptSetId: PromptSetId
}

export function describePanel(panelConfig: PanelConfig): PanelSummary {
  return {
    id: panelConfig.id,
    label: panelConfig.label,
    description: panelConfig.description,
    promptSetId: panelConfig.promptSetId,
  }
}
