"use client";

import { useRef, useState, useTransition } from "react";
import { fileFollowUp } from "@/app/actions/inbox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import type { JobRow } from "@/db/schema";
import { allows, followUpHint, inboxKind, MAX_FOLLOW_UP_CHARS } from "@/lib/inbox";
import { parseDecision } from "./merge-decision";

/** Whether the inbox lets the owner write to this job: only a failed revert files a follow-up today. */
export const canMessageThread = (job: JobRow) => allows(inboxKind(job), "follow_up");

/** The run's message box. It files a follow-up job (`fileFollowUp`); nothing reaches the agent's thread. */
export function MessageThread({ job }: { job: JobRow }) {
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  // A second submit can land before React re-renders the disabled button.
  const running = useRef(false);
  const send = () => {
    if (!text.trim() || running.current) return;
    running.current = true;
    start(async () => {
      try {
        // ponytail: the runner files the follow-up from the intent; we don't poll for it as the inbox does, the item leaves on the next refresh.
        const outcome = await fileFollowUp(job.id, crypto.randomUUID(), text).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
        toastManager.add(outcome.ok ? { type: "success", title: outcome.message ?? "Filed the follow-up." } : { type: "error", title: outcome.message });
        if (outcome.ok) setText("");
      } finally {
        running.current = false;
      }
    });
  };
  return (
    <form
      aria-label="Message the thread"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={followUpHint(job, parseDecision(job.merge_decision))}
        maxLength={MAX_FOLLOW_UP_CHARS}
        disabled={pending}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">Files a follow-up job to get main green again; this item leaves the inbox.</p>
        <Button type="submit" size="sm" variant="outline" loading={pending} disabled={!text.trim()}>
          Send
        </Button>
      </div>
    </form>
  );
}
