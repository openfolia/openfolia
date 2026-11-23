ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "outbox_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "max_audience" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "max_audience" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_max_audience" CHECK ("webhook_deliveries"."max_audience" is null or "webhook_deliveries"."max_audience" ~ '^[a-z][a-z0-9-]{0,63}$');--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_outbox" CHECK (("webhook_deliveries"."event" = 'ping') = ("webhook_deliveries"."outbox_id" is null));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event" CHECK ("webhook_deliveries"."event" in ('manual.released', 'module.released', 'module.deprecated', 'release.withdrawn', 'translation.imported', 'ping'));--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_max_audience" CHECK ("webhooks"."max_audience" is null or "webhooks"."max_audience" ~ '^[a-z][a-z0-9-]{0,63}$');