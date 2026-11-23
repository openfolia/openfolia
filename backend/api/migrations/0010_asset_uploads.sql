CREATE TABLE "asset_uploads" (
	"change_set_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by_kind" text NOT NULL,
	"uploaded_by_id" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"last_uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "asset_uploads_change_set_id_sha256_pk" PRIMARY KEY("change_set_id","sha256"),
	CONSTRAINT "asset_uploads_sha256" CHECK ("asset_uploads"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_uploads_size" CHECK ("asset_uploads"."size" >= 0),
	CONSTRAINT "asset_uploads_content_type" CHECK ("asset_uploads"."content_type" in ('image/png', 'image/jpeg')),
	CONSTRAINT "asset_uploads_uploaded_by_kind" CHECK ("asset_uploads"."uploaded_by_kind" in ('user', 'service')),
	CONSTRAINT "asset_uploads_uploaded_by_id" CHECK (char_length("asset_uploads"."uploaded_by_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "asset_uploads" ADD CONSTRAINT "asset_uploads_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_uploads_sha256_idx" ON "asset_uploads" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "asset_uploads_last_uploaded_at_idx" ON "asset_uploads" USING btree ("last_uploaded_at");