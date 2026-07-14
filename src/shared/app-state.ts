import type { LicenseState, Session } from './types'

/**
 * What the app should be showing right now. Decided in MAIN and handed to the renderer.
 *
 * The renderer does NOT derive this from a pile of booleans — that is how you get a screen claiming
 * "activated" while the main process quietly disagrees.
 */
export type AppPhase =
  /** No licence key yet → Activation screen (shows the Machine ID to send the vendor). */
  | 'activation'
  /** Licensed, but nobody owns the shop yet → create the Owner account. */
  | 'first-owner'
  /** Ready, but nobody is signed in → Login. */
  | 'login'
  /** Signed in → the app. */
  | 'ready'

export type AppState = {
  phase: AppPhase
  license: LicenseState
  session: Session | null
  /** Licence has lapsed: everything viewable and exportable, nothing writable. */
  readOnly: boolean
}
