// Prints a one-time link (R32): `bun scripts/setup-token.ts` for the first admin (1 hour, only while no admin
// exists), or `bun scripts/setup-token.ts --reset <email>` for a password reset (24 hours).
try {
  process.loadEnvFile(".env.local");
} catch {
  // A shell that already exports DATABASE_URL
}
const { createLink, createResetLink, SETUP_TTL_MS } = await import("../lib/access-links");
const { panelUrl } = await import("../lib/slack");

const [flag, email] = process.argv.slice(2);
try {
  if (flag === "--reset") {
    if (!email) throw new Error("usage: bun scripts/setup-token.ts --reset <email>");
    console.log(`${panelUrl()}/auth/reset?token=${await createResetLink(email)}`);
  } else if (flag) {
    throw new Error("usage: bun scripts/setup-token.ts [--reset <email>]");
  } else {
    console.log(`${panelUrl()}/auth/setup?token=${await createLink("setup", null, SETUP_TTL_MS)}`);
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

export {};
