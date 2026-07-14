import type { Result } from './result'
import type { SystemInfo, DbSelfCheck, UpdateStatus } from './ipc'

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
    /** Subscribe to update status pushed from main. Returns an unsubscribe function. */
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
  }
}
