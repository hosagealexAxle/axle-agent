// desktop/main.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

let backendProc = null;

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
    PORT: process.env.PORT || "4000",
    DATABASE_URL,

    // pass through OpenAI config if present
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENAI_MODEL: process.env.OPENAI_MODEL || "",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "",
  };

  backendProc = spawn(process.execPath, [runner], {
    env,
    stdio: "ignore", // change to "inherit" if you want logs in terminal
  });

  backendProc.on("exit", () => {
    backendProc = null;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b1220",
    icon: path.join(__dirname, "assets", "icon.png"),
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
    // If user double-clicks app repeatedly, just focus existing window
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });

  app.whenReady().then(() => {
    startBackend();
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
