import type { Migration } from './index'

/**
 * 0018 — PROMOTIONS. "Buy 2 get 1 free", "10% off Sunday", "Rs 50 off tea" — the shop's own offers,
 * applied automatically at the till so the cashier never has to remember one.
 *
 * ── A PROMOTION IS A DISCOUNT. THAT IS THE WHOLE DESIGN. ─────────────────────────────────────────────
 * It does not invent a new kind of money. It computes a LINE DISCOUNT, and from that point on it travels
 * the road that is already proven and already tested:
 *
 *     sale_lines.line_discount  →  priceCart re-resolves tax on what is ACTUALLY paid
 *                               →  DR Discounts Given (4200, contra-income) at its ex-tax value
 *                               →  frozen onto the line, so a return refunds what was really charged
 *
 * This is deliberate and it is the point of putting Phase 8 AFTER selling, returns and the ledger were
 * proven (see PLAN §6). A promotion that posted its own journal leg, or carried its own money column,
 * would be a SECOND path to the same place — and every derived figure in the app (returns, the profit
 * report, leakage, loyalty's earn basis, output tax) would have to learn about it separately. They do not,
 * because there is nothing new to learn: it is a line discount with a reason.
 *
 * ── WHAT A "FREE" ITEM ACTUALLY IS ──────────────────────────────────────────────────────────────────
 * Buy 2 get 1 free does NOT ring up a zero-price line. The free tin is rung at its normal price and
 * carries a 100% line discount. Three reasons, all of them things a shop gets audited on:
 *   · stock moves for all 3 tins, at cost — the shelf and the books agree,
 *   · the giveaway's cost is VISIBLE in Discounts Given, not hidden in a smaller Sales figure,
 *   · output tax is computed on what the customer actually pays, which is what the government wants.
 *
 * ── THE RULES ARE DATA, NOT CODE ────────────────────────────────────────────────────────────────────
 * A shop writes its own offers in Settings; nobody edits TypeScript to run a Sunday special (CLAUDE.md §4).
 * Hence `promotions` (the offer, its window, its priority) + `promotion_rules` (what it applies to).
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Three new tables. `sale_lines` is NOT touched: a promotion writes the line_discount column that has
 * existed since 0007. `sale_line_promotions` records WHICH offer gave WHICH line its discount, so the
 * shopkeeper can ask "what did that Sunday special actually cost me?" and get an answer.
 */
export const migration0018: Migration = {
  version: 18,
  name: 'promotions: promotions, promotion_rules, sale_line_promotions',
  up: (db) => {
    db.exec(`
      -- ── The offer ─────────────────────────────────────────────────────────────
      CREATE TABLE promotions (
        id            INTEGER PRIMARY KEY,
        name          TEXT    NOT NULL,          -- what the cashier and the customer see on the receipt
        description   TEXT,

        -- WHAT KIND of offer. The engine branches on this, so it is a CHECK, not a lookup: adding a kind
        -- means writing the code that computes it. (The offers themselves are data; the ARITHMETIC is not.)
        --   'percent_off'   n% off the matching lines
        --   'amount_off'    a fixed rupee amount off each matching unit
        --   'buy_x_get_y'   buy X, get Y of the same thing at 100% off (the cheapest ones are the free ones)
        --   'fixed_price'   the matching unit sells at this price instead of its own
        kind          TEXT    NOT NULL
                        CHECK (kind IN ('percent_off', 'amount_off', 'buy_x_get_y', 'fixed_price')),

        -- The knobs. Which are meaningful depends on kind; the SERVICE validates that pairing, because
        -- SQLite cannot express "percent_bp is required IF kind='percent_off'" without a CHECK per kind.
        percent_bp    INTEGER CHECK (percent_bp IS NULL OR (percent_bp > 0 AND percent_bp <= 10000)),
        amount_minor  INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),   -- 2-dp money
        buy_qty_m     INTEGER CHECK (buy_qty_m   IS NULL OR buy_qty_m   > 0),     -- 3-dp qty
        get_qty_m     INTEGER CHECK (get_qty_m   IS NULL OR get_qty_m   > 0),     -- 3-dp qty

        -- WHEN it runs. NULL start = "since forever", NULL end = "until further notice". Dates, not
        -- timestamps: a shop thinks in days. The service compares on the sale's own date.
        starts_on     TEXT,
        ends_on       TEXT,
        -- WHICH DAYS. NULL = every day. Otherwise a 7-char mask of '0'/'1', Monday first: '0000011' is
        -- weekends only. A mask, not a table, because it is one answer to one question.
        days_mask     TEXT    CHECK (days_mask IS NULL OR length(days_mask) = 7),

        -- WHICH COMES FIRST when two offers could both fire on one line. LOWER runs first. Only ONE
        -- promotion ever discounts a given line (the engine takes the first that matches) — stacking two
        -- offers on one tin is how a shop accidentally sells at a loss, so it is not the default. A shop
        -- that wants "10% off, then Rs 20 off" writes ONE offer that does that.
        priority      INTEGER NOT NULL DEFAULT 100,

        -- An offer is switched OFF, never deleted: last March's sales must still explain themselves.
        is_active     INTEGER NOT NULL DEFAULT 1,

        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );
      CREATE INDEX idx_promotions_active ON promotions (is_active, priority);

      -- ── What it applies to ────────────────────────────────────────────────────
      -- A promotion with NO rules applies to NOTHING. That is deliberate: an offer that silently applied
      -- to the whole shop because someone forgot to add a rule is a very expensive typo.
      CREATE TABLE promotion_rules (
        id           INTEGER PRIMARY KEY,
        promotion_id INTEGER NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,

        -- WHAT this rule matches on. 'product' one item; 'category'/'brand'/'department' a whole group
        -- (the lookup id); 'all' every stocked item (a shop-wide sale).
        scope        TEXT    NOT NULL CHECK (scope IN ('product', 'category', 'brand', 'department', 'all')),
        -- The thing matched: products.id for 'product', the lookup id for the group scopes, NULL for 'all'.
        target_id    INTEGER,

        created_at   TEXT    NOT NULL,

        -- 'all' takes no target; every other scope requires one. A rule that says "category: (nothing)"
        -- would match either everything or nothing depending on how the SQL fell out — so it cannot exist.
        CHECK ((scope = 'all' AND target_id IS NULL) OR (scope <> 'all' AND target_id IS NOT NULL))
      );
      CREATE INDEX idx_promotion_rules_promotion ON promotion_rules (promotion_id);
      CREATE INDEX idx_promotion_rules_scope     ON promotion_rules (scope, target_id);

      -- ── What an offer ACTUALLY cost, per line ─────────────────────────────────
      -- The audit trail for "was that Sunday special worth it?". One row per line a promotion discounted,
      -- carrying the FROZEN name and the FROZEN money it gave away — so a promotion later renamed, edited
      -- or switched off never rewrites what an old sale says it cost.
      CREATE TABLE sale_line_promotions (
        id             INTEGER PRIMARY KEY,
        sale_line_id   INTEGER NOT NULL REFERENCES sale_lines (id) ON DELETE CASCADE,
        promotion_id   INTEGER NOT NULL REFERENCES promotions (id),
        name_snapshot  TEXT    NOT NULL,                          -- FROZEN: what it was CALLED that day
        -- 2-dp money: the discount THIS offer gave THIS line. It is a component of sale_lines.line_discount
        -- (which stays the one figure the sale's own maths and its journal use — this is the WHY, not a
        -- second source of truth).
        discount_minor INTEGER NOT NULL CHECK (discount_minor >= 0),
        created_at     TEXT    NOT NULL
      );
      CREATE INDEX idx_sale_line_promotions_line      ON sale_line_promotions (sale_line_id);
      CREATE INDEX idx_sale_line_promotions_promotion ON sale_line_promotions (promotion_id);
    `)
  }
}
