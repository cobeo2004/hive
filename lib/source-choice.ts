import { z } from "zod";

// Where jobs come from (R13, R14): the choice and what it changes in the UI. No server imports, so client components can use it.

export const SOURCE_CHOICES = ["linear", "github", "both"] as const;
export const sourceChoiceSchema = z.enum(SOURCE_CHOICES);
export type SourceChoice = z.infer<typeof sourceChoiceSchema>;

export const SOURCE_COPY: Record<SourceChoice, { title: string; note: string }> = {
  linear: { title: "Linear", note: "Issues in your Linear teams, picked up by label or assignee." },
  github: { title: "GitHub Issues", note: "Issues in the repositories you register, picked up by label. Linear is not needed." },
  both: { title: "Both", note: "Each source claims its own work." },
};

/** The steps of /setup: only an admin chooses the sources (R13), and nobody sets up Linear when GitHub Issues is the only source (R14). */
export const setupSteps = (role: "admin" | "engineer", sources: SourceChoice) =>
  ["Account", ...(role === "admin" ? ["Sources"] : []), ...(sources === "github" ? [] : ["Linear"]), "Done"] as const;
