/*
  Warnings:

  - The primary key for the `_DealTags` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[A,B]` on the table `_DealTags` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "_DealTags" DROP CONSTRAINT "_DealTags_AB_pkey";

-- CreateIndex
CREATE UNIQUE INDEX "_DealTags_AB_unique" ON "_DealTags"("A", "B");
