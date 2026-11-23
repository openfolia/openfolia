CREATE TABLE "change_set_supersessions" (
	"change_set_id" uuid PRIMARY KEY NOT NULL,
	"superseded_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_set_supersessions" ADD CONSTRAINT "change_set_supersessions_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set_supersessions" ADD CONSTRAINT "change_set_supersessions_superseded_id_change_sets_id_fk" FOREIGN KEY ("superseded_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_set_supersessions_superseded_idx" ON "change_set_supersessions" USING btree ("superseded_id");--> statement-breakpoint
CREATE TRIGGER "change_set_supersessions_immutable" BEFORE UPDATE ON "change_set_supersessions" FOR EACH ROW EXECUTE FUNCTION "maintenance_links_immutable"();
