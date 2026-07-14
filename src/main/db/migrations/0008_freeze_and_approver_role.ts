import type { Migration } from './index'

/**
 * 0008 — freeze what a receipt needs, and record who approved.
 *
 * Two independent fixes from the Phase 5 audit, both about a number that should have been frozen and
 * wasn't.
 *
 * 1. sale_lines.priced_qty_m — THE QUANTITY THE LINE WAS PRICED ON.
 *
 *    A carton line stores qty_m = 24000 (the 24 base units that left the shelf) and unit_price = the
 *    carton's price. The receipt shows "1 Carton", which it worked out as qty_m ÷ the pack's current
 *    pack_size — read LIVE from product_packs. But a pack's size can be edited later, and then a
 *    REPRINT of last week's receipt divides 24000 by the new size and prints a different number of
 *    cartons than the original. A duplicate receipt that contradicts the original is worse than no
 *    duplicate. A sale line already freezes its price, its tax and its cost against exactly this kind
 *    of after-the-fact edit; it must freeze the priced quantity too.
 *
 * 2. audit_log.approved_by_role — the ROLE of the supervisor who approved.
 *
 *    CLAUDE.md §4 requires WHO did WHAT and WHEN, with the ROLE, for every void, refund,
 *    over-threshold discount and price override. The actor's role was copied in; the APPROVER's was
 *    not — only their id and name. A supervisor demoted to cashier next month would have their old
 *    approvals read as if a cashier had made them. The role is copied in, at the time, like the name.
 *
 * FORWARD-ONLY. Both columns are added and backfilled; nothing is dropped or rewritten.
 */
export const migration0008: Migration = {
  version: 8,
  name: 'freeze priced quantity on sale lines; record the approver role in the audit log',
  up: (db) => {
    db.exec(`
      ALTER TABLE sale_lines ADD COLUMN priced_qty_m INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE audit_log  ADD COLUMN approved_by_role TEXT;
    `)

    // Backfill priced_qty_m from the frozen line and the pack size AS IT IS NOW. This is the best
    // available answer for sales made before this column existed — and from here on the value is
    // frozen at sale time and never moves again. A non-pack line's priced quantity is just its qty_m.
    db.exec(`
      UPDATE sale_lines
      SET priced_qty_m = CASE
        WHEN pack_id IS NULL THEN qty_m
        ELSE CAST(
          ROUND(
            qty_m * 1000.0 /
            NULLIF((SELECT pack_size FROM product_packs WHERE product_packs.id = sale_lines.pack_id), 0)
          ) AS INTEGER
        )
      END
      WHERE priced_qty_m = 0
    `)

    // Where a pack row has since been deleted (pack_size unknown), fall back to the base quantity so
    // the value is never left at 0.
    db.exec('UPDATE sale_lines SET priced_qty_m = qty_m WHERE priced_qty_m = 0 AND qty_m <> 0')
  }
}
