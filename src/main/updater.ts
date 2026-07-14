import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from './logger'
import type { UpdateStatus } from '@shared/ipc'

/**
 * AUTO-UPDATE. (TRAP #1 — the single most important thing in this file.)
 *
 * Auto-update is performed by the ALREADY-INSTALLED app. An app shipped without an updater can
 * never update itself — every user would have to be walked through a manual re-install, forever.
 * There is no retrofit. So the updater ships in v0.1.0, BEFORE there is anything to update to.
 *
 * Publishing is deferred (docs/PLAN.md §3). Right now this checks, finds nothing, and goes quiet.
 * That is the intended behaviour, not a bug.
 *
 * SILENCE IS A FEATURE. This is an OFFLINE POS. "No internet" is the NORMAL state, not an error.
 * A cashier with a customer waiting must NEVER see an update dialog, an error toast, or a
 * "restart now?" prompt. Updates download in the background and install on quit — so the shop gets
 * the new version when it opens tomorrow, never in the middle of a sale.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6 hours, while the shop is open

let broadcast: (status: UpdateStatus) => void = () => {}
let lastStatus: UpdateStatus = { state: 'idle' }

function setStatus(status: UpdateStatus): void {
  lastStatus = status
  broadcast(status)
}

export function getUpdateStatus(): UpdateStatus {
  return lastStatus
}

/**
 * Local proof-of-updater override (docs/PLAN.md §3).
 *
 * Before GitHub publishing exists, we prove the whole update path end-to-end against a plain local
 * HTTP folder using electron-updater's `generic` provider: install v0.1.0, serve v0.1.1, watch the
 * installed app update itself with zero clicks. If that works, GitHub is just a different URL.
 *
 * Drop a file called `update-feed.txt` in userData containing a URL, or set POS_UPDATE_FEED_URL.
 * Absent both, the app uses the real feed baked in by electron-builder.
 */
function resolveFeedOverride(): string | null {
  const fromEnv = process.env.POS_UPDATE_FEED_URL?.trim()
  if (fromEnv) return fromEnv

  const overrideFile = join(app.getPath('userData'), 'update-feed.txt')
  if (existsSync(overrideFile)) {
    const url = readFileSync(overrideFile, 'utf8').trim()
    if (url) return url
  }

  return null
}

/**
 * A failed update check dumps the entire HTTP response — headers, cookies, the lot — which is ~60
 * lines. This app checks every 6 hours and runs for YEARS on a shop counter, usually offline. Left
 * alone, the log fills with noise and the one line that matters when something really breaks is
 * impossible to find. So a failure is one line.
 */
function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() ?? message
}

export function initUpdater(send: (status: UpdateStatus) => void): void {
  broadcast = send

  // electron-updater logs its own errors at full volume. Downgrade them to a single info line —
  // "cannot reach the update server" is NOT an error for an offline POS, it is Tuesday.
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`[updater] ${firstLine(String(m))}`),
    warn: (m: unknown) => log.info(`[updater] ${firstLine(String(m))}`),
    error: (m: unknown) => log.info(`[updater] ${firstLine(String(m))}`),
    debug: () => {}
  }

  autoUpdater.autoDownload = true

  // Install on quit — NOT mid-session. A POS must never restart itself while a cart is open.
  // With NSIS oneClick + perMachine:false, that install is completely silent: no wizard, no clicks,
  // no admin prompt. The shop just opens tomorrow on the new version. (Trap #5)
  autoUpdater.autoInstallOnAppQuit = true

  const feedOverride = resolveFeedOverride()
  if (feedOverride) {
    log.info(`[updater] using local generic feed override: ${feedOverride}`)
    autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride })
    // Lets us exercise the updater from an unpackaged dev run too.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
  }

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'up-to-date' }))
  autoUpdater.on('update-available', (info) => setStatus({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) =>
    setStatus({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] ${info.version} downloaded — it will install silently when the app quits`)
    setStatus({ state: 'ready', version: info.version })
  })

  autoUpdater.on('error', (error) => {
    // Log it and move on. This NEVER becomes a dialog — the cashier must not care that we tried.
    //
    // Do NOT claim this is "offline". It usually is (offline is the normal state of an offline POS),
    // but this same event fires for a bad signature, a corrupt download, or a missing release, and a
    // log that misreports the cause is worse than no log at all — it sends the next person hunting
    // for a network problem that was never there.
    log.info(`[updater] update not applied: ${firstLine(error.message)}`)
    setStatus({ state: 'error', technical: firstLine(error.message) })
  })

  void check()
  setInterval(() => void check(), CHECK_INTERVAL_MS)
}

/** Safe to call any time — from the periodic timer or from a Settings button. Never throws. */
export async function check(): Promise<UpdateStatus> {
  if (!app.isPackaged && !autoUpdater.forceDevUpdateConfig) {
    // In dev there is no installed app to update. Not an error, just nothing to do.
    setStatus({ state: 'idle' })
    return lastStatus
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // The 'error' event above has already logged this and set the status. Swallow the rejection so
    // it cannot become an unhandled promise rejection — and do NOT log it a second time.
  }

  return lastStatus
}
