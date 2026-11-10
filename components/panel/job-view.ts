import type { OwnerView } from "@/lib/inbox";

export type JobView = "board" | "list";

/** The last view the owner picked, so `/` without `?view` opens it. */
export const JOB_VIEW_COOKIE = "jobs_view";

export const parseJobView = (raw: unknown): JobView | undefined => (raw === "board" || raw === "list" ? raw : undefined);

/**
 * The jobs page in `view`, with the run open on the right when there is one. `archived` shows the
 * archive, always as a list, and leaves the view out so the remembered one comes back after it.
 * `owner` is carried only for Mine, since Everyone is the page's default.
 */
export const jobsHref = (view: JobView, run?: string, archived = false, owner?: OwnerView) =>
  `/?${new URLSearchParams({
    ...(!archived && { view }),
    ...(run && { run }),
    ...(archived && { archived: "1" }),
    ...(owner === "mine" && { owner }),
  })}`;

/**
 * The inbox, with its item open on the right when there is one. Mine is the page's default, so it is left
 * out of a plain link, and Everyone is carried. An item link always names its owner, since a bare `?job=`
 * opens on Everyone (Slack posts those links).
 */
export const inboxHref = (owner: OwnerView = "mine", job?: string) => {
  const params = new URLSearchParams({ ...((owner === "everyone" || job) && { owner }), ...(job && { job }) }).toString();
  return params ? `/inbox?${params}` : "/inbox";
};
