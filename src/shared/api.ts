import type { Result } from './result'
import type {
  SystemInfo,
  DbSelfCheck,
  UpdateStatus,
  ActivateInput,
  CreateFirstOwnerInput,
  SignInInput,
  PinInput,
  RestoreInput,
  LookupsListInput,
  LookupsAddInput,
  AuditListInput
} from './ipc'
import type { AuditEntry, BackupResult, Lookup } from './types'
import type { AppState } from './app-state'

/**
 * The shape of `window.pos` — the ENTIRE surface the renderer has.
 *
 * It lives in `shared/` rather than in preload so the renderer can be typed against it without
 * dragging Electron's Node-flavoured types into the browser build. The preload declares
 * `const api: PosApi`, so if a method here has no implementation, the build fails.
 *
 * Every capability is listed explicitly. There is deliberately NO generic `invoke(channel, args)`
 * escape hatch — that would hand the renderer the whole IPC surface and make the whitelist a
 * decoration. (CLAUDE.md §3)
 */
export interface PosApi {
  system: {
    getInfo: () => Promise<Result<SystemInfo>>
    dbSelfCheck: () => Promise<Result<DbSelfCheck>>
  }

  updates: {
    check: () => Promise<Result<UpdateStatus>>
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
  }

  /** What screen should we be on? Answered by MAIN, never worked out in the renderer. */
  app: {
    getState: () => Promise<Result<AppState>>
  }

  license: {
    activate: (input: ActivateInput) => Promise<Result<AppState>>
  }

  auth: {
    createFirstOwner: (input: CreateFirstOwnerInput) => Promise<Result<AppState>>
    signIn: (input: SignInInput) => Promise<Result<AppState>>
    signInWithPin: (input: PinInput) => Promise<Result<AppState>>
    signOut: () => Promise<Result<AppState>>
  }

  backup: {
    /** Always allowed — even on an expired licence. Their data is never held hostage. */
    run: () => Promise<Result<BackupResult>>
    chooseFolder: () => Promise<Result<string | null>>
    restore: (input: RestoreInput) => Promise<Result<{ restoredFrom: string; safetyCopy: string }>>
  }

  lookups: {
    list: (input: LookupsListInput) => Promise<Result<Lookup[]>>
    add: (input: LookupsAddInput) => Promise<Result<Lookup>>
  }

  audit: {
    list: (
      input: AuditListInput
    ) => Promise<Result<{ rows: AuditEntry[]; total: number; page: number; pageSize: number }>>
  }
}
