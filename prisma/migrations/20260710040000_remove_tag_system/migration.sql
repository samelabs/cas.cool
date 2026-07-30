-- Remove Tag system — posts now use Chemical (CAS number) exclusively.

DROP INDEX IF EXISTS "Tag_name_trgm_idx";
DROP TABLE IF EXISTS "_PostToTag";
DROP TABLE IF EXISTS "Tag";
