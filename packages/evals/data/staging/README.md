# Staging

Where `bun run evals triage` writes eval cases drawn from real thumbs-downs, before a person has
finished them.

A staged item has no rubric. The export knows the question that was asked and that somebody said the
answer was wrong; what a *correct* answer must contain is the judgement a reviewer supplies. Nothing
in this directory is ever loaded by the runner.

To promote one: write the rubric, choose the category it actually belongs in, drop the staging-only
fields (`runId`, `feedbackId`, `reportedReason`, `reportedNote`) or leave them for provenance, and
move the line into `../goldens/<category>.jsonl`. Then run `bun run evals dataset` to check it.
