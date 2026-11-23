CREATE TABLE "installation_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"self_approval" text DEFAULT 'never' NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "installation_settings_one_row" CHECK ("installation_settings"."id" = 1),
	CONSTRAINT "installation_settings_version" CHECK ("installation_settings"."version" >= 0),
	CONSTRAINT "installation_settings_self_approval" CHECK ("installation_settings"."self_approval" in ('never', 'review', 'review-and-sign-off'))
);
--> statement-breakpoint
ALTER TABLE "change_set_approvals" ADD COLUMN "self" boolean DEFAULT false NOT NULL;