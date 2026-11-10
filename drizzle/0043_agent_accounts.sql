CREATE TYPE "public"."account_login_status" AS ENUM('pending', 'waiting_code', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_account_kind" AS ENUM('subscription', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."agent_provider" AS ENUM('claude', 'codex');--> statement-breakpoint
CREATE TYPE "public"."usage_window" AS ENUM('5h', '7d');--> statement-breakpoint
CREATE TABLE "account_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" "agent_provider" NOT NULL,
	"status" "account_login_status" DEFAULT 'pending' NOT NULL,
	"url" text,
	"code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_usage" (
	"account_id" text NOT NULL,
	"window" "usage_window" NOT NULL,
	"used_pct" real NOT NULL,
	"resets_at" timestamp with time zone,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_usage_account_id_window_pk" PRIMARY KEY("account_id","window"),
	CONSTRAINT "account_usage_used_pct_range" CHECK ("account_usage"."used_pct" >= 0 and "account_usage"."used_pct" <= 100)
);
--> statement-breakpoint
CREATE TABLE "agent_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"provider" "agent_provider" NOT NULL,
	"kind" "agent_account_kind" NOT NULL,
	"label" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "account_logins" ADD CONSTRAINT "account_logins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_agent_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_accounts" ADD CONSTRAINT "agent_accounts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_accounts" ADD CONSTRAINT "agent_accounts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_accounts_owner_idx" ON "agent_accounts" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_account_id_agent_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."agent_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_account_idx" ON "runs" USING btree ("account_id");