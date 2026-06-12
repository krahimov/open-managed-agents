-- Reconcile node-pg model_cards with the 0015 handle rename: the shared
-- SqlModelCardRepo selects "model" unconditionally, but the consolidated
-- baseline (0000) shipped the pre-rename shape (display_name, no model),
-- crash-looping the first Postgres boot at seedEnvModelCard.
--
-- Idempotent ALTERs so this is safe whether the deployed table predates or
-- postdates the fix, and a no-op on a fresh DB that built 0000 + this in one
-- pass. We ADD model and leave display_name in place (nullable-safe) rather
-- than DROP it, to avoid destroying data on any environment that populated it.
ALTER TABLE "model_cards" ADD COLUMN IF NOT EXISTS "model" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_cards" ALTER COLUMN "display_name" DROP NOT NULL;
