import type { DB } from '../db'
import type { AppPhase, AppState } from '@shared/app-state'
import { needsFirstUser } from './auth'
import { getLicenseState } from './license'
import * as session from '../security/session'

/**
 * What should the app SHOW right now? One question, answered in one place, in main.
 *
 * The renderer asks this on launch and after anything that could change it. It does NOT work the
 * answer out for itself from a pile of booleans — that is how you end up with a screen that says
 * "activated" while the main process disagrees.
 */
export type { AppPhase, AppState }

export function getAppState(
  db: DB,
  machineId: string,
  options: { clockTampered?: boolean } = {}
): AppState {
  const license = getLicenseState(db, machineId, { clockTampered: options.clockTampered })
  const current = session.getCurrent()

  // An expired licence is NOT a lock-out. They still sign in, still look at everything, still run
  // reports, still export, still back up. They just cannot sell until they renew. So an expired
  // licence does NOT send them back to the Activation wall — only a missing or invalid one does.
  const licensed = license.status === 'active' || license.status === 'expired'

  let phase: AppPhase
  if (!licensed) phase = 'activation'
  else if (needsFirstUser(db)) phase = 'first-owner'
  else if (!current) phase = 'login'
  else phase = 'ready'

  return {
    phase,
    license,
    session: current,
    readOnly: license.status !== 'active'
  }
}
