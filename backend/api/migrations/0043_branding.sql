CREATE TABLE "branding" (
	"id" smallint PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"product_name" text,
	"logo_light" text,
	"logo_dark" text,
	"mark" text,
	"favicon" text,
	"app_icon" text,
	"primary_colour" text,
	"accent_colour" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "branding_one_row" CHECK ("branding"."id" = 1),
	CONSTRAINT "branding_version" CHECK ("branding"."version" >= 0),
	CONSTRAINT "branding_product_name" CHECK ("branding"."product_name" is null or char_length("branding"."product_name") between 1 and 80),
	CONSTRAINT "branding_images" CHECK (("branding"."logo_light" is null or "branding"."logo_light" ~ '^[0-9a-f]{64}$') and ("branding"."logo_dark" is null or "branding"."logo_dark" ~ '^[0-9a-f]{64}$') and ("branding"."mark" is null or "branding"."mark" ~ '^[0-9a-f]{64}$') and ("branding"."favicon" is null or "branding"."favicon" ~ '^[0-9a-f]{64}$') and ("branding"."app_icon" is null or "branding"."app_icon" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "branding_colours" CHECK (("branding"."primary_colour" is null or "branding"."primary_colour" ~ '^#[0-9a-f]{6}$') and ("branding"."accent_colour" is null or "branding"."accent_colour" ~ '^#[0-9a-f]{6}$'))
);
--> statement-breakpoint
CREATE TABLE "branding_images" (
	"sha256" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"uploaded_by_kind" text NOT NULL,
	"uploaded_by_id" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "branding_images_sha256" CHECK ("branding_images"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "branding_images_type" CHECK ("branding_images"."content_type" in ('image/png', 'image/webp')),
	CONSTRAINT "branding_images_size" CHECK ("branding_images"."size" > 0 and "branding_images"."width" > 0 and "branding_images"."height" > 0)
);
--> statement-breakpoint
-- Upgrade (#169): admin.branding is new. Every role holding admin.roles gets it, so an existing
-- installation's admins can open Branding without editing a role first: a holder of admin.roles
-- could grant it to themselves anyway, so this adds no power. Audited as role.update by the
-- migration, like a change made in the editor.
WITH "granted" AS (
	UPDATE "roles" SET "permissions" = array_append("permissions", 'admin.branding')
	WHERE 'admin.roles' = ANY("permissions") AND NOT 'admin.branding' = ANY("permissions")
	RETURNING "id", "permissions"
)
INSERT INTO "audit_events" ("actor_kind", "actor_id", "action", "subject_type", "subject_id", "comment", "data")
SELECT 'service', 'service:migration', 'role.update', 'role', "id",
	'admin.branding granted on upgrade to a role holding admin.roles (#169).',
	jsonb_build_object('changed', jsonb_build_array('permissions'), 'permissions', to_jsonb("permissions"), 'added', jsonb_build_array('admin.branding'))
FROM "granted";
