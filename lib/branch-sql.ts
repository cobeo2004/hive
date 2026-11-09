import { sql, type SQL } from "drizzle-orm";
import { jobs } from "../db/schema";
import { BRANCH_PREFIX } from "./factory";

/** attemptBranch (lib/factory.ts) in SQL, for the job row a query is on. */
export const attemptBranchSql: SQL<string> = sql<string>`case when ${jobs.attempt} > 1 then ${BRANCH_PREFIX} || ${jobs.key} || '-a' || ${jobs.attempt} else ${BRANCH_PREFIX} || ${jobs.key} end`;
