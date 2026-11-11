import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { intents, jobs, webhookDeliveries } from "@/db/schema";
import { readRegistry } from "@/lib/repositories";
import { githubIssuesOn, isJobSource, sourceFor } from "@/lib/sources";
import type { JobSource } from "@/lib/sources/types";
import { linearSettings } from "@/lib/linear-settings";
import { githubIntent, githubIssueIntent, githubPushIntent, verifyGithub, type IntentDraft } from "@/lib/webhooks";

export const runtime = "nodejs";

/**
 * Stores the delivery and the intents it implies in one transaction. A delivery id seen before
 * stores nothing, so a redelivery or replay has no effect.
 */
async function record(source: string, deliveryId: string, event: string, payload: unknown, drafts: IntentDraft | null | readonly (IntentDraft | null)[]) {
  const all = (Array.isArray(drafts) ? drafts : [drafts]).filter((d): d is IntentDraft => d !== null);
  return db.transaction(async (tx) => {
    const now = new Date();
    const fresh = await tx
      .insert(webhookDeliveries)
      .values({ delivery_id: `${source}:${deliveryId}`, source, event, received_at: now, payload })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.delivery_id });
    if (fresh.length === 0) return { duplicate: true, intent: null };
    for (const intent of all) {
      const [byPr] = intent.prUrl && !intent.jobId ? await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.pr_url, intent.prUrl)) : [];
      await tx
        .insert(intents)
        .values({
          id: `${source}:${intent.key ?? deliveryId}`,
          kind: intent.kind,
          job_id: intent.jobId ?? byPr?.id,
          pr_url: intent.prUrl,
          detail: intent.detail,
          created_at: now,
        })
        .onConflictDoNothing();
    }
    return { duplicate: false, intent: all.map((i) => i.kind).join(",") || null };
  });
}

async function sourceWebhook(source: JobSource, request: Request) {
  const { webhook } = sourceFor(source);
  if (!webhook) return Response.json({ error: "not found" }, { status: 404 });
  const secret = process.env[webhook.secretEnv];
  if (!secret) return Response.json({ error: "no webhook secret configured" }, { status: 401 });
  const raw = await request.text();
  const verdict = webhook.verify(raw, request.headers, secret);
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
  const deliveryId = request.headers.get(webhook.deliveryHeader);
  if (!deliveryId) return Response.json({ error: `missing ${webhook.deliveryHeader}` }, { status: 400 });
  const body = JSON.parse(raw) as unknown;
  const intent = await webhook.intent(body, process.env);
  return Response.json(await record(source, deliveryId, request.headers.get(webhook.eventHeader) ?? "?", body, intent));
}

/** An issue delivery wakes the runner only if it can act: the switch is on, the repo is enabled, and a comment answers a waiting job. */
async function githubIssueDraft(event: string, body: unknown) {
  if (!githubIssuesOn()) return null;
  const draft = githubIssueIntent(event, body, (await linearSettings(db)).label);
  if (!draft) return null;
  const repo = (body as { repository: { full_name: string } }).repository.full_name.toLowerCase();
  if (!(await readRegistry(db)).some((r) => r.enabled && r.repo.toLowerCase() === repo)) return null;
  if (draft.kind !== "answer") return draft;
  const [job] = await db.select({ stage: jobs.stage }).from(jobs).where(eq(jobs.id, draft.jobId!));
  return job?.stage === "waiting" ? draft : null;
}

async function githubWebhook(request: Request) {
  const raw = await request.text();
  const verdict = verifyGithub(raw, request.headers.get("x-hub-signature-256"), process.env.GITHUB_APP_WEBHOOK_SECRET);
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event") ?? "?";
  if (!deliveryId) return Response.json({ error: "missing X-GitHub-Delivery" }, { status: 400 });
  const body = JSON.parse(raw) as unknown;
  const issue = event === "issues" || event === "issue_comment" ? await githubIssueDraft(event, body) : null;
  return Response.json(await record("github", deliveryId, event, body, [githubIntent(event, body), githubPushIntent(event, body), issue]));
}

/** Linear and GitHub deliveries. The proxy lets them through; each source's signature is the check. */
export async function POST(request: Request, ctx: { params: Promise<{ source: string }> }) {
  const { source } = await ctx.params;
  if (source === "github") return githubWebhook(request);
  if (isJobSource(source)) return sourceWebhook(source, request);
  return Response.json({ error: "not found" }, { status: 404 });
}
