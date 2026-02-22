-- CreateTable
CREATE TABLE "ShopSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "visits" INTEGER,
    "orders" INTEGER,
    "revenueUsd" REAL,
    "conversionRate" REAL,
    "trafficEtsyApp" INTEGER,
    "trafficDirect" INTEGER,
    "trafficSeo" INTEGER,
    "trafficSearch" INTEGER,
    "trafficSocial" INTEGER,
    "adsStatus" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ListingMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "title" TEXT,
    "priceUsd" REAL,
    "visits" INTEGER,
    "orders" INTEGER,
    "revenueUsd" REAL,
    "conversionRate" REAL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ActionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "confidence" REAL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "blockedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BudgetLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "amountUsd" REAL NOT NULL,
    "description" TEXT,
    "metaJson" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SystemState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
