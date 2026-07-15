import type { Migration } from './index'

/**
 * 0013 — BUYING. Stock coming INTO the shop from a supplier, and the money owed for it.
 *
 * This is the mirror of selling (0007). Where a sale takes stock out and brings money in, a PURCHASE
 * (a goods-received note) brings stock IN at a real landed cost — re-averaging the product's weighted
 * cost — and either pays for it now or owes the supplier the rest. Everything the sale engine is strict
 * about applies here, pointing the other way:
 *
 *   • STOCK IS STILL DERIVED. A purchase line does not store a stock figure; it APPENDS a 'purchase'
 *     movement through stock.record(), which freezes that movement's value_minor (0006) and re-blends
 *     the weighted average. On-hand stays SUM(stock_movements.qty_m).
 *
 *   • THE COST SCALE IS 4-DP, A HUNDRED TIMES THE MONEY SCALE. `unit_cost` is the landed cost per base
 *     unit (a carton of 24 for Rs 2185 lands each piece at 91.0417). `line_total` is the 2-dp money
 *     value of the line, and it EQUALS the frozen value of the stock movement it created — never a fresh
 *     multiply — so DR Inventory and the stock valuation move by the same paisa (same rule as sale COGS).
 *
 *   • THE JOURNAL BALANCES AS ALGEBRA (the purchase service posts it):
 *         DR Inventory (ACC.INVENTORY)      = Σ line_total          (net landed cost)
 *         DR Input Tax (ACC.INPUT_TAX)      = tax_total             (recoverable sales tax, if any)
 *         CR each tender account            = paid_total            (cash/bank/wallet paid NOW)
 *         CR Supplier Payables (ACC.PAYABLE)= grand_total − paid_total   (the rest, owed on account)
 *     grand_total = subtotal_net + tax_total, so DR = CR by construction.
 *
 *   • WHAT A SUPPLIER IS OWED IS DERIVED, never stored — exactly like a customer's udhaar (0009):
 *         opening payable (0005)  +  Σ (purchase.grand_total − purchase.paid_total)  −  Σ supplier_payments
 *     which reconciles, to the paisa, with the GL Payables account.
 *
 * ── INPUT TAX IS OPTIONAL AND DEFAULTS TO ZERO ──────────────────────────────────────────────────────
 * A shop that is GST-registered and reclaims input tax records `tax_total` and it lands in the
 * recoverable Input Tax asset; the `unit_cost` that re-averages the product stays NET of it. A shop that
 * cannot reclaim it simply folds the tax into `unit_cost` and leaves `tax_total` 0. Which of the two is
 * correct is the owner's tax status — the default is 0, and it is documented as needing their confirmation.
 *
 * ── PAYMENT: TENDERS NOW, THE REST IS THE PAYABLE ───────────────────────────────────────────────────
 * `purchase_payments` records only real tenders paid at purchase time (cash / bank / wallet). There is
 * no 'credit' tender here: the amount NOT paid now IS the payable, and it is `grand_total − paid_total`.
 * A later payment that settles it is a `supplier_payment` (DR Payable CR Cash/Bank), the mirror of a
 * customer paying down udhaar (0009). A purchase paid in cash is assumed NOT to come out of the till
 * drawer (to take cash from the drawer for a supplier, use a shift Pay-out, 0012); so a purchase carries
 * no shift_id and never touches a Z-report.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Four new tables. `suppliers` (0003), `product_suppliers` (0003) and `opening_payables` (0005) already
 * exist and are untouched. Returns-to-supplier (purchase returns) is a later table, deferred by design.
 */
export const migration0013: Migration = {
  version: 13,
  name: 'buying: purchases, purchase_lines, purchase_payments, supplier_payments',
  up: (db) => {
    db.exec(`
      -- ── Purchases (goods-received notes) ──────────────────────────────────────
      CREATE TABLE purchases (
        id                  INTEGER PRIMARY KEY,
        supplier_id         INTEGER NOT NULL REFERENCES suppliers (id),
        at                  TEXT    NOT NULL,                    -- when the goods were received
        -- The SUPPLIER's own bill number, as written on their invoice. Free text — it is their number,
        -- we only record it, and it is how the owner cross-checks a delivery against a bill.
        supplier_invoice_no TEXT,

        -- ALL 2-dp money.
        --   subtotal_net = Σ purchase_lines.line_total   (net landed cost of the goods)
        --   tax_total    = recoverable input tax on the bill (0 unless the shop reclaims it)
        --   grand_total  = subtotal_net + tax_total       (the whole bill)
        --   paid_total   = Σ purchase_payments.amount      (tenders paid NOW; the rest is the payable)
        subtotal_net        INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_net >= 0),
        tax_total           INTEGER NOT NULL DEFAULT 0 CHECK (tax_total    >= 0),
        grand_total         INTEGER NOT NULL DEFAULT 0 CHECK (grand_total  >= 0),
        paid_total          INTEGER NOT NULL DEFAULT 0 CHECK (paid_total   >= 0),

        notes               TEXT,
        user_id             INTEGER NOT NULL REFERENCES users (id),
        journal_id          INTEGER REFERENCES journals (id),
        created_at          TEXT    NOT NULL,

        CHECK (grand_total = subtotal_net + tax_total),
        -- You cannot pay more than the bill (change is not a thing when buying). The unpaid remainder,
        -- grand_total − paid_total, is what is owed to the supplier.
        CHECK (paid_total <= grand_total)
      );
      CREATE INDEX idx_purchases_supplier ON purchases (supplier_id, at DESC);
      CREATE INDEX idx_purchases_at       ON purchases (at DESC);

      -- ── Purchase lines — WHAT was received, and at what landed cost ───────────
      CREATE TABLE purchase_lines (
        id            INTEGER PRIMARY KEY,
        purchase_id   INTEGER NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
        product_id    INTEGER NOT NULL REFERENCES products (id),
        name_snapshot TEXT    NOT NULL,                         -- FROZEN name at receipt time

        qty_m         INTEGER NOT NULL CHECK (qty_m > 0),       -- 3-dp base units received
        uom           TEXT,
        -- 4-dp COST — a DIFFERENT SCALE from the money columns. The landed net cost per base unit; this
        -- is what re-averages the product's weighted cost when stock.record posts the movement.
        unit_cost     INTEGER NOT NULL CHECK (unit_cost >= 0),
        -- 2-dp money value of the line = the frozen value of the 'purchase' stock movement it created.
        -- DR Inventory sums THESE, never a fresh qty×cost multiply (sum-of-rounded ≠ round-of-sum).
        line_total    INTEGER NOT NULL CHECK (line_total >= 0),

        -- The batch this stock went into. A batch-tracked product's purchase CREATES a batch (batch_no +
        -- expiry) and the movement attaches to it, so FEFO has something to pick later. NULL otherwise.
        batch_id      INTEGER REFERENCES batches (id),

        created_at    TEXT    NOT NULL
      );
      CREATE INDEX idx_purchase_lines_purchase ON purchase_lines (purchase_id);
      CREATE INDEX idx_purchase_lines_product  ON purchase_lines (product_id);

      -- ── Purchase payments — tenders paid AT PURCHASE TIME ─────────────────────
      -- Only real money out now: cash / bank / wallet. NO 'credit' tender — the unpaid remainder IS the
      -- payable (grand_total − paid_total), settled later by a supplier_payment. A split is many rows.
      CREATE TABLE purchase_payments (
        id               INTEGER PRIMARY KEY,
        purchase_id      INTEGER NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
        method_lookup_id INTEGER NOT NULL REFERENCES lookups (id),
        amount           INTEGER NOT NULL CHECK (amount > 0),   -- 2-dp money
        cheque_no        TEXT,
        cheque_date      TEXT,
        wallet_ref       TEXT,
        created_at       TEXT    NOT NULL
      );
      CREATE INDEX idx_purchase_payments_purchase ON purchase_payments (purchase_id);

      -- ── Supplier payments — the payable PAID DOWN ─────────────────────────────
      -- The mirror of customer_payments (0009): money the shop pays a supplier to reduce what it owes.
      -- DR Payables CR Cash/Bank. amount > 0 (a negative is not a payment, it is a fresh bill).
      CREATE TABLE supplier_payments (
        id               INTEGER PRIMARY KEY,
        supplier_id      INTEGER NOT NULL REFERENCES suppliers (id),
        at               TEXT    NOT NULL,
        amount           INTEGER NOT NULL CHECK (amount > 0),   -- 2-dp money, paid DOWN
        method_lookup_id INTEGER NOT NULL REFERENCES lookups (id),
        cheque_no        TEXT,
        cheque_date      TEXT,
        wallet_ref       TEXT,
        note             TEXT,
        user_id          INTEGER REFERENCES users (id),
        journal_id       INTEGER REFERENCES journals (id),
        created_at       TEXT    NOT NULL
      );
      CREATE INDEX idx_supplier_payments_supplier ON supplier_payments (supplier_id, at DESC);
    `)
  }
}
