/**
 * THE IPC CONTRACT. The one place the renderer and the main process agree on.
 *
 * The renderer can ONLY reach main through the channels listed here, exposed through a
 * contextBridge whitelist in src/preload. There is no `require`, no `fs`, and no SQLite in the
 * renderer — not hidden, not "just for now". (CLAUDE.md §3)
 */

export const IPC = {
  /** Version, platform, where the database lives. */
  systemGetInfo: 'system:getInfo',
  /** Proves better-sqlite3 actually loaded and WAL is on — the check that catches trap #8. */
  systemDbSelfCheck: 'system:dbSelfCheck',
  /** Manual "check for updates" (Settings). The automatic check is silent. */
  updateCheck: 'update:check',
  /** main -> renderer push. Update state changes. */
  updateStatus: 'update:status'
} as const

export type SystemInfo = {
  appName: string
  appVersion: string
  platform: string
  isPackaged: boolean
  dbPath: string
  logPath: string
}

export type DbSelfCheck = {
  sqliteVersion: string
  journalMode: string
  foreignKeys: boolean
  /** A real write+read round trip. If this works, the native module is genuinely alive. */
  roundTripOk: boolean
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  /**
   * The cashier is NEVER shown an update error. No internet is the NORMAL case for this app —
   * it is an offline POS. This state exists for the Settings screen and the log file only.
   */
  | { state: 'error'; technical: string }
