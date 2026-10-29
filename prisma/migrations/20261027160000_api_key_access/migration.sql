CREATE TYPE "ApiKeyAccess" AS ENUM ('read', 'read_write');

-- Existing keys were unrestricted. Preserve that explicit level in data;
-- every new key must choose an access level at creation.
ALTER TABLE "ApiKey"
  ADD COLUMN "access" "ApiKeyAccess" NOT NULL DEFAULT 'read_write';
ALTER TABLE "ApiKey" ALTER COLUMN "access" SET DEFAULT 'read';
ALTER TABLE "ApiKey" DROP COLUMN "scopes";
