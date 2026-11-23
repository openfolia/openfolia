CREATE TABLE "module_index_commits" (
	"commit" text PRIMARY KEY NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_index_commits_commit" CHECK ("module_index_commits"."commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
);
--> statement-breakpoint
CREATE TABLE "module_index_manuals" (
	"commit" text NOT NULL,
	"manual_id" text NOT NULL,
	"title" text,
	"audience" text,
	"modules" jsonb NOT NULL,
	"error" text,
	CONSTRAINT "module_index_manuals_commit_manual_id_pk" PRIMARY KEY("commit","manual_id"),
	CONSTRAINT "module_index_manuals_readable" CHECK (("module_index_manuals"."error" is null) = ("module_index_manuals"."title" is not null))
);
--> statement-breakpoint
CREATE TABLE "module_index_modules" (
	"commit" text NOT NULL,
	"module_id" text NOT NULL,
	"lang" text NOT NULL,
	"title" text,
	"module_type" text,
	"audience" text,
	"facets" jsonb,
	"keywords" jsonb,
	"refs" jsonb NOT NULL,
	"error" text,
	CONSTRAINT "module_index_modules_commit_module_id_lang_pk" PRIMARY KEY("commit","module_id","lang"),
	CONSTRAINT "module_index_modules_readable" CHECK (("module_index_modules"."error" is null) = ("module_index_modules"."title" is not null and "module_index_modules"."module_type" is not null and "module_index_modules"."facets" is not null))
);
--> statement-breakpoint
ALTER TABLE "module_index_manuals" ADD CONSTRAINT "module_index_manuals_commit_module_index_commits_commit_fk" FOREIGN KEY ("commit") REFERENCES "public"."module_index_commits"("commit") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_index_modules" ADD CONSTRAINT "module_index_modules_commit_module_index_commits_commit_fk" FOREIGN KEY ("commit") REFERENCES "public"."module_index_commits"("commit") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "module_index_commits_built_at_idx" ON "module_index_commits" USING btree ("built_at");