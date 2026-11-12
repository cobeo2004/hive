import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// Client code must not reach for the secure-context-only APIs again; lib/clipboard.ts is the one guarded use.
const root = join(import.meta.dirname, "..");
const offenders = ["components", "app", "hooks", "lib"]
  .flatMap((dir) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f}`))
  .filter((file) => /\.tsx?$/.test(file))
  .filter((file) => {
    const text = readFileSync(join(root, file), "utf8");
    const client = text.startsWith('"use client"') || file.startsWith("components/");
    return client && file !== "lib/clipboard.ts" && /crypto\.randomUUID\(|navigator\.clipboard/.test(text);
  });
assert.deepEqual(offenders, [], "client code uses requestId() and copyText(), not crypto.randomUUID or navigator.clipboard");

console.log("request id regressions pass");
