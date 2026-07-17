import type { Migration } from './index'

/**
 * 0019 — STOCK TAKE. The counting sheet: the shop walks its shelves, writes down what is actually
 * there, and the books are corrected to match.
 *
 * ── THE DOCUMENT WRAPS THE ENGINE. IT DOES NOT REPLACE IT. ──────────────────────────────────────────
 * There is ALREADY exactly one way stock changes by hand: `stock.adjust()`, which appends a movement,
 * keeps the weighted average honest and posts a balanced journal (DR/CR Stock Adjustment 5100). A stock
 * take is not a new kind of event — it is a BATCH of those, with a sheet of paper around it. So `apply`
 * calls stock.adjust() once per varying line and nothing else. It posts no journal of its own, invents
 * no account and writes no movement directly. If a future change finds itself calling ledger.post from
 * the stock-take service, that change is wrong: every derived figure in the app (the stock report, the
 * leakage report, COGS, the trial balance) already understands an adjustment, and would have to learn
 * about a second path separately. They do not, because there is nothing new to learn.
 *
 * ── WHY THE SHEET FREEZES WHAT THE BOOKS EXPECTED ───────────────────────────────────────────────────
 * `expected_qty_m` is captured AT THE MOMENT THE LINE IS COUNTED, not recomputed when the sheet is
 * applied — because it is EVIDENCE of what the books claimed when the counter was standing at the shelf
 * with a pen. That is the number the variance was calculated against and the number the owner will be
 * asked about. Recomputing it at apply time would silently rewrite the finding: count 8 against an
 * expected 10 (variance −2, a real loss worth investigating), sell 2 more before the sheet is applied,
 * and a recomputed expected of 8 would report a variance of 0. The theft would erase its own evidence.
 *
 *   THE COUNT WINS. THE VARIANCE IS HISTORY.
 *
 * `variance_qty_m` and the movement it posts are `counted − expected_AT_COUNT_TIME`. So a sale that
 * happens between the count and the apply is NOT undone by the sheet — it stays sold, and the
 * correction lands on top of it. On-hand after apply is therefore `counted + whatever legitimately
 * moved since`, which for the ordinary case (nothing moved) is exactly `counted`: what the counter saw.
 * This is what a stock take MEANS — a correction of the drift the books could not see, not a command to
 * force the shelf to a number that was true ten minutes ago. (Documented and tested by name.)
 *
 * ── EVERYTHING A LINE NEEDS TO EXPLAIN ITSELF IS FROZEN ONTO IT ─────────────────────────────────────
 * `name_snapshot` and `unit_cost`, like every frozen figure in this app: a product renamed or re-costed
 * next year must never rewrite what last year's sheet says was counted, or what the variance was worth.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Two new tables. Nothing existing is touched: `stock_movements` already carries the 'stock_take' type
 * (migration 0003) and lookups already seeds the 'stock_take' adjustment reason. A stock take is never
 * deleted — an abandoned sheet is evidence too, and "what did we count last March?" must stay answerable.
 */
export const migration0019: Migration = {
  version: 19,
  name: 'stock take: stock_takes, stock_take_lines',
  up: (db) => {
    db.exec(`
      -- ── The counting sheet ────────────────────────────────────────────────────
      CREATE TABLE stock_takes (
        id         INTEGER PRIMARY KEY,
        -- WHEN the count is FOR. The apply posts its movements at this instant, so a sheet counted on
        -- the 31st and applied on the 2nd corrects the month it belongs to -- if that month is still
        -- open. A locked month refuses it, which is exactly the point of locking one.
        at         TEXT    NOT NULL,

        -- open     -> being counted; lines can still be added and changed
        -- counted  -> counting finished, waiting to be applied (a supervisor may want to look first)
        -- applied  -> the movements are posted. TERMINAL. The sheet is now history and cannot change.
        -- cancelled-> abandoned without applying. Also terminal. The sheet stays; it is evidence.
        status     TEXT    NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'counted', 'applied', 'cancelled')),

        user_id    INTEGER REFERENCES users (id),   -- who opened the sheet
        note       TEXT,

        -- WHO applied it and WHEN. Null until then. The audit log carries the same fact with the
        -- variance total against it; this is here so the sheet itself can say who signed it off.
        applied_at      TEXT,
        applied_by      INTEGER REFERENCES users (id),

        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
      CREATE INDEX idx_stock_takes_status ON stock_takes (status, at DESC);
      CREATE INDEX idx_stock_takes_at     ON stock_takes (at DESC);

      -- ── What was counted, line by line ────────────────────────────────────────
      CREATE TABLE stock_take_lines (
        id            INTEGER PRIMARY KEY,
        stock_take_id INTEGER NOT NULL REFERENCES stock_takes (id) ON DELETE CASCADE,
        product_id    INTEGER NOT NULL REFERENCES products (id),

        -- FROZEN: what the item was CALLED when it was counted. A rename must not rewrite the sheet.
        name_snapshot TEXT    NOT NULL,

        -- 3-dp thousandths, all three (CLAUDE.md §4: quantity is never a float).
        -- What the counter physically saw on the shelf. May be 0 (the shelf was empty) but never
        -- negative -- you cannot count minus three tins.
        counted_qty_m  INTEGER NOT NULL CHECK (counted_qty_m >= 0),
        -- FROZEN: what the books said at the instant of counting. CAN be negative -- an oversold item
        -- is a real state of the books, and it is precisely the state a stock take exists to find.
        expected_qty_m INTEGER NOT NULL,
        -- counted - expected, stored so the sheet reads back exactly as it was found. Signed:
        -- negative = stock is MISSING (the expensive one), positive = more on the shelf than booked.
        variance_qty_m INTEGER NOT NULL,

        -- FROZEN: the 4-dp weighted-average cost the variance is valued at, read at counting time. This
        -- is what stock.adjust will post the movement at, so the sheet's own "what did this cost us"
        -- figure and the journal can never disagree.
        unit_cost      INTEGER NOT NULL CHECK (unit_cost >= 0),

        -- The movement this line posted, stamped by apply(). NULL means: not applied yet, OR applied
        -- with a zero variance -- a line that found the books already correct posts NOTHING, because a
        -- zero movement is a row claiming something happened while recording that nothing did.
        movement_id    INTEGER REFERENCES stock_movements (id),

        counted_at     TEXT    NOT NULL,
        counted_by     INTEGER REFERENCES users (id),
        created_at     TEXT    NOT NULL,
        updated_at     TEXT    NOT NULL,

        -- ONE line per product per sheet. Counting the same tin twice on one sheet is a mistake, not a
        -- second opinion -- setCount UPDATES the line instead. Without this, two lines would each post
        -- their own correction and the second would "fix" a shelf the first had already fixed.
        UNIQUE (stock_take_id, product_id)
      );
      CREATE INDEX idx_stock_take_lines_take    ON stock_take_lines (stock_take_id);
      CREATE INDEX idx_stock_take_lines_product ON stock_take_lines (product_id);
    `)
  }
}
