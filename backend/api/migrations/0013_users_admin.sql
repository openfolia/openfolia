ALTER TABLE "roles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_description_length" CHECK ("roles"."description" is null or char_length("roles"."description") between 1 and 500);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_format" CHECK ("users"."email" is null or (char_length("users"."email") <= 254 and "users"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'));