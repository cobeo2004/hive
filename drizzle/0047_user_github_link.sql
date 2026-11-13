ALTER TABLE "user" ADD COLUMN "github_id" bigint;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "github_login" text;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_github_id_unique" UNIQUE("github_id");