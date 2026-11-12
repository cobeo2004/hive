"use client";

import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import type { Stage } from "@/lib/events";
import { Time } from "./time";

/** The runner captures frames only while a heartbeat is under 15 s old; 5 s keeps one alive across a missed beat. */
const HEARTBEAT_MS = 5_000;

/** Stages whose job can have an open device: `IN_FLIGHT` in runner/ops.ts minus `queued`, which has no thread yet. */
export const WATCHABLE_STAGES: readonly Stage[] = ["triage", "investigating", "planning", "implementing", "verifying"];

/** The device the agent drives, as the runner last captured it (R26a). Watching only: no input reaches the device. */
export function DeviceView({ jobKey, takenAt, recording }: { jobKey: string; takenAt: Date | undefined; recording: boolean }) {
  const url = `/api/jobs/${encodeURIComponent(jobKey)}/device-frame`;
  useEffect(() => {
    // ponytail: errors swallowed; the next beat retries, and a missed one only pauses frames.
    const beat = () => void fetch(url, { method: "POST" }).catch(() => {});
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [url]);

  if (!takenAt) return null;
  return (
    <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Device</h3>
        {recording && <Badge variant="destructive">recording</Badge>}
        <span className="ms-auto text-xs text-muted-foreground">
          <Time date={takenAt} />
        </span>
      </div>
      {/* An owner-only image behind the session; next/image would fetch it without the cookie. `v` busts the cache for each new frame. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${url}?v=${takenAt.getTime()}`} alt="The agent's device screen" className="max-h-[60vh] w-auto self-start rounded-md border" />
    </section>
  );
}
