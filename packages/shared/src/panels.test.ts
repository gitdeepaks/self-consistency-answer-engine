import { describe, expect, test } from "bun:test"
import {
  assignPanel,
  assignVariant,
  DEFAULT_PANEL_ID,
  describePanel,
  experimentListSchema,
  experimentSchema,
  isExperimentActive,
  narrowPanel,
  panelConfigSchema,
  panelSeats,
  PANELS,
  PANEL_LIST,
  resolvePanelConfig,
  type Experiment,
} from "./panels.ts"
import { PROMPT_SETS } from "./prompts.ts"

const NOW = new Date("2026-09-07T12:00:00.000Z")

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return experimentSchema.parse({
    id: "third-member",
    label: "Is the third panel member worth it?",
    hypothesis: "Dropping Gemini costs less than two points of judged correctness.",
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: null,
    variants: [
      { id: "control", panelId: "trio", weight: 1 },
      { id: "duo", panelId: "duo", weight: 1 },
    ],
    ...overrides,
  })
}

describe("the built-in panels", () => {
  test("every registered panel is valid and self-consistent", () => {
    for (const panel of PANEL_LIST) {
      expect(panelConfigSchema.safeParse(panel).success).toBe(true)
      expect(panel.promptSetId in PROMPT_SETS).toBe(true)
    }
  })

  test("the default panel is registered under the id everything falls back to", () => {
    expect(resolvePanelConfig(null)?.id).toBe(DEFAULT_PANEL_ID)
    expect(PANELS[DEFAULT_PANEL_ID]).toBeDefined()
  })

  test("an unknown panel id resolves to null rather than to the default", () => {
    // Falling back would answer a run with a panel it was not created under,
    // which is the exact drift panel ids exist to prevent.
    expect(resolvePanelConfig("panel-from-the-future")).toBeNull()
  })
})

describe("panelSeats", () => {
  test("one seat per member, labelled by the provider", () => {
    const seats = panelSeats(PANELS.trio ?? PANELS[DEFAULT_PANEL_ID] ?? PANEL_LIST[0] ?? panelSeatsFixture())

    expect(seats.map((seat) => seat.provider)).toEqual(["openai", "anthropic", "google"])
    expect(seats.map((seat) => seat.label)).toEqual(["OpenAI", "Claude", "Gemini"])
    expect(seats.every((seat) => seat.sample === 1)).toBe(true)
  })

  test("a multi-sample member gets one numbered seat per sample", () => {
    const panel = panelConfigSchema.parse({
      id: "trio-plus",
      label: "Trio plus",
      description: "Two samples from OpenAI, one from each of the others.",
      members: [{ provider: "openai", samples: 2 }, { provider: "google" }],
      evaluator: { provider: "anthropic" },
    })

    const seats = panelSeats(panel)
    expect(seats.map((seat) => seat.label)).toEqual(["OpenAI #1", "OpenAI #2", "Gemini"])
    expect(seats.map((seat) => seat.sample)).toEqual([1, 2, 1])
    // Labels are what reviews align to, so they have to be unique.
    expect(new Set(seats.map((seat) => seat.label)).size).toBe(seats.length)
  })

  test("a pinned model reaches the seat; an unpinned one is left to the environment", () => {
    const panel = panelConfigSchema.parse({
      id: "pinned",
      label: "Pinned",
      description: "One member on a pinned checkpoint.",
      members: [{ provider: "openai", model: "gpt-5.5-2026-08" }, { provider: "google" }],
      evaluator: { provider: "anthropic" },
    })

    const seats = panelSeats(panel)
    expect(seats[0]?.model).toBe("gpt-5.5-2026-08")
    expect(seats[1]?.model).toBeNull()
  })
})

describe("panelConfigSchema", () => {
  test("refuses a panel that would draw more candidates than the cap", () => {
    const parsed = panelConfigSchema.safeParse({
      id: "too-big",
      label: "Too big",
      description: "Nine candidates for one question.",
      members: [
        { provider: "openai", samples: 5 },
        { provider: "anthropic", samples: 5 },
      ],
      evaluator: { provider: "anthropic" },
    })

    expect(parsed.success).toBe(false)
  })

  test("refuses an empty panel", () => {
    const parsed = panelConfigSchema.safeParse({
      id: "empty",
      label: "Empty",
      description: "Nobody to ask.",
      members: [],
      evaluator: { provider: "anthropic" },
    })

    expect(parsed.success).toBe(false)
  })
})

describe("narrowPanel", () => {
  test("keeps only the providers the caller asked for", () => {
    const trio = PANELS.trio
    expect(trio).toBeDefined()
    if (trio === undefined) return

    const narrowed = narrowPanel(trio, ["anthropic"])
    expect(narrowed.members.map((member) => member.provider)).toEqual(["anthropic"])
    expect(narrowed.id).toBe(trio.id)
  })

  test("a request that would empty the panel is ignored", () => {
    const selfConsistency = PANELS["self-consistency-3"]
    expect(selfConsistency).toBeDefined()
    if (selfConsistency === undefined) return

    // Asking a single-model panel for Gemini only leaves nobody to ask, and an
    // empty panel is a run that fails rather than a run that is cheaper.
    expect(narrowPanel(selfConsistency, ["google"]).members).toEqual(selfConsistency.members)
  })
})

describe("experiments", () => {
  test("a variant naming an unregistered panel is refused", () => {
    const parsed = experimentSchema.safeParse({
      id: "bad",
      label: "Bad",
      hypothesis: "Nothing, because this panel does not exist.",
      startsAt: "2026-09-01T00:00:00.000Z",
      variants: [
        { id: "control", panelId: "trio" },
        { id: "ghost", panelId: "not-a-panel" },
      ],
    })

    expect(parsed.success).toBe(false)
  })

  test("duplicate variant ids and duplicate experiment ids are refused", () => {
    expect(
      experimentSchema.safeParse({
        id: "dupes",
        label: "Dupes",
        hypothesis: "Two arms with one name.",
        startsAt: "2026-09-01T00:00:00.000Z",
        variants: [
          { id: "a", panelId: "trio" },
          { id: "a", panelId: "duo" },
        ],
      }).success,
    ).toBe(false)

    expect(experimentListSchema.safeParse([experiment(), experiment()]).success).toBe(false)
  })

  test("an experiment is inactive before it starts and after it ends", () => {
    const window = experiment({ endsAt: "2026-09-10T00:00:00.000Z" })

    expect(isExperimentActive(window, new Date("2026-08-30T00:00:00.000Z"))).toBe(false)
    expect(isExperimentActive(window, NOW)).toBe(true)
    expect(isExperimentActive(window, new Date("2026-09-11T00:00:00.000Z"))).toBe(false)
    expect(assignVariant(window, "tenant_1", new Date("2026-08-30T00:00:00.000Z"))).toBeNull()
  })

  test("assignment is stable for a tenant and spread across tenants", () => {
    const live = experiment()

    const first = assignVariant(live, "tenant_1", NOW)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(assignVariant(live, "tenant_1", NOW)?.id).toBe(first?.id)
    }

    const tenants = Array.from({ length: 400 }, (_unused, index) => `tenant_${index}`)
    const control = tenants.filter((tenant) => assignVariant(live, tenant, NOW)?.id === "control").length
    // Even 50/50 weights: a split this far off would mean the hash is degenerate.
    expect(control).toBeGreaterThan(140)
    expect(control).toBeLessThan(260)
  })

  test("weights shift the split without changing determinism", () => {
    const weighted = experiment({
      variants: [
        { id: "control", panelId: "trio", weight: 9 },
        { id: "duo", panelId: "duo", weight: 1 },
      ],
    })

    const tenants = Array.from({ length: 400 }, (_unused, index) => `tenant_${index}`)
    const treated = tenants.filter((tenant) => assignVariant(weighted, tenant, NOW)?.id === "duo").length

    expect(treated).toBeGreaterThan(10)
    expect(treated).toBeLessThan(100)
  })

  test("two experiments do not put the same tenants in the same arm", () => {
    const first = experiment()
    const second = experiment({ id: "evaluator-swap" })

    const tenants = Array.from({ length: 400 }, (_unused, index) => `tenant_${index}`)
    const agree = tenants.filter(
      (tenant) => assignVariant(first, tenant, NOW)?.id === assignVariant(second, tenant, NOW)?.id,
    ).length

    // Independent assignment agrees about half the time. Hashing the tenant
    // alone would agree every time, and confound both experiments.
    expect(agree).toBeGreaterThan(140)
    expect(agree).toBeLessThan(260)
  })

  test("assignPanel picks one experiment, and falls back cleanly", () => {
    const live = experiment()
    const assignment = assignPanel([live], "tenant_1", NOW)

    expect(assignment.experimentId).toBe("third-member")
    expect(["trio", "duo"]).toContain(assignment.panelId)
    expect(assignment.variantId).not.toBeNull()

    const none = assignPanel([], "tenant_1", NOW)
    expect(none).toEqual({ panelId: DEFAULT_PANEL_ID, experimentId: null, variantId: null })

    const future = assignPanel([experiment({ startsAt: "2027-01-01T00:00:00.000Z" })], "tenant_1", NOW)
    expect(future.experimentId).toBeNull()
  })

  test("a run belongs to at most one experiment", () => {
    const assignment = assignPanel([experiment(), experiment({ id: "evaluator-swap" })], "tenant_9", NOW)
    expect(assignment.experimentId).toBe("third-member")
  })
})

describe("describePanel", () => {
  test("carries the prompt set, which is half of what a panel means", () => {
    const trio = PANELS.trio
    expect(trio).toBeDefined()
    if (trio === undefined) return

    expect(describePanel(trio)).toEqual({
      id: trio.id,
      label: trio.label,
      description: trio.description,
      promptSetId: trio.promptSetId,
    })
  })
})

/** Only reached if the registry is empty, which the first suite already fails on. */
function panelSeatsFixture(): never {
  throw new Error("the panel registry is empty")
}
