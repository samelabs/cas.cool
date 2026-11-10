-- Structure-image task cancelled: CAS pages no longer render structure
-- images. Drop the bookkeeping column (was all NULL; metadata-only change).
ALTER TABLE "Chemical" DROP COLUMN IF EXISTS "structureSvgAt";
