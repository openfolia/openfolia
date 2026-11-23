CREATE TABLE "password_attempts" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	CONSTRAINT "password_attempts_key_hash_format" CHECK ("password_attempts"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "password_attempts_failures" CHECK ("password_attempts"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "password_attempts_key" (
	"id" integer PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "password_attempts_key_one" CHECK ("password_attempts_key"."id" = 1),
	CONSTRAINT "password_attempts_key_format" CHECK ("password_attempts_key"."key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sign_in_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sign_in_links_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "sign_in_links_token_hash_format" CHECK ("sign_in_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sign_in_links_kind" CHECK ("sign_in_links"."kind" in ('invite', 'reset'))
);
--> statement-breakpoint
CREATE TABLE "user_passwords" (
	"user_id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_passwords_hash_format" CHECK ("user_passwords"."hash" like '$argon2id$%' and char_length("user_passwords"."hash") <= 512)
);
--> statement-breakpoint
ALTER TABLE "sign_in_links" ADD CONSTRAINT "sign_in_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_passwords" ADD CONSTRAINT "user_passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_attempts_window_start_idx" ON "password_attempts" USING btree ("window_start");