"use client";

import { useSearchParams } from "next/navigation";
import { parseOwnerView, type OwnerView } from "@/lib/inbox";

/** The owner view in the URL: `owner` is canonical, and `view` still holds it when a link used the alias. */
export function useOwnerParam(): OwnerView | undefined {
  const params = useSearchParams();
  return parseOwnerView(params.get("owner")) ?? parseOwnerView(params.get("view"));
}
