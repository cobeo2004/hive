// The plan gate: with `plan_gate = "inbox"` the lead thread reports waiting with its plan instead of
// a question. The plan travels as the job's question, headed so the inbox can tell it from an
// ordinary one. Pure, so the reporter, the inbox and the resume message share it.

export const PLAN_HEADER = "## Plan for your approval";
export const PLAN_MAX = 20_000;
export const PLAN_TRUNCATED = "\n\n[… truncated at 20,000 characters; the full plan is in the run directory]";
/** The answer Approve sends; anything else is the owner's requested changes. */
export const PLAN_APPROVED = "Plan approved.";
export const PLAN_QUESTION_MAX = PLAN_HEADER.length + 2 + PLAN_MAX + PLAN_TRUNCATED.length;

export function planQuestion(plan: string, answerKey = "") {
  const key = answerKey.trim();
  const body = plan.trim() + (key ? `\n\n## answer-key.md\n\n${key}` : "");
  return `${PLAN_HEADER}\n\n${body.length > PLAN_MAX ? body.slice(0, PLAN_MAX) + PLAN_TRUNCATED : body}`;
}

export const isPlanApproval = (question?: string | null) => !!question?.startsWith(PLAN_HEADER);
