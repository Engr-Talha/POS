import type { Migration } from './index'

/**
 * 0006 — every stock movement carries its own money value, and the ledger and the stock report read
 * THE SAME NUMBER.
 *
 * THE BUG THIS FIXES (found by an adversarial reviewer, reproduced before fixing):
 *
 *   A pharmacy opens with two batches of Panadol, 3 pcs each at Rs 91.0417 (the 4-dp cost the whole
 *   cost scale exists to represent).
 *
 *     GL Inventory      = round(3 x 91.0417) + round(3 x 91.0417) = 273.13 + 273.13 = Rs 546.26
 *     Stock report      = round(6 x 91.0417)                                        = Rs 546.25
 *
 *   One paisa of inventory that exists in the ledger and nowhere on the shelf — and EVERY journal is
 *   internally balanced, so the trial balance stays green and nothing downstream ever notices. It
 *   compounds with every extra batch. This is the exact failure CLAUDE.md warns about by name: "the
 *   ledger and the stock report drift apart silently and the trial balance still balances".
 *
 * WHY IT HAPPENED: sum-of-rounded != round-of-sum. The journal rounded ONCE PER MOVEMENT; the stock
 * report rounded ONCE ON THE TOTAL (on_hand x average). Those two can never be guaranteed equal once
 * a product has two movements at different costs — and patching the opening wizard would only have
 * hidden it until the first purchase at an awkward cost did the same thing.
 *
 * THE FIX: stop computing the value twice. Each movement stores `value_minor` — the money it moved,
 * rounded once, at the moment it happened. The journal posts THAT number. The stock report SUMS
 * THAT number. They are now equal by construction, for any number of movements at any costs, and no
 * future phase can reintroduce the drift by rounding differently.
 *
 * (Same discipline as the sale line freezing its own net/tax/gross: value the thing once, when it
 * happens, and never recompute it from today's numbers.)
 */
export const migration0006: Migration = {
  version: 6,
  name: 'stock movements carry their own money value (GL and stock report can no longer drift)',
  up: (db) => {
    db.exec(`
      ALTER TABLE stock_movements ADD COLUMN value_minor INTEGER NOT NULL DEFAULT 0;
    `)

    // Backfill. Signed: a movement OUT of the shop carries a negative value, so SUM(value_minor) is
    // the inventory value directly.
    //
    // Done in JS, with the SAME helpers the live path uses, rather than in SQL — the conversion is
    // qty_m (thousandths) x cost (ten-thousandths) -> money (minor units), which is two integer
    // roundings across three different scales. Writing that in SQL would mean writing it a second
    // time, and a second implementation is a second chance to get it wrong.
    const rows = db
      .prepare('SELECT id, qty_m, unit_cost FROM stock_movements')
      .all() as Array<{ id: number; qty_m: number; unit_cost: number }>

    const update = db.prepare('UPDATE stock_movements SET value_minor = ? WHERE id = ?')

    for (const row of rows) {
      update.run(movementValueMinor(row.qty_m, row.unit_cost), row.id)
    }
  }
}

/**
 * The money a movement moved, SIGNED, in minor units (2 dp).
 *
 * Duplicated here rather than imported from services/ on purpose: a migration must keep doing exactly
 * what it did on the day it shipped, forever. If it imported a helper and that helper were later
 * improved, this migration would start producing different numbers on a database restored from an
 * old backup — and a forward-only migration that is not deterministic is not a migration, it is a
 * time bomb.
 */
function movementValueMinor(qtyM: number, unitCost: number): number {
  const QTY_SCALE = 1000n
  const COST_PER_MINOR = 100n // 4-dp cost units per 2-dp money unit

  const magnitude = BigInt(Math.abs(qtyM)) * BigInt(Math.abs(unitCost))

  // qty_m x cost -> cost units, rounded half up
  const costUnits = (magnitude * 2n + QTY_SCALE) / (QTY_SCALE * 2n)

  // cost units -> money minor units, rounded half up
  const minor = (costUnits * 2n + COST_PER_MINOR) / (COST_PER_MINOR * 2n)

  const value = Number(minor)
  return qtyM < 0 ? -value : value
}
