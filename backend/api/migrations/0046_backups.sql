CREATE TABLE "backup_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"fingerprint" text NOT NULL,
	"identity_sealed" text,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "backup_keys_recipient" CHECK ("backup_keys"."recipient" ~ '^age1[0-9a-z]{58}$'),
	CONSTRAINT "backup_keys_fingerprint" CHECK ("backup_keys"."fingerprint" ~ '^[0-9a-f]{4}(-[0-9a-f]{4}){3}$')
);
--> statement-breakpoint
CREATE TABLE "backup_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_kind" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"run_id" uuid,
	"error" text,
	"error_detail" text,
	CONSTRAINT "backup_requests_states" CHECK ("backup_requests"."kind" in ('run', 'test-location') and "backup_requests"."status" in ('pending', 'running', 'done', 'failed') and "backup_requests"."requested_by_kind" in ('user', 'service'))
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"sha256" text,
	"location" text,
	"name" text,
	"key_fingerprint" text,
	"verified" boolean,
	"verify_mode" text,
	"error" text,
	"error_detail" text,
	"process_id" text NOT NULL,
	"request_id" uuid,
	CONSTRAINT "backup_runs_states" CHECK ("backup_runs"."trigger" in ('schedule', 'manual', 'command') and "backup_runs"."status" in ('running', 'succeeded', 'failed') and ("backup_runs"."verify_mode" is null or "backup_runs"."verify_mode" in ('decrypted', 'before-encryption'))),
	CONSTRAINT "backup_runs_sha256" CHECK ("backup_runs"."sha256" is null or "backup_runs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "backup_runs_size" CHECK ("backup_runs"."size_bytes" is null or "backup_runs"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "backup_service" (
	"id" smallint PRIMARY KEY NOT NULL,
	"process_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"overrides" jsonb NOT NULL,
	"key_fingerprint" text,
	CONSTRAINT "backup_service_one_row" CHECK ("backup_service"."id" = 1),
	CONSTRAINT "backup_service_overrides" CHECK (jsonb_typeof("backup_service"."overrides") = 'object')
);
--> statement-breakpoint
CREATE TABLE "backup_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"frequency" jsonb NOT NULL,
	"time" text NOT NULL,
	"time_zone" text NOT NULL,
	"retention" jsonb NOT NULL,
	"location" jsonb NOT NULL,
	"s3_secret_sealed" text,
	"verify" boolean NOT NULL,
	"verify_by_decrypting" boolean NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "backup_settings_one_row" CHECK ("backup_settings"."id" = 1),
	CONSTRAINT "backup_settings_time" CHECK ("backup_settings"."time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "backup_settings_json" CHECK (jsonb_typeof("backup_settings"."frequency") = 'object' and jsonb_typeof("backup_settings"."retention") = 'object' and jsonb_typeof("backup_settings"."location") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_keys_current" ON "backup_keys" USING btree ((true)) WHERE "backup_keys"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "backup_requests_pending" ON "backup_requests" USING btree ("created_at") WHERE "backup_requests"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "backup_runs_started" ON "backup_runs" USING btree ("started_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "backup_runs_scheduled" ON "backup_runs" USING btree ("scheduled_for" DESC NULLS LAST);--> statement-breakpoint
-- Upgrade (#529): admin.backups is new. Every role holding admin.roles gets it, so an existing
-- installation's admins can open Backups without editing a role first: a holder of admin.roles
-- could grant it to themselves anyway, so this adds no power. Audited as role.update by the
-- migration, like a change made in the editor. Not written by drizzle-kit: keep it when
-- regenerating this migration.
WITH "granted" AS (
	UPDATE "roles" SET "permissions" = array_append("permissions", 'admin.backups')
	WHERE 'admin.roles' = ANY("permissions") AND NOT 'admin.backups' = ANY("permissions")
	RETURNING "id", "permissions"
)
INSERT INTO "audit_events" ("actor_kind", "actor_id", "action", "subject_type", "subject_id", "comment", "data")
SELECT 'service', 'service:migration', 'role.update', 'role', "id",
	'admin.backups granted on upgrade to a role holding admin.roles (#529).',
	jsonb_build_object('changed', jsonb_build_array('permissions'), 'permissions', to_jsonb("permissions"), 'added', jsonb_build_array('admin.backups'))
FROM "granted";
