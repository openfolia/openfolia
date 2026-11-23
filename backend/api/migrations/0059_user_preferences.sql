CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"show_tips" boolean DEFAULT true NOT NULL,
	"dismissed_tips" text[] DEFAULT '{}'::text[] NOT NULL,
	"tour_done" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_dismissed_tips" CHECK (cardinality("user_preferences"."dismissed_tips") <= 500)
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;