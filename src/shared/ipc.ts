import { z } from 'zod'

/**
 * THE IPC CONTRACT. The one place the renderer and the main process agree on.
 *
 * The renderer can ONLY reach main through the channels listed here, exposed through a
 * contextBridge whitelist in src/preload. There is no `require`, no `fs`, and no SQLite in the
 * renderer — not hidden, not "just for now". (CLAUDE.md §3)
 */

export const IPC = {
  systemGetInfo: 'system:getInfo',
  systemDbSelfCheck: 'system:dbSelfCheck',
  updateCheck: 'update:check',
  updateStatus: 'update:status',

  appGetState: 'app:getState',

  licenseActivate: 'license:activate',

  authCreateFirstOwner: 'auth:createFirstOwner',
  authSignIn: 'auth:signIn',
  authSignInWithPin: 'auth:signInWithPin',
  authSignOut: 'auth:signOut',

  backupRun: 'backup:run',
  backupChooseFolder: 'backup:chooseFolder',
  backupRestore: 'backup:restore',

  lookupsList: 'lookups:list',
  lookupsAdd: 'lookups:add',
  lookupsUpdate: 'lookups:update',
  lookupsDeactivate: 'lookups:deactivate',

  settingsGetAll: 'settings:getAll',
  settingsSet: 'settings:set',

  ledgerTrialBalance: 'ledger:trialBalance',
  accountsList: 'accounts:list',

  auditList: 'audit:list'
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

// ── Input schemas ────────────────────────────────────────────────────────────
// Every handler that takes user input validates it with one of these, in MAIN, before it reaches a
// service. The renderer is not trusted to have validated anything.

export const ActivateInput = z.object({
  key: z.string().min(1, 'Please paste your licence key.')
})

export const CreateFirstOwnerInput = z.object({
  username: z.string().trim().min(1).max(50),
  fullName: z.string().trim().min(1).max(100),
  password: z.string().min(8, 'Please choose a password of at least 8 characters.')
})

export const SignInInput = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
})

export const PinInput = z.object({
  pin: z.string().trim().min(4).max(12)
})

export const RestoreInput = z.object({
  backupPath: z.string().min(1)
})

export const LookupsListInput = z.object({
  listKey: z.string().min(1),
  includeInactive: z.boolean().optional()
})

export const LookupsAddInput = z.object({
  listKey: z.string().min(1),
  label: z.string().trim().min(1, 'Please enter a name.')
})

export const LookupsUpdateInput = z.object({
  id: z.number().int().positive(),
  // Only the fields the form actually edits. We NEVER post the whole object back — that is how the
  // saved logo and signature got wiped (trap #18). `.nullish()` for anything nullable.
  label: z.string().trim().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional()
})

export const LookupsDeactivateInput = z.object({
  id: z.number().int().positive()
})

export const SettingsSetInput = z.object({
  key: z.string().min(1),
  value: z.unknown()
})

export const AuditListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  action: z.string().optional()
})

export type ActivateInput = z.infer<typeof ActivateInput>
export type CreateFirstOwnerInput = z.infer<typeof CreateFirstOwnerInput>
export type SignInInput = z.infer<typeof SignInInput>
export type PinInput = z.infer<typeof PinInput>
export type RestoreInput = z.infer<typeof RestoreInput>
export type LookupsListInput = z.infer<typeof LookupsListInput>
export type LookupsAddInput = z.infer<typeof LookupsAddInput>
export type LookupsUpdateInput = z.infer<typeof LookupsUpdateInput>
export type LookupsDeactivateInput = z.infer<typeof LookupsDeactivateInput>
export type SettingsSetInput = z.infer<typeof SettingsSetInput>
export type AuditListInput = z.infer<typeof AuditListInput>
