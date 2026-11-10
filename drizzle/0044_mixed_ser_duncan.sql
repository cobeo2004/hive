CREATE TABLE "repo_sstack_config" (
	"repo" text PRIMARY KEY NOT NULL,
	"files" jsonb NOT NULL,
	"sha" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sstack_defaults" (
	"id" text PRIMARY KEY NOT NULL,
	"files" jsonb NOT NULL,
	"sha" text,
	"updated_at" timestamp with time zone,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "harness" text;--> statement-breakpoint
-- Live updates (R31/R37): the sstack snapshots take part in live updates. Same statement triggers as
-- 0040, reusing its "hive_notify" function and its per-event transition tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['repo_sstack_config', 'sstack_defaults'] LOOP
    EXECUTE format('CREATE TRIGGER "hive_notify_insert" AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
    EXECUTE format('CREATE TRIGGER "hive_notify_update" AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
    EXECUTE format('CREATE TRIGGER "hive_notify_delete" AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
  END LOOP;
END
$$;
