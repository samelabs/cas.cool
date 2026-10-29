-- Repair migration-chain drift: align the COMMITTED migration chain with
-- prisma/schema.prisma (and with what production already contains).
--
-- History: the User denormalized count columns and the ApiKey table were
-- applied to production OUTSIDE the migration chain (untracked db push), so
-- any database built solely from prisma/migrations was missing them — the
-- API then fails with P2022 "The column User.postCount does not exist".
-- Every statement below is idempotent: it creates missing objects on
-- migration-built databases and skips objects already present. Production
-- no-op behavior depends on the live objects matching the expected schema;
-- inspect production before deployment.
--
-- Note: prisma migrate diff also proposes dropping the *_trgm_idx / idx_*trgm
-- GIN indexes. That proposal is an artifact — schema.prisma cannot express
-- gin_trgm_ops indexes; they are created by raw SQL in migration
-- 20260710030000 on purpose. They are deliberately NOT dropped here.

-- User denormalized counts (same pattern as Post.likeCount etc. —
-- maintained by application-layer increments in the same transaction)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "postCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "followerCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "followingCount" INTEGER NOT NULL DEFAULT 0;

-- ApiKey — external API authentication (raw key SHA-256 hashed at rest)
CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX IF NOT EXISTS "ApiKey_userId_idx" ON "ApiKey"("userId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_userId_fkey'
    ) THEN
        ALTER TABLE "ApiKey"
            ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId")
            REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
