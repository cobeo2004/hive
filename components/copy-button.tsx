"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

/** A button that copies a secret or link, showing a tick once it has. */
export function CopyButton({ value, label, children }: { value: string; label: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label={label}
      size={children ? "sm" : "icon"}
      variant="outline"
      onClick={async () => {
        await copyText(value);
        setCopied(true);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {children}
    </Button>
  );
}

/** A monospace box around a value too long for a field, with its copy button. */
export function CopyBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-1.5 ps-3">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">{value}</code>
      <CopyButton label={`Copy ${label}`} value={value} />
    </div>
  );
}
