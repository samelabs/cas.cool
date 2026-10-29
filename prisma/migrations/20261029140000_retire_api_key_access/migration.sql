-- Drop the legacy per-key access column and enum.
-- Keys now serve strictly as unified identity credentials; authorization is
-- computed dynamically at invocation time based on the owning account's state.
ALTER TABLE "ApiKey" DROP COLUMN "access";
DROP TYPE "ApiKeyAccess";
