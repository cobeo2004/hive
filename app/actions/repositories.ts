"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { currentUser } from "@/lib/auth/server";
import type { RepoName } from "@/lib/github/app";
import { installationRepos } from "@/lib/github/installation";
import { sourcesOn } from "@/lib/job-sources";
import { github } from "@/lib/github/pulls";
import { reportedHarnesses } from "@/lib/machine";
import { runsLocally } from "@/lib/onboarding";
import { modalEnvConfigured, modalSecretStore } from "@/lib/modal-secrets";
import {
  addRepository as add,
  listAddable,
  rebuildRepoImage as rebuild,
  recordSecretNames,
  retryOnboarding as retry,
  saveRepoSecrets as saveSecrets,
  writeNewRepository,
  writeRepoRequest,
  writeVerify,
  type SecretsInput,
} from "@/lib/repo-onboarding";
import { SSTACK_PROJECT_PATH } from "@/lib/sstack-verify";
import {
  makeDefaultRepo,
  readRegistry,
  saveRepository as save,
  writeDefaultRepo,
  writeRepository,
  type DefaultRepoInput,
  type RepositoryInput,
} from "@/lib/repositories";
import { readSettings, resolveExecution } from "@/lib/settings";
import { panelSource, syncGithubLabelsNow } from "@/lib/sources";

const user = currentUser;
const registry = () => readRegistry(db);
const installable = () => installationRepos();
const request = (kind: "onboard_repo" | "rebuild_repo_image", repo: string) => writeRepoRequest(db, kind, repo, new Date());

export async function saveRepository(input: RepositoryInput) {
  return save(
    {
      user,
      registry,
      harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
      save: async (choice, by) => {
        const at = new Date();
        const before = (await registry()).find((r) => r.repo === choice.repo);
        await writeRepository(db, choice, by, at);
        // A local repo was never onboarded; moving it to the cloud starts onboarding.
        const fallback = resolveExecution(await readSettings(db));
        const settled = before?.onboarding_state === "ready" || before?.onboarding_state === "rebuilding";
        if (before && !settled && runsLocally(before.execution, fallback) && !runsLocally(choice.execution, fallback))
          await request("onboard_repo", choice.repo);
      },
    },
    input,
  );
}

export async function makeDefaultRepository(input: DefaultRepoInput) {
  return makeDefaultRepo({ user, registry, save: (repo, by) => writeDefaultRepo(db, repo, by, new Date()) }, input);
}

export async function addableRepositories() {
  return listAddable({ user, registry, installable });
}

export async function addRepository(input: { repo: string }) {
  return add(
    {
      user,
      registry,
      installable,
      create: (repo, by) => writeNewRepository(db, repo, by, new Date()),
      syncLabels: async (groups) => {
        // Linear's Repository label only where Linear is a source (R14); GitHub's labels only where it is (R15).
        const linear = (await sourcesOn(db)).linear ? await panelSource().panelSyncLabelGroups!(groups) : { team: "", created: [], problems: [] };
        const github = await syncGithubLabelsNow(db).catch((error) => [`GitHub labels: ${error instanceof Error ? error.message : String(error)}`]);
        return { ...linear, problems: [...linear.problems, ...github] };
      },
    },
    input,
  );
}

export async function saveRepositorySecrets(input: SecretsInput) {
  return saveSecrets(
    {
      user,
      registry,
      modalConfigured: () => modalEnvConfigured(),
      upsert: (name, entries) => modalSecretStore().upsert(name, entries),
      recordNames: (repo, names) => recordSecretNames(db, repo, names, new Date()),
    },
    input,
  );
}

export async function retryOnboarding(input: { repo: string }) {
  return retry({ user, registry, request }, input);
}

export async function rebuildRepositoryImage(input: { repo: string }) {
  return rebuild(
    {
      user,
      registry,
      request,
      projectToml: (repo) => github.fileAt(repo as RepoName, SSTACK_PROJECT_PATH, "HEAD"),
      saveVerify: (repo, verify) => writeVerify(db, repo, verify),
    },
    input,
  );
}
