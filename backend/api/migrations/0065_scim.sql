CREATE TABLE "scim_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "scim_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_lengths" CHECK (char_length("scim_groups"."display_name") between 1 and 256 and ("scim_groups"."external_id" is null or char_length("scim_groups"."external_id") between 1 and 256))
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_scim" boolean DEFAULT false NOT NULL,
	"scim_deactivated_at" timestamp with time zone,
	"unlinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_users_lengths" CHECK (char_length("scim_users"."user_name") between 1 and 256 and ("scim_users"."external_id" is null or char_length("scim_users"."external_id") between 1 and 256))
);
--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_group_members_user_id_idx" ON "scim_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_display_name_unique" ON "scim_groups" USING btree ("display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_user_name_unique" ON "scim_users" USING btree (lower("user_name")) WHERE "scim_users"."unlinked_at" is null;