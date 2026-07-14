import type { Migration } from './index'

/**
 * 0007 — SELLING. The sale, its lines, its money, and the number on the receipt.
 *
 * This is the table the shop's entire year of trading lands in. Everything before it — the ledger,
 * the catalog, the opening balances — existed so that this one could be written correctly.
 *
 * FIVE THINGS THIS SCHEMA REFUSES TO LET GO WRONG. Each one is a CHECK or an index, not a comment,
 * because a rule that lives only in a service is a rule the next service forgets.
 *
 * ── 1. THE INVOICE NUMBER IS GAPLESS ────────────────────────────────────────────────────────────
 *
 * A held sale and a quote take NO NUMBER. The number is drawn — and `invoice_counters.next_seq`
 * incremented — IN THE SAME TRANSACTION as the row that gets it, and only when the sale COMPLETES.
 * That is the whole mechanism, and it is the only one that works:
 *
 *   - Number on hold  ->  the cashier abandons the cart, the number dies with it, and the shop hands
 *                         the tax man a book with 47 missing.
 *   - Number outside the transaction  ->  two tills, one number, or a crash between the two writes.
 *
 * The CHECK below makes "held and quote have no number; completed and voided have one" a property of
 * the database rather than a habit of the sale service. And a VOIDED INVOICE KEEPS ITS NUMBER — it is
 * never reused and never renumbered. A void is a line in the book saying "this one was cancelled",
 * not an eraser. (PLAN.md §1.)
 *
 * ── 2. EVERY LINE FREEZES ITS OWN MONEY ─────────────────────────────────────────────────────────
 *
 * `net`, `tax_rate_bp`, `tax_amount`, `gross` and `unit_cost` are computed ONCE, at the moment of the
 * sale, and never recomputed. Reprint a receipt from last March after the shop has changed its tax
 * rate, renamed the product and re-averaged its cost, and it must print the same numbers it printed
 * in March. A historical line recomputed from today's settings is not a receipt, it is fiction — and
 * it is the fiction an auditor will find. (CLAUDE.md §4.)
 *
 * `CHECK (gross = net + tax_amount)` enforces the arithmetic the customer can do in their head. It
 * holds by construction in computeLineTax() (shared/tax.ts); this is what stops a future code path
 * writing a line that does not add up.
 *
 * ── 3. THE THREE SCALES, AND THEY ARE NOT INTERCHANGEABLE ───────────────────────────────────────
 *
 *      money  (unit_price, line_discount, net, tax_amount, gross,     INTEGER minor units,     2 dp
 *              subtotal_net, cart_discount, tax_total, grand_total,
 *              paid_total, change_due, sale_payments.amount)
 *      cost   (sale_lines.unit_cost — THE FROZEN COGS)                INTEGER ten-thousandths, 4 dp
 *      qty_m  (sale_lines.qty_m)                                      INTEGER thousandths,     3 dp
 *
 * `unit_cost` sits one column away from `unit_price` and they are A HUNDRED TIMES APART. Cost is 4 dp
 * because a carton of 24 bought for Rs 2185 costs 91.0417 a piece. Passing a price into the cost
 * column understates COGS a hundredfold and reports a profit the shop did not make.
 *
 * There is not one REAL column here. (`had_negative_stock` is a 0/1 FLAG, not a quantity — see below.)
 *
 * ── 4. STOCK IS STILL DERIVED ───────────────────────────────────────────────────────────────────
 *
 * NOTHING in this migration stores a stock figure. A sale moves stock by APPENDING a row to
 * `stock_movements` through stock.record(), which freezes that movement's cost and its `value_minor`
 * (migration 0006) and maintains the weighted average. On-hand remains SUM(stock_movements.qty_m),
 * for a sold product exactly as for any other. `sale_lines.qty_m` is what was SOLD on this document;
 * it is not, and must never become, an authority on what is on the shelf.
 *
 * ── 5. A NEGATIVE-STOCK SALE IS FLAGGED FOREVER ─────────────────────────────────────────────────
 *
 * `had_negative_stock` is the flag PLAN.md §1 requires: the sale went through, and the row is
 * "visibly flagged in every list it appears in". It is a BOOLEAN (CHECK IN (0,1)), never a quantity —
 * it says THAT the shop sold what it did not have, not how much. The audit row, with the cashier's
 * name and role against it, is written by the sale service.
 *
 * ── FBR (Pakistan Tier-1) ───────────────────────────────────────────────────────────────────────
 *
 * `fbr_invoice_no`, `fbr_qr`, `fbr_sync_status` and the whole `sync_queue` table are a SEAM and
 * nothing more. Real-time invoice reporting needs the internet, which this app does not have and does
 * not want (CLAUDE.md §2). The columns exist now so that the day it is switched on, no shop with a
 * year of sales has to migrate its `sales` table. NOTHING in this phase writes them.
 */
export const migration0007: Migration = {
  version: 7,
  name: 'selling: sales, sale lines, payments, invoice counters, FBR sync seam',
  up: (db) => {
    db.exec(`
      -- ── Sales ───────────────────────────────────────────────────────────────
      -- One row per document, in four states:
      --
      --   'held'       a parked cart. The customer went back for the milk they forgot. NO NUMBER.
      --   'quote'      a price the shop offered. It may never become a sale.  NO NUMBER.
      --   'completed'  it happened. Money moved, stock moved, the journal posted. HAS A NUMBER.
      --   'voided'     it happened and was then cancelled. IT KEEPS ITS NUMBER.
      --
      -- The number is assigned ONLY on the held/quote -> completed transition, in the same
      -- transaction that bumps invoice_counters. That is what makes numbering gapless.
      CREATE TABLE sales (
        id                 INTEGER PRIMARY KEY,

        -- The number the customer sees, formatted per Settings ('INV-2026-000123'). NULL until the
        -- sale completes. UNIQUE: a number is issued once and belongs to that sale forever.
        invoice_no         TEXT UNIQUE,
        -- The raw sequence and the year it was drawn from — kept apart from the formatted string so
        -- that a gap audit ("is 122 followed by 123?") never has to parse a prefix the owner is
        -- free to change in Settings tomorrow.
        invoice_seq        INTEGER,
        invoice_year       INTEGER,

        at                 TEXT NOT NULL,                              -- when it was rung up
        customer_id        INTEGER REFERENCES customers (id),          -- NULL = walk-in
        user_id            INTEGER NOT NULL REFERENCES users (id),     -- WHO sold it. Never null.

        -- Which price column was used. 'customer' = a per-customer agreed price (customer_prices).
        -- WHO may switch off 'retail' is a SETTING (selling.wholesaleTierRole), not a constant.
        price_tier         TEXT NOT NULL DEFAULT 'retail'
                             CHECK (price_tier IN ('retail', 'wholesale', 'customer')),

        status             TEXT NOT NULL
                             CHECK (status IN ('held', 'completed', 'voided', 'quote')),

        -- ALL 2-dp MONEY (integer minor units).
        --   subtotal_net  = SUM(sale_lines.net)      — after line discounts, before tax
        --   cart_discount = a discount on the WHOLE cart, on top of any line discounts
        --   tax_total     = SUM(sale_lines.tax_amount)
        --   grand_total   = what the customer owes.   NO CASH ROUNDING. 2 decimals, exact.
        --   paid_total    = SUM(sale_payments.amount) — may EXCEED grand_total (they paid with 500)
        --   change_due    = paid_total - grand_total when they overpaid in cash
        subtotal_net       INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_net  >= 0),
        cart_discount      INTEGER NOT NULL DEFAULT 0 CHECK (cart_discount >= 0),
        tax_total          INTEGER NOT NULL DEFAULT 0 CHECK (tax_total     >= 0),
        grand_total        INTEGER NOT NULL DEFAULT 0 CHECK (grand_total   >= 0),
        paid_total         INTEGER NOT NULL DEFAULT 0 CHECK (paid_total    >= 0),
        change_due         INTEGER NOT NULL DEFAULT 0 CHECK (change_due    >= 0),

        -- THE FLAG. 0 or 1 — never a quantity. The shop sold stock it did not have; the sale stands,
        -- and every list that shows this row shows it flagged. (PLAN.md §1: "warn, allow, flag".)
        -- Whether that is even permitted is the SETTING selling.negativeStock (warn/block/allow).
        had_negative_stock INTEGER NOT NULL DEFAULT 0 CHECK (had_negative_stock IN (0, 1)),

        -- A void carries a REASON CODE from lookups('void_reason'), the supervisor who approved it,
        -- and when. Enforced below, because "every void has a reason" (CLAUDE.md §4) must not depend
        -- on a service remembering to ask.
        void_reason_code   TEXT,
        voided_by          INTEGER REFERENCES users (id),
        voided_at          TEXT,

        -- An EXCHANGE is a return and a sale sharing this id, settling the difference either way.
        -- Deliberately NOT a foreign key: the returns table arrives in Phase 6, and this is the
        -- correlation id both documents carry, not a pointer to one of them.
        exchange_group_id  INTEGER,

        -- FBR seam (Pakistan Tier-1). SCHEMA ONLY — nothing in this phase writes these. See header.
        fbr_invoice_no     TEXT,
        fbr_qr             TEXT,
        fbr_sync_status    TEXT,

        created_at         TEXT NOT NULL,

        -- GAPLESS NUMBERING, MADE STRUCTURAL.
        -- A parked cart or a quotation has no number and cannot have one. A completed sale must have
        -- one. A voided sale KEEPS the one it had — which is why 'voided' sits on the "has a number"
        -- side of this CHECK, not the other.
        CHECK (
          (status IN ('held', 'quote')
             AND invoice_no  IS NULL
             AND invoice_seq IS NULL
             AND invoice_year IS NULL)
          OR
          (status IN ('completed', 'voided')
             AND invoice_no  IS NOT NULL
             AND invoice_seq IS NOT NULL
             AND invoice_year IS NOT NULL)
        ),

        -- A voided sale knows WHO cancelled it, WHEN, and WHY. A sale that is not voided carries
        -- none of those three. This is what stops the two states half-existing — a row that says
        -- "completed" while holding a void reason is a row nobody can interpret a year later.
        CHECK (
          (status =  'voided' AND voided_at IS NOT NULL
                              AND voided_by IS NOT NULL
                              AND void_reason_code IS NOT NULL)
          OR
          (status <> 'voided' AND voided_at IS NULL
                              AND voided_by IS NULL
                              AND void_reason_code IS NULL)
        )
      );

      -- Assume years of trading and 1000+ sales a day (CLAUDE.md §2). Every list this table feeds
      -- gets an index: the day's sales, the held-carts tray, a customer's history, a cashier's
      -- takings, the leakage report.
      CREATE INDEX idx_sales_at            ON sales (at DESC);
      CREATE INDEX idx_sales_status_at     ON sales (status, at DESC);
      CREATE INDEX idx_sales_customer      ON sales (customer_id, at DESC);
      CREATE INDEX idx_sales_user          ON sales (user_id, at DESC);
      -- "Show me invoice 123 of 2026", and the audit that proves numbering has no holes in it.
      CREATE INDEX idx_sales_invoice_seq   ON sales (invoice_year, invoice_seq);

      -- Two PARTIAL indexes. Both cover a handful of rows out of a million, and both are read by a
      -- screen that must not table-scan a year of sales to find them.
      --   the flagged sales the leakage report is FOR:
      CREATE INDEX idx_sales_negative_stock ON sales (at DESC) WHERE had_negative_stock = 1;
      --   the two documents of an exchange, finding each other:
      CREATE INDEX idx_sales_exchange_group ON sales (exchange_group_id)
        WHERE exchange_group_id IS NOT NULL;

      -- ── Sale lines ──────────────────────────────────────────────────────────
      -- WHAT WAS SOLD, AS IT WAS AT THE MOMENT IT WAS SOLD. Every figure here is FROZEN.
      --
      -- product_id is NULLABLE — an OPEN ITEM ("Misc — Rs 50") has no product behind it. That is why
      -- name_snapshot is NOT NULL and product_id is not: the receipt must be able to name every line
      -- it prints, whether or not the catalog ever knew about it. And a product that is later renamed
      -- or deleted cannot retroactively change what an old receipt says it sold.
      CREATE TABLE sale_lines (
        id               INTEGER PRIMARY KEY,
        -- CASCADE: deleting a HELD cart (the only sale row that is ever deleted — completed and
        -- voided sales are permanent) takes its lines with it. A line with no sale is an orphan that
        -- shows up in a report nobody can trace.
        sale_id          INTEGER NOT NULL REFERENCES sales (id) ON DELETE CASCADE,

        product_id       INTEGER REFERENCES products (id),   -- NULL = an open / miscellaneous item
        name_snapshot    TEXT NOT NULL,                      -- FROZEN: the name AT SALE TIME
        name_other_lang  TEXT,                               -- Urdu, frozen the same way
        batch_id         INTEGER REFERENCES batches (id),    -- FEFO auto-picked; the cashier never does
        -- Scanned a CARTON? Then this is the pack that was scanned, and unit_price is the CARTON's
        -- price while qty_m is in BASE units (a carton of 24 -> 24000). This is what "buy in cartons,
        -- sell in pieces" costs the schema: one nullable column.
        pack_id          INTEGER REFERENCES product_packs (id),

        -- 3-dp qty, in the product's BASE unit. Positive: a sale line sells something. A line that
        -- gives something back is a RETURN, and a return is its own document (Phase 6).
        qty_m            INTEGER NOT NULL CHECK (qty_m > 0),
        uom              TEXT,                               -- FROZEN unit name ("pcs", "kg")

        -- ALL 2-dp MONEY.
        unit_price       INTEGER NOT NULL          CHECK (unit_price    >= 0),  -- 0 = a giveaway
        line_discount    INTEGER NOT NULL DEFAULT 0 CHECK (line_discount >= 0),

        -- THE FROZEN TAX. Computed once by computeLineTax() (shared/tax.ts) and never again.
        net              INTEGER NOT NULL           CHECK (net        >= 0),
        tax_rate_bp      INTEGER NOT NULL           CHECK (tax_rate_bp >= 0),   -- 17% = 1700
        tax_amount       INTEGER NOT NULL           CHECK (tax_amount >= 0),
        gross            INTEGER NOT NULL           CHECK (gross      >= 0),
        -- Was this line's price typed WITH tax in it or without? Frozen per line, because one cart
        -- may legitimately mix both (CLAUDE.md §4).
        tax_mode         TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),

        -- 4-dp COST — A DIFFERENT SCALE FROM EVERY MONEY COLUMN ABOVE. This is the weighted-average
        -- cost at the instant of the sale, frozen: THE COGS. Ten purchases later, when the average
        -- has moved, this line still knows what the thing it sold actually cost the shop. Recomputing
        -- it from today's average is how a profit report becomes fiction.
        unit_cost        INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),

        is_open_item     INTEGER NOT NULL DEFAULT 0 CHECK (is_open_item IN (0, 1)),
        -- WHO overrode the price, if anyone. Non-null = this line was not sold at the catalog price,
        -- and there is an audit row with a reason code to match. Who MAY do it is the setting
        -- selling.priceOverrideRole.
        price_override_by INTEGER REFERENCES users (id),

        -- THE IMEIs THE CASHIER SCANNED, so that PARKING A CART DOES NOT FORGET THEM.
        --
        -- This is the parked cart's MEMORY, not the record of a sale. For a COMPLETED sale the record
        -- of which handset went out is serial_numbers.sale_id — that is the queryable, relational
        -- truth, and it is what a warranty claim or a stolen-handset check reads. Nothing here
        -- replaces it.
        --
        -- But a held cart marks nothing sold (nothing HAS been sold), so the serials the cashier
        -- typed had nowhere to live: hold a phone sale, resume it, and the IMEIs were simply gone —
        -- and the sale could then never be completed, because main requires one serial per unit. The
        -- cart remembers the quantity and the discount the cashier keyed; it remembers the IMEI the
        -- same way, for the same reason.
        --
        -- A JSON array of strings, or NULL. Deliberately not a table: it is never joined on, never
        -- reported on, and never aggregated — it is read back verbatim by exactly one caller
        -- (toCartLines) to refill a cart.
        serials_json     TEXT,

        created_at       TEXT NOT NULL,

        -- THE RECEIPT ADDS UP. Guaranteed by construction in computeLineTax(); enforced here so that
        -- no future code path — a promotion engine, an import, a fix applied at 11pm — can write a
        -- line whose tax and net do not reconcile to the amount the customer was charged.
        CHECK (gross = net + tax_amount),

        -- An open item has no product; a catalogued line has one. The flag and the column cannot
        -- disagree, because a report that groups by product silently drops every row where they do.
        CHECK ((is_open_item = 1 AND product_id IS NULL)
            OR (is_open_item = 0 AND product_id IS NOT NULL))
      );
      CREATE INDEX idx_sale_lines_sale    ON sale_lines (sale_id);
      -- The item-wise sales report and "show me this product's history" both read this.
      CREATE INDEX idx_sale_lines_product ON sale_lines (product_id);
      CREATE INDEX idx_sale_lines_batch   ON sale_lines (batch_id);
      CREATE INDEX idx_sale_lines_pack    ON sale_lines (pack_id);

      -- ── Sale payments ───────────────────────────────────────────────────────
      -- HOW they paid. A SPLIT PAYMENT IS SEVERAL ROWS — Rs 200 cash + Rs 260 card is two rows, and
      -- that is the only way a payment-method breakdown can ever be honest.
      --
      -- CREDIT (UDHAAR) is a payment row too, with method 'credit': the customer "paid" with a
      -- promise, and the sale posts DR Accounts Receivable instead of DR Cash. Modelling it as a
      -- payment rather than as an absence of one is what makes paid_total = SUM(amount) hold for
      -- every sale in the book, and what gives the customer ledger a row to point at.
      CREATE TABLE sale_payments (
        id               INTEGER PRIMARY KEY,
        sale_id          INTEGER NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
        -- lookups('payment_method'). NEVER a hardcoded dropdown (CLAUDE.md §4) — the shop adds
        -- "Sadapay" itself, in Settings, without a new release.
        method_lookup_id INTEGER NOT NULL REFERENCES lookups (id),
        -- 2-dp money, POSITIVE. A zero payment is not a payment. Overpayment is legitimate and
        -- normal (they handed over Rs 500 for a Rs 460 sale): SUM(amount) may exceed grand_total,
        -- and the difference is sales.change_due.
        amount           INTEGER NOT NULL CHECK (amount > 0),

        -- A POST-DATED CHEQUE is a real Pakistani retail instrument: the money is not in the bank
        -- yet, and the shop needs to know which cheque, dated when.
        cheque_no        TEXT,
        cheque_date      TEXT,
        -- JazzCash / Easypaisa transaction reference — what the shop quotes when a wallet payment
        -- is disputed.
        wallet_ref       TEXT,

        created_at       TEXT NOT NULL
      );
      CREATE INDEX idx_sale_payments_sale   ON sale_payments (sale_id);
      -- The payment-method breakdown report (PLAN.md §5) groups on this, over a date range.
      CREATE INDEX idx_sale_payments_method ON sale_payments (method_lookup_id);

      -- ── Invoice counters ────────────────────────────────────────────────────
      -- THE SOURCE OF THE NUMBER, and the reason it has no gaps.
      --
      -- next_seq is read and incremented IN THE SAME TRANSACTION AS THE SALE INSERT. Not before it,
      -- not after it. If the sale rolls back, so does the number, and the next sale takes it instead.
      -- Any other arrangement — reserving a number when the cart opens, or bumping the counter in a
      -- second transaction — puts holes in the book, and a book with holes in it is what a tax
      -- inspector is trained to look for.
      --
      -- series: the numbering stream. One shop, one stream, in practice — but keyed so that a
      --   separate quotation or exchange series can be added later without touching this table.
      -- year:   the year it resets in, when Settings says to reset yearly (invoice.resetYearly).
      --   A shop that numbers straight through the years uses a single fixed key here — the SERVICE
      --   decides that, from the setting, and this table just holds counters.
      CREATE TABLE invoice_counters (
        series     TEXT    NOT NULL,
        year       INTEGER NOT NULL,
        next_seq   INTEGER NOT NULL CHECK (next_seq >= 1),
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        PRIMARY KEY (series, year)
      );

      -- ── Sync queue ──────────────────────────────────────────────────────────
      -- FBR SEAM. SCHEMA ONLY. NOTHING IN THIS PHASE WRITES TO IT, AND NOTHING READS IT.
      --
      -- When Pakistan Tier-1 real-time invoice reporting is switched on, a completed sale will drop a
      -- row in here inside its own transaction, and a background worker will drain it when the
      -- internet happens to be up. That design is what lets an OFFLINE app satisfy an ONLINE
      -- obligation: the sale never waits for the network, and a failed upload is a retry, not a lost
      -- sale. The table exists NOW so that the shop with two years of sales in it does not have to
      -- migrate this table on the day the law arrives. (CLAUDE.md §2, PLAN.md §7.)
      CREATE TABLE sync_queue (
        id           INTEGER PRIMARY KEY,
        entity       TEXT NOT NULL,                 -- 'sale', ...
        entity_id    INTEGER NOT NULL,
        action       TEXT NOT NULL,                 -- 'create', 'void', ...
        payload_json TEXT,
        status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'failed')),
        created_at   TEXT NOT NULL
      );
      -- The drain: oldest pending first.
      CREATE INDEX idx_sync_queue_status ON sync_queue (status, created_at);
      CREATE INDEX idx_sync_queue_entity ON sync_queue (entity, entity_id);
    `)
  }
}
