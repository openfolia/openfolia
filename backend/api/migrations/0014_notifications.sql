CREATE TABLE "outbox_consumers" (
	"name" text PRIMARY KEY NOT NULL,
	"last_tx_id" "xid8" DEFAULT '0'::xid8 NOT NULL,
	"last_outbox_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_consumers_name" CHECK ("outbox_consumers"."name" ~ '^[a-z][a-z0-9-]*$' and char_length("outbox_consumers"."name") <= 100),
	CONSTRAINT "outbox_consumers_last_outbox_id" CHECK ("outbox_consumers"."last_outbox_id" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"outbox_id" bigint NOT NULL,
	"recipient_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_recipient_id" CHECK (char_length("notifications"."recipient_id") <= 64 and "notifications"."recipient_id" ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'),
	CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' and char_length("notifications"."kind") <= 100),
	CONSTRAINT "notifications_subject" CHECK ("notifications"."subject_type" ~ '^[a-z][a-z0-9-]*$' and char_length("notifications"."subject_type") <= 50 and char_length("notifications"."subject_id") between 1 and 200),
	CONSTRAINT "notifications_payload" CHECK (jsonb_typeof("notifications"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "tx_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_outbox_recipient" ON "notifications" USING btree ("outbox_id","recipient_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread" ON "notifications" USING btree ("recipient_id","id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_read" ON "notifications" USING btree ("read_at") WHERE "notifications"."read_at" is not null;--> statement-breakpoint
CREATE INDEX "outbox_tx_id" ON "outbox" USING btree ("tx_id","id");