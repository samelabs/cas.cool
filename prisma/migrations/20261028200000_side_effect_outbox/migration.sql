-- Transactional outbox for post-commit side effects.
-- Rows are enqueued inside the caller's transaction; execution happens
-- after commit. Failures stay pending with attempts/lastError for retry.

CREATE TYPE "SideEffectKind" AS ENUM ('notification', 'upload_cleanup');
CREATE TYPE "SideEffectStatus" AS ENUM ('pending', 'succeeded');

CREATE TABLE "SideEffectTask" (
    "id" TEXT NOT NULL,
    "kind" "SideEffectKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SideEffectStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SideEffectTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SideEffectTask_status_createdAt_idx" ON "SideEffectTask"("status", "createdAt");
