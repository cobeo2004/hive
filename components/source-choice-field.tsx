"use client";

import { SOURCE_CHOICES, SOURCE_COPY, type SourceChoice } from "@/lib/source-choice";
import { cn } from "@/lib/utils";

/** The three places jobs can come from, one pick (R13). */
export function SourceChoiceField({
  value,
  onChange,
  disabled = false,
}: {
  value: SourceChoice;
  onChange: (choice: SourceChoice) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Where do jobs come from?" className="flex flex-col gap-2">
      {SOURCE_CHOICES.map((choice) => (
        <label
          key={choice}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 has-checked:border-foreground has-checked:bg-accent",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <input checked={value === choice} className="mt-1" disabled={disabled} name="job-source" onChange={() => onChange(choice)} type="radio" />
          <span className="flex flex-col">
            <span className="font-semibold">{SOURCE_COPY[choice].title}</span>
            <span className="text-xs text-muted-foreground">{SOURCE_COPY[choice].note}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
