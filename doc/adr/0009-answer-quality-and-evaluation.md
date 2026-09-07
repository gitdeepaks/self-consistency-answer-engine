# ADR-0009 — Measuring answer quality: golden set, LLM judge, and a gate

**Status:** accepted · **Date:** 2026-09-07 · **Phase:** 7

## Context

The product's thesis is one sentence: *a panel of independent models, compared by an evaluator,
produces a better answer than any single model.* Through Phase 6 that sentence was an assumption.
Nothing in the repository could tell whether it was true, whether it was still true after a prompt
edit, or by how much — and a claim nobody can measure is a claim that quietly becomes false.

Phase 7 makes it measurable. Six decisions were load-bearing enough to write down, because each has
a plausible alternative that would have produced numbers rather than knowledge.

## Decisions

### 1. Baselines come from the same run, not from separate calls

One run of the panel yields the synthesis, every panel member's own answer, and the majority vote —
all graded as separate systems. The alternative, re-asking each model separately, is both four times
the cost and *less* fair: a second sample of the same model at the same temperature is a different
answer, so a difference in score would partly measure sampling noise.

The majority-vote baseline is included deliberately and is the uncomfortable one. It is
"pick the candidate most in agreement with the others and ship it verbatim" — the whole architecture
minus the evaluator. If synthesis cannot beat that, the evaluator is an expensive way to choose a
winner, and the report says so instead of leaving the question unasked.

### 2. The judge is blind, rubric-driven and rotated

An LLM grades every answer, because grading a few hundred long answers by hand every night is not
something anyone will keep doing. That makes the judge a measuring instrument, and three properties
were required before its numbers could gate anything:

- **Blind.** The judge is never told which system produced the answer. Told it is reading "the
  synthesised answer", a model scores it higher — and the report's central comparison would then be
  measuring the label rather than the text.
- **Rubric-driven.** Every golden item carries an explicit statement of what a correct answer must
  contain, and the judge is asked which points are covered. "Rate this 1-10" produces a number that
  drifts with answer length, judge mood and model release.
- **Rotated.** A judge scores its own model family higher. Each answer is graded by one judge chosen
  deterministically from the item and the system, spreading that bias evenly across the set instead
  of handing it to one system under test.

What is left is measured, not assumed: `data/human-labels.jsonl` holds frozen answers with human
verdicts, and `evals judges` reports **Cohen's kappa** against them. Raw agreement was rejected as
the headline metric — on a set where 85% of answers pass, a judge that passes everything agrees 85%
of the time and is worthless, and kappa is what says so.

### 3. Calibration is derived, not scored

The plan lists calibration as a judged dimension alongside correctness, completeness and citation
fidelity. It is not implemented that way, and the reason is that it cannot be: "was 0.8 the right
confidence" is not a property of one answer. It is a property of *many* answers — of the 0.8s, did
about 80% turn out right — and asking a judge to score it per answer would produce a number that
looks like a measurement and is not one.

So the judge scores the three dimensions visible in the text, and calibration is computed across the
report from the confidences and the verdicts. It is reported as expected calibration error, maximum
bin error and Brier score, and the gate watches it.

### 4. A fitted calibration is checked on held-out data, or it is not shipped

`evals calibrate` fits a monotone correction (isotonic regression, via pool-adjacent-violators) on
two thirds of the answers and measures it on the third that was held out. Both halves are required:
a map evaluated on the data it was fitted to always looks excellent — it is by construction the best
fit to those points — and shipping on that basis is exactly how a "calibrated" number ends up less
trustworthy than the raw one it replaced. A map that does not improve *both* calibration error and
Brier score on held-out answers is not proposed at all.

The accepted map is deployed as configuration (`CONFIDENCE_CALIBRATION` on the worker), not as a row
in a table. It is a release decision: fitted, reviewed, and deployed with the build whose answers it
corrects. A knob that could silently change the confidence every customer sees, with no diff and no
review, would be the wrong shape.

Both numbers are stored on every synthesis, for ever. The raw value is the evidence the next fit is
made from; keeping only the corrected one would make the correction impossible to ever check.

### 5. Prompts and panels are versioned data, and their ids live on the run

The prompt text moved out of `packages/worker/src/prompts.ts` into an immutable registry in
`packages/shared/src/prompts.ts`, and the panel — which models, sampled how often, judged by whom —
became a configuration record in `panels.ts`. Both ids are written onto the run row.

The alternative was to keep editing the text in place. It costs nothing until the day somebody asks
why answers got worse last Tuesday, at which point the question is unanswerable: the prompt that
produced those answers no longer exists anywhere.

Two consequences follow, and both are deliberate:

- **A worker that does not recognise a run's prompt set or panel refuses the job** rather than
  falling back to its own current wording. Answering a run differently than it was created under
  would produce an answer nothing could later explain, which is the exact failure the registry
  exists to prevent. The job is retried and lands on a worker that does know the id.
- **`Candidate` lost its `@@unique([runId, provider])` constraint.** It made n-of-1 self-consistency
  — the same model asked the same question several times — unrepresentable, and that configuration
  is precisely the single-model baseline the product's claim has to be measured against. Reviews are
  now aligned to candidates by *label*, not by provider.

### 6. Experiments assign by tenant, and the assignment hash is finalised

`PANEL_EXPERIMENTS` is a JSON array in configuration rather than rows in a table, because starting
an experiment deserves a review of the hypothesis as much as of the weights — and because the panel
every customer's answers come from should not sit behind a form.

Assignment is by **workspace**, not by run: a tenant whose answers came from a different panel on
every request would produce noise rather than data, and would look broken to the people using it.

The hash matters more than it looks. FNV-1a's low bit is just the parity of the input bytes, so
`hash % 2` over two experiment ids of different parity assigns *every* tenant to opposite arms —
silently confounding one experiment with the other. `hashCohort` therefore applies an avalanche
finalizer, and `panels.test.ts` fails without it.

## Consequences

- Quality is a number in CI. `evals gate` blocks a release on a score regression, a per-category
  regression, or the synthesis losing to the best member of its own panel.
- A changed dataset downgrades every comparison to a warning rather than reporting a regression that
  is really an edit to the questions. Re-baselining is a reviewed pull request.
- The nightly job costs real money — 200 panel runs plus roughly 800 judge calls — which is why it
  is nightly and not per-commit, and why the harness's own tests run on every pull request with no
  keys at all.
- The answer cache (also Phase 7) is invisible to the harness by construction: every eval run sends
  `Cache-Control: no-store`, because a cached engine would grade one real run and re-grade its copy
  for ever, producing a report that is perfectly stable and measures nothing.

## Alternatives considered

**Human evaluation only.** The highest-quality signal and the one nobody sustains nightly. Kept as
the calibration set for the judge, which is the role it can actually hold.

**A third-party eval platform.** Would have arrived faster. Rejected because the golden set, the
rubrics and the gate thresholds are the actual asset here, and putting them behind someone else's
API makes the one thing worth owning the one thing not owned.

**Scoring failures as zero instead of excluding them.** Simpler to implement and actively harmful: a
provider outage would read as a quality regression, and the fix would become "re-run until the
number comes back" rather than "find out what broke".
