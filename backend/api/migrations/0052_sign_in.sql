CREATE TABLE "group_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_name" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_roles_group_role" UNIQUE("group_name","role_id"),
	CONSTRAINT "group_roles_group_length" CHECK (char_length("group_roles"."group_name") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_format" CHECK ("sessions"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject"),
	CONSTRAINT "user_identities_user_issuer" UNIQUE("user_id","issuer"),
	CONSTRAINT "user_identities_lengths" CHECK (char_length("user_identities"."issuer") between 1 and 2000 and char_length("user_identities"."subject") between 1 and 255 and cardinality("user_identities"."groups") <= 200)
);
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "direct" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "via_groups" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_roles_role_id_idx" ON "group_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_identities_groups_idx" ON "user_identities" USING gin ("groups");--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_held" CHECK ("role_assignments"."direct" or "role_assignments"."via_groups");