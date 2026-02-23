-- CreateTable
CREATE TABLE "PinterestToken" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "username" TEXT,
    "updatedAt" DATETIME NOT NULL
);
