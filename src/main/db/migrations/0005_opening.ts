import type { Migration } from './index'

/**
 * 0005 — THE OPENING SETUP. What the shop ALREADY HAS on the day it starts using this app.
 *
 * WHY THIS EXISTS AT ALL. Without it the app believes the shop began life with nothing: no stock, no
 * money in the till, nobody owing it anything and it owing nobody. Every report is then wrong from
 * day one — the first sale of a tin the shop bought last year shows a 100% profit, because as far as
 * the books are concerned that tin cost nothing. The opening balances are what make the very first
 * report tell the truth.
 *
 * WHAT IT CAPTURES — five things, and they are the whole of a small shop's day-one balance sheet:
 *
 *      opening stock      per product: how many, and what it cost
 *      opening cash       money in the till
 *      opening bank       money in the bank
 *      customer udhaar    what customers already owe the shop      (receivables)
 *      supplier dues      what the shop already owes suppliers     (payables)
 *
 * ...and all of it posts as BALANCED journals against OPENING BALANCE EQUITY (ACC.OPENING_BALANCE_EQUITY):
 *
 *      opening stock    ->  DR Inventory              CR Opening Balance Equity
 *      opening cash     ->  DR Cash in Hand           CR Opening Balance Equity
 *      opening bank     ->  DR Bank                   CR Opening Balance Equity
 *      customer udhaar  ->  DR Accounts Receivable    CR Opening Balance Equity
 *      supplier dues    ->  DR Opening Balance Equity CR Accounts Payable
 *
 * So OBE ends up credited with (Inventory + Cash + Bank + Receivables − Payables) — the shop's day-one
 * net worth. IF THE SHOP OWES MORE THAN IT OWNS, OBE LANDS ON THE DEBIT SIDE, and that is CORRECT: it
 * is a negative net worth, honestly stated. Nothing in this app should ever try to "fix" it.
 *
 * THESE TABLES ARE THE WIZARD'S WORKSHEET, NOT THE BOOKS. They hold what the owner typed while they
 * were still typing it — a draft they can come back to over three evenings with a stock sheet in hand.
 * The moment they commit, the real records are written where they belong: stock lines become
 * `stock_movements` (through stock.adjust(), which also posts the journal and sets the weighted-average
 * cost), and cash/bank/udhaar/dues become journals. Nothing reads these tables to answer "what is my
 * stock" or "what is in the till" — those answers come from the movements and the ledger, as they do
 * for every other day of the shop's life. Keeping the worksheet afterwards is what lets the owner see
 * WHAT THEY ENTERED on day one, months later, when a figure looks wrong.
 *
 * SCALES — the same three integer scales as everywhere else, and they are NOT interchangeable:
 *
 *      money  (opening_cash, opening_bank, amount, credit_limit)   INTEGER minor units,     2 dp
 *      cost   (unit_cost)                                          INTEGER ten-thousandths, 4 dp
 *      qty_m  (qty_m)                                              INTEGER thousandths,     3 dp
 *
 * Not one REAL column, here or anywhere.
 */
export const migration0005: Migration = {
  version: 5,
  name: 'opening setup: customers, opening stock, cash, bank, receivables, payables',
  up: (db) => {
    db.exec(`
      -- ── Customers ───────────────────────────────────────────────────────────
      -- MINIMAL, deliberately. The customer LEDGER, loyalty and per-customer pricing all arrive in
      -- Phase 7. This table exists NOW for one reason: opening udhaar has to be owed BY SOMEBODY.
      -- A receivable with no customer against it is a number nobody can ever collect.
      --
      -- type_lookup_id -> lookups('customer_type'). Never a hardcoded dropdown. (CLAUDE.md §4)
      -- credit_limit is 2-dp MONEY: how much udhaar this customer is allowed to run up. It is a
      -- LIMIT, not a balance — the balance is derived from the ledger, like everything else.
      CREATE TABLE customers (
        id             INTEGER PRIMARY KEY,
        name           TEXT NOT NULL,
        phone          TEXT,
        address        TEXT,
        type_lookup_id INTEGER REFERENCES lookups (id),
        credit_limit   INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),  -- 2 dp money
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      -- Assume 100k+ rows. The Sell screen looks a customer up by name, and by phone when two
      -- customers share a name — which, in a Pakistani neighbourhood shop, they will.
      CREATE INDEX idx_customers_name ON customers (name);
      CREATE INDEX idx_customers_active_name ON customers (is_active, name);
      CREATE INDEX idx_customers_phone ON customers (phone);
      CREATE INDEX idx_customers_type ON customers (type_lookup_id);

      -- ── Opening setup ───────────────────────────────────────────────────────
      -- ONE ROW, EVER (id = 1, enforced by the CHECK). A shop opens its books once.
      --
      -- status: 'draft'     the owner is still typing. Nothing has been posted. Edit freely.
      --         'committed' the journals and the stock movements are IN THE BOOKS.
      --
      -- Committing is a ONE-WAY DOOR, and the service must refuse to commit twice. Not because the
      -- second commit would fail loudly — it would succeed, and post the whole opening balance a
      -- SECOND time: double the stock, double the cash, double the equity, with the trial balance
      -- still balancing perfectly, because two balanced journals balance. Nothing would catch it.
      -- The status column is what makes that impossible.
      --
      -- Fixing a committed opening balance is NOT done by editing this row. It is done the way every
      -- other correction in this app is done: post an adjustment, with a reason and a name against it.
      -- (Forward-only, CLAUDE.md §4 — the books are append-only.)
      --
      -- go_live_date is the date the opening balances are AS AT: the journals and the stock movements
      -- are dated to it, not to the evening the owner happened to type them in. Defaulted to today so
      -- that the wizard can create this row before it has asked for the date — the last thing a
      -- cashier should ever see is a NOT NULL constraint error.
      CREATE TABLE opening_setup (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        status       TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'committed')),
        go_live_date TEXT NOT NULL DEFAULT (date('now')),
        opening_cash INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),  -- 2 dp money, in the till
        opening_bank INTEGER NOT NULL DEFAULT 0 CHECK (opening_bank >= 0),  -- 2 dp money, in the bank
        committed_at TEXT,
        committed_by INTEGER REFERENCES users (id),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        -- A committed setup knows who committed it and when. A draft has neither. This keeps the two
        -- states from ever half-existing.
        CHECK ((status = 'draft'     AND committed_at IS NULL AND committed_by IS NULL)
            OR (status = 'committed' AND committed_at IS NOT NULL))
      );

      -- ── Opening stock lines ─────────────────────────────────────────────────
      -- The stock sheet: one line per item, "I have 40 of these and they cost me 91.0417 each".
      --
      -- ONE LINE PER ITEM. Batch number and expiry are OPTIONAL and are only offered for products
      -- flagged track_batches (the service enforces that — this table cannot see the flag). An
      -- ordinary tin of beans is one line with no batch, and the owner is never made to invent a
      -- batch number for it. (Owner's decision.)
      --
      -- qty_m > 0: an opening line states what the shop HAS. "Minus three" is not an opening balance,
      -- it is a stock correction, and that goes through stock.adjust() with a reason code.
      --
      -- unit_cost is the 4-dp COST — what the shop PAID, not what it sells for. It is what the
      -- opening journal debits Inventory with, and what seeds the product's weighted-average cost.
      -- Zero is allowed (a free sample, a gift from a supplier): it posts no journal because there is
      -- no money to move, and the item still counts on the shelf.
      CREATE TABLE opening_stock_lines (
        id          INTEGER PRIMARY KEY,
        product_id  INTEGER NOT NULL REFERENCES products (id),
        qty_m       INTEGER NOT NULL CHECK (qty_m > 0),                    -- 3 dp qty
        unit_cost   INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),     -- 4 dp cost
        -- Both NULL for an ordinary item. Only a track_batches product carries them.
        -- A blank string is not a batch number — it is a NULL that got typed at. Forcing it to NULL
        -- here is what makes the partial unique index below actually mean "the un-batched line".
        batch_no    TEXT CHECK (batch_no IS NULL OR TRIM(batch_no) <> ''),
        expiry_date TEXT,                                                  -- ISO date, or NULL
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE (product_id, batch_no)
      );
      CREATE INDEX idx_opening_stock_lines_product ON opening_stock_lines (product_id);

      -- THE NULL HOLE IN THAT UNIQUE, and why this second index is not belt-and-braces.
      --
      -- In SQLite (and in the SQL standard) two NULLs are NOT equal, so UNIQUE (product_id, batch_no)
      -- happily allows FIVE rows for the same product as long as every batch_no is NULL. That is
      -- exactly the un-batched case — i.e. almost every line the shop will type. The owner
      -- double-enters a line, the wizard accepts both, and the shop's opening stock is silently
      -- doubled with a perfectly balanced journal behind it.
      --
      -- A partial unique index closes it: at most ONE line per product with no batch number. Batched
      -- products keep their many lines, one per batch, through the UNIQUE above.
      CREATE UNIQUE INDEX idx_opening_stock_lines_one_unbatched
        ON opening_stock_lines (product_id) WHERE batch_no IS NULL;

      -- ── Opening receivables — CUSTOMER UDHAAR ───────────────────────────────
      -- What customers already owe the shop on day one. DR Accounts Receivable, CR Opening Balance
      -- Equity.
      --
      -- ONE ROW PER CUSTOMER (UNIQUE), and no NULL hole this time — customer_id is NOT NULL, so the
      -- plain UNIQUE does what it says. The opening figure is a single "Rashid owes 12,400", not a
      -- list of the invoices behind it. Those invoices predate the app; the app was not there to
      -- record them, and inventing them would be inventing data (CLAUDE.md §7). What the shop needs
      -- is the balance, and the balance is what this holds.
      --
      -- amount > 0: a customer who owes nothing is not a receivable, they are just a customer. A
      -- customer in CREDIT (they overpaid) is a payable, and that is a Phase 7 conversation.
      CREATE TABLE opening_receivables (
        id          INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers (id),
        amount      INTEGER NOT NULL CHECK (amount > 0),   -- 2 dp money
        note        TEXT,
        created_at  TEXT NOT NULL,
        UNIQUE (customer_id)
      );

      -- ── Opening payables — SUPPLIER DUES ────────────────────────────────────
      -- What the shop already owes its suppliers on day one.
      -- DR Opening Balance Equity, CR Accounts Payable — the one leg of the opening entry that runs
      -- the other way, because it is the only one that is not something the shop OWNS.
      CREATE TABLE opening_payables (
        id          INTEGER PRIMARY KEY,
        supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
        amount      INTEGER NOT NULL CHECK (amount > 0),   -- 2 dp money
        note        TEXT,
        created_at  TEXT NOT NULL,
        UNIQUE (supplier_id)
      );
    `)
  }
}
