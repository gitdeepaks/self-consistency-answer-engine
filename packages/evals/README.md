# @sce/evals

The answer-quality harness: the golden set, the judge, the baselines the panel
has to beat, and the gate that blocks a release when it stops beating them.

This package exists to answer one question with numbers rather than opinions:

> Does synthesising several independent answers actually beat the best single
> model — and by how much, on what, and is that still true today?

---

## The five commands

```sh
bun run evals dataset                              # validate the golden set
bun run evals run --out report.json                # measure a deployment
bun run evals report report.json                   # render it as Markdown
bun run evals gate --report report.json \
  --baseline packages/evals/baselines/current.json # block a regression
bun run evals calibrate --report report.json       # fit the confidence correction
bun run evals judges                               # measure the judge itself
bun run evals triage --promote                     # complaints -> eval cases
```

Everything that *measures* writes a file; everything that *decides* reads one.
A nightly run leaves an artefact a person can open a week later and argue with,
and the gate is a pure function of two such artefacts — so a disputed result is
re-checkable without re-running anything.

---

## The golden set

`data/goldens/*.jsonl` — one item per line, one file per category, 200 items.

| Category | Items | What it catches |
| -------- | ----: | --------------- |
| `factual` | 45 | Confident invention of facts |
| `reasoning` | 45 | Plausible steps, wrong conclusion |
| `coding` | 45 | Answers a reader can mechanically check |
| `longform` | 35 | Merging everything into an unreadable mush |
| `adversarial` | 30 | Answering a question that should have been questioned |

Every item carries a **rubric** — what a correct answer must contain — and that
is not optional. A prompt with no statement of what "right" means is a demo, not
an eval item, and the loader refuses to parse one. Items may also carry:

- `reference` — a known-good answer, for the judge to compare against;
- `antiRubric` — the claims a *wrong* answer characteristically makes, which is
  what turns "waffled plausibly" into a measurable failure;
- `expectation` — for an ambiguous or loaded question, what the right
  *behaviour* is, as distinct from the right content.

JSONL rather than one JSON array so that adding a question is a one-line diff
and a merge conflict touches one item.

### Adding an item

Append a line, then run `bun run evals dataset`. The loader will tell you the
file and line number of anything malformed, and the coverage check will tell you
if a category has fallen below the point where its mean stops meaning anything.

---

## What gets measured

One run of the panel produces **every system under test**, which is why the
central comparison costs one panel run per question rather than four:

| System | What it is |
| ------ | ---------- |
| `synthesis` | The product: the evaluator's merged answer |
| `single:<label>` | One panel member's own answer, from the same run |
| `majority` | The candidate most in agreement with the others, shipped verbatim |

`majority` is the important baseline. If synthesis cannot beat *picking the most
consensual answer with no evaluator at all*, the evaluator is an expensive way to
choose a winner — and the report says so rather than leaving it unasked.

---

## The judge

An LLM grades each answer against the item's rubric. Three design decisions make
it a measuring instrument rather than a participant:

**Blind.** The judge is never told which system produced the answer. Told it is
looking at "the synthesised answer", a model scores it higher, and the report's
central comparison would be measuring the label.

**Rubric-driven.** The prompt carries the rubric, the anti-rubric and the
reference, and asks which points are covered. "Rate this 1-10" produces a number
that drifts with the answer's length and the model's release.

**Rotated.** Judges score their own model family higher. Each answer is graded by
one judge chosen deterministically from `itemId + system`, which spreads that
bias evenly instead of handing it to one system.

The judge scores **correctness**, **completeness** and **citation fidelity**.
It does not score calibration: "was 0.8 the right confidence" is not answerable
from one answer, and asking for it would produce a number that means nothing.
Calibration is computed across the report instead — see below.

### Measuring the judge

`data/human-labels.jsonl` holds frozen answers with human verdicts. The answer
text is stored, not referenced, because a label attached to "whatever the engine
said for item 12" is worthless the next time it says something else.

```sh
bun run evals judges
```

reports **Cohen's kappa**, not raw agreement. On a set where 85% of answers pass,
a judge that said "pass" to everything agrees 85% of the time and is worthless;
kappa subtracts what chance would produce, so that judge scores zero.

| kappa | What it means |
| ----- | ------------- |
| >= 0.8 | Trustworthy enough to gate releases on |
| 0.6-0.8 | Usable, with the caveat stated in the report |
| < 0.6 | The rubric or the judge prompt is the problem. Fix that first. |

The command exits non-zero below 0.6.

---

## Scoring

```
score = 0.6 x correctness + 0.3 x completeness + 0.1 x citationFidelity
        - 0.15 per anti-rubric violation, capped at 0.45
```

Correctness dominates because an answer that is wrong is worthless however
complete it is. Citation fidelity is weighted lowest only because it defaults to
1 for an answer that cites nothing — it is a penalty for invention, not a reward
for sourcing.

Two aggregation rules that matter more than the weights:

- **Failures are excluded, never scored zero.** An item the engine or the judge
  could not complete is listed in `failures` and left out of every mean.
  Scoring it zero would make a provider outage read as a quality regression.
- **Categories are weighted equally.** The headline is the mean of the category
  means, so adding twenty factual questions cannot "improve quality" without a
  single answer changing.

---

## The gate

```sh
bun run evals gate --report report.json --baseline packages/evals/baselines/current.json
```

Blocking findings (non-zero exit):

| Finding | Default threshold |
| ------- | ----------------- |
| `score-regression` | synthesis fell more than 2 points |
| `category-regression:<c>` | one category fell more than 5 points |
| `pass-rate-regression` | pass rate fell more than 3 points |
| `thesis-broken` | synthesis no longer beats the best single model |
| `sample-too-small` | fewer than 50 graded synthesis answers |
| `no-synthesis` | nothing was graded at all |

Warnings, which never block: `no-baseline`, `dataset-changed`,
`calibration-regression`, `evaluator-not-earning`.

**A changed dataset downgrades every comparison to a warning.** Adding twenty
hard questions lowers the mean, and calling that a regression would teach
everyone to ignore the gate on exactly the days the set improves. Re-baseline in
a reviewed pull request once the change is understood.

The thresholds are not decoration: the judge is a sampled instrument, and a gate
that fired on a 0.3% move would fire on noise every other night. A gate that
fires on noise is a gate somebody comments out.

---

## Confidence calibration

The evaluator reports a confidence with every answer. Whether that number means
anything is an empirical question:

```sh
bun run evals calibrate --report report.json --out calibration.json
```

The harness pairs each confidence with the judge's verdict, fits a monotone
correction (isotonic regression) on two thirds of the data, and **measures it on
the third that was held out**. The held-out split is the whole discipline: a map
evaluated on the data it was fitted to always looks excellent, and shipping on
that basis is how a "calibrated" number ends up less trustworthy than the raw
one it replaced. A map that does not improve *both* calibration error and Brier
score on held-out answers is not proposed at all.

Deploy an accepted map as `CONFIDENCE_CALIBRATION` on the worker. It stores both
numbers for ever: the raw value is the evidence the next fit is made from, and
keeping only the corrected one would make the correction impossible to check.

---

## The feedback loop

A thumbs-down with a sentence attached is the cheapest labelled failure this
product will ever get. The path from complaint to regression test is three
steps, and only the middle one needs a person:

1. a customer clicks thumbs-down;
2. somebody marks it `accepted` in the triage queue — this answer really *was*
   wrong;
3. `bun run evals triage --promote` exports the accepted ones to
   `data/staging/` and marks them so they are never exported twice.

A staged item deliberately has **no rubric**. The export knows what was asked and
that somebody was unhappy; what a correct answer must contain is exactly the
judgement a person supplies. Add the rubric, choose the category, and move the
line into `data/goldens/` — that is the moment it starts gating releases.

---

## Cost

A full run is 200 panel runs (three models plus an evaluator each) plus one judge
call per system per item — roughly 800 judge calls. Budget accordingly, use
`--limit` for a smoke run (the sample is deterministic and stays balanced across
categories), and note that every eval run sends `Cache-Control: no-store`: the
golden set asks the same questions every night, and a cached engine would grade
one real run and then re-grade its own copy for ever.
