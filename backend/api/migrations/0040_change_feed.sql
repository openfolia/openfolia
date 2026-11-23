CREATE TABLE "change_feed_scopes" (
	"digest" text PRIMARY KEY NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_feed_scopes_digest" CHECK ("change_feed_scopes"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "change_feed_scopes_scopes" CHECK (jsonb_typeof("change_feed_scopes"."scopes") = 'array')
);
--> statement-breakpoint
CREATE INDEX "outbox_change_feed" ON "outbox" USING btree ("tx_id","id") WHERE "outbox"."topic" in ('release.published', 'release.withdrawn', 'module.deprecated');