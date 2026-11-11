ALTER TABLE "job_screenshots" RENAME TO "job_media";--> statement-breakpoint
ALTER TABLE "job_media" RENAME CONSTRAINT "job_screenshots_stage_event_id_file_pk" TO "job_media_stage_event_id_file_pk";--> statement-breakpoint
ALTER INDEX "job_screenshots_job_idx" RENAME TO "job_media_job_idx";--> statement-breakpoint
ALTER TABLE "job_media" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
CREATE TABLE "device_frames" (
	"job_key" text PRIMARY KEY NOT NULL,
	"png" "bytea" NOT NULL,
	"taken_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_viewers" (
	"job_key" text NOT NULL,
	"user_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_viewers_job_key_user_id_pk" PRIMARY KEY("job_key","user_id")
);
--> statement-breakpoint
ALTER TABLE "device_viewers" ADD CONSTRAINT "device_viewers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Live updates (R31/R38): device_frames notifies so the panel sees a new frame. device_viewers does not,
-- because the runner polls it. job_media gets none: job_screenshots never had one (assumptions.md).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_frames'] LOOP
    EXECUTE format('CREATE TRIGGER "hive_notify_insert" AFTER INSERT ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
    EXECUTE format('CREATE TRIGGER "hive_notify_update" AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
    EXECUTE format('CREATE TRIGGER "hive_notify_delete" AFTER DELETE ON %I REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION "hive_notify"()', t);
  END LOOP;
END
$$;
