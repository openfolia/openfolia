CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"body" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"outbox_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event" CHECK ("webhook_deliveries"."event" in ('manual.released', 'module.released', 'module.deprecated', 'release.withdrawn', 'translation.imported')),
	CONSTRAINT "webhook_deliveries_status" CHECK ("webhook_deliveries"."status" in ('pending', 'succeeded', 'failed', 'skipped') and ("webhook_deliveries"."status" = 'succeeded') = ("webhook_deliveries"."delivered_at" is not null)),
	CONSTRAINT "webhook_deliveries_key_format" CHECK ("webhook_deliveries"."idempotency_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "webhook_deliveries_body" CHECK (char_length("webhook_deliveries"."body") between 2 and 65536),
	CONSTRAINT "webhook_deliveries_owner_kind" CHECK ("webhook_deliveries"."owner_kind" in ('user', 'service')),
	CONSTRAINT "webhook_deliveries_attempts" CHECK ("webhook_deliveries"."attempts" >= 0 and "webhook_deliveries"."deferrals" >= 0),
	CONSTRAINT "webhook_deliveries_error" CHECK ("webhook_deliveries"."last_error" is null or "webhook_deliveries"."last_error" in ('http-status', 'timeout', 'connection', 'blocked-address', 'blocked-url', 'secret-unreadable')),
	CONSTRAINT "webhook_deliveries_status_code" CHECK ("webhook_deliveries"."last_status_code" is null or "webhook_deliveries"."last_status_code" between 100 and 599)
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" text[] NOT NULL,
	"secret_sealed" text NOT NULL,
	"previous_secret_sealed" text,
	"previous_secret_until" timestamp with time zone,
	"secret_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"attempt_failures" integer DEFAULT 0 NOT NULL,
	"sending_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_url" CHECK (char_length("webhooks"."url") between 1 and 2000 and "webhooks"."url" ~ '^https?://'),
	CONSTRAINT "webhooks_description" CHECK ("webhooks"."description" is null or char_length("webhooks"."description") between 1 and 500),
	CONSTRAINT "webhooks_events" CHECK (cardinality("webhooks"."events") between 1 and 20 and "webhooks"."events" <@ array['manual.released', 'module.released', 'module.deprecated', 'release.withdrawn', 'translation.imported']::text[]),
	CONSTRAINT "webhooks_secrets" CHECK (char_length("webhooks"."secret_sealed") between 1 and 1000 and ("webhooks"."previous_secret_sealed" is null) = ("webhooks"."previous_secret_until" is null)),
	CONSTRAINT "webhooks_disabled" CHECK (("webhooks"."disabled_reason" is null or "webhooks"."disabled_reason" = 'failing') and ("webhooks"."disabled_reason" is null or not "webhooks"."active") and ("webhooks"."disabled_reason" is null) = ("webhooks"."disabled_at" is null)),
	CONSTRAINT "webhooks_failures" CHECK ("webhooks"."consecutive_failures" >= 0 and "webhooks"."attempt_failures" >= 0),
	CONSTRAINT "webhooks_owner_kind" CHECK ("webhooks"."owner_kind" in ('user', 'service')),
	CONSTRAINT "webhooks_owner_id" CHECK (char_length("webhooks"."owner_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_key" ON "webhook_deliveries" USING btree ("webhook_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_log" ON "webhook_deliveries" USING btree ("webhook_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_settled" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."status" <> 'pending';--> statement-breakpoint
CREATE INDEX "webhooks_created" ON "webhooks" USING btree ("created_at","id");