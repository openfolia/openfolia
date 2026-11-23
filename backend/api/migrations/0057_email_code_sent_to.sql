-- #646: a code remembers the address it was mailed to. Open codes (10 minutes at most) have none
-- to remember, so they end here: the person asks for a new one.
-- Locked first, so a server still on the old code stores none between the two statements.
LOCK TABLE "email_sign_in_codes" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "email_sign_in_codes";--> statement-breakpoint
ALTER TABLE "email_sign_in_codes" ADD COLUMN "sent_to" text NOT NULL;
