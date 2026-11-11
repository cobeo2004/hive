ALTER TYPE "public"."run_stage" ADD VALUE 'planning' BEFORE 'implementing';--> statement-breakpoint
CREATE TABLE "linear_opt_ins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"assigned" boolean DEFAULT false NOT NULL,
	"plan_approval" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "linear_opt_ins" ADD CONSTRAINT "linear_opt_ins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_owner_idx" ON "jobs" USING btree ("owner_id");