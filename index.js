"use strict";
const node_path = require("node:path");
const electron = require("electron");
const log = require("electron-log/main");
const Database = require("better-sqlite3");
const node_fs = require("node:fs");
const electronUpdater = require("electron-updater");
const IPC = {
  /** Version, platform, where the database lives. */
  systemGetInfo: "system:getInfo",
  /** Proves better-sqlite3 actually loaded and WAL is on — the check that catches trap #8. */
  systemDbSelfCheck: "system:dbSelfCheck",
  /** Manual "check for updates" (Settings). The automatic check is silent. */
  updateCheck: "update:check",
  /** main -> renderer push. Update state changes. */
  updateStatus: "update:status"
};
log.initialize();
log.transports.file.level = "info";
log.transports.console.level = "debug";
log.transports.file.maxSize = 10 * 1024 * 1024;
function openDatabase(filePath) {
  const db2 = new Database(filePath);
  db2.pragma("journal_mode = WAL");
  db2.pragma("foreign_keys = ON");
  db2.pragma("synchronous = FULL");
  db2.pragma("busy_timeout = 5000");
  return db2;
}
function closeDatabase(db2) {
  if (db2.open) db2.close();
}
let db = null;
function getDbPath() {
  return node_path.join(electron.app.getPath("userData"), "pos.db");
}
function initDb() {
  if (db) return db;
  const path = getDbPath();
  db = openDatabase(path);
  log.info(`[db] opened ${path}`);
  return db;
}
function getDb() {
  if (!db) throw new Error("Database used before initDb() — this is a startup-order bug.");
  return db;
}
function shutdownDb() {
  if (!db) return;
  closeDatabase(db);
  db = null;
  log.info("[db] closed cleanly");
}
function ok(data) {
  return { ok: true, data };
}
function err(code, userMessage, technical = "") {
  return { ok: false, error: { code, userMessage, technical } };
}
class AppError extends Error {
  code;
  userMessage;
  constructor(code, userMessage, technical) {
    super(technical ?? userMessage);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
  }
}
const ErrorCode = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",
  LICENSE_INVALID: "LICENSE_INVALID",
  READ_ONLY: "READ_ONLY",
  PERIOD_LOCKED: "PERIOD_LOCKED",
  DB: "DB",
  UNKNOWN: "UNKNOWN"
};
function databaseSelfCheck(db2) {
  const sqliteVersion = db2.prepare("SELECT sqlite_version() AS v").pluck().get();
  const journalMode = db2.pragma("journal_mode", { simple: true });
  const foreignKeys = db2.pragma("foreign_keys", { simple: true }) === 1;
  db2.exec("CREATE TABLE IF NOT EXISTS _selfcheck (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  const marker = `selfcheck-${Date.now()}`;
  db2.prepare("DELETE FROM _selfcheck").run();
  db2.prepare("INSERT INTO _selfcheck (note) VALUES (?)").run(marker);
  const readBack = db2.prepare("SELECT note FROM _selfcheck").pluck().get();
  db2.prepare("DELETE FROM _selfcheck").run();
  return {
    sqliteVersion,
    journalMode,
    foreignKeys,
    roundTripOk: readBack === marker
  };
}
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
let broadcast = () => {
};
let lastStatus = { state: "idle" };
function setStatus(status) {
  lastStatus = status;
  broadcast(status);
}
function resolveFeedOverride() {
  const fromEnv = process.env.POS_UPDATE_FEED_URL?.trim();
  if (fromEnv) return fromEnv;
  const overrideFile = node_path.join(electron.app.getPath("userData"), "update-feed.txt");
  if (node_fs.existsSync(overrideFile)) {
    const url = node_fs.readFileSync(overrideFile, "utf8").trim();
    if (url) return url;
  }
  return null;
}
function initUpdater(send) {
  broadcast = send;
  electronUpdater.autoUpdater.logger = log;
  electronUpdater.autoUpdater.autoDownload = true;
  electronUpdater.autoUpdater.autoInstallOnAppQuit = true;
  const feedOverride = resolveFeedOverride();
  if (feedOverride) {
    log.info(`[updater] using local generic feed override: ${feedOverride}`);
    electronUpdater.autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
    electronUpdater.autoUpdater.forceDevUpdateConfig = !electron.app.isPackaged;
  }
  electronUpdater.autoUpdater.on("checking-for-update", () => setStatus({ state: "checking" }));
  electronUpdater.autoUpdater.on("update-not-available", () => setStatus({ state: "up-to-date" }));
  electronUpdater.autoUpdater.on("update-available", (info) => setStatus({ state: "available", version: info.version }));
  electronUpdater.autoUpdater.on(
    "download-progress",
    (p) => setStatus({ state: "downloading", percent: Math.round(p.percent) })
  );
  electronUpdater.autoUpdater.on("update-downloaded", (info) => {
    log.info(`[updater] ${info.version} downloaded — it will install silently when the app quits`);
    setStatus({ state: "ready", version: info.version });
  });
  electronUpdater.autoUpdater.on("error", (error) => {
    log.info(`[updater] check failed (this is normal offline): ${error.message}`);
    setStatus({ state: "error", technical: error.message });
  });
  void check();
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}
async function check() {
  if (!electron.app.isPackaged && !electronUpdater.autoUpdater.forceDevUpdateConfig) {
    setStatus({ state: "idle" });
    return lastStatus;
  }
  try {
    await electronUpdater.autoUpdater.checkForUpdates();
  } catch (error) {
    log.info(`[updater] check threw (normal offline): ${error.message}`);
    setStatus({ state: "error", technical: error.message });
  }
  return lastStatus;
}
function handle(channel, schema, fn) {
  electron.ipcMain.handle(channel, async (_event, rawInput) => {
    try {
      let input = rawInput;
      if (schema) ;
      return ok(await fn(input));
    } catch (error) {
      if (error instanceof AppError) {
        log.warn(`[ipc] ${channel} -> ${error.code}: ${error.message}`);
        return err(error.code, error.userMessage, error.message);
      }
      const e = error;
      log.error(`[ipc] ${channel} CRASHED: ${e.stack ?? e.message}`);
      return err(
        ErrorCode.UNKNOWN,
        "Something went wrong. Please try again — if it keeps happening, contact support.",
        e.stack ?? e.message
      );
    }
  });
}
function registerIpcHandlers() {
  handle(IPC.systemGetInfo, null, () => ({
    appName: electron.app.getName(),
    appVersion: electron.app.getVersion(),
    platform: process.platform,
    isPackaged: electron.app.isPackaged,
    dbPath: getDbPath(),
    logPath: log.transports.file.getFile().path
  }));
  handle(IPC.systemDbSelfCheck, null, () => databaseSelfCheck(getDb()));
  handle(IPC.updateCheck, null, () => check());
}
let mainWindow = null;
const boot = (m) => {
  try {
    node_fs.appendFileSync("/tmp/pos-boot.log", `${(/* @__PURE__ */ new Date()).toISOString()} ${m}
`);
  } catch {
  }
};
boot("main module loaded (better-sqlite3 required OK)");
const gotLock = electron.app.requestSingleInstanceLock();
boot(`requestSingleInstanceLock -> ${gotLock}`);
if (!gotLock) {
  boot("QUITTING: another instance holds the lock");
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  boot("waiting for app.whenReady()");
  void electron.app.whenReady().then(start).catch((e) => boot(`whenReady/start THREW: ${e.stack ?? e.message}`));
}
function start() {
  boot("app ready — start() running");
  applyContentSecurityPolicy();
  initDb();
  boot("initDb() OK — better-sqlite3 loaded and db opened");
  registerIpcHandlers();
  createWindow();
  initUpdater((status) => {
    mainWindow?.webContents.send(IPC.updateStatus, status);
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    // avoid a white flash — show once the renderer has actually painted
    autoHideMenuBar: true,
    title: "Insha POS",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      // The renderer gets NO Node, NO fs, NO SQLite. Not "for now" — ever. Its only route to the
      // database is the whitelisted contextBridge in src/preload. (CLAUDE.md §3)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (!electron.app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
}
function applyContentSecurityPolicy() {
  if (!electron.app.isPackaged) return;
  electron.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self'",
            "script-src 'self'",
            // Mantine injects styles at runtime, so inline styles must be allowed.
            "style-src 'self' 'unsafe-inline'",
            // data: is for base64-embedded fonts and images in receipts — the ONLY way to have
            // fonts at all in an offline app (trap #13).
            "img-src 'self' data:",
            "font-src 'self' data:",
            "connect-src 'self'"
          ].join("; ")
        ]
      }
    });
  });
}
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", shutdownDb);
process.on("uncaughtException", (error) => {
  log.error(`[main] uncaught: ${error.stack ?? error.message}`);
});
