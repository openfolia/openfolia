CREATE TABLE "release_diffs" (
	"head_commit" text NOT NULL,
	"base_commit" text NOT NULL,
	"format" integer NOT NULL,
	"diff" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_diffs_head_commit_base_commit_pk" PRIMARY KEY("head_commit","base_commit"),
	CONSTRAINT "release_diffs_head_commit" CHECK ("release_diffs"."head_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "release_diffs_base_commit" CHECK ("release_diffs"."base_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})?$')
);
