import type { Migration } from './index'

/**
 * 0017 — LOYALTY POINTS. What the shop owes its regulars, in points rather than rupees.
 *
 * ── POINTS ARE A LIABILITY, NOT A MARKETING NUMBER ──────────────────────────────────────────────────
 * A point is a promise: come back and this is worth something at the till. That promise is real money the
 * shop will hand over later, so it is a LIABILITY (ACC.LOYALTY 2200, which has existed since 0002 waiting
 * for exactly this) and it hits the books the moment it is earned — never when it is redeemed:
 *
 *     earning     DR Loyalty Expense (5300)   CR Loyalty Points Liability (2200)
 *     redeeming   DR Loyalty Points Liability CR (the sale takes less money — see below)
 *     expiring    DR Loyalty Points Liability CR Loyalty Expense       (a promise released)
 *
 * Book it only at redemption and every P&L until then overstates profit by the points quietly piling up,
 * and the day a big customer cashes them the shop takes a hit it never saw coming.
 *
 * ── REDEMPTION IS A TENDER, NOT A DISCOUNT ──────────────────────────────────────────────────────────
 * This is the decision everything else follows from. Points PAY for goods; they do not reduce their
 * price. So a redemption is a PAYMENT LINE on the sale, exactly like cash — which means:
 *   · revenue and output tax are unchanged (the shop sold Rs 1000 of goods and got Rs 900 + 100 points),
 *   · the tax authority sees the true taxable value, not a discounted one,
 *   · the frozen sale lines stay untouched, so no historical line ever needs recomputing.
 * Making it a discount instead would understate revenue AND under-collect output tax on every redemption.
 *
 * ── THE BALANCE IS DERIVED, NEVER STORED ────────────────────────────────────────────────────────────
 * Same law as stock (CLAUDE.md §4): there is no `customers.points` column and there never will be. A
 * customer's balance is SUM(loyalty_movements.points) — earned positive, redeemed/expired negative. Every
 * path that could change it writes a movement, so the balance cannot silently drift from the ledger, and
 * a standing test asserts Σ(all customers' points) × redeem value === GL Loyalty Liability.
 *
 * ── WHOLE POINTS ────────────────────────────────────────────────────────────────────────────────────
 * `points` is a plain INTEGER — a whole point, not a scaled decimal. It is NOT money and NOT a quantity:
 * it is a count of promises. Its RUPEE value is `points × loyalty.redeemValueMinor` (a setting), computed
 * and FROZEN onto the movement at the moment it happens, so a later change to the redeem rate can never
 * rewrite what the books already say the shop owed.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * One new table and one new expense account. Nothing is dropped, nothing is rewritten.
 */
export const migration0017: Migration = {
  version: 17,
  name: 'loyalty: loyalty_movements + loyalty expense account',
  up: (db) => {
    db.exec(`
      -- ── Loyalty movements — the ONLY source of a customer's points ────────────
      CREATE TABLE loyalty_movements (
        id           INTEGER PRIMARY KEY,

        -- Points belong to a NAMED customer. A walk-in cannot earn them: there is nobody to come back
        -- and claim them, and an unattributable liability is one nobody can ever settle.
        customer_id  INTEGER NOT NULL REFERENCES customers (id),

        at           TEXT    NOT NULL,
        -- WHY the points moved. 'earn' from a sale; 'redeem' spent at the till; 'expire' aged out;
        -- 'adjust' an owner's correction (goodwill, or fixing a mistake) — audited, with a reason.
        type         TEXT    NOT NULL CHECK (type IN ('earn', 'redeem', 'expire', 'adjust')),

        -- WHOLE points. POSITIVE = the customer gained them (earn, a positive adjust); NEGATIVE = they
        -- left (redeem, expire, a negative adjust). SUM over a customer IS their balance — never 0,
        -- because a movement that moves nothing is not an event.
        points       INTEGER NOT NULL CHECK (points <> 0),

        -- The FROZEN 2-dp rupee value of these points when they moved: points × the redeem rate in force
        -- at that instant. This is what the journal posted, so changing the rate later can never rewrite
        -- history. Magnitude only — the sign lives on the points column.
        value_minor  INTEGER NOT NULL CHECK (value_minor >= 0),

        -- What caused it: a sale (earn / redeem), or NULL for expire/adjust. Not a FK to one table
        -- because the ref could grow (a return clawing points back), mirroring stock_movements' shape.
        ref_type     TEXT,
        ref_id       INTEGER,

        -- Required for 'adjust' (the service enforces it): lookups('adjustment_reason'). An owner moving
        -- a liability by hand without a reason is exactly what the audit log exists to prevent.
        reason_code  TEXT,
        reason_text  TEXT,

        user_id      INTEGER NOT NULL REFERENCES users (id),
        -- The balanced journal this movement posted. NULLABLE only so the row and its journal write in
        -- one transaction; a committed movement always has one.
        journal_id   INTEGER REFERENCES journals (id),
        created_at   TEXT    NOT NULL
      );
      -- THE hot query: "what is this customer's balance?" — SUM(points) over the customer.
      CREATE INDEX idx_loyalty_movements_customer ON loyalty_movements (customer_id);
      CREATE INDEX idx_loyalty_movements_at       ON loyalty_movements (at DESC);
      CREATE INDEX idx_loyalty_movements_ref      ON loyalty_movements (ref_type, ref_id);
    `)

    // The other side of an earn: what the points COST the shop, expensed as they are promised. Sits with
    // the operating expenses (5200–5240) so it lands in the P&L beside rent and wages.
    //
    // It is declared in chart-of-accounts.ts (the single source of truth) and `seedChartOfAccounts` puts
    // it in every NEW book on launch. This backfills the shops ALREADY RUNNING, whose accounts table was
    // seeded before 5300 existed — the same ON CONFLICT DO NOTHING shape the seeder uses, so a book that
    // already has it is untouched and re-running is harmless.
    db.prepare(
      `INSERT INTO accounts (code, name, type, is_system, is_active, created_at, updated_at)
       VALUES ('5300', 'Loyalty Points Expense', 'expense', 1, 1, @now, @now)
       ON CONFLICT (code) DO NOTHING`
    ).run({ now: new Date().toISOString() })
  }
}
