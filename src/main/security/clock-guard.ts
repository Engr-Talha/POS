import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { DB } from '../db'

/**
 * CLOCK-ROLLBACK DETECTION.
 *
 * The obvious way to dodge an expiry date is to set the computer's clock back a year. So we
 * remember the latest time we have ever seen, in TWO places: the database, and a plain file beside
 * it. To beat this you have to find and edit both — which is well past "casual copying", and
 * casual copying is all we are trying to stop (CLAUDE.md §6).
 *
 * TOLERANCE MATTERS. Clocks legitimately move backwards: NTP corrects drift, a dead CMOS battery
 * resets the BIOS, someone fixes a wrong timezone. Punishing a shop with a dead motherboard battery
 * by locking their till would be far worse than letting one thief have a free month. So the
 * tolerance is generous, and a trip means "re-activate", never "your data is gone".
 */

const TOLERANCE_MS = 48 * 60 * 60 * 1000 // 2 days — absorbs NTP jumps and timezone mistakes

export type ClockCheck = { ok: true } | { ok: false; lastSeen: string; now: string }

export function checkAndRecordClock(db: DB, mirrorFilePath: string, now = new Date()): ClockCheck {
  const fromDb = db.prepare('SELECT last_seen_at FROM clock_guard WHERE id = 1').pluck().get() as
    | string
    | undefined

  let fromFile: string | undefined
  try {
    if (existsSync(mirrorFilePath)) fromFile = readFileSync(mirrorFilePath, 'utf8').trim()
  } catch {
    // A missing or unreadable mirror is not evidence of tampering — the file may simply not exist
    // yet on first run. We just fall back to the database's word.
  }

  // Trust the LATEST of the two. Deleting one of them must not roll the guard back.
  const candidates = [fromDb, fromFile].filter((value): value is string => Boolean(value))
  const lastSeen = candidates.sort().at(-1)

  const nowIso = now.toISOString()
  let result: ClockCheck = { ok: true }

  if (lastSeen && now.getTime() < new Date(lastSeen).getTime() - TOLERANCE_MS) {
    result = { ok: false, lastSeen, now: nowIso }
  }

  // Only ever move the watermark FORWARD. If the clock is currently wound back, recording "now"
  // would help the attacker by lowering the bar they have to clear.
  const watermark = !lastSeen || nowIso > lastSeen ? nowIso : lastSeen

  db.prepare(
    `INSERT INTO clock_guard (id, last_seen_at) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(watermark)

  try {
    writeFileSync(mirrorFilePath, watermark, 'utf8')
  } catch {
    // If we cannot write the mirror we still have the DB copy. Do not crash the shop's till over it.
  }

  return result
}
