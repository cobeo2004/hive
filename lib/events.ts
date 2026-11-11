import { z } from "zod";
import { assessmentInputSchema } from "./assessment";
import { evidenceShape } from "./evidence";
import { isPlanApproval, PLAN_QUESTION_MAX, planQuestion } from "./plan-approval";
import { mediaShape, withinLimit } from "./media";

export const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  model: z.string(),
});
export type Usage = z.infer<typeof usageSchema>;

export const STAGES = ["queued", "triage", "investigating", "planning", "implementing", "verifying", "pr", "waiting", "merged", "failed"] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

/** What a factory thread passes to `report_stage`; the hook re-parses the same shape from tool_input. */
export const stageReportShape = {
  stage: stageSchema.describe("The stage the run just entered."),
  summary: z.string().min(1).max(500).describe("One or two sentences on what happened. For failed, the reason."),
  prUrl: z.url().optional().describe("Required for stage pr: the pull request URL."),
  question: z.string().min(1).max(2000).optional().describe("Required for stage waiting: the concrete question the human must answer."),
  assessment: assessmentInputSchema.optional().describe("Stage pr only: your merge assessment, as the factory playbook describes."),
};
/** The reporting tool's input: the stage report plus the plan gate, which the stage event itself doesn't carry (it carries the plan as `question`). */
export const reportToolShape = {
  ...stageReportShape,
  kind: z.literal("plan_approval").optional().describe("Stage waiting only: the plan gate; attach plan (and answerKey) instead of a question."),
  plan: z.string().min(1).max(200_000).optional().describe("With kind plan_approval: plan.md's contents."),
  answerKey: z.string().max(200_000).optional().describe("With kind plan_approval: answer-key.md's contents."),
};
export const stageReportSchema = z
  .object(reportToolShape)
  .refine((r) => r.stage !== "pr" || r.prUrl, { message: "stage pr needs prUrl", path: ["prUrl"] })
  .refine((r) => r.stage === "pr" || !r.assessment, { message: "only stage pr takes an assessment", path: ["assessment"] })
  .refine((r) => r.stage !== "waiting" || r.question || (r.kind === "plan_approval" && r.plan), {
    message: "stage waiting needs question, or kind plan_approval with plan",
    path: ["question"],
  })
  .refine((r) => r.kind === "plan_approval" || !isPlanApproval(r.question), {
    message: "question must not start with the plan header",
    path: ["question"],
  })
  .refine((r) => !r.kind || (r.stage === "waiting" && r.plan), { message: "kind plan_approval needs stage waiting and plan", path: ["kind"] });
export type StageReport = z.infer<typeof stageReportSchema>;

/** The stage event's fields from a report: a plan approval becomes its question; the tool-only fields never reach the event. */
export function stageEventFields(report: StageReport) {
  const { kind, plan, answerKey, ...rest } = report;
  return kind === "plan_approval" && plan ? { ...rest, question: planQuestion(plan, answerKey) } : rest;
}

const base = {
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  at: z.number().int().nonnegative(),
  /** The main session transcript; recorded so usage can be rebuilt when no Stop hook ever fires. */
  transcriptPath: z.string().optional(),
};

export const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("session_start"),
    cwd: z.string(),
    branch: z.string().optional(),
    repo: z.string().optional(),
    source: z.enum(["startup", "resume", "compact"]).optional(),
    t3ThreadId: z.string().optional(),
    title: z.string().optional(),
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_start"),
    toolUseId: z.string().min(1),
    subagentType: z.string(),
    description: z.string(),
    model: z.string().optional(),
    parentAgentId: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_launched"),
    toolUseId: z.string().min(1),
    agentId: z.string().min(1),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_stop"),
    agentId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    usage: usageSchema,
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("turn_stop"),
    usage: usageSchema,
    lastMessage: z.string().max(500).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("stage"),
    ...stageReportShape,
    /** A plan approval's question is the plan, which is longer than a question the agent asks. */
    question: z.string().min(1).max(PLAN_QUESTION_MAX).optional(),
    jobKey: z.string().optional(),
    issueKey: z.undefined({ error: "issueKey was renamed to jobKey" }).optional(),
    /** The branch the reporting thread was on; absent on events the runner posts itself. */
    branch: z.string().optional(),
    /** Set by the runner when a human answered a waiting question and the run resumes. */
    answer: z.string().max(4000).optional(),
  }),
  z.object({
    ...base,
    // A mid-turn snapshot of the main session's usage, so spend is known before the turn ends.
    kind: z.literal("usage"),
    usage: usageSchema,
    /** Subagents of the session with their usage so far, so running ones count before SubagentStop. */
    agents: z.array(z.object({ agentId: z.string().min(1), toolUseId: z.string().optional(), usage: usageSchema })).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("session_end"),
    reason: z.string().optional(),
  }),
  z.object({
    ...base,
    // The checks run at one commit, by factory-verify or by the runner; see lib/evidence.ts.
    kind: z.literal("evidence"),
    ...evidenceShape,
  }),
  z
    .object({
      ...base,
      // One image or video a pr report's assessment attached; see lib/media.ts.
      kind: z.literal("screenshot"),
      ...mediaShape,
    })
    .refine(withinLimit, { message: "file is over the limit for its type", path: ["data"] }),
]);
export type FactoryEvent = z.infer<typeof eventSchema>;
export type EventKind = FactoryEvent["kind"];

export const MAX_BATCH = 100;

export const ingestBodySchema = z.union([eventSchema, z.array(eventSchema).min(1).max(MAX_BATCH)]).transform((body) => (Array.isArray(body) ? body : [body]));
