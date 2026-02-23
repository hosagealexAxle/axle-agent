// desktop/backend-runner.js
// Runs backend server using Electron as Node (ELECTRON_RUN_AS_NODE=1)
// 1. Runs Prisma migrations to ensure DB tables exist
// 2. Starts the backend server via dynamic import (ESM)

const path = require("path");
const { execFileSync } = require("child_process");

const backendDir = process.env.AXLE_BACKEND_DIR
  ? process.env.AXLE_BACKEND_DIR
  : process.resourcesPath
    ? path.join(process.resourcesPath, "backend")
    : path.join(__dirname, "..", "backend");

process.chdir(backendDir);

// Run Prisma migrate deploy using Electron's own Node binary
try {
  const prismaEngine = path.join(backendDir, "node_modules", "prisma", "build", "index.js");
  const schemaPath = path.join(backendDir, "prisma", "schema.prisma");
  console.log("[backend-runner] Running Prisma migrations...");
  execFileSync(process.execPath, [prismaEngine, "migrate", "deploy", `--schema=${schemaPath}`], {
    cwd: backendDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: 30000,
  });
  console.log("[backend-runner] Migrations complete");
} catch (err) {
  console.error("[backend-runner] Migration warning:", err.message);
  // Continue — tables may already exist from a previous run
}

// ESM backend — must use import(), not require()
const serverPath = path.join(backendDir, "src", "server.js");
import(serverPath).catch((err) => {
  console.error("Failed to start Axle backend:", err);
  process.exit(1);
});
