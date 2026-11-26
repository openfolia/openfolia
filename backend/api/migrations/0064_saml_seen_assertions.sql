CREATE TABLE "saml_seen_assertions" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saml_seen_assertions_key_hash_format" CHECK ("saml_seen_assertions"."key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "saml_seen_assertions_expires_at_idx" ON "saml_seen_assertions" USING btree ("expires_at");