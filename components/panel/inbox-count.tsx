"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import type { JobRow } from "@/db/schema";
import { splitArchived } from "@/lib/archive";
import { inboxItems, ownedBy, type Viewer } from "@/lib/inbox";
import { useFeed, type Feed } from "./live-refresh";

/** How many inbox items wait on the viewer (their Mine), live; a dot on the icon while the rail is collapsed. */
export function InboxCount({ jobs, me }: { jobs: Feed<JobRow>; me: Viewer | null }) {
  const { rows } = useFeed(jobs);
  const count = useMemo(() => inboxItems(ownedBy(splitArchived(rows).shown, "mine", me)).length, [rows, me]);
  if (count === 0) return null;
  return (
    <>
      <Badge
        variant="secondary"
        size="sm"
        className="border-transparent bg-(--lime) font-bold text-(--on-lime) tabular-nums in-data-collapsed:hidden"
        aria-label={`${count} waiting on you`}
      >
        {count}
      </Badge>
      <span aria-hidden className="absolute top-1.5 left-6 hidden size-1.5 rounded-full bg-primary in-data-collapsed:block" />
    </>
  );
}
