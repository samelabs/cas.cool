-- Chemical enrichment columns — one-time HGS stock import targets.
-- Populated out-of-band by ops (batched import), not by app runtime.
-- cas.cool has ZERO runtime coupling to HGS: this was a single data import.
-- Idempotent (IF NOT EXISTS): the columns are applied out-of-band ahead of
-- the code deploy, then this migration is recorded via prisma migrate
-- resolve; on a fresh chain-built database it creates them normally.

ALTER TABLE "Chemical" ADD COLUMN IF NOT EXISTS "hcid" INTEGER;
ALTER TABLE "Chemical" ADD COLUMN IF NOT EXISTS "molecularFormula" TEXT;
ALTER TABLE "Chemical" ADD COLUMN IF NOT EXISTS "averageMass" DOUBLE PRECISION;
