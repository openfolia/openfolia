CREATE TABLE "release_output_refusals" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"wanted" integer NOT NULL,
	"max" integer NOT NULL,
	"refused_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_output_refusals_reason" CHECK ("release_output_refusals"."reason" in ('too-many-outputs')),
	CONSTRAINT "release_output_refusals_counts" CHECK ("release_output_refusals"."wanted" >= 0 and "release_output_refusals"."max" >= 0)
);
--> statement-breakpoint
ALTER TABLE "release_output_refusals" ADD CONSTRAINT "release_output_refusals_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;