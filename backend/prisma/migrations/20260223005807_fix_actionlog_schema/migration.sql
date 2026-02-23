/*
  Warnings:

  - You are about to drop the column `actionType` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `afterJson` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `beforeJson` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `blockedReason` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `confidence` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `shopId` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `ActionLog` table. All the data in the column will be lost.
  - You are about to drop the column `targetId` on the `ActionLog` table. All the data in the column will be lost.
  - Added the required column `type` to the `ActionLog` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ActionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "amountUsd" REAL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ActionLog" ("createdAt", "id") SELECT "createdAt", "id" FROM "ActionLog";
DROP TABLE "ActionLog";
ALTER TABLE "new_ActionLog" RENAME TO "ActionLog";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
