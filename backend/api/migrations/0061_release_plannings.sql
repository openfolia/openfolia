CREATE TABLE "release_plannings" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"planned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_plannings" ADD CONSTRAINT "release_plannings_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;