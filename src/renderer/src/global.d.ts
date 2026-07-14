import type { PosApi } from '@shared/api'

/**
 * `window.pos` is the ONLY route the renderer has to the main process — and therefore the only route
 * it has to the database, the printer, or the filesystem. If it is not on `PosApi`, the renderer
 * cannot do it.
 */
declare global {
  interface Window {
    pos: PosApi
  }
}

export {}
