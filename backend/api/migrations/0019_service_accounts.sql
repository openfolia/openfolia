CREATE TABLE "service_account_roles" (
	"service_account_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_account_roles_service_account_id_role_id_pk" PRIMARY KEY("service_account_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_accounts_id_format" CHECK (char_length("service_accounts"."id") <= 64 and "service_accounts"."id" ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "service_accounts_name_length" CHECK (char_length("service_accounts"."name") between 1 and 200),
	CONSTRAINT "service_accounts_description_length" CHECK ("service_accounts"."description" is null or char_length("service_accounts"."description") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "service_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"service_account_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "service_tokens_id_format" CHECK ("service_tokens"."id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "service_tokens_name_length" CHECK (char_length("service_tokens"."name") between 1 and 100),
	CONSTRAINT "service_tokens_secret_hash_format" CHECK ("service_tokens"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "service_tokens_expires_after_created" CHECK ("service_tokens"."expires_at" > "service_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "service_account_roles" ADD CONSTRAINT "service_account_roles_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_account_roles" ADD CONSTRAINT "service_account_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tokens" ADD CONSTRAINT "service_tokens_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_account_roles_role_id_idx" ON "service_account_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "service_tokens_account_idx" ON "service_tokens" USING btree ("service_account_id","created_at");