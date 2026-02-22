// desktop/backend-runner.js
// Runs backend server using Electron as Node (no system node/npm required)

const path = require("path");

// In dev, backend is at ../backend
// In packaged app, backend will be copied into process.resourcesPath/backend
const backendDir = process.env.AXLE_BACKEND_DIR
  ? process.env.AXLE_BACKEND_DIR
  : (process.resourcesPath
      ? path.join(process.resourcesPath, "backend")
      : path.join(__dirname, "..", "backend"));

process.chdir(backendDir);

// Prefer backend/src/server.js (your current entry)
require(path.join(backendDir, "src", "server.js"));
