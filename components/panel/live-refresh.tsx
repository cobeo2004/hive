"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { liveUpdates } from "@/lib/live-mode";

/** Rows a server component read for the page; a live update re-renders the page with fresh ones. */
export type Feed<Row> = { initialData: Row[] };

export type FeedStatus = "live" | "connecting" | "off";

const REFRESH_DEBOUNCE_MS = 300;
const initialStatus: FeedStatus = liveUpdates ? "connecting" : "off";
let status: FeedStatus = initialStatus;
const listeners = new Set<() => void>();
function setStatus(next: FeedStatus) {
  status = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useLiveStatus = () => useSyncExternalStore(subscribe, () => status, () => initialStatus);

export function useFeed<Row>(feed: Feed<Row>) {
  return { rows: feed.initialData, status: useLiveStatus() };
}

/** Follows /api/live and re-renders the page when a table changes, a burst of changes at once. */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    if (!liveUpdates) return;
    const source = new EventSource("/api/live");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => setStatus("live");
    // EventSource reconnects on its own; until then the page shows what it has.
    source.onerror = () => setStatus("connecting");
    source.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };
    return () => {
      clearTimeout(timer);
      source.close();
      setStatus(initialStatus);
    };
  }, [router]);
  return null;
}
