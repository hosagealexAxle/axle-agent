-- CreateTable
CREATE TABLE "EtsyToken" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "etsyUserId" TEXT,
    "shopId" TEXT,
    "updatedAt" DATETIME NOT NULL
);
