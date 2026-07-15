import type { Migration } from './index'

/**
 * 0014 — EXPENSES. The shop's money going out on things that are NOT stock — rent, wages, bills, transport.
 *
 * A purchase (0013) brings in stock and re-averages its cost. An EXPENSE buys none: it is a cost of
 * running the shop, and it lands straight in the Profit & Loss. Each expense is paid NOW from cash or the
 * bank and posts one balanced journal:
 *
 *       DR  <the expense account for its category>   amount
 *       CR  Cash / Bank / wallet (the tender it was paid with)   amount
 *
 * ── CATEGORY → EXPENSE ACCOUNT ──────────────────────────────────────────────────────────────────────
 * `category_lookup_id` is a live entry on the owner's OWN lookups('expense_category') list (rent,
 * salaries, utilities, transport, repairs, misc, and any they add) — never a hardcoded dropdown
 * (CLAUDE.md §4). The service maps a category CODE to a chart expense account (rent→5200, salaries→5210,
 * utilities→5220, transport→5230, repairs→5240) so the P&L breaks the spend down by line; a category with
 * no dedicated account — 'misc' or a custom one the owner invents — falls back to General Expenses (5900),
 * so a new category always books somewhere sensible without a schema change.
 *
 * ── PAID NOW, NOT OWED ──────────────────────────────────────────────────────────────────────────────
 * v1 records expenses that are PAID (cash / bank / wallet). The service refuses a 'credit' tender: an
 * unpaid bill is an accrued liability, a later feature, not an expense row that pretends the money left.
 * (To take cash out of the TILL DRAWER for a bill mid-shift, a shift Pay-out (0012) is the instrument;
 * the Expenses screen is for proper, categorised bookkeeping from cash or bank.)
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * One new table. The expense accounts (chart-of-accounts) and the expense_category lookups already exist.
 */
export const migration0014: Migration = {
  version: 14,
  name: 'expenses: shop running costs (rent/wages/bills…) paid from cash or bank',
  up: (db) => {
    db.exec(`
      CREATE TABLE expenses (
        id                 INTEGER PRIMARY KEY,
        at                 TEXT    NOT NULL,                      -- when it was paid
        -- lookups('expense_category') — WHAT it was for. The service maps it to an expense account.
        category_lookup_id INTEGER NOT NULL REFERENCES lookups (id),
        amount             INTEGER NOT NULL CHECK (amount > 0),   -- 2-dp money, paid OUT
        -- lookups('payment_method') — HOW it was paid. Cash / bank / wallet only; the service refuses a
        -- 'credit' tender (an unpaid bill is not an expense row).
        method_lookup_id   INTEGER NOT NULL REFERENCES lookups (id),
        -- Who it was paid to. Free text — the landlord, the electricity company — it is not a supplier
        -- in the stock sense (a stock supplier is a Purchase, 0013). Optional.
        payee              TEXT,
        note               TEXT,
        user_id            INTEGER NOT NULL REFERENCES users (id),
        -- The balanced journal this expense posted (DR expense account, CR the tender). NULLABLE only so
        -- the row and its journal write in one transaction; a committed expense always has one.
        journal_id         INTEGER REFERENCES journals (id),
        created_at         TEXT    NOT NULL
      );
      -- The expense list (newest first) and the by-category breakdown both read these. Assume years of
      -- rows (CLAUDE.md §4).
      CREATE INDEX idx_expenses_at       ON expenses (at DESC);
      CREATE INDEX idx_expenses_category ON expenses (category_lookup_id);
    `)
  }
}
