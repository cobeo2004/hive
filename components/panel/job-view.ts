import { useSearchParams } from "next/navigation";
import { parseOwnerView, type OwnerView } from "@/lib/inbox";

export type JobView = "board" | "list";

/** The last view the owner picked, so `/` without `?view` opens it. */
export const JOB_VIEW_COOKIE = "jobs_view";

export const parseJobView = (raw: unknown): JobView | undefined => (raw === "board" || raw === "list" ? raw : undefined);

/** The owner view in the URL: `owner` is canonical, and `view` still holds it when a link used the alias. */
export function useOwnerParam(): OwnerView | undefined {
  const params = useSearchParams();
  return parseOwnerView(params.get("owner")) ?? parseOwnerView(params.get("view"));
}

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

/** The inbox, with its item open on the right when there is one. Only Everyone is carried, since Mine is the page's default. */
export const inboxHref = (owner?: OwnerView, job?: string) => {
  const params = new URLSearchParams({ ...(owner === "everyone" && { owner }), ...(job && { job }) }).toString();
  return params ? `/inbox?${params}` : "/inbox";
};
