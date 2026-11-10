-- Track which chemicals already have a server-generated structure SVG
-- at /mol-svg/<casNumber>.svg. Nullable timestamp: NULL = not generated yet.
-- Set by the offline batch job, never by the application.
ALTER TABLE "Chemical" ADD COLUMN IF NOT EXISTS "structureSvgAt" TIMESTAMP(3);
