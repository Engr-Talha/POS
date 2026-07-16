import type { Migration } from './index'

/**
 * 0016 — RETURNS TO SUPPLIER. Goods going BACK to where they came from, and the money that follows.
 *
 * The mirror of a customer return (0011), pointing the other way. A customer return takes stock IN and
 * pays money OUT; a supplier return sends stock BACK OUT and either lowers what the shop OWES or brings a
 * refund IN. Damaged stock, wrong delivery, expired goods the distributor takes back — all of it.
 *
 * ── EVERYTHING IT REVERSES IS FROZEN, NOT RECOMPUTED ────────────────────────────────────────────────
 * A line copies the ORIGINAL purchase line's frozen `unit_cost` (4-dp) and sends the goods back at the
 * cost they came in at — never today's re-averaged cost. Buy at Rs 60, buy again at Rs 80 (average Rs 70),
 * return one of the FIRST tins: Inventory must fall by Rs 60, not Rs 70, or the books and the shelf part
 * company. Same discipline as sale_lines and migration 0006.
 *
 * ── THE JOURNAL (the service posts it; it balances as algebra) ───────────────────────────────────────
 *       CR Inventory (ACC.INVENTORY)   = Σ line_total     the goods leave, at their frozen cost
 *       DR <settlement>                = grand_total
 *   where the settlement is one of:
 *       'supplier_credit'  DR Supplier Payables (ACC.PAYABLE)  — the common case: it comes off the bill
 *       'refund'           DR Cash / Bank (the tender they paid us back through)
 *   Input tax: if the original purchase reclaimed input tax, returning the goods gives it back —
 *       CR Input Tax (ACC.INPUT_TAX) = the tax portion returned. The service computes it pro-rata from
 *       the purchase's own frozen tax_total and omits the leg when there was none.
 *
 * ── WHAT MAY GO BACK ────────────────────────────────────────────────────────────────────────────────
 * Never more than was received, summed across ALL returns against that purchase line (the service proves
 * it; the index below is that query). qty_m > 0 — a return sends something back; it is never negative.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Two new tables. The `purchase_return` stock-movement type has existed since 0003, waiting for exactly
 * this. Nothing is dropped or rewritten.
 */
export const migration0016: Migration = {
  version: 16,
  name: 'returns to supplier: purchase_returns, purchase_return_lines',
  up: (db) => {
    db.exec(`
      -- ── Returns to supplier ───────────────────────────────────────────────────
      CREATE TABLE purchase_returns (
        id                      INTEGER PRIMARY KEY,

        -- The purchase the goods arrived on. Its supplier is the supplier — a return cannot be
        -- re-pointed at a different one, or the payable would move to a party that never sold it.
        purchase_id             INTEGER NOT NULL REFERENCES purchases (id),

        at                      TEXT    NOT NULL,                        -- when the goods went back
        user_id                 INTEGER NOT NULL REFERENCES users (id),  -- who sent them

        -- WHY, from lookups('purchase_return_reason') — never a hardcoded list (CLAUDE.md §4). Stored as
        -- the code; the service validates it against the live lookup, exactly as a void/refund does.
        reason_code             TEXT    NOT NULL,
        reason_text             TEXT,

        -- HOW it is settled. 'supplier_credit' takes it off what the shop owes (DR Payables) — the common
        -- case. 'refund' means they paid it back through a tender (DR Cash/Bank). The CHECK binds the
        -- companion column so a half-described settlement cannot be written.
        settlement              TEXT    NOT NULL
                                  CHECK (settlement IN ('supplier_credit', 'refund')),
        -- The tender a 'refund' came back through: lookups('payment_method'). NULL for supplier_credit.
        refund_method_lookup_id INTEGER REFERENCES lookups (id),

        -- FROZEN totals (2-dp money). subtotal_net = Σ line_total (goods at their frozen cost);
        -- tax_total = the input tax handed back; grand_total = what the settlement is worth.
        subtotal_net            INTEGER NOT NULL CHECK (subtotal_net >= 0),
        tax_total               INTEGER NOT NULL CHECK (tax_total    >= 0),
        grand_total             INTEGER NOT NULL CHECK (grand_total  >= 0),

        notes                   TEXT,
        -- The balanced journal this return posted. NULLABLE only so the row and its journal write in one
        -- transaction; a committed return always has one.
        journal_id              INTEGER REFERENCES journals (id),
        created_at              TEXT    NOT NULL,

        CHECK (grand_total = subtotal_net + tax_total),
        CHECK (
          (settlement = 'supplier_credit' AND refund_method_lookup_id IS NULL)
          OR
          (settlement = 'refund'          AND refund_method_lookup_id IS NOT NULL)
        )
      );
      CREATE INDEX idx_purchase_returns_purchase ON purchase_returns (purchase_id);
      CREATE INDEX idx_purchase_returns_at       ON purchase_returns (at DESC);

      -- ── Return lines — WHAT went back, at the cost it came in at ──────────────
      CREATE TABLE purchase_return_lines (
        id                INTEGER PRIMARY KEY,
        -- CASCADE: a return document is atomic; its lines never outlive it.
        purchase_return_id INTEGER NOT NULL REFERENCES purchase_returns (id) ON DELETE CASCADE,
        -- The exact purchase line these units came in on. This is what "how much of this line has already
        -- gone back?" sums over, so the shop can never return more than the distributor delivered.
        purchase_line_id  INTEGER NOT NULL REFERENCES purchase_lines (id),

        product_id        INTEGER NOT NULL REFERENCES products (id),
        name_snapshot     TEXT    NOT NULL,                    -- FROZEN name, so an old return reads true

        qty_m             INTEGER NOT NULL CHECK (qty_m > 0),  -- 3-dp base units going back
        uom               TEXT,
        -- 4-dp COST — a DIFFERENT SCALE from the money columns. The purchase line's frozen landed cost:
        -- the goods leave at what they came in at, never at today's weighted average.
        unit_cost         INTEGER NOT NULL CHECK (unit_cost >= 0),
        -- 2-dp money = the frozen value of the 'purchase_return' stock movement this line created.
        -- CR Inventory sums THESE, never a fresh qty x cost (sum-of-rounded is not round-of-sum).
        line_total        INTEGER NOT NULL CHECK (line_total >= 0),
        -- The batch the goods went back out of — the same one they were received into, so FEFO and
        -- expiry stay honest. NULL when the product is not batch-tracked.
        batch_id          INTEGER REFERENCES batches (id),

        created_at        TEXT    NOT NULL
      );
      CREATE INDEX idx_purchase_return_lines_return  ON purchase_return_lines (purchase_return_id);
      -- THE hot query: "how much of this purchase line has already gone back?" — SUM(qty_m) over it.
      CREATE INDEX idx_purchase_return_lines_line    ON purchase_return_lines (purchase_line_id);
      CREATE INDEX idx_purchase_return_lines_product ON purchase_return_lines (product_id);
    `)
  }
}
