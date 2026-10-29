-- Outbox claim lease + notification event idempotency key.
--
-- claimToken/claimedAt: drains claim pending rows atomically (per-row
-- conditional UPDATE), so concurrent executors never double-execute a
-- task; a claim is re-claimable once its lease (60 s) has expired, which
-- recovers tasks orphaned by a process that died mid-execution.
--
-- Notification.eventKey: persistent per-event idempotency key for outbox
-- delivery (at-least-once execution, exactly-once observable effect).
-- Covers postId-NULL events that the compound unique constraint cannot
-- dedup (PostgreSQL treats NULLs as distinct). Existing rows keep NULL
-- (multiple NULLs allowed by the unique index).

ALTER TABLE "SideEffectTask" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "SideEffectTask" ADD COLUMN "claimedAt" TIMESTAMP(3);

ALTER TABLE "Notification" ADD COLUMN "eventKey" TEXT;
CREATE UNIQUE INDEX "Notification_eventKey_key" ON "Notification"("eventKey");
