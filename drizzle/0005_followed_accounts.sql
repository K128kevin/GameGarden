CREATE TABLE "followed_accounts" (
	"account_id" text NOT NULL,
	"author_key" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followed_accounts_account_id_author_key_pk" PRIMARY KEY("account_id","author_key")
);
--> statement-breakpoint
ALTER TABLE "followed_accounts" ADD CONSTRAINT "followed_accounts_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;