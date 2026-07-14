import type { DB } from '../db'

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
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'shop.name': 'My Shop',
  'shop.country': 'PK',
  'shop.address': '',
  'shop.phone': '',
  'shop.taxNumber': '',

  'currency.code': 'PKR',
  'currency.symbol': 'Rs',
  'currency.name': 'Pakistani Rupee',

  'tax.enabled': true,
  'tax.defaultRateBp': 1700, // 17% GST — basis points, never a float
  'tax.defaultMode': 'exclusive',

  'invoice.prefix': 'INV-',
  'invoice.padding': 6,
  'invoice.includeYear': true,
  'invoice.resetYearly': true,

  'backup.lastRunAt': null,
  'backup.directory': null,
  'backup.promptDaily': true
}
