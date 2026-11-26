ALTER TABLE "installation_settings" ADD COLUMN "single_sign_on" text;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD COLUMN "break_glass_user_id" text;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD COLUMN "session_idle_minutes" integer;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD COLUMN "session_max_hours" integer;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_break_glass_user_id_users_id_fk" FOREIGN KEY ("break_glass_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_single_sign_on" CHECK ("installation_settings"."single_sign_on" in ('optional', 'required'));--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_session_idle_minutes" CHECK ("installation_settings"."session_idle_minutes" between 5 and 43200);--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_session_max_hours" CHECK ("installation_settings"."session_max_hours" between 1 and 8760);