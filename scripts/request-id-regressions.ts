import assert from "node:assert/strict";
import { z } from "zod";
import { requestId } from "../lib/request-id";

// A panel on plain http (a tailnet name) has no crypto.randomUUID: every button that sent one threw before reaching the server.
const native = crypto.randomUUID;
Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
try {
  const ids = Array.from({ length: 500 }, requestId);
  for (const id of ids) assert.ok(z.uuid().safeParse(id).success, `${id} passes the server's z.uuid() check`);
  assert.equal(new Set(ids).size, ids.length, "ids do not repeat");
} finally {
  Object.defineProperty(crypto, "randomUUID", { value: native, configurable: true });
}

console.log("request id regressions pass");
