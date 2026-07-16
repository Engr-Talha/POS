import type { Migration } from './index'

/**
 * 0015 — HOW LONG A QUOTATION HOLDS.
 *
 * A quote is a price the shop OFFERED (0007: status 'quote', no invoice number until it is rung up). It
 * was already savable, resumable and convertible — but it had no shelf life, and a price with no shelf
 * life is a promise the shop cannot keep: quote a carton at today's cost, the distributor raises it next
 * month, and the customer walks in waving a six-month-old slip.
 *
 * `valid_until` is the DATE the offer expires, written when the quote is saved from the shop's own
 * `quote.validDays` setting (not a constant — one shop honours a price for a week, the next for a month).
 *
 * ── ONLY A QUOTE HAS ONE ────────────────────────────────────────────────────────────────────────────
 * A held cart, a completed sale and a voided sale carry NULL. It is an OFFER's expiry, not a document's —
 * once the quote becomes a sale (the SAME row, per PLAN.md §2), money has changed hands and the date is
 * meaningless, so `complete()` clears it. SQLite cannot bolt a table CHECK on with ALTER TABLE, so the
 * SERVICE owns that invariant (`saveQuote` sets it, `complete`/`hold` clear it) and a test proves it —
 * the one place in this schema where a rule is a habit rather than a constraint, and it is called out
 * here so the next reader does not assume the database is guarding it.
 *
 * Nothing enforces the date at conversion: an expired quote is a CONVERSATION ("this price was good until
 * the 14th"), not a lock the till should refuse — the shopkeeper decides whether to honour it. The screen
 * shows it plainly; the database only records what was promised and until when.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * One nullable column appended to `sales`. Every existing row is NULL — true: they were quoted before the
 * shop had a validity policy, and no quote is retroactively given or denied a life it never had.
 */
export const migration0015: Migration = {
  version: 15,
  name: 'quotations: valid_until (how long an offered price holds)',
  up: (db) => {
    db.exec(`
      -- ISO date 'YYYY-MM-DD' — a DAY, not an instant: an offer is good "until the 14th", all of it.
      ALTER TABLE sales ADD COLUMN valid_until TEXT;

      -- The quote tray reads "which of my open quotes are about to lapse", newest first. A partial index:
      -- a handful of rows out of a million, and the only query that ever reads this column.
      CREATE INDEX idx_sales_quote_valid_until ON sales (valid_until)
        WHERE status = 'quote' AND valid_until IS NOT NULL;
    `)
  }
}
