CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"product_facet" text NOT NULL,
	"revision" text NOT NULL,
	"tag" text NOT NULL,
	"tag_object" text,
	"commit" text NOT NULL,
	"notes" text,
	"published_by_kind" text NOT NULL,
	"published_by_id" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "releases_product" CHECK ("releases"."product" ~ '^[a-z][a-z0-9-]*$' and char_length("releases"."product") <= 64),
	CONSTRAINT "releases_product_facet" CHECK ("releases"."product_facet" ~ '^[a-z][a-z0-9-]*$' and char_length("releases"."product_facet") <= 64),
	CONSTRAINT "releases_revision" CHECK ("releases"."revision" ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$' and "releases"."revision" not like '%..%' and "releases"."revision" not like '%.' and "releases"."revision" not like '%.lock'),
	CONSTRAINT "releases_tag" CHECK (char_length("releases"."tag") between 1 and 256 and "releases"."tag" !~ '^refs/'),
	CONSTRAINT "releases_tag_object" CHECK ("releases"."tag_object" is null or "releases"."tag_object" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "releases_commit" CHECK ("releases"."commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "releases_notes" CHECK ("releases"."notes" is null or char_length("releases"."notes") between 1 and 10000),
	CONSTRAINT "releases_published_by_kind" CHECK ("releases"."published_by_kind" in ('user', 'service')),
	CONSTRAINT "releases_published_by_id" CHECK (char_length("releases"."published_by_id") between 1 and 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "releases_name_idx" ON "releases" USING btree ("product","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_tag_idx" ON "releases" USING btree (lower("tag"));--> statement-breakpoint
CREATE INDEX "releases_published_idx" ON "releases" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "releases_product_idx" ON "releases" USING btree ("product","published_at","id");--> statement-breakpoint
-- Immutable once published, held by the database: a reserved release (no
-- tag object yet) may be published, setting only its tag object, or
-- dropped; a published one is never changed or deleted, and the table is
-- never truncated. Written by hand: drizzle-kit does not track triggers.
CREATE FUNCTION "releases_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'TRUNCATE' THEN
		RAISE EXCEPTION 'releases cannot be truncated'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."tag_object" IS NOT NULL THEN
		RAISE EXCEPTION 'release % is published: % is not allowed', OLD."id", TG_OP
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	IF NEW."tag_object" IS NULL
		OR (to_jsonb(NEW) - 'tag_object') IS DISTINCT FROM (to_jsonb(OLD) - 'tag_object') THEN
		RAISE EXCEPTION 'a reserved release % may only be published', OLD."id"
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "releases_immutable" BEFORE UPDATE OR DELETE ON "releases" FOR EACH ROW EXECUTE FUNCTION "releases_immutable"();
--> statement-breakpoint
CREATE TRIGGER "releases_no_truncate" BEFORE TRUNCATE ON "releases" FOR EACH STATEMENT EXECUTE FUNCTION "releases_immutable"();
