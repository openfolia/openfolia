CREATE TABLE "secret_key_check" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_key_check_one_row" CHECK ("secret_key_check"."id" = 1)
);
