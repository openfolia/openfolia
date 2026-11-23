CREATE TABLE "asset_renditions" (
	"source_sha256" text NOT NULL,
	"width" integer NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "asset_renditions_source_sha256_width_pk" PRIMARY KEY("source_sha256","width"),
	CONSTRAINT "asset_renditions_source_sha256" CHECK ("asset_renditions"."source_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_renditions_sha256" CHECK ("asset_renditions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_renditions_width" CHECK ("asset_renditions"."width" in (320, 640, 1280)),
	CONSTRAINT "asset_renditions_size" CHECK ("asset_renditions"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "asset_deletions" (
	"sha256" text PRIMARY KEY NOT NULL,
	"marked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "asset_deletions_sha256" CHECK ("asset_deletions"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "asset_renditions_sha256_idx" ON "asset_renditions" USING btree ("sha256");