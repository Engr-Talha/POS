import type { DB } from '../db'
import { AppError, ErrorCode } from '@shared/result'
import { ALL_DEFAULTS, validateSetting } from '@shared/settings-registry'

/**
 * SETTINGS — key/value JSON, so adding a setting never needs a migration.
 * Namespaced: shop.*, tax.*, receipt.*, printer.*, scanner.*, invoice.*, backup.*
 */

export function get<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(key) as
    | string
    | undefined
  if (row === undefined) return fallback

  try {
    return JSON.parse(row) as T
  } catch {
    return fallback
  }
}

export function set(db: DB, key: string, value: unknown, now = new Date()): void {
  // Validated HERE, in main. The renderer is not a security boundary (CLAUDE.md §4) — a tampered one
  // could otherwise set the tax rate to "banana", or a negative discount threshold that makes every
  // sale need a supervisor.
  const check = validateSetting(key, value)
  if (!check.ok) {
    throw new AppError(ErrorCode.VALIDATION, check.message, `invalid setting ${key} = ${JSON.stringify(value)}`)
  }

  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), now.toISOString())
}

export function getAll(db: DB): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{
    key: string
    value_json: string
  }>

  const result: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value_json)
    } catch {
      result[row.key] = null
    }
  }
  return result
}

/**
 * Defaults. Currency and country are CONFIGURABLE — Pakistan is only the default, not an assumption
 * baked into the code.
 *
 * CHANGING THE CURRENCY CHANGES THE LABEL ONLY. It never converts a stored value: every amount in
 * the database stays exactly the integer it was. The UI must SAY so, loudly, or an owner will
 * switch "PKR" to "USD" and think their prices converted.
 */
/**
 * The defaults, DERIVED from the settings registry (src/shared/settings-registry.ts).
 *
 * This used to be a hand-written object, which meant every new knob had to be added in two places
 * and would eventually be added in only one. The registry is now the single source of truth: declare
 * a setting there and its default, its validation and its field on the Settings screen all follow.
 */
export const DEFAULT_SETTINGS: Record<string, unknown> = ALL_DEFAULTS
