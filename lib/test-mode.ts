import { parse } from "pg-connection-string";

export const TEST_DB_ENV = "FACTORY_TEST_DB";

export const TEST_IDENTITY_ENV = "FACTORY_TEST_IDENTITY";

// Neon reads an endpoint from `options` or from an `endpoint=<id>;` password prefix when SNI does not name one.
const OPTION_ENDPOINT = /(?:^|\s)(?:--)?(?:endpoint|project)=(\S+)/gi;
const PASSWORD_ENDPOINT = /^(?:endpoint|project)=([^;$]+)[;$]/i;

function parseUrl(url: string) {
  const invalid = new Error("is not a valid URL");
  if (!/^postgres(?:ql)?:\/\//i.test(url)) throw invalid;
  try {
    return parse(url);
  } catch {
    throw invalid;
  }
}

/**
 * The Neon endpoint a `pg` connection to `url` reaches, parsed the way `pg` parses it.
 * Throws when the string names no endpoint, more than one, or hides it behind `hostaddr`.
 */
export function endpointOf(url: string): string {
  const config = parseUrl(url);
  if (config.hostaddr) throw new Error("sets hostaddr, which hides its endpoint");
  const host = config.host?.toLowerCase();
  if (!host) throw new Error("names no host");
  const selected = [
    ...[...(config.options ?? "").matchAll(OPTION_ENDPOINT)].map((match) => match[1]!),
    ...(config.password?.match(PASSWORD_ENDPOINT)?.slice(1) ?? []),
  ].map((id) => id.toLowerCase());
  const hostEndpoints = host.split(",").map((name) => name.split(".")[0]!.replace(/-pooler$/, ""));
  // A host without an endpoint label (c-2.<region>.aws.neon.tech) defers to the selectors.
  const named = new Set([...selected, ...hostEndpoints.filter((id) => id.startsWith("ep-") || selected.length === 0)]);
  if (named.size !== 1) throw new Error(`names more than one endpoint (${[...named].join(", ")})`);
  return [...named][0]!;
}

const LOOPBACK = new Set(["", "localhost", "127.0.0.1", "::1"]);

/**
 * The database a `pg` connection to `url` reaches: `endpoint/dbname` for a Neon host, otherwise `host:port/dbname`.
 * Aliases collapse conservatively (loopback names and unix sockets, a missing port), so two URLs for one
 * database never look different. Throws on `hostaddr` or a host list, which could reach somewhere else.
 */
export function identityOf(url: string): string {
  const config = parseUrl(url);
  const host = (config.host ?? "").toLowerCase().replace(/\.$/, "");
  if (config.hostaddr) throw new Error("sets hostaddr, which hides its host");
  if (host.includes(",")) throw new Error("names more than one host");
  const database = (config.database || config.user || "").toLowerCase();
  if (!database) throw new Error("names no database");
  // One Neon endpoint holds many databases; the pooled and direct hosts are the same endpoint.
  if (host.split(".")[0]!.startsWith("ep-") || host.endsWith(".neon.tech")) return `${endpointOf(url)}/${database}`;
  const port = Number(config.port || 5432);
  if (!Number.isInteger(port)) throw new Error(`has a bad port ${config.port}`);
  return `${LOOPBACK.has(host) || host.startsWith("/") ? "loopback" : host}:${port}/${database}`;
}

export const inTestMode = () => Boolean(process.env[TEST_DB_ENV]);

export function forbidInTest(service: string) {
  if (inTestMode()) throw new Error(`${service} was called during a regression run; give the test a fake`);
}
