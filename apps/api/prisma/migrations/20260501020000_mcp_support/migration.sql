-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAuditEvent" (
    "id" SERIAL NOT NULL,
    "tokenId" TEXT,
    "actorUserId" INTEGER,
    "toolName" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "args" JSONB,
    "summary" TEXT,
    "errorMessage" TEXT,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpApprovalToken" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsFingerprint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpApprovalToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE INDEX "ApiToken_revokedAt_idx" ON "ApiToken"("revokedAt");

-- CreateIndex
CREATE INDEX "McpAuditEvent_tokenId_createdAt_idx" ON "McpAuditEvent"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAuditEvent_toolName_createdAt_idx" ON "McpAuditEvent"("toolName", "createdAt");

-- CreateIndex
CREATE INDEX "McpAuditEvent_createdAt_idx" ON "McpAuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "McpApprovalToken_tokenId_idx" ON "McpApprovalToken"("tokenId");

-- CreateIndex
CREATE INDEX "McpApprovalToken_expiresAt_idx" ON "McpApprovalToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuditEvent" ADD CONSTRAINT "McpAuditEvent_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ApiToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpApprovalToken" ADD CONSTRAINT "McpApprovalToken_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ApiToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
