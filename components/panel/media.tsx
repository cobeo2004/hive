import type { JobRow } from "@/db/schema";
import type { MergeAssessment } from "@/lib/assessment";
import { mediaKind, mediaUrl } from "@/lib/media";

/** What the agent saw in the browser, as it attached it to its assessment: images open full size in a new tab, videos play in place. */
export function Media({ job, assessment }: { job: Pick<JobRow, "key" | "assessment_event_id">; assessment: MergeAssessment }) {
  const items = assessment.media ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2">
      {items.map((m, i) => {
        const src = mediaUrl(job.key, i, job.assessment_event_id);
        return (
          <li key={`${i}:${m.file}`} className="flex min-w-0 flex-col gap-1">
            {mediaKind(m.file) === "video" ? (
              <video src={src} controls preload="metadata" className="aspect-video w-full rounded-md border bg-muted" />
            ) : (
              <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-muted">
                {/* An owner-only image behind the session; next/image would fetch it without the cookie. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={m.caption} loading="lazy" className="aspect-video w-full object-cover object-top" />
              </a>
            )}
            <span className="text-xs text-muted-foreground">{m.caption}</span>
          </li>
        );
      })}
    </ul>
  );
}
