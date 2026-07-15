import type { Migration } from './index'

/**
 * 0009 — THE CUSTOMER LEDGER. What a customer owes, and the payments that bring it down.
 *
 * Phase 7 finally turns the minimal customer row from 0005 into a real party the shop keeps a running
 * account with. Two things arrive here:
 *
 *   1. Four fields the customer record was always going to need, added to `customers`.
 *   2. `customer_payments` — the udhaar a customer PAYS BACK.
 *
 * ── STILL NO BALANCE COLUMN, HERE OR ANYWHERE ──────────────────────────────────────────────────────
 * What a customer owes stays DERIVED, exactly as stock is derived from movements (CLAUDE.md §4):
 *
 *       opening udhaar (opening_receivables)  +  credit sales  −  customer_payments
 *
 * This table is only the CREDIT side of that sum — the money coming back in. It is NOT a balance, and
 * nothing may treat it as one. A stored balance is a balance that can disagree with the rows behind it,
 * and then the shop chases a customer for money the ledger says they do not owe. The whole point of a
 * ledger screen is that it recomputes on read, and it MUST read the same figure whether a payment was
 * taken from the sell screen or from the ledger screen itself (CLAUDE.md trap #17).
 *
 * ── THE ACCOUNTING (the service that inserts a row also posts this journal, in one transaction) ──────
 *
 *       customer pays udhaar  ->  DR Cash / Bank / wallet     CR Accounts Receivable (ACC.RECEIVABLE)
 *
 * The receivable this credits was DEBITED by a credit sale (sales.ts) or by the opening receivable
 * (0005). `journal_id` links the payment to the balanced journal it posted, so the ledger screen and
 * the general ledger can never drift. It is NULLABLE only so the row can be written and the journal
 * attached in the same transaction — a committed payment always has one.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Every statement here ADDS. The four ALTERs append nullable columns to `customers` (an existing row
 * is simply NULL for each — a customer added before today's build has no business name, and that is
 * true), and the new table stands alone. Nothing is dropped, renamed or rewritten.
 */
export const migration0009: Migration = {
  version: 9,
  name: 'customer ledger: business/tax/notes/price-tier fields; customer_payments (udhaar repayments)',
  up: (db) => {
    db.exec(`
      -- ── Customer record: the fields Phase 7 needs ─────────────────────────────
      -- business_name — the SHOP name a WHOLESALE customer trades under. A retail walk-in has none;
      --                 a business buying for resale needs it printed on their tax invoice.
      -- tax_number    — their NTN/STRN. What a proper sales-tax invoice to a registered buyer must
      --                 carry. Free text: it is THEIR number, we only record it.
      -- notes         — anything the owner wants to remember about this customer. Free text.
      ALTER TABLE customers ADD COLUMN business_name TEXT;
      ALTER TABLE customers ADD COLUMN tax_number    TEXT;
      ALTER TABLE customers ADD COLUMN notes         TEXT;

      -- price_tier — this customer's DEFAULT price tier, so a known wholesaler is rung up at wholesale
      -- without the cashier picking it every time. NULLABLE: null means "fall back to the shop default".
      -- Only 'retail' or 'wholesale' — NOT 'customer'. The 'customer' tier means "use this customer's
      -- own per-customer prices" and is a choice made AT THE TILL, not a default stored on the record.
      -- The CHECK keeps a typo or a stale renderer from ever writing a tier the pricing engine cannot
      -- read; the service validates it too (the renderer is not a security boundary, CLAUDE.md §4).
      ALTER TABLE customers ADD COLUMN price_tier TEXT
        CHECK (price_tier IS NULL OR price_tier IN ('retail', 'wholesale'));

      -- ── Customer payments — UDHAAR PAID BACK ──────────────────────────────────
      -- One row per payment received against a customer's account. Money coming IN, lowering what they
      -- owe. It is the CREDIT side of the derived balance above — never a balance itself.
      --
      -- amount > 0: a payment is money the shop RECEIVED. "Minus five hundred" is not a payment, it is
      --            a fresh charge, and a fresh charge is a credit sale — it goes through sales.ts, not
      --            here. The CHECK makes the wrong sign impossible.
      --
      -- method_lookup_id -> lookups('payment_method'): cash / bank / jazzcash / easypaisa / cheque...
      --            NOT a hardcoded list (CLAUDE.md §4). cheque_no + cheque_date carry a cheque; wallet_ref
      --            carries a mobile-wallet transaction id. All optional — a cash payment fills none of them.
      --
      -- SPLIT PAYMENT = MANY ROWS. A customer settling part in cash and part by cheque is two rows, each
      --            with its own method — the same shape sale_payments uses. There is no "methods array".
      --
      -- user_id — who took the money (from the authenticated session in MAIN, never from the renderer).
      -- journal_id — the balanced journal this payment posted (DR Cash/Bank CR Receivable). See header.
      -- at — WHEN the money changed hands, MAIN's clock; created_at — when the row was written. Usually
      --            the same instant, kept apart because a back-dated receipt would make them differ.
      CREATE TABLE customer_payments (
        id               INTEGER PRIMARY KEY,
        customer_id      INTEGER NOT NULL REFERENCES customers (id),
        at               TEXT    NOT NULL,
        amount           INTEGER NOT NULL CHECK (amount > 0),               -- 2 dp money, paid DOWN
        method_lookup_id INTEGER NOT NULL REFERENCES lookups (id),
        cheque_no        TEXT,
        cheque_date      TEXT,                                              -- ISO date, or NULL
        wallet_ref       TEXT,
        note             TEXT,
        user_id          INTEGER REFERENCES users (id),
        journal_id       INTEGER REFERENCES journals (id),
        created_at       TEXT    NOT NULL
      );

      -- The ledger screen lists ONE customer's payments, newest first, and pages through them. Assume
      -- 100k+ rows across the shop's life (CLAUDE.md §4). This index is exactly that query.
      CREATE INDEX idx_customer_payments_customer_at ON customer_payments (customer_id, at DESC);
    `)
  }
}
