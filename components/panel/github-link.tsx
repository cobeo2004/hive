import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { user } from "@/db/schema";
import { currentUser } from "@/lib/auth/server";
import { GithubLinkCard } from "./github-link-card";
import { SettingsSection } from "./settings-section";

/** Settings → GitHub (R27f): the viewer's linked GitHub login, which matches them as a job's owner before their email does. */
export async function GithubLinkSection() {
  const viewer = await currentUser();
  if (!viewer?.id) return null;
  const [row] = await db.select({ login: user.githubLogin }).from(user).where(eq(user.id, viewer.id));
  return (
    <SettingsSection
      id="github-link"
      title="GitHub"
      description="Link your GitHub account so issues you open or are assigned on GitHub become your jobs, even with a private email. Hive keeps only your login and id."
    >
      <GithubLinkCard login={row?.login ?? null} />
    </SettingsSection>
  );
}
