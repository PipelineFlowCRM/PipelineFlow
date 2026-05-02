-- CreateTable
CREATE TABLE "GoogleAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "googleSub" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleContactsSync" (
    "googleAccountId" INTEGER NOT NULL,
    "syncToken" TEXT,
    "initialPageToken" TEXT,
    "initialImportedCount" INTEGER NOT NULL DEFAULT 0,
    "fullSyncDoneAt" TIMESTAMP(3),
    "lastPulledAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "inboundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "outboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleContactsSync_pkey" PRIMARY KEY ("googleAccountId")
);

-- CreateTable
CREATE TABLE "ContactGoogleLink" (
    "id" SERIAL NOT NULL,
    "contactId" INTEGER NOT NULL,
    "googleAccountId" INTEGER NOT NULL,
    "resourceName" TEXT NOT NULL,
    "etag" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPushedHash" TEXT,
    "lastPulledHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactGoogleLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAccount_userId_key" ON "GoogleAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAccount_googleSub_key" ON "GoogleAccount"("googleSub");

-- CreateIndex
CREATE INDEX "ContactGoogleLink_contactId_idx" ON "ContactGoogleLink"("contactId");

-- CreateIndex
CREATE INDEX "ContactGoogleLink_googleAccountId_lastSyncedAt_idx" ON "ContactGoogleLink"("googleAccountId", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactGoogleLink_googleAccountId_resourceName_key" ON "ContactGoogleLink"("googleAccountId", "resourceName");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "OAuthState_userId_idx" ON "OAuthState"("userId");

-- AddForeignKey
ALTER TABLE "GoogleAccount" ADD CONSTRAINT "GoogleAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleContactsSync" ADD CONSTRAINT "GoogleContactsSync_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactGoogleLink" ADD CONSTRAINT "ContactGoogleLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactGoogleLink" ADD CONSTRAINT "ContactGoogleLink_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
