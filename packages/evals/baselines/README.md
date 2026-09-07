# Baselines

The last accepted measurement, committed so that `evals gate` compares against something a person
approved rather than against whatever the previous run happened to produce.

`current.json` is an `EvalReport` — the exact file `bun run evals run --out` writes. There is no
baseline in the repository yet: the first nightly run against a real deployment produces one, and
adding it is a pull request whose description says what the numbers are.

To re-baseline after an accepted movement:

```sh
cp report.json packages/evals/baselines/current.json
```

Commit it separately from the change that moved the numbers, so the diff answers "what did this
change do to quality" on its own. `doc/runbooks/quality.md` has the checklist for deciding whether a
movement should be accepted at all.
