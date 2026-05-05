-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "domains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "meetingId" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "autoExtracted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "customerCommitment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceActionItemText" TEXT,
ADD COLUMN     "sourceMeetingId" INTEGER;

-- CreateTable
CREATE TABLE "GoogleCalendarSync" (
    "googleAccountId" INTEGER NOT NULL,
    "eventsSyncToken" TEXT,
    "lastEventsSyncedAt" TIMESTAMP(3),
    "lastArtifactsSyncedAt" TIMESTAMP(3),
    "calendarChannelId" TEXT,
    "calendarChannelExpires" TIMESTAMP(3),
    "driveChannelId" TEXT,
    "driveChannelExpires" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCalendarSync_pkey" PRIMARY KEY ("googleAccountId")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" SERIAL NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "calendarProvider" TEXT NOT NULL DEFAULT 'google',
    "sourceAccountId" INTEGER,
    "conferenceId" TEXT,
    "organizerEmail" TEXT NOT NULL,
    "organizerUserId" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "primaryContactId" INTEGER,
    "primaryDealId" INTEGER,
    "primaryCompanyId" INTEGER,
    "linkStatus" TEXT NOT NULL DEFAULT 'unlinked',
    "linkConfidence" DECIMAL(3,2),
    "linkMethod" TEXT,
    "linkedAt" TIMESTAMP(3),
    "linkedByUserId" INTEGER,
    "recordingUrl" TEXT,
    "recordingDriveId" TEXT,
    "summaryDocUrl" TEXT,
    "summaryDocId" TEXT,
    "summaryExcerpt" TEXT,
    "transcriptDocUrl" TEXT,
    "transcriptDocId" TEXT,
    "briefingDocUrl" TEXT,
    "artifactsProcessedAt" TIMESTAMP(3),
    "artifactsPartial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingAttendee" (
    "id" SERIAL NOT NULL,
    "meetingId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "contactId" INTEGER,
    "userId" INTEGER,
    "responseStatus" TEXT,
    "attended" BOOLEAN,
    "joinTime" TIMESTAMP(3),
    "leaveTime" TIMESTAMP(3),
    "isOrganizer" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MeetingAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingLinkAudit" (
    "id" SERIAL NOT NULL,
    "meetingId" INTEGER NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "chosenContactId" INTEGER,
    "chosenDealId" INTEGER,
    "chosenCompanyId" INTEGER,
    "confidence" DECIMAL(3,2),
    "outcome" TEXT NOT NULL DEFAULT 'accepted',

    CONSTRAINT "MeetingLinkAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_calendarEventId_key" ON "Meeting"("calendarEventId");

-- CreateIndex
CREATE INDEX "Meeting_primaryDealId_scheduledStart_idx" ON "Meeting"("primaryDealId", "scheduledStart");

-- CreateIndex
CREATE INDEX "Meeting_primaryContactId_scheduledStart_idx" ON "Meeting"("primaryContactId", "scheduledStart");

-- CreateIndex
CREATE INDEX "Meeting_primaryCompanyId_scheduledStart_idx" ON "Meeting"("primaryCompanyId", "scheduledStart");

-- CreateIndex
CREATE INDEX "Meeting_organizerUserId_idx" ON "Meeting"("organizerUserId");

-- CreateIndex
CREATE INDEX "Meeting_status_scheduledStart_idx" ON "Meeting"("status", "scheduledStart");

-- CreateIndex
CREATE INDEX "Meeting_linkStatus_idx" ON "Meeting"("linkStatus");

-- CreateIndex
CREATE INDEX "MeetingAttendee_email_idx" ON "MeetingAttendee"("email");

-- CreateIndex
CREATE INDEX "MeetingAttendee_contactId_idx" ON "MeetingAttendee"("contactId");

-- CreateIndex
CREATE INDEX "MeetingAttendee_userId_idx" ON "MeetingAttendee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAttendee_meetingId_email_key" ON "MeetingAttendee"("meetingId", "email");

-- CreateIndex
CREATE INDEX "MeetingLinkAudit_meetingId_attemptedAt_idx" ON "MeetingLinkAudit"("meetingId", "attemptedAt");

-- CreateIndex
CREATE INDEX "Note_meetingId_idx" ON "Note"("meetingId");

-- CreateIndex
CREATE INDEX "Task_sourceMeetingId_idx" ON "Task"("sourceMeetingId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sourceMeetingId_fkey" FOREIGN KEY ("sourceMeetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarSync" ADD CONSTRAINT "GoogleCalendarSync_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "GoogleAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_organizerUserId_fkey" FOREIGN KEY ("organizerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_primaryDealId_fkey" FOREIGN KEY ("primaryDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_primaryCompanyId_fkey" FOREIGN KEY ("primaryCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_linkedByUserId_fkey" FOREIGN KEY ("linkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingLinkAudit" ADD CONSTRAINT "MeetingLinkAudit_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
