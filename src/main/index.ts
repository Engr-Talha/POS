// MUST be first: pins the userData folder name before anything reads it. See app-identity.ts for why
// it is a separate module and not a statement here (the bundler would hoist a bare statement below the
// imports' side effects, defeating it).
import './app-identity'
import { join } from 'node:path'
import { app, shell, BrowserWindow, session } from 'electron'
import { IPC } from '@shared/ipc'
import type { UpdateStatus } from '@shared/ipc'
import log from './logger'
import { initDb, shutdownDb } from './db/instance'
import { registerIpcHandlers } from './ipc'
import { initUpdater } from './updater'

let mainWindow: BrowserWindow | null = null

/**
 * ONE INSTANCE ONLY.
 *
 * Two copies of the app would be two processes writing the same SQLite file. That is the same class
 * of corruption as putting the database on a network drive (trap #20) — just closer to home. A
 * shopkeeper double-clicking the icon twice must not be able to damage his books, so the second
 * launch simply focuses the window that is already open.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app
    .whenReady()
    .then(start)
    .catch((error: Error) => log.error(`[main] startup failed: ${error.stack ?? error.message}`))
}

function start(): void {
  applyContentSecurityPolicy()

  initDb()
  registerIpcHandlers()

  createWindow()

  initUpdater((status: UpdateStatus) => {
    mainWindow?.webContents.send(IPC.updateStatus, status)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false, // avoid a white flash — show once the renderer has actually painted
    autoHideMenuBar: true,
    title: 'Malgary Labs POS',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer gets NO Node, NO fs, NO SQLite. Not "for now" — ever. Its only route to the
      // database is the whitelisted contextBridge in src/preload. (CLAUDE.md §3)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  /**
   * TRAP #9 DETECTOR — the packaged blank screen.
   *
   * Mantine's AppShell rendered a blank window in the packaged build while working perfectly in dev.
   * A blank window is silent: the app "starts", nothing errors, and the shop just sees white.
   *
   * So we make it loud. `did-finish-load` proves the HTML loaded; a `render-process-gone` or a
   * failed load proves it didn't. Combined with the renderer's first IPC call (logged in ipc/), a
   * healthy launch leaves an unmistakable trail in the log — and a blank screen leaves a gap in it.
   */
  mainWindow.webContents.on('did-finish-load', () => {
    log.info('[window] renderer finished loading')
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, description) => {
    log.error(`[window] RENDERER FAILED TO LOAD (${code}): ${description}`)
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error(`[window] RENDERER CRASHED: ${details.reason}`)
  })

  // Any link that wants a new window opens in the real browser instead. The POS is not a web browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // loadFile, not loadURL('data:...') — large inline HTML (embedded fonts) breaks data URLs
    // (trap #11). Everything the renderer needs is on disk.
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Lock the renderer down. This app is OFFLINE: it has no business fetching anything from anywhere,
 * and a POS that can't be talked into loading remote code is one less thing to worry about.
 *
 * Only in the packaged build — Vite's dev server needs eval and a websocket for hot reload.
 */
function applyContentSecurityPolicy(): void {
  if (!app.isPackaged) return

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
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
          ].join('; ')
        ]
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close the database cleanly on the way out. An unclosed handle is how a WAL ends up out of step
// with the .db file — and this file is the shop's money.
app.on('before-quit', shutdownDb)

process.on('uncaughtException', (error) => {
  log.error(`[main] uncaught: ${error.stack ?? error.message}`)
})
