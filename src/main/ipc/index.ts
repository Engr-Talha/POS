import { ipcMain, app } from 'electron'
import type { ZodType } from 'zod'
import { IPC, type SystemInfo } from '@shared/ipc'
import { ok, err, AppError, ErrorCode, type Result } from '@shared/result'
import { databaseSelfCheck } from '../services/system'
import { getDb, getDbPath } from '../db/instance'
import { check as checkForUpdates } from '../updater'
import log from '../logger'

/**
 * THE IPC LAYER IS THIN. (CLAUDE.md §3)
 *
 * A handler does exactly four things: validate the input, check permission, call a service, wrap the
 * result. There is NO business logic here — that lives in services/, which knows nothing about
 * Electron and can therefore be tested directly and, one day, served over a LAN.
 *
 * Every handler returns a Result envelope. Nothing throws across the IPC boundary, and no stack
 * trace ever reaches the screen.
 */

/**
 * @param schema zod schema for the input. `null` means the channel takes no input — and that is a
 *               deliberate choice per channel, not a way to skip validation. Anything carrying user
 *               input MUST have a schema.
 */
function handle<TIn, TOut>(
  channel: string,
  schema: ZodType<TIn> | null,
  fn: (input: TIn) => TOut | Promise<TOut>
): void {
  ipcMain.handle(channel, async (_event, rawInput: unknown): Promise<Result<TOut>> => {
    try {
      // Also serves as the trap #9 proof: if the renderer is calling IPC, React actually mounted and
      // the window is NOT the silent blank screen that AppShell gave us in the packaged build.
      log.info(`[ipc] ${channel}`)

      let input = rawInput as TIn

      if (schema) {
        const parsed = schema.safeParse(rawInput)
        if (!parsed.success) {
          log.warn(`[ipc] ${channel} rejected bad input: ${parsed.error.message}`)
          return err(
            ErrorCode.VALIDATION,
            'Some of the information entered is not valid. Please check and try again.',
            parsed.error.message
          )
        }
        input = parsed.data
      }

      return ok(await fn(input))
    } catch (error) {
      if (error instanceof AppError) {
        // A deliberate, expected failure. The service already wrote the cashier's message.
        log.warn(`[ipc] ${channel} -> ${error.code}: ${error.message}`)
        return err(error.code, error.userMessage, error.message)
      }

      // Anything else is a BUG. The cashier gets a calm sentence; we get the stack in the log file.
      const e = error as Error
      log.error(`[ipc] ${channel} CRASHED: ${e.stack ?? e.message}`)
      return err(
        ErrorCode.UNKNOWN,
        'Something went wrong. Please try again — if it keeps happening, contact support.',
        e.stack ?? e.message
      )
    }
  })
}

export function registerIpcHandlers(): void {
  handle<void, SystemInfo>(IPC.systemGetInfo, null, () => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    dbPath: getDbPath(),
    logPath: log.transports.file.getFile().path
  }))

  handle(IPC.systemDbSelfCheck, null, () => databaseSelfCheck(getDb()))

  handle(IPC.updateCheck, null, () => checkForUpdates())
}
