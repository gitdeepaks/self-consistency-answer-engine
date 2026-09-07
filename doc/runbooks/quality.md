# Runbook — answer quality

What to do when the quality gate fails, when the confidence number stops making sense, or when the
answer cache starts serving something it should not.

Dashboards: the **Quality** tab of the operations console (`/admin`, install operators only).
Everything below assumes you can run `bun run evals` in a checkout with the workspace installed.

---

## The nightly gate failed

The `evals` workflow uploads `report.json` and `report.md` as artefacts on every run, pass or fail.
Start there — the gate's own output names the finding and the numbers behind it.

### `score-regression` or `category-regression:<category>`

Synthesis fell further than the allowance against `packages/evals/baselines/current.json`.

1. **Check the dataset digest first.** If the report also carries `dataset-changed`, the comparison
   is between two different sets of questions and every score movement is a warning, not a
   regression. Re-baseline (below) and move on.
2. **Find out what changed.** Compare the failing report to the baseline by category. A regression
   in one category usually points straight at the change: a prompt edit that made answers terser
   shows up in `longform`; a panel change shows up everywhere; a provider swapping a model
   underneath you shows up in `coding` first, because it is the category a judge can check hardest.
3. **Read five failing items.** `report.json` carries the full verdict for every graded answer,
   including the judge's rationale and the rubric points it recorded as missed. Five is usually
   enough to see the pattern.
4. **Check whether the judge moved.** Run `bun run evals judges`. If kappa has fallen below 0.6, the
   *instrument* changed, not the product — a judge model was updated underneath you — and the score
   movement is not evidence of anything until that is fixed.

### `thesis-broken`

Synthesis scored below the best single model in its own panel. This is the serious one: the panel is
not currently earning the calls it makes.

- Look at the per-system table. If one member's own answers now beat the merged answer, the
  evaluator is losing information — usually because the evaluator prompt or model changed, or
  because the panel's members became so similar that there is nothing left to synthesise.
- Check `evaluator-not-earning` in the same report. If majority vote also beats synthesis, the
  problem is the evaluator specifically, not the panel.
- Roll back the change that caused it. This is not a threshold to relax.

### `sample-too-small` or `no-synthesis`

The harness failed, not the product. Read the `failures` list in the report: it names the item, the
system and the error. Provider outages, an expired `EVALS_API_KEY`, and a deployment that is down
all land here. Fix and re-run; do not adjust the thresholds to make it pass.

### Re-baselining

Only after the movement is understood and accepted:

```sh
cp report.json packages/evals/baselines/current.json
```

Commit it in a pull request whose description says what moved and why it is acceptable. The baseline
is committed precisely so that this is a reviewed decision with a readable diff rather than a number
that drifts on its own.

---

## The confidence number looks wrong

Symptoms: the Quality tab shows a large expected calibration error, or users report that answers
marked 90% are often wrong.

1. **Check the sample size.** The console's calibration panel is computed from thumbs, which is a
   weak label — people click for tone and speed as well as accuracy. Below a few hundred rated
   answers it says very little.
2. **Get the judged measurement.** The nightly report's calibration section is the real one, scored
   against the golden set rather than against opinions.
3. **Fit a correction:**

   ```sh
   bun run evals calibrate --report report.json --out calibration.json
   ```

   It fits on two thirds and checks on the held-out third. If it prints *no map proposed*, that is
   the answer: either there is too little data, or the fit did not improve both calibration error
   and Brier score, and the raw number stays.
4. **Deploy the map** as `CONFIDENCE_CALIBRATION` on the worker, in a pull request, with the
   before/after numbers in the description. Both readings are stored on every synthesis afterwards,
   so the correction stays checkable.

**Never** hand-edit a calibration map. It is a fitted object; a hand-edited one is a number somebody
made up, wearing the clothes of a measurement.

---

## The answer cache is serving something wrong

Symptoms: a user reports getting an answer to a question they did not ask, or a stale answer to
something time-sensitive.

**Stop the bleeding.** Set `ANSWER_CACHE_ENABLED=false` on the API and restart. Nothing else depends
on the cache; runs simply start paying for their model calls again.

Then work out which of the two matching modes did it:

- **A stale but correct answer.** Exact matching worked as designed and the world moved. Lower
  `ANSWER_CACHE_TTL_MS`. The default of 24 hours suits questions whose answers do not change hourly.
- **An answer to a *different* question.** Near-duplicate matching was too loose. Turn off
  `ANSWER_CACHE_NEAR_DUPLICATES` first, then work out which check should have caught it — all three
  must pass before an answer is reused:
  - the two questions used *different words* → raise `ANSWER_CACHE_MIN_JACCARD`;
  - the two questions used the *same words in a different order* → raise
    `ANSWER_CACHE_MIN_SHINGLE`, which is the only one of the three that can see order;
  - a great many unrelated prompts are reaching the overlap checks at all → lower
    `ANSWER_CACHE_MAX_HAMMING`, which is the prefilter and costs only search time.

To find the run involved: a cached run carries `cachedFromRunId`, and the web UI shows a **from
cache** link on it pointing at the run that actually generated the answer. Compare the two prompts.

A caller can always bypass the cache for one request with `Cache-Control: no-store`; the eval
harness always does, so cache behaviour never contaminates a quality measurement.

---

## An experiment is producing nothing

The Quality tab lists every configured experiment with its arms, including arms with zero runs.

- **All arms empty.** The API is not running with `PANEL_EXPERIMENTS` set, or the experiment's
  `startsAt` is in the future. Check the API's boot logs: a malformed experiment list stops the
  process rather than silently assigning everybody to control.
- **One arm empty.** Its weight is zero, or the tenant population is too small for the split to have
  reached it. Assignment is deterministic per workspace, so a handful of workspaces can genuinely
  land entirely in one arm.
- **Runs exist but the numbers are identical.** Check that the arms name *different* panels, and that
  the callers are not passing an explicit `providers` list — a caller that chooses its own panel is
  excluded from every arm on purpose.

To end an experiment, set its `endsAt` in the past or remove it from the list. Its historical runs
keep their `experimentId`, and the console continues to report them under "no longer configured".

---

## Complaints are piling up in triage

The feedback queue (`GET /api/feedback?status=open`) is the list of thumbs-downs nobody has read.

1. Work the queue oldest first. For each: was the answer actually wrong?
   - Yes → `accepted`, with a note saying what a correct answer needed to contain.
   - No → `dismissed`.
2. Export the accepted ones:

   ```sh
   bun run evals triage --promote
   ```

   This writes `packages/evals/data/staging/from-feedback-<date>.jsonl` and marks the verdicts so
   they are never exported twice.
3. For each staged item, write the rubric, choose the right category, and move the line into
   `packages/evals/data/goldens/`. It starts gating releases from the next nightly run.

Step 3 is the one that cannot be automated. The export knows what was asked and that somebody was
unhappy; what a *correct* answer must contain is the judgement a person supplies, and a generated
rubric would produce a test that passes whenever the model repeats itself.
