-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('CONTACT', 'COMPANY', 'DEAL');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'MONEY', 'DATE', 'EMAIL', 'URL', 'PHONE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT');

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" SERIAL NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "options" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValue" (
    "id" SERIAL NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "valueText" TEXT,
    "valueNumber" DECIMAL(20,4),
    "valueDate" DATE,
    "valueBool" BOOLEAN,
    "valueJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserListPreference" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "prefs" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserListPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_entityType_isActive_order_idx" ON "CustomFieldDefinition"("entityType", "isActive", "order");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_entityType_key_key" ON "CustomFieldDefinition"("entityType", "key");

-- CreateIndex
CREATE INDEX "CustomFieldValue_entityType_entityId_idx" ON "CustomFieldValue"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "CustomFieldValue_definitionId_idx" ON "CustomFieldValue"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldValue_definitionId_entityType_entityId_key" ON "CustomFieldValue"("definitionId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "UserListPreference_userId_idx" ON "UserListPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserListPreference_userId_entityType_key" ON "UserListPreference"("userId", "entityType");

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "CustomFieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserListPreference" ADD CONSTRAINT "UserListPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
