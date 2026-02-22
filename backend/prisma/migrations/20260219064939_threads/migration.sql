/*
  Warnings:

  - You are about to drop the column `killSwitch` on the `SystemState` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SystemState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "metaJson" JSONB,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SystemState" ("id", "updatedAt") SELECT "id", "updatedAt" FROM "SystemState";
DROP TABLE "SystemState";
ALTER TABLE "new_SystemState" RENAME TO "SystemState";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");
