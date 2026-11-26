CREATE TABLE "notification_email_sends" (
	"key" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"mode" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_email_sends_mode" CHECK ("notification_email_sends"."mode" in ('now', 'digest')),
	CONSTRAINT "notification_email_sends_key" CHECK (char_length("notification_email_sends"."key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "notification_emails" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_emails_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notification_id" bigint NOT NULL,
	"recipient_id" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim" uuid,
	"claimed_until" timestamp with time zone,
	CONSTRAINT "notification_emails_notification" UNIQUE("notification_id"),
	CONSTRAINT "notification_emails_mode" CHECK ("notification_emails"."mode" in ('now', 'digest'))
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "audit_data" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "notification_choices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "email_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "notifications_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "digest_hour" smallint;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "notification_email_sends" ADD CONSTRAINT "notification_email_sends_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_email_sends_recipient" ON "notification_email_sends" USING btree ("recipient_id","sent_at");--> statement-breakpoint
CREATE INDEX "notification_email_sends_sent_at" ON "notification_email_sends" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "notification_emails_due" ON "notification_emails" USING btree ("mode","created_at");--> statement-breakpoint
CREATE INDEX "notification_emails_recipient" ON "notification_emails" USING btree ("recipient_id","mode");--> statement-breakpoint
CREATE INDEX "notification_emails_claim" ON "notification_emails" USING btree ("claim");--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_notification_choices" CHECK (jsonb_typeof("user_preferences"."notification_choices") = 'object');--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_digest_hour" CHECK ("user_preferences"."digest_hour" is null or "user_preferences"."digest_hour" between 0 and 23);--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_time_zone" CHECK ("user_preferences"."time_zone" is null or char_length("user_preferences"."time_zone") between 1 and 64);--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_language" CHECK ("user_preferences"."language" is null or "user_preferences"."language" in ('en', 'de'));