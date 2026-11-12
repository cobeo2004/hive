// Relays a Claude or ChatGPT sign-in before the panel has a UI for it (R9b); a running runner does the login:
//   bun scripts/account-login.ts --user <email> --provider claude|codex
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

try {
  process.loadEnvFile(".env.local");
} catch {
  // A shell that already exports DATABASE_URL
}
const { and, eq, sql } = await import("drizzle-orm");
const { db } = await import("../db/client");
const { agentAccounts, user } = await import("../db/schema");
const { readLogin, writeCode, writeLogin } = await import("../lib/account-logins");

const { values } = parseArgs({ options: { user: { type: "string" }, provider: { type: "string" } } });
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const provider = values.provider as "claude" | "codex";
if (!values.user || (provider !== "claude" && provider !== "codex"))
  fail(
    "usage: bun scripts/account-login.ts --user <email> --provider claude|codex\nFor operators with database access: it trusts --user and connects the account for that user.",
  );
const [member] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${values.user!.toLowerCase()}`);
if (!member) fail(`no Hive user with the email ${values.user}`);

const loginId = await writeLogin(db, member!.id, provider);
console.log("Login recorded; a runner starts it within a few seconds (10 minutes in all).");
let shown = false;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const login = await readLogin(db, member!.id, loginId);
  if (!login) {
    const connected = await db.$count(agentAccounts, and(eq(agentAccounts.owner_id, member!.id), eq(agentAccounts.provider, provider)));
    if (!connected) fail("The login ended without connecting (cancelled or expired).");
    console.log(`Connected: ${provider} account sealed for ${values.user}.`);
    process.exit(0);
  }
  if (login.status === "failed") fail("The login failed on the runner; see its log.");
  if (login.status !== "waiting_code" || shown) continue;
  shown = true;
  console.log(`\n1. Open ${login.url}`);
  if (login.code) console.log(`2. Enter this code: ${login.code}\nThen wait here.`);
  else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = await rl.question("2. Sign in, then paste the code it shows here: ");
    rl.close();
    if (!(await writeCode(db, member!.id, loginId, code))) fail("The login is not waiting for a code any more.");
  }
}
