import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CONFIG_PATH, loadConfig, requireLinearKey } from "../lib/config";
import { linearWebhookInput } from "../lib/linear-settings";
import { publicUrl } from "../lib/slack";

process.loadEnvFile(".env.local");
const config = loadConfig();

async function linear<T>(query: string, variables: object, schema: z.ZodType<T>) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: requireLinearKey(config), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return schema.parse(json.data);
}

async function linearWebhook() {
  const url = `${publicUrl()}/api/webhooks/linear`;
  const { webhooks } = await linear(
    `{ webhooks(first: 100) { nodes { id url allPublicTeams } } }`,
    {},
    z.object({ webhooks: z.object({ nodes: z.array(z.object({ id: z.string(), url: z.string(), allPublicTeams: z.boolean() })) }) }),
  );
  const input = linearWebhookInput({ url, secret: process.env.LINEAR_WEBHOOK_SECRET });
  const existing = webhooks.nodes.find((w) => w.url === url);
  if (existing?.allPublicTeams) {
    await linear(
      `mutation($id: String!, $input: WebhookUpdateInput!) { webhookUpdate(id: $id, input: $input) { success } }`,
      { id: existing.id, input: { url: input.url, resourceTypes: input.resourceTypes, secret: input.secret, label: input.label, enabled: true } },
      z.object({ webhookUpdate: z.object({ success: z.boolean() }) }),
    );
    return existing.id;
  }
  // ponytail: a webhook's team scope is fixed at creation, so a per-team one at our URL is replaced by the org-wide one.
  if (existing) {
    await linear(
      `mutation($id: String!) { webhookDelete(id: $id) { success } }`,
      { id: existing.id },
      z.object({ webhookDelete: z.object({ success: z.boolean() }) }),
    );
  }
  // Matched by URL, so a webhook at an older URL (such as the retired ingest Function) stays and would deliver twice.
  for (const old of webhooks.nodes.filter((w) => w.id !== existing?.id && w.url.endsWith("/webhooks/linear"))) {
    console.warn(`delete the old Linear webhook ${old.id} at ${old.url} in Linear's settings; it still delivers there`);
  }
  const created = await linear(
    `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { webhook { id } } }`,
    { input },
    z.object({ webhookCreate: z.object({ webhook: z.object({ id: z.string() }) }) }),
  );
  return created.webhookCreate.webhook.id;
}

const ids = { linear: await linearWebhook() };
const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, Record<string, unknown>>;
raw.factory = { ...raw.factory, webhooks: { ...(raw.factory?.webhooks as object), linear: ids.linear } };
writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`);
// The mode option only applies when the file is created; the config holds secrets either way.
chmodSync(CONFIG_PATH, 0o600);
console.log(JSON.stringify(ids));
