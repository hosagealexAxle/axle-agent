// desktop/main.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");

let backendProc = null;

// Load .env from multiple locations (first found wins):
// 1. Electron userData dir (~/Library/Application Support/Axle/.env) — for packaged app
// 2. Backend dir .env — for dev mode
function loadEnvFile() {
  const locations = [];

  // userData .env (persistent across rebuilds)
  try {
    locations.push(path.join(app.getPath("userData"), ".env"));
  } catch {}

  // Dev: backend/.env
  locations.push(path.join(__dirname, "..", "backend", ".env"));

  // Packaged: resources/backend/.env (unlikely but check)
  if (process.resourcesPath) {
    locations.push(path.join(process.resourcesPath, "backend", ".env"));
  }

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      console.log("Loading .env from:", loc);
      const lines = fs.readFileSync(loc, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
      return loc;
    }
  }
  console.warn("No .env file found in:", locations);
  return null;
}

const BACKEND_PORT = process.env.PORT || "4000";

function resolveDashboardFile() {
  // Packaged: resources/dashboard/dist/index.html (from extraResources)
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, "dashboard", "dist", "index.html");
    if (fs.existsSync(p)) return p;
  }
  // Dev: ../dashboard/dist/index.html
  return path.join(__dirname, "..", "dashboard", "dist", "index.html");
}

function startBackend() {
  if (backendProc) return;

  const runner = path.join(__dirname, "backend-runner.js");

  // Put DB in a writable place (NOT inside app bundle)
  const dbPath = path.join(app.getPath("userData"), "axle.db");
  const DATABASE_URL = `file:${dbPath}`;

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: BACKEND_PORT,
    DATABASE_URL,
    // pass through OpenAI config if present
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENAI_MODEL: process.env.OPENAI_MODEL || "",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "",
  };

  backendProc = spawn(process.execPath, [runner], {
    env,
    stdio: "pipe",
  });

  backendProc.stdout.on("data", (d) => console.log("[backend]", d.toString().trim()));
  backendProc.stderr.on("data", (d) => console.error("[backend]", d.toString().trim()));

  backendProc.on("exit", (code) => {
    console.log(`Backend exited with code ${code}`);
    backendProc = null;
  });
}

function waitForBackend(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Backend did not start in time"));
      }
      const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) return resolve();
        setTimeout(check, 300);
      });
      req.on("error", () => setTimeout(check, 300));
      req.end();
    }
    check();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b1220",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    icon: path.join(__dirname, "assets", "icon_base.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(resolveDashboardFile());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });

  app.whenReady().then(async () => {
    loadEnvFile();
    startBackend();

    // Wait for backend health check before showing UI
    try {
      await waitForBackend();
      console.log("Backend is ready");
    } catch (e) {
      console.warn("Backend health check timed out — loading UI anyway:", e.message);
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {}
  }
  backendProc = null;

  if (process.platform !== "darwin") app.quit();
});
