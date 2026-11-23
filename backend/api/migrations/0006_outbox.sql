CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"topic" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_topic" CHECK ("outbox"."topic" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' and char_length("outbox"."topic") <= 100),
	CONSTRAINT "outbox_key" CHECK (char_length("outbox"."key") between 1 and 200),
	CONSTRAINT "outbox_payload" CHECK (jsonb_typeof("outbox"."payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_topic_key" ON "outbox" USING btree ("topic","key");