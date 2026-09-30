ALTER TABLE "interactions" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "draft_text" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "draft_model" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "drafted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "inbound_checked_at" timestamp with time zone;