import { Client } from "pg";

/** The channel drizzle/0040_live_notify.sql's triggers notify, with the changed table's name. */
export const LIVE_CHANNEL = "hive_changes";

/**
 * Opens a dedicated connection that LISTENs for table changes. The pooler can't hold a LISTEN, so it
 * uses the direct URL. `onClose` runs when the connection errors or ends; the caller reconnects.
 */
export async function listen(onTable: (table: string) => void, onClose: (reason: string) => void) {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!;
  const client = new Client({ connectionString: url.replace("sslmode=require", "sslmode=verify-full") });
  client.on("notification", (n) => {
    if (n.channel === LIVE_CHANNEL && n.payload) onTable(n.payload);
  });
  client.on("error", (error) => onClose(error.message));
  client.on("end", () => onClose("ended"));
  await client.connect();
  try {
    await client.query(`LISTEN ${LIVE_CHANNEL}`);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}
