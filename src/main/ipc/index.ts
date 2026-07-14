import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import type { ZodType } from 'zod'
import {
  IPC,
  ActivateInput,
  CreateFirstOwnerInput,
  SignInInput,
  PinInput,
  RestoreInput,
  LookupsListInput,
  LookupsAddInput,
  AuditListInput,
  type SystemInfo
} from '@shared/ipc'
import { ok, err, AppError, ErrorCode, type Result } from '@shared/result'
import type { AppState } from '../services/app-state'
import { getAppState } from '../services/app-state'
import { databaseSelfCheck } from '../services/system'
import { getDb, getDbPath, isClockTampered } from '../db/instance'
import { check as checkForUpdates } from '../updater'
import { getMachineId } from '../security/machine-id'
import * as session from '../security/session'
import * as auth from '../services/auth'
import * as licenseService from '../services/license'
import * as backupService from '../services/backup'
import * as lookupsService from '../services/lookups'
import * as auditService from '../services/audit'
import * as settingsService from '../services/settings'
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

function state(): AppState {
  return getAppState(getDb(), getMachineId(), { clockTampered: isClockTampered() })
}

/**
 * Guard for anything that CHANGES data.
 *
 * Reads, reports, exports and BACKUPS never call this — an expired shop must always be able to get
 * its own numbers out. We do not hold their data hostage (CLAUDE.md §6).
 */
function assertWritable(): void {
  licenseService.assertCanWrite(state().license)
}

function handle<TIn, TOut>(
  channel: string,
  schema: ZodType<TIn> | null,
  fn: (input: TIn) => TOut | Promise<TOut>
): void {
  ipcMain.handle(channel, async (_event, rawInput: unknown): Promise<Result<TOut>> => {
    try {
      log.info(`[ipc] ${channel}`)

      let input = rawInput as TIn
      if (schema) {
        const parsed = schema.safeParse(rawInput)
        if (!parsed.success) {
          const first = parsed.error.issues[0]?.message
          log.warn(`[ipc] ${channel} rejected bad input: ${parsed.error.message}`)
          return err(
            ErrorCode.VALIDATION,
            first ?? 'Some of the information entered is not valid. Please check and try again.',
            parsed.error.message
          )
        }
        input = parsed.data
      }

      return ok(await fn(input))
    } catch (error) {
      if (error instanceof AppError) {
        log.warn(`[ipc] ${channel} -> ${error.code}: ${error.message}`)
        return err(error.code, error.userMessage, error.message)
      }

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
  // ── System ────────────────────────────────────────────────────────────────
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

  // ── App state — what screen should we be on? ───────────────────────────────
  handle(IPC.appGetState, null, () => state())

  // ── Licence ───────────────────────────────────────────────────────────────
  handle(IPC.licenseActivate, ActivateInput, (input) => {
    licenseService.activate(getDb(), input.key, getMachineId())
    return state()
  })

  // ── Auth ──────────────────────────────────────────────────────────────────
  handle(IPC.authCreateFirstOwner, CreateFirstOwnerInput, (input) => {
    const owner = auth.createFirstOwner(getDb(), input)
    session.signIn(owner) // straight in — no point making them log in to the account they just made
    return state()
  })

  handle(IPC.authSignIn, SignInInput, (input) => {
    const user = auth.signIn(getDb(), input.username, input.password)
    session.signIn(user)
    return state()
  })

  handle(IPC.authSignInWithPin, PinInput, (input) => {
    const user = auth.signInWithPin(getDb(), input.pin)
    session.signIn(user)
    return state()
  })

  handle(IPC.authSignOut, null, () => {
    session.signOut()
    return state()
  })

  // ── Backup ────────────────────────────────────────────────────────────────
  // NOTE: no assertWritable() here, deliberately. Backing up is ALWAYS allowed, even on an expired
  // licence. A business that cannot get its own books out is a business we have taken hostage.
  handle(IPC.backupChooseFolder, null, async () => {
    session.requirePermissionOf('backup.run')
    const window = BrowserWindow.getFocusedWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Choose where to save backups',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Save backups here'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled || !result.filePaths[0]) return null
    settingsService.set(getDb(), 'backup.directory', result.filePaths[0])
    return result.filePaths[0]
  })

  handle(IPC.backupRun, null, async () => {
    const user = session.requirePermissionOf('backup.run')
    const db = getDb()

    const directory =
      settingsService.get<string | null>(db, 'backup.directory', null) ??
      app.getPath('documents')

    const result = await backupService.backupTo(db, directory)

    settingsService.set(db, 'backup.lastRunAt', result.at)
    auditService.record(db, user, { action: 'backup.run', entity: 'backup', entityId: result.path })

    return result
  })

  handle(IPC.backupRestore, RestoreInput, (input) => {
    // Owner only. Restore OVERWRITES the shop's live data — it is the most dangerous button here.
    const user = session.requirePermissionOf('backup.restore')

    const outcome = backupService.restoreFrom(getDbPath(), input.backupPath)
    auditService.record(getDb(), user, {
      action: 'backup.restore',
      entity: 'backup',
      entityId: input.backupPath,
      after: { safetyCopy: outcome.safetyCopy }
    })

    // The database file underneath us has just been swapped. Restarting is the only honest way to
    // pick it up — every open statement and cached page is now stale.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 500)

    return outcome
  })

  // ── Lookups — every dropdown in the app ───────────────────────────────────
  handle(IPC.lookupsList, LookupsListInput, (input) =>
    lookupsService.list(
      getDb(),
      input.listKey as lookupsService.LookupList,
      input.includeInactive ?? false
    )
  )

  handle(IPC.lookupsAdd, LookupsAddInput, (input) => {
    const user = session.requirePermissionOf('lookups.manage')
    assertWritable()

    const added = lookupsService.add(getDb(), {
      listKey: input.listKey as lookupsService.LookupList,
      label: input.label
    })

    auditService.record(getDb(), user, {
      action: 'lookup.add',
      entity: 'lookup',
      entityId: added.id,
      after: added
    })

    return added
  })

  // ── Audit log ─────────────────────────────────────────────────────────────
  handle(IPC.auditList, AuditListInput, (input) => {
    session.requirePermissionOf('audit.view')
    return auditService.list(getDb(), input)
  })
}
