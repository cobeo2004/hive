/**
 * Session ids are Claude's UUIDs, `evidence:<branch>`, or `mcp:<branch>` for Codex, and branches
 * carry slashes (`mcp:hive/FAC-61`). So an id travels in a query string, never a path segment.
 */
const SESSION_ID = /^[\w.:-]+(?:\/[\w.:-]+)*$/;
const MAX_SESSION_ID = 128;

export const parseSessionId = (value: string | null | undefined) =>
  value && value.length <= MAX_SESSION_ID && SESSION_ID.test(value) ? value : undefined;

/** The activity page with the run open on the right. */
export const activityHref = (sessionId: string) => `/activity?${new URLSearchParams({ run: sessionId })}`;

/** The same page with its open detail in full view or back in the side panel; every other param stays. */
export const fullViewHref = (pathname: string, params: URLSearchParams, full: boolean) => {
  const next = new URLSearchParams(params);
  if (full) next.set("full", "1");
  else next.delete("full");
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
};
