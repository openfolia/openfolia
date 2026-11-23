CREATE TABLE "email_code_sign_ins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sign_in_codes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"link_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_sign_in_codes_link_hash_key" UNIQUE("link_hash"),
	CONSTRAINT "email_sign_in_codes_failures" CHECK ("email_sign_in_codes"."failures" >= 0),
	CONSTRAINT "email_sign_in_codes_code_hash_format" CHECK ("email_sign_in_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_sign_in_codes_link_hash_format" CHECK ("email_sign_in_codes"."link_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "email_code_sign_ins" ADD CONSTRAINT "email_code_sign_ins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sign_in_codes" ADD CONSTRAINT "email_sign_in_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;