CREATE TABLE "pending_sign_ins" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"step" text NOT NULL,
	"provider" text NOT NULL,
	"via" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_sign_ins_token_hash_format" CHECK ("pending_sign_ins"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pending_sign_ins_step" CHECK ("pending_sign_ins"."step" in ('verify', 'set-up')),
	CONSTRAINT "pending_sign_ins_provider_length" CHECK (char_length("pending_sign_ins"."provider") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "second_factor_recovery_codes" (
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	CONSTRAINT "second_factor_recovery_codes_user_id_code_hash_pk" PRIMARY KEY("user_id","code_hash"),
	CONSTRAINT "second_factor_recovery_codes_hash_format" CHECK ("second_factor_recovery_codes"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "second_factors" (
	"user_id" text PRIMARY KEY NOT NULL,
	"sealed_secret" text NOT NULL,
	"begun_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_step" bigint,
	CONSTRAINT "second_factors_sealed_secret_length" CHECK (char_length("second_factors"."sealed_secret") between 1 and 1000),
	CONSTRAINT "second_factors_confirmed_step" CHECK (("second_factors"."confirmed_at" is null) = ("second_factors"."last_step" is null))
);
--> statement-breakpoint
ALTER TABLE "installation_settings" ADD COLUMN "second_factor" text DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_sign_ins" ADD CONSTRAINT "pending_sign_ins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "second_factor_recovery_codes" ADD CONSTRAINT "second_factor_recovery_codes_user_id_second_factors_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."second_factors"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "second_factors" ADD CONSTRAINT "second_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_sign_ins_user_id_idx" ON "pending_sign_ins" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_second_factor" CHECK ("installation_settings"."second_factor" in ('optional', 'admins', 'everyone'));