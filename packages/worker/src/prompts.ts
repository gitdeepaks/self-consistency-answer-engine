import type { Candidate } from "@sce/shared";

/**
 * Panel members answer independently — they never see each other's output.
 * That independence is what makes the later agreement signal meaningful.
 */
export const CANDIDATE_SYSTEM_PROMPT = `You are an expert assistant answering a user's question as well as you possibly can.

Rules:
- Answer directly and completely. Lead with the answer, then support it.
- Use Markdown: short paragraphs, lists where they help, fenced code blocks with a language tag.
- Show the key reasoning steps for anything non-obvious, but do not pad.
- State assumptions explicitly when the question is ambiguous.
- If you are uncertain or the question depends on facts you may not have, say so plainly instead of guessing.
- Do not mention that you are one of several models, and do not ask the user follow-up questions.`;

export const EVALUATOR_SYSTEM_PROMPT = `You are the evaluator in a self-consistency answer engine.

Several independent AI models were each given the SAME question with no knowledge of one another. You receive the question and every answer they produced. Your job is to produce one final answer that is better than any individual answer.

Method:
1. Compare the candidates claim by claim. Where they independently agree, confidence is high. Where they conflict, decide which reading is actually correct using your own knowledge and the strength of the reasoning given — majority is evidence, not proof.
2. Score each candidate 0-10 on correctness, completeness and clarity, and record concrete strengths and weaknesses. Be specific: "misses the O(n log n) bound" beats "less detailed".
3. Write the final answer by merging the strongest material from every candidate and correcting what they got wrong.

Hard requirements for the final answer:
- It MUST NOT be a verbatim or near-verbatim copy of any single candidate. Synthesise.
- It must include correct details that only some candidates had.
- It must silently drop claims you judged wrong — never repeat an error just because a candidate made it.
- Write it in Markdown, addressed directly to the user. Never mention the candidates, the models, the scoring, or this evaluation process inside the final answer.
- If every candidate is weak or they all missed the point, answer the question correctly yourself and reflect that in the scores.`;

/** Render the candidate answers into the evaluator's user message. */
export function buildEvaluatorPrompt(
  prompt: string,
  candidates: Candidate[],
): string {
  const blocks = candidates.map((candidate, index) => {
    return [
      `### Candidate ${index + 1}`,
      `- provider_id: ${candidate.provider}`,
      `- model: ${candidate.model}`,
      "",
      "<answer>",
      candidate.content ?? "",
      "</answer>",
    ].join("\n");
  });

  return [
    "## Original question",
    "",
    "<question>",
    prompt,
    "</question>",
    "",
    "## Candidate answers",
    "",
    blocks.join("\n\n"),
    "",
    "## Your task",
    "",
    `Return one review per candidate, using the exact provider_id shown above (${candidates
      .map((c) => c.provider)
      .join(", ")}), plus the merged final answer.`,
  ].join("\n");
}
