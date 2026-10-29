-- Persistent per-event notification delivery record (idempotency authority).
-- One row per delivered eventKey, written in the same transaction as the
-- visible notification change; later events never overwrite it, so retries
-- of old events are pure no-ops. FK is ON DELETE SET NULL so the dedup
-- record survives notification-row cascade deletions (e.g. post removal).

CREATE TABLE "NotificationDelivery" (
    "eventKey" TEXT NOT NULL,
    "notificationId" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("eventKey")
);

CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
