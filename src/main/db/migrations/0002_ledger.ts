import type { Migration } from './index'

/**
 * 0002 — the double-entry ledger.
 *
 * This exists BEFORE the Sell screen on purpose. Every sale, purchase, payment, return, expense and
 * stock adjustment posts a balanced journal entry. If selling shipped first, those sales would have
 * nowhere to post, and we would be back-filling a year of journals later — from data that had
 * already lost the detail we needed.
 *
 * THE CASHIER NEVER SEES ANY OF THIS. No debits, no credits, no account codes. It runs underneath,
 * so that at any moment the owner can be handed a Trial Balance, a P&L and a Balance Sheet that
 * actually add up.
 *
 * MONEY IS INTEGER MINOR UNITS. `debit` and `credit` are INTEGER columns. There is not one REAL
 * column in this schema, and there never will be.
 */
export const migration0002: Migration = {
  version: 2,
  name: 'ledger: chart of accounts, journals, periods',
  up: (db) => {
    db.exec(`
      -- ── Chart of accounts ───────────────────────────────────────────────────
      -- is_system accounts are ones the posting engine names directly (Cash, Inventory, Sales…).
      -- The owner may RENAME them, but never delete them, or the engine loses its footing.
      -- is_contra: an account that works BACKWARDS from its type.
      --
      --   "Discounts Given" and "Sales Returns" are INCOME accounts, but they REDUCE income, so
      --   they carry a DEBIT balance where income normally carries a credit. Without this flag a
      --   Rs 50 discount reads as MINUS Rs 50 of income and the sign flips on every discount and
      --   return in the P&L.
      --
      --   They are kept under income (rather than relabelled as expenses) because that is what they
      --   are: revenue you did not get. The P&L shows
      --      Net revenue = Sales − Sales Returns − Discounts
      --   which is also how an accountant expects to read it.
      CREATE TABLE accounts (
        id         INTEGER PRIMARY KEY,
        code       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
        is_contra  INTEGER NOT NULL DEFAULT 0,
        parent_id  INTEGER REFERENCES accounts (id),
        is_system  INTEGER NOT NULL DEFAULT 0,
        is_active  INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_accounts_type ON accounts (type, code);

      -- ── Periods ─────────────────────────────────────────────────────────────
      -- A locked month refuses new or edited entries, so last year's books cannot quietly change
      -- after they have been reported. OWNER-ONLY unlock, and every lock/unlock is audited.
      CREATE TABLE periods (
        id           INTEGER PRIMARY KEY,
        year         INTEGER NOT NULL,
        month        INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
        locked_by    INTEGER REFERENCES users (id),
        locked_at    TEXT,
        created_at   TEXT NOT NULL,
        UNIQUE (year, month)
      );

      -- ── Journals ────────────────────────────────────────────────────────────
      -- One journal per business event. ref_type/ref_id point back at the thing that caused it
      -- (a sale, a purchase, an expense), so any number on a report can be traced to its source.
      CREATE TABLE journals (
        id              INTEGER PRIMARY KEY,
        at              TEXT NOT NULL,
        ref_type        TEXT NOT NULL,
        ref_id          TEXT,
        memo            TEXT NOT NULL,
        created_by_user_id INTEGER REFERENCES users (id),
        year            INTEGER NOT NULL,
        month           INTEGER NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_journals_at ON journals (at DESC);
      CREATE INDEX idx_journals_ref ON journals (ref_type, ref_id);
      CREATE INDEX idx_journals_period ON journals (year, month);

      -- ── Journal lines ───────────────────────────────────────────────────────
      -- THE INVARIANT: for every journal, SUM(debit) = SUM(credit). Enforced by the posting engine
      -- inside the transaction, and asserted by a standing test after EVERY scenario.
      --
      -- The CHECK constraints below are the database's own last line of defence: an amount can never
      -- be negative (you credit instead of debiting a negative), and a line is never both a debit
      -- and a credit at once.
      CREATE TABLE journal_lines (
        id         INTEGER PRIMARY KEY,
        journal_id INTEGER NOT NULL REFERENCES journals (id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts (id),
        debit      INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit     INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
        CHECK (NOT (debit > 0 AND credit > 0)),
        CHECK (debit > 0 OR credit > 0)
      );
      CREATE INDEX idx_journal_lines_journal ON journal_lines (journal_id);
      CREATE INDEX idx_journal_lines_account ON journal_lines (account_id);
    `)
  }
}
