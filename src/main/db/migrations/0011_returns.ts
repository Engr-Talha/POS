import type { Migration } from './index'

/**
 * 0011 — RETURNS & REFUNDS. Goods coming BACK, and the money that goes back with them.
 *
 * A VOID (0007) cancels a whole sale that should never have happened — same day, full reversal, the
 * invoice keeps its number and is marked cancelled. A RETURN is the other thing entirely: the sale was
 * real, the customer keeps most of it, and brings SOME of it back later. It is its own document, it can
 * be partial, it can happen many times against one sale, and it settles money either as a refund or as
 * a reduction of what the customer still owes (udhaar). The original sale is never touched.
 *
 * ── EVERYTHING A RETURN REVERSES IS FROZEN, NOT RECOMPUTED ───────────────────────────────────────────
 *
 * A return_line copies the sale line's frozen `net`, `tax_amount`, `gross` (scaled to the quantity
 * coming back) and its 4-dp `unit_cost`. It NEVER re-reads today's price, today's tax rate, or today's
 * weighted-average cost. Return three tins in August that were sold in March and the refund is what was
 * charged in March, and the stock comes back onto the shelf at what it cost in March — so the ledger's
 * Inventory and the stock report move by the SAME paisa (the migration-0006 invariant, now extended to
 * returns). Recomputing any of it from today's settings is how a refund becomes fiction. (CLAUDE.md §4.)
 *
 * ── THE ARITHMETIC IS A PROPERTY OF THE DATABASE, NOT A HABIT OF THE SERVICE ─────────────────────────
 *
 *   - `CHECK (gross = net + tax_amount)` on the line — the same receipt-adds-up rule as sale_lines.
 *   - `CHECK (grand_total = subtotal_net + tax_total)` on the header.
 *   - `qty_m > 0` — a return line gives something back; it is never negative or zero. How MUCH may come
 *     back (never more than was sold, less anything already returned) is the SERVICE's job, proven by a
 *     test, because it needs to sum prior returns — but the shape is fixed here.
 *   - `settlement` is a three-way CHECK, and the columns that must accompany each are CHECKed with it,
 *     so a row can never say "refunded" while naming no tender, or "exchange" while naming no group.
 *
 * ── SETTLEMENT: WHERE THE MONEY GOES ────────────────────────────────────────────────────────────────
 *
 *   'refund'          — money OUT, through one tender from lookups('payment_method'). The journal
 *                       credits Cash / Bank for `grand_total`. `refund_method_lookup_id` is required.
 *   'customer_credit' — the sale was on udhaar and is being reduced instead of paid out. The journal
 *                       credits Accounts Receivable. Only valid when the sale had a customer.
 *   'exchange'        — the return's value is consumed by a REPLACEMENT sale that carries the same
 *                       `exchange_group_id` (sales.exchange_group_id, 0007). Neither cash nor udhaar
 *                       moves here; the paired sale settles the difference either way.
 *
 * ── THE JOURNAL (the service posts it in the same transaction; it balances as algebra) ───────────────
 *
 *       DR Sales Returns (ACC.SALES_RETURNS, contra-income)   = Σ return_lines.net
 *       DR Output Tax    (ACC.OUTPUT_TAX)                      = Σ return_lines.tax_amount
 *       CR Cash / Bank / Receivable                            = grand_total (= net + tax)
 *   and, for every line that goes back on the shelf (restocked = 1):
 *       DR Inventory     (ACC.INVENTORY)                       = Σ frozen stock-movement value
 *       CR COGS          (ACC.COGS)                            = the same
 *   A DAMAGED return (restocked = 0) posts no stock movement and no inventory/COGS leg: the goods are
 *   gone, the shop still refunds, and it eats the cost — which is the truth of a broken item.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Two new tables. `sales.exchange_group_id` already exists (0007), waiting for exactly this. Nothing is
 * dropped, renamed or rewritten.
 */
export const migration0011: Migration = {
  version: 11,
  name: 'returns & refunds: returns, return_lines (partial, restock/damage, refund/credit/exchange)',
  up: (db) => {
    db.exec(`
      -- ── Returns ───────────────────────────────────────────────────────────────
      -- One row per return document, against one completed sale. A sale may have many.
      CREATE TABLE returns (
        id                      INTEGER PRIMARY KEY,

        -- The original sale the goods came from. Only a 'completed' sale can be returned (enforced in
        -- the service): you cannot return a held cart, a quote, or an already-voided invoice.
        sale_id                 INTEGER NOT NULL REFERENCES sales (id),

        at                      TEXT    NOT NULL,                    -- when the goods came back
        user_id                 INTEGER NOT NULL REFERENCES users (id),  -- who processed it

        -- WHO authorised it. A return/refund is a Supervisor action (rbac: sale.refund). If the person
        -- at the till is a Supervisor or above they authorise their own; otherwise a supervisor's PIN
        -- is entered and resolves to a real user IN MAIN (auth.verifyPin) — never an id the renderer
        -- claims. The role is snapshotted alongside, exactly as the audit log does, so the record still
        -- reads true after the person is promoted or retired.
        approved_by             INTEGER NOT NULL REFERENCES users (id),
        approved_by_role        TEXT    NOT NULL,

        -- WHY, from lookups('refund_reason') — never a hardcoded list (CLAUDE.md §4). Stored as the
        -- code string (the service validates it against the lookup), the same way a void stores its
        -- reason code. Free text is optional colour on top.
        reason_code             TEXT    NOT NULL,
        reason_text             TEXT,

        -- HOW the money is settled. See the header. The CHECK at the bottom binds the companion columns
        -- to each value so a half-described settlement cannot be written.
        settlement              TEXT    NOT NULL
                                  CHECK (settlement IN ('refund', 'customer_credit', 'exchange')),
        -- The tender a 'refund' was paid through: lookups('payment_method'). NULL for the other two.
        refund_method_lookup_id INTEGER REFERENCES lookups (id),
        -- The replacement sale's correlation id for an 'exchange'. NULL for the other two.
        exchange_group_id       INTEGER,

        -- The returned totals, FROZEN (2-dp money). grand_total is the amount settled.
        subtotal_net            INTEGER NOT NULL CHECK (subtotal_net >= 0),
        tax_total               INTEGER NOT NULL CHECK (tax_total    >= 0),
        grand_total             INTEGER NOT NULL CHECK (grand_total  >= 0),

        -- The balanced journal this return posted (DR Sales Returns / Output Tax, CR Cash/Bank/Recv,
        -- and the Inventory/COGS leg for restocked lines). NULLABLE only so the row and its journal can
        -- be written in one transaction; a committed return always has one.
        journal_id              INTEGER REFERENCES journals (id),

        notes                   TEXT,
        created_at              TEXT    NOT NULL,

        CHECK (grand_total = subtotal_net + tax_total),

        -- Each settlement names exactly what it needs, and nothing it does not.
        CHECK (
          (settlement = 'refund'
             AND refund_method_lookup_id IS NOT NULL
             AND exchange_group_id IS NULL)
          OR
          (settlement = 'customer_credit'
             AND refund_method_lookup_id IS NULL
             AND exchange_group_id IS NULL)
          OR
          (settlement = 'exchange'
             AND refund_method_lookup_id IS NULL
             AND exchange_group_id IS NOT NULL)
        )
      );

      -- Assume years of trading (CLAUDE.md §2). Every list this feeds gets an index: a sale's returns,
      -- the day's returns for the leakage report, and the exchange lookup that pairs the two documents.
      CREATE INDEX idx_returns_sale     ON returns (sale_id);
      CREATE INDEX idx_returns_at       ON returns (at DESC);
      CREATE INDEX idx_returns_exchange ON returns (exchange_group_id) WHERE exchange_group_id IS NOT NULL;

      -- ── Return lines ──────────────────────────────────────────────────────────
      -- WHAT came back, and the frozen money it reverses. Mirrors sale_lines, one scale at a time.
      CREATE TABLE return_lines (
        id             INTEGER PRIMARY KEY,
        -- CASCADE: a return document is atomic; its lines never outlive it.
        return_id      INTEGER NOT NULL REFERENCES returns (id) ON DELETE CASCADE,
        -- The exact sale line these units came off. This is what "how much of this line has already
        -- come back?" sums over, so a customer can never return more than they bought.
        sale_line_id   INTEGER NOT NULL REFERENCES sale_lines (id),

        product_id     INTEGER REFERENCES products (id),   -- NULL = an open / miscellaneous item
        name_snapshot  TEXT    NOT NULL,                   -- FROZEN name, so an old return still reads true

        -- 3-dp qty in the product's BASE unit, POSITIVE. Never more than remains un-returned on the
        -- sale line — the service proves it; the CHECK keeps the sign honest.
        qty_m          INTEGER NOT NULL CHECK (qty_m > 0),
        uom            TEXT,

        -- THE FROZEN MONEY (2-dp), scaled to qty_m from the sale line, with the cart-level discount
        -- unwound so net is what the customer ACTUALLY paid for these units — not the sticker price.
        -- The last return of a line takes the exact remainder, so returning a line in pieces sums back
        -- to the sale line to the paisa (never sum-of-rounded drift).
        net            INTEGER NOT NULL CHECK (net        >= 0),
        tax_rate_bp    INTEGER NOT NULL CHECK (tax_rate_bp >= 0),
        tax_amount     INTEGER NOT NULL CHECK (tax_amount >= 0),
        gross          INTEGER NOT NULL CHECK (gross      >= 0),

        -- 4-dp COST — a DIFFERENT SCALE from the money columns above. The weighted-average cost frozen
        -- on the sale line: what these units cost the shop. Restocking puts them back at THIS cost, so
        -- Inventory rises by exactly what COGS falls by.
        unit_cost      INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),

        -- 1 = back onto the sellable shelf (a stock_movement of type 'sale_return' is appended at
        -- unit_cost); 0 = damaged / written off, no movement, the shop eats the cost.
        restocked      INTEGER NOT NULL DEFAULT 1 CHECK (restocked IN (0, 1)),
        -- Restock to the SAME batch it was sold from, so FEFO and expiry stay honest. NULL for a
        -- non-batch-tracked product or an open item.
        batch_id       INTEGER REFERENCES batches (id),

        created_at     TEXT    NOT NULL,

        -- The receipt adds up, here as on the sale line — no future path can write a line whose tax and
        -- net do not reconcile to the amount refunded.
        CHECK (gross = net + tax_amount)
      );
      CREATE INDEX idx_return_lines_return    ON return_lines (return_id);
      -- THE hot query: "how much of this sale line has already been returned?" — SUM(qty_m) over it.
      CREATE INDEX idx_return_lines_sale_line ON return_lines (sale_line_id);
      CREATE INDEX idx_return_lines_product   ON return_lines (product_id);
    `)
  }
}
