-- Add registration IDs for Signal/libsignal device bundles.
ALTER TABLE "Device" ADD COLUMN "registrationId" INTEGER;

-- Add optional post-quantum Kyber prekey support for modern Signal-style bundles.
CREATE TABLE "KyberPreKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "publicKey" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KyberPreKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KyberPreKey_userId_deviceId_consumedAt_idx" ON "KyberPreKey"("userId", "deviceId", "consumedAt");
CREATE UNIQUE INDEX "KyberPreKey_deviceId_keyId_key" ON "KyberPreKey"("deviceId", "keyId");

ALTER TABLE "KyberPreKey" ADD CONSTRAINT "KyberPreKey_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
