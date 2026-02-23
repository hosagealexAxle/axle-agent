-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "estimatedCost" REAL,
    "actualCost" REAL,
    "resultJson" TEXT,
    "errorMessage" TEXT,
    "targetId" TEXT,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "scheduledFor" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RoiTracker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "actionType" TEXT NOT NULL,
    "targetId" TEXT,
    "targetTitle" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "beforeVisits" INTEGER,
    "beforeOrders" INTEGER,
    "beforeRevenue" REAL,
    "beforeCvr" REAL,
    "afterVisits" INTEGER,
    "afterOrders" INTEGER,
    "afterRevenue" REAL,
    "afterCvr" REAL,
    "revenueChange" REAL,
    "roiMultiple" REAL,
    "measuredAt" DATETIME,
    "period" TEXT NOT NULL DEFAULT '7d',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AgentTask_status_scheduledFor_idx" ON "AgentTask"("status", "scheduledFor");
