import type { Migration } from './index'

/**
 * The client shop had barcodes of THREE digits / short words. Default `scanner.minLength` was 4 and
 * silently refused them. The registry default is now 1 (v0.23.0), but an ALREADY-WRITTEN setting of
 * 4 stays 4 forever — Settings never overwrites a saved value. Shops that still hold the old default
 * get the same fix as a fresh install: short barcodes scan at the till.
 *
 * Only the literal old default `4` is changed. A shop that intentionally raised the floor (e.g. to
 * 6) is left alone.
 */
export const migration0021: Migration = {
  version: 21,
  name: 'scanner_min_length_default_1',
  up(db) {
    db.prepare(
      `UPDATE settings
          SET value_json = '1', updated_at = ?
        WHERE key = 'scanner.minLength' AND value_json = '4'`
    ).run(new Date().toISOString())
  }
}
