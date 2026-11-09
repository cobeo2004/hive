import { after } from "next/server";
import { inboxDeps } from "@/lib/inbox-deps";
import { memberByEmail } from "@/lib/members";
import { panelUrl, secretValues } from "@/lib/slack";
import { postResponse, slackClient } from "@/lib/slack-api";
import type { InteractionDeps } from "@/lib/slack-interactions";

/** What Slack's routes act with: the app's env, the panel's inbox and new-job actions as the clicker's Hive user, and next/server's after. */
export function slackRouteDeps(): InteractionDeps {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const slack = token ? slackClient({ token, baseUrl: process.env.SLACK_API_URL?.trim() || undefined, minGapMs: 0 }) : null;
  return {
    signingSecret: process.env.SLACK_SIGNING_SECRET?.trim(),
    ownerSlackId: process.env.SLACK_OWNER_USER_ID?.trim(),
    // ponytail: one users.info call per click, inside Slack's 3-second window; cache by Slack id if it gets slow.
    member: async (slackUserId) => (slack ? memberByEmail(await slack.userEmail(slackUserId)) : null),
    slack,
    respond: postResponse,
    // handleInteraction swaps in the clicker; until then no one is signed in.
    inbox: inboxDeps(async () => null),
    panelUrl: panelUrl(),
    secrets: secretValues(process.env),
    after,
  };
}
