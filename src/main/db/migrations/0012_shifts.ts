import type { Migration } from './index'

/**
 * 0012 — SHIFTS & THE CASH DRAWER. Who opened the till, what was in it, and what it should hold at close.
 *
 * A SHIFT is a drawer session: a cashier opens it with a starting float, rings sales and refunds through
 * it all day, and at close COUNTS the drawer against what the books say should be there. The difference —
 * over or short — is the single most watched number in a shop, because a drawer that is short every
 * evening is how a till is skimmed. This migration gives that its own record, plus the CASH MOVEMENTS
 * that are not sales: the no-sale drawer pop (the classic theft vector, logged with a reason), petty cash
 * paid in or out, and a drop to the safe.
 *
 * ── ONE OPEN SHIFT AT A TIME ────────────────────────────────────────────────────────────────────────
 * One shop, one drawer, so one shift is open at any moment. That is enforced in the service (a single
 * synchronous main process cannot interleave two opens), which refuses to open a second while one is
 * live and refuses to close one that is not. A closed shift is frozen forever — the Z-report it produced
 * has to still read the same a year later, exactly like a sale line (CLAUDE.md §4).
 *
 * ── THE CASH RECONCILIATION IS DERIVED, NOT TYPED ───────────────────────────────────────────────────
 * `expected_cash` is what the drawer SHOULD hold, computed from the movements that touched it and frozen
 * onto the row at close:
 *
 *     opening_float
 *       + cash SALES rung on this shift            (sale_payments whose method maps to ACC.CASH)
 *       + cash UDHAAR repaid on this shift         (customer_payments in cash)
 *       + pay-ins                                  (cash put INTO the drawer)
 *       − cash REFUNDS paid out on this shift      (returns settled 'refund' in cash)
 *       − pay-outs                                 (cash taken OUT for a bill/expense)
 *       − drops                                    (cash moved to the safe / bank)
 *
 * `variance = counted_cash − expected_cash` (positive = over, negative = short). It is RECORDED, not
 * auto-posted to the ledger: an over/short is usually a miscount to investigate, and silently adjusting
 * GL Cash on every close would hide the very theft or error the count exists to catch. The books stay at
 * what the sales and refunds actually posted; the count sits beside them.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Two new tables, and a nullable `shift_id` appended to the three documents whose cash lands in a drawer
 * (sales, returns, customer_payments) so a Z-report can total exactly its own shift. An older row simply
 * has no shift — true, it predates shifts. Nothing is dropped or rewritten.
 */
export const migration0012: Migration = {
  version: 12,
  name: 'shifts & cash drawer: shifts, cash_movements, shift_id on sales/returns/customer_payments',
  up: (db) => {
    db.exec(`
      -- ── Shifts ────────────────────────────────────────────────────────────────
      CREATE TABLE shifts (
        id             INTEGER PRIMARY KEY,

        opened_at      TEXT    NOT NULL,
        opened_by      INTEGER NOT NULL REFERENCES users (id),
        -- 2-dp money. The cash the drawer STARTS with — the float of small notes for change.
        opening_float  INTEGER NOT NULL CHECK (opening_float >= 0),

        -- All NULL while the shift is open; all set, together, the moment it closes. The CHECK makes a
        -- half-closed shift — a close time with no count, a count with no closer — impossible to write.
        closed_at      TEXT,
        closed_by      INTEGER REFERENCES users (id),
        counted_cash   INTEGER,                    -- 2-dp: what the cashier physically counted
        expected_cash  INTEGER,                    -- 2-dp: what the books say should be there (frozen)
        variance       INTEGER,                    -- 2-dp: counted − expected (over > 0, short < 0)

        note           TEXT,
        created_at     TEXT    NOT NULL,

        CHECK (
          (closed_at IS NULL AND closed_by IS NULL AND counted_cash IS NULL
             AND expected_cash IS NULL AND variance IS NULL)
          OR
          (closed_at IS NOT NULL AND closed_by IS NOT NULL AND counted_cash IS NOT NULL
             AND expected_cash IS NOT NULL AND variance IS NOT NULL
             AND variance = counted_cash - expected_cash)
        )
      );
      -- The open-shift lookup, and the shift list newest-first.
      CREATE INDEX idx_shifts_open       ON shifts (opened_at DESC) WHERE closed_at IS NULL;
      CREATE INDEX idx_shifts_opened_at  ON shifts (opened_at DESC);

      -- ── Cash movements — drawer events that are NOT sales ─────────────────────
      -- no_sale : the drawer was popped with no sale (to give change, check the float…). Money does NOT
      --           move, so amount is 0 and there is no journal — but WHO/WHEN/WHY is logged, because an
      --           unexplained no-sale is how cash is lifted. A reason code is required (service).
      -- pay_in  : cash put INTO the drawer. Posts DR Cash CR Owner Equity (an owner top-up).
      -- pay_out : cash taken OUT for a bill or errand. Posts DR General Expenses CR Cash. (Proper expense
      --           categories arrive with the Expenses phase; this keeps GL Cash honest until then.)
      -- drop    : cash moved to the safe / bank. Posts DR Bank CR Cash — it only relocates the money.
      CREATE TABLE cash_movements (
        id           INTEGER PRIMARY KEY,
        shift_id     INTEGER NOT NULL REFERENCES shifts (id),
        at           TEXT    NOT NULL,
        type         TEXT    NOT NULL CHECK (type IN ('no_sale', 'pay_in', 'pay_out', 'drop')),
        -- 2-dp money. Zero ONLY for a no-sale (nothing moved); a positive amount for the others.
        amount       INTEGER NOT NULL CHECK (amount >= 0),
        -- lookups('cash_reason') — WHY. Required for no_sale and pay_out (service enforces); optional
        -- for a pay_in or a drop, which are self-explanatory. Never a hardcoded list (CLAUDE.md §4).
        reason_code  TEXT,
        note         TEXT,
        user_id      INTEGER NOT NULL REFERENCES users (id),
        -- The balanced journal this movement posted (pay_in / pay_out / drop). NULL for a no_sale, which
        -- moves no money. Nullable so the row and its journal write in one transaction.
        journal_id   INTEGER REFERENCES journals (id),
        created_at   TEXT    NOT NULL,

        -- A no-sale moves nothing; everything else moves a positive amount. Structural, not a habit.
        CHECK ((type = 'no_sale' AND amount = 0) OR (type <> 'no_sale' AND amount > 0))
      );
      CREATE INDEX idx_cash_movements_shift ON cash_movements (shift_id, at);

      -- ── The shift a document belongs to ───────────────────────────────────────
      -- Nullable, and set by the service to the OPEN shift at the moment the document is written, so a
      -- Z-report totals exactly its own shift's cash rather than guessing by a time window (a sale at
      -- 11:59 vs a shift that rolled at midnight is exactly where a time-window total goes wrong).
      ALTER TABLE sales             ADD COLUMN shift_id INTEGER REFERENCES shifts (id);
      ALTER TABLE returns           ADD COLUMN shift_id INTEGER REFERENCES shifts (id);
      ALTER TABLE customer_payments ADD COLUMN shift_id INTEGER REFERENCES shifts (id);

      CREATE INDEX idx_sales_shift             ON sales (shift_id)             WHERE shift_id IS NOT NULL;
      CREATE INDEX idx_returns_shift           ON returns (shift_id)           WHERE shift_id IS NOT NULL;
      CREATE INDEX idx_customer_payments_shift ON customer_payments (shift_id) WHERE shift_id IS NOT NULL;
    `)
  }
}
