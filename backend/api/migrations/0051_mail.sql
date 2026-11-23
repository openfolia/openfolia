CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_address" text NOT NULL,
	"to_name" text,
	"template" text NOT NULL,
	"language" text NOT NULL,
	"params_sealed" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_to_address" CHECK (char_length("mail_messages"."to_address") between 3 and 254),
	CONSTRAINT "mail_messages_to_name" CHECK ("mail_messages"."to_name" is null or char_length("mail_messages"."to_name") between 1 and 200),
	CONSTRAINT "mail_messages_template" CHECK ("mail_messages"."template" ~ '^[a-z][a-z0-9-]*$' and char_length("mail_messages"."template") <= 64),
	CONSTRAINT "mail_messages_language" CHECK ("mail_messages"."language" ~ '^[a-z]{2}$'),
	CONSTRAINT "mail_messages_last_error" CHECK ("mail_messages"."last_error" is null or char_length("mail_messages"."last_error") <= 32)
);
--> statement-breakpoint
CREATE INDEX "mail_messages_created_at" ON "mail_messages" USING btree ("created_at");