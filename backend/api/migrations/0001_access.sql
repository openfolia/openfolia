CREATE TABLE "role_assignments" (
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"permissions" text[] NOT NULL,
	"languages" text[],
	"module_types" text[],
	"max_audience" text,
	"facets" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_id_format" CHECK (char_length("roles"."id") <= 64 and "roles"."id" ~ '^[a-z][a-z0-9-]*$'),
	CONSTRAINT "roles_permissions_not_empty" CHECK (cardinality("roles"."permissions") > 0),
	CONSTRAINT "roles_languages_not_empty" CHECK ("roles"."languages" is null or cardinality("roles"."languages") > 0),
	CONSTRAINT "roles_module_types_not_empty" CHECK ("roles"."module_types" is null or cardinality("roles"."module_types") > 0),
	CONSTRAINT "roles_facets_not_empty" CHECK ("roles"."facets" is null or (jsonb_typeof("roles"."facets") = 'object' and "roles"."facets" <> '{}'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_format" CHECK (char_length("users"."id") <= 64 and "users"."id" ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_assignments_role_id_idx" ON "role_assignments" USING btree ("role_id");