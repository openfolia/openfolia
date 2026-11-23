CREATE TABLE "commit_intents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commit_intents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"change_set_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"parent" text NOT NULL,
	"tree" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_intents_actor_kind" CHECK ("commit_intents"."actor_kind" in ('user', 'service')),
	CONSTRAINT "commit_intents_actor_id" CHECK (char_length("commit_intents"."actor_id") between 1 and 200),
	CONSTRAINT "commit_intents_parent" CHECK ("commit_intents"."parent" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "commit_intents_tree" CHECK ("commit_intents"."tree" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "commit_intents_payload" CHECK (jsonb_typeof("commit_intents"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "commit_intents" ADD CONSTRAINT "commit_intents_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commit_intents_change_set_idx" ON "commit_intents" USING btree ("change_set_id","parent","tree");--> statement-breakpoint
CREATE INDEX "commit_intents_created_idx" ON "commit_intents" USING btree ("created_at");