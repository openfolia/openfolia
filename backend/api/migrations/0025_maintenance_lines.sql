CREATE TABLE "change_set_carry_forwards" (
	"change_set_id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_line_releases" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"line_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"revision" text NOT NULL,
	"base_release" uuid NOT NULL,
	"base_commit" text NOT NULL,
	"branch" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_kind" text,
	"closed_by_id" text,
	CONSTRAINT "maintenance_lines_product" CHECK ("maintenance_lines"."product" ~ '^[a-z][a-z0-9-]*$' and char_length("maintenance_lines"."product") <= 64),
	CONSTRAINT "maintenance_lines_revision" CHECK ("maintenance_lines"."revision" ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$'),
	CONSTRAINT "maintenance_lines_base_commit" CHECK ("maintenance_lines"."base_commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "maintenance_lines_branch" CHECK (char_length("maintenance_lines"."branch") between 1 and 256 and lower("maintenance_lines"."branch") !~ '^(refs|change-sets)/'),
	CONSTRAINT "maintenance_lines_created_by_kind" CHECK ("maintenance_lines"."created_by_kind" in ('user', 'service')),
	CONSTRAINT "maintenance_lines_created_by_id" CHECK (char_length("maintenance_lines"."created_by_id") between 1 and 200),
	CONSTRAINT "maintenance_lines_closed" CHECK (("maintenance_lines"."closed_at" is null and "maintenance_lines"."closed_by_kind" is null and "maintenance_lines"."closed_by_id" is null) or ("maintenance_lines"."closed_at" is not null and "maintenance_lines"."closed_by_kind" in ('user', 'service') and char_length("maintenance_lines"."closed_by_id") between 1 and 200))
);
--> statement-breakpoint
ALTER TABLE "change_set_carry_forwards" ADD CONSTRAINT "change_set_carry_forwards_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set_carry_forwards" ADD CONSTRAINT "change_set_carry_forwards_source_id_change_sets_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_line_releases" ADD CONSTRAINT "maintenance_line_releases_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_line_releases" ADD CONSTRAINT "maintenance_line_releases_line_id_maintenance_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."maintenance_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_lines" ADD CONSTRAINT "maintenance_lines_base_release_releases_id_fk" FOREIGN KEY ("base_release") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_set_carry_forwards_source_idx" ON "change_set_carry_forwards" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "maintenance_line_releases_line_idx" ON "maintenance_line_releases" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_lines_base_release_idx" ON "maintenance_lines" USING btree ("base_release");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_lines_name_idx" ON "maintenance_lines" USING btree ("product","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_lines_branch_idx" ON "maintenance_lines" USING btree (lower("branch"));--> statement-breakpoint
CREATE INDEX "maintenance_lines_created_idx" ON "maintenance_lines" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "maintenance_lines_product_idx" ON "maintenance_lines" USING btree ("product","created_at","id");--> statement-breakpoint
CREATE FUNCTION "maintenance_lines_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'TRUNCATE' THEN
		RAISE EXCEPTION 'maintenance lines cannot be truncated'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'maintenance line % is never deleted', OLD."id"
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD."closed_at" IS NOT NULL OR NEW."closed_at" IS NULL
		OR (NEW."id", NEW."product", NEW."revision", NEW."base_release", NEW."base_commit", NEW."branch", NEW."created_by_kind", NEW."created_by_id", NEW."created_at")
			IS DISTINCT FROM (OLD."id", OLD."product", OLD."revision", OLD."base_release", OLD."base_commit", OLD."branch", OLD."created_by_kind", OLD."created_by_id", OLD."created_at") THEN
		RAISE EXCEPTION 'maintenance line % changes only by closing it, once', OLD."id"
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "maintenance_lines_guard" BEFORE UPDATE OR DELETE ON "maintenance_lines" FOR EACH ROW EXECUTE FUNCTION "maintenance_lines_guard"();
--> statement-breakpoint
CREATE TRIGGER "maintenance_lines_no_truncate" BEFORE TRUNCATE ON "maintenance_lines" FOR EACH STATEMENT EXECUTE FUNCTION "maintenance_lines_guard"();
--> statement-breakpoint
CREATE FUNCTION "maintenance_links_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "maintenance_line_releases_immutable" BEFORE UPDATE ON "maintenance_line_releases" FOR EACH ROW EXECUTE FUNCTION "maintenance_links_immutable"();
--> statement-breakpoint
CREATE TRIGGER "change_set_carry_forwards_immutable" BEFORE UPDATE ON "change_set_carry_forwards" FOR EACH ROW EXECUTE FUNCTION "maintenance_links_immutable"();
