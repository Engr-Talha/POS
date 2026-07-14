import type { Migration } from './index'

/**
 * 0003 — the catalog: products, barcodes, packs, suppliers, batches, serials, and stock movements.
 *
 * This migration is the schema behind the legacy "Item Detail" form the shop uses today. Every field
 * on that form has a home here, and a few of its habits deliberately do NOT:
 *
 *   THERE IS NO STOCK COLUMN ON products. Not one. Stock on hand is SUM(stock_movements.qty_m) and
 *   nothing else. The legacy form let a user type over the balance quantity, which is how a shop's
 *   stock figure and its stock history end up telling two different stories with no way to know which
 *   one lied. Here the balance quantity is READ-ONLY: it is derived, every time, from the movements.
 *   An opening figure is a movement (type='opening'). A correction is a movement (type='adjustment' or
 *   'stock_take') with a reason code and a user against it. (CLAUDE.md §4)
 *
 * SCALES — three different integer scales live in this file. They are NOT interchangeable:
 *
 *   money  (retail_price, wholesale_price)  INTEGER minor units,      2 dp   src/shared/money.ts
 *   cost   (cost_price, unit_cost, ...)     INTEGER ten-thousandths,  4 dp   src/shared/cost.ts
 *   qty_m  (qty_m, min_stock_m, pack_size)  INTEGER thousandths,      3 dp   src/shared/qty.ts
 *
 * Cost is 4 dp because a carton of 24 bought for Rs 2185 costs 91.0417 a piece, and rounding that to
 * the paisa on every purchase quietly falsifies a year of profit. Never pass a cost to formatMoney().
 *
 * There is not one REAL column here, and there never will be.
 */
export const migration0003: Migration = {
  version: 3,
  name: 'catalog: products, barcodes, packs, suppliers, batches, serials, stock movements',
  up: (db) => {
    db.exec(`
      -- ── Suppliers ───────────────────────────────────────────────────────────
      -- Minimal on purpose. The supplier LEDGER (purchases, payments, aging) arrives in Phase 7;
      -- what Phase 3 needs is somewhere for "this product is bought from these people, at these
      -- prices, under these item codes" to point.
      -- type_lookup_id -> lookups('supplier_type'). Never a hardcoded dropdown. (CLAUDE.md §4)
      CREATE TABLE suppliers (
        id             INTEGER PRIMARY KEY,
        name           TEXT NOT NULL,
        phone          TEXT,
        address        TEXT,
        type_lookup_id INTEGER REFERENCES lookups (id),
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX idx_suppliers_active ON suppliers (is_active, name);
      CREATE INDEX idx_suppliers_name ON suppliers (name);
      CREATE INDEX idx_suppliers_type ON suppliers (type_lookup_id);

      -- ── Variant groups ──────────────────────────────────────────────────────
      -- A group ("T-Shirt") names the AXES its children vary on: ["size","colour"]. Each child is a
      -- full product row with its OWN sku, barcode, price and stock — because that is what a shop
      -- actually counts and sells. The group only exists so the Sell screen can offer a picker
      -- instead of making the cashier hunt for "T-Shirt / M / Red" in a list of 400 SKUs.
      CREATE TABLE variant_groups (
        id                  INTEGER PRIMARY KEY,
        name                TEXT NOT NULL,
        attribute_keys_json TEXT NOT NULL DEFAULT '[]',
        created_at          TEXT NOT NULL
      );
      CREATE INDEX idx_variant_groups_name ON variant_groups (name);

      -- ── Products ────────────────────────────────────────────────────────────
      -- THE PRICE CHAIN from the legacy form:
      --     supplier price -> discount -> COST PRICE -> unit cost
      --                    -> RETAIL PRICE (+ profit %)
      --                    -> WHOLESALE PRICE (+ margin %)
      --                    -> net profit
      -- Only the ENDS of that chain are stored. Profit %, margin %, unit cost and net profit are
      -- COMPUTED from cost + price, live in the form and live on every report. Storing a typed-in
      -- profit % would let it drift out of step with the cost it was supposedly derived from, and
      -- then two screens disagree about what the shop earns.
      --
      -- cost_price is the WEIGHTED AVERAGE cost (shared/accounting.ts COSTING_METHOD), 4 dp. Every
      -- purchase re-averages it. It is a cache of the movement history in the same way stock is —
      -- except stock is cheap to re-sum and an average needs the running balance at each purchase,
      -- so this one is materialised. The purchase service owns it.
      --
      -- NOTE WHAT IS NOT HERE: no "stock" column. See the header. On-hand = SUM(stock_movements.qty_m).
      CREATE TABLE products (
        id                 INTEGER PRIMARY KEY,
        sku                TEXT NOT NULL UNIQUE,              -- legacy "STOCK CODE"
        name               TEXT NOT NULL,
        name_other_lang    TEXT,                              -- Urdu. Prints on the receipt.

        -- Every one of these is lookups-driven. No hardcoded <Select> anywhere in this app.
        department_id      INTEGER REFERENCES lookups (id),
        category_id        INTEGER REFERENCES lookups (id),
        sub_category_id    INTEGER REFERENCES lookups (id),
        brand_id           INTEGER REFERENCES lookups (id),
        location_id        INTEGER REFERENCES lookups (id),   -- aisle / shelf
        favourite_group_id INTEGER REFERENCES lookups (id),   -- the Sell screen's quick-pick tiles

        -- The BASE unit this product is sold in. Every qty_m in the app is in THIS unit.
        -- Larger packs (box, carton) are rows in product_packs that convert back to it.
        sale_uom_id        INTEGER NOT NULL REFERENCES lookups (id),
        size_volume        TEXT,                              -- legacy "SIZE (VOLUME)", e.g. "1.5 L"

        cost_price         INTEGER NOT NULL DEFAULT 0 CHECK (cost_price >= 0),      -- 4 dp, weighted avg
        retail_price       INTEGER NOT NULL DEFAULT 0 CHECK (retail_price >= 0),    -- 2 dp money
        wholesale_price    INTEGER NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0), -- 2 dp money

        tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0),     -- 17% = 1700
        -- Was the price above typed WITH tax in it or without? Both kinds may sit in one cart, so
        -- this is resolved per line at sale time and then FROZEN onto the sale line.
        price_entry_mode   TEXT NOT NULL DEFAULT 'exclusive'
                             CHECK (price_entry_mode IN ('inclusive', 'exclusive')),
        is_tax_exempt      INTEGER NOT NULL DEFAULT 0,

        -- non_inventory: a service or a bag charge. It sells, it earns, it has no stock and never
        -- appears on a stock report.
        item_type          TEXT NOT NULL DEFAULT 'inventory'
                             CHECK (item_type IN ('inventory', 'non_inventory')),

        track_batches      INTEGER NOT NULL DEFAULT 0,  -- batch_no + expiry. FEFO auto-pick: Phase 5.
        track_serials      INTEGER NOT NULL DEFAULT 0,  -- IMEI/serial captured at purchase and sale.
                                                        -- ONLY flagged products prompt — a tin of
                                                        -- beans must still scan in one keystroke.
        is_weighted        INTEGER NOT NULL DEFAULT 0,  -- sold by weight; qty comes from the scale

        min_stock_m        INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_m >= 0),  -- RE-ORDER LEVEL, qty_m
        image_path         TEXT,                                                 -- copied into app data

        variant_group_id   INTEGER REFERENCES variant_groups (id),
        attributes_json    TEXT,   -- {"size":"M","colour":"red"} — the keys come from the group

        is_active          INTEGER NOT NULL DEFAULT 1,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      -- Assume 100k+ rows: every column a list filters or sorts on gets an index. (CLAUDE.md §4)
      CREATE INDEX idx_products_name ON products (name);
      CREATE INDEX idx_products_active_name ON products (is_active, name);
      CREATE INDEX idx_products_department ON products (department_id);
      CREATE INDEX idx_products_category ON products (category_id);
      CREATE INDEX idx_products_sub_category ON products (sub_category_id);
      CREATE INDEX idx_products_brand ON products (brand_id);
      CREATE INDEX idx_products_location ON products (location_id);
      CREATE INDEX idx_products_favourite ON products (favourite_group_id);
      CREATE INDEX idx_products_sale_uom ON products (sale_uom_id);
      CREATE INDEX idx_products_variant_group ON products (variant_group_id);
      CREATE INDEX idx_products_item_type ON products (item_type, is_active);

      -- ── Product barcodes ────────────────────────────────────────────────────
      -- A product may have MANY barcodes. Scanning ANY of them finds it.
      --
      -- Barcodes are never deleted. When a supplier reprints a label with a new number, the old
      -- number is still stuck on the tins already sitting on the shelf, and those tins must still
      -- scan at the counter for as long as they exist. A "replaced" barcode simply stops being the
      -- primary one; it keeps resolving to the product forever. (See barcode_replacements.)
      CREATE TABLE product_barcodes (
        id         INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products (id),
        barcode    TEXT NOT NULL UNIQUE,
        is_primary INTEGER NOT NULL DEFAULT 0,  -- the one printed on new labels
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_product_barcodes_product ON product_barcodes (product_id);
      -- At most one primary per product, enforced by the database rather than by remembering to.
      CREATE UNIQUE INDEX idx_product_barcodes_one_primary
        ON product_barcodes (product_id) WHERE is_primary = 1;

      -- ── Barcode replacements ────────────────────────────────────────────────
      -- The audit trail behind the legacy "REPLACE BARCODE" panel: who swapped which number for
      -- which, and when. The old row in product_barcodes SURVIVES. This table only records the event.
      CREATE TABLE barcode_replacements (
        id          INTEGER PRIMARY KEY,
        product_id  INTEGER NOT NULL REFERENCES products (id),
        old_barcode TEXT NOT NULL,
        new_barcode TEXT NOT NULL,
        at          TEXT NOT NULL,
        user_id     INTEGER REFERENCES users (id),
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_barcode_replacements_product ON barcode_replacements (product_id, at DESC);

      -- ── Product packs ───────────────────────────────────────────────────────
      -- The legacy "ALTERNATE PACKINGS" grid. Buy a carton, sell a piece.
      --
      -- pack_size is in qty_m OF THE BASE SALE UNIT — a carton of 24 pieces is 24000. So one row is
      -- the base unit itself (is_base = 1, pack_size = 1000) and the bigger packs are more rows.
      -- Each pack carries its OWN cost, retail, wholesale AND barcode, because that is how the shop
      -- prices them: a carton is not simply 24 x the piece price.
      --
      -- A pack barcode is scannable exactly like a product barcode. It lives here rather than in
      -- product_barcodes because scanning it must select the PACK (24 pieces at the carton price),
      -- not one piece. The barcode-resolving service checks BOTH tables and MUST refuse to create a
      -- barcode that already exists in the other one — SQLite cannot enforce uniqueness across two
      -- tables, so that check is the service's job, and it has a test.
      CREATE TABLE product_packs (
        id              INTEGER PRIMARY KEY,
        product_id      INTEGER NOT NULL REFERENCES products (id),
        uom_id          INTEGER NOT NULL REFERENCES lookups (id),
        pack_size       INTEGER NOT NULL CHECK (pack_size > 0),  -- qty_m of base units in one pack
        cost            INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),             -- 4 dp
        retail_price    INTEGER NOT NULL DEFAULT 0 CHECK (retail_price >= 0),     -- 2 dp money
        wholesale_price INTEGER NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),  -- 2 dp money
        barcode         TEXT UNIQUE,
        is_base         INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_product_packs_product ON product_packs (product_id);
      CREATE INDEX idx_product_packs_uom ON product_packs (uom_id);
      -- Exactly one base pack per product, and one row per unit of measure: "sell as Carton" has to
      -- mean one unambiguous thing. (Two different carton sizes = two lookups, e.g. "Carton (12)".)
      CREATE UNIQUE INDEX idx_product_packs_one_base
        ON product_packs (product_id) WHERE is_base = 1;
      CREATE UNIQUE INDEX idx_product_packs_uom_unique
        ON product_packs (product_id, uom_id);

      -- ── Product suppliers ───────────────────────────────────────────────────
      -- The legacy "MULTIPLE SUPPLIER" panel. One product, many suppliers, and each of them has
      -- their OWN item code for it and their OWN price. supplier_item_code is what goes on the
      -- purchase order; it is how the supplier's invoice can be matched back to our product.
      --
      -- supplier_price is a 4-dp COST. discount_bp is basis points off it (5% = 500). The landed
      -- cost the purchase actually posts is computed at purchase time and frozen onto the purchase
      -- line — these two are the DEFAULTS the purchase form starts from, not history.
      CREATE TABLE product_suppliers (
        id                 INTEGER PRIMARY KEY,
        product_id         INTEGER NOT NULL REFERENCES products (id),
        supplier_id        INTEGER NOT NULL REFERENCES suppliers (id),
        supplier_item_code TEXT,
        supplier_price     INTEGER NOT NULL DEFAULT 0 CHECK (supplier_price >= 0),  -- 4 dp cost
        discount_bp        INTEGER NOT NULL DEFAULT 0
                             CHECK (discount_bp >= 0 AND discount_bp <= 10000),
        is_preferred       INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (product_id, supplier_id)
      );
      CREATE INDEX idx_product_suppliers_product ON product_suppliers (product_id);
      CREATE INDEX idx_product_suppliers_supplier ON product_suppliers (supplier_id);
      CREATE UNIQUE INDEX idx_product_suppliers_one_preferred
        ON product_suppliers (product_id) WHERE is_preferred = 1;

      -- ── Batches ─────────────────────────────────────────────────────────────
      -- Only for products with track_batches = 1. A batch is a batch number and an expiry date.
      -- The CASHIER NEVER PICKS ONE: the sale auto-picks first-expiry-first-out (Phase 5). This
      -- table and the batch_id on a movement are what make that possible, and what makes a
      -- near-expiry report tell the truth.
      CREATE TABLE batches (
        id          INTEGER PRIMARY KEY,
        product_id  INTEGER NOT NULL REFERENCES products (id),
        batch_no    TEXT NOT NULL,
        expiry_date TEXT,                                       -- ISO date. NULL = does not expire.
        cost        INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),  -- 4 dp, what THIS batch cost
        created_at  TEXT NOT NULL,
        UNIQUE (product_id, batch_no)
      );
      CREATE INDEX idx_batches_product ON batches (product_id);
      -- FEFO reads this index, and so does the near-expiry report.
      CREATE INDEX idx_batches_expiry ON batches (expiry_date, product_id);

      -- ── Serial numbers ──────────────────────────────────────────────────────
      -- Only for products with track_serials = 1 (phones, appliances). Captured at purchase, matched
      -- at sale, and freed again on a return. A grocery item never touches this table and never
      -- costs the cashier a keystroke for it.
      --
      -- purchase_id and sale_id are deliberately UNCONSTRAINED integers for now: the "purchases" and
      -- "sales" tables do not exist until Phases 7 and 5. They are seams, and a later migration can
      -- add the foreign keys without moving any data.
      CREATE TABLE serial_numbers (
        id          INTEGER PRIMARY KEY,
        product_id  INTEGER NOT NULL REFERENCES products (id),
        serial      TEXT NOT NULL UNIQUE,
        status      TEXT NOT NULL DEFAULT 'in_stock'
                      CHECK (status IN ('in_stock', 'sold', 'returned')),
        purchase_id INTEGER,   -- seam: FK added when the purchases table exists (Phase 7)
        sale_id     INTEGER,   -- seam: FK added when the sales table exists (Phase 5)
        at          TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_serial_numbers_product ON serial_numbers (product_id, status);
      CREATE INDEX idx_serial_numbers_status ON serial_numbers (status, at DESC);

      -- ── Stock movements ─────────────────────────────────────────────────────
      -- THE SINGLE SOURCE OF TRUTH FOR STOCK.
      --
      --     stock on hand = SUM(qty_m) WHERE product_id = ?
      --
      -- That is the whole definition. There is no stock column to fall out of step with it, no
      -- "recalculate stock" button, and no way for the number on the screen to disagree with the
      -- history that produced it. Every single thing that moves stock — an opening balance, a
      -- purchase, a sale, either kind of return, an adjustment, damage, a stock take — writes a row
      -- here, and stock is re-summed from them.
      --
      -- qty_m is SIGNED: + into the shop, − out of it. A zero movement is meaningless and is rejected
      -- by the CHECK: it would be a row that claims something happened while recording that nothing did.
      --
      -- unit_cost is the 4-dp cost AT THE MOMENT OF THE MOVEMENT, frozen. COGS on a sale from March
      -- must still read March's cost after ten more purchases have re-averaged it. Recomputing a
      -- historical line from today's numbers is how a profit report becomes fiction.
      --
      -- reason_code comes from lookups('adjustment_reason'). Every adjustment carries one, plus the
      -- user who made it — this table is where shrinkage either gets explained or gets noticed.
      CREATE TABLE stock_movements (
        id          INTEGER PRIMARY KEY,
        at          TEXT NOT NULL,
        type        TEXT NOT NULL CHECK (type IN (
                      'opening', 'purchase', 'sale', 'sale_return', 'purchase_return',
                      'adjustment', 'damage', 'stock_take'
                    )),
        product_id  INTEGER NOT NULL REFERENCES products (id),
        batch_id    INTEGER REFERENCES batches (id),
        qty_m       INTEGER NOT NULL CHECK (qty_m != 0),                   -- SIGNED: +in, −out
        unit_cost   INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),     -- 4 dp, frozen
        ref_type    TEXT,                                                  -- 'sale' | 'purchase' | ...
        ref_id      TEXT,                                                  -- the id of that document
        reason_code TEXT,                                                  -- lookups('adjustment_reason')
        note        TEXT,
        user_id     INTEGER REFERENCES users (id),
        created_at  TEXT NOT NULL
      );
      -- The on-hand sum and the item's history screen both read (product_id, at).
      CREATE INDEX idx_stock_movements_product ON stock_movements (product_id, at);
      CREATE INDEX idx_stock_movements_type ON stock_movements (type, at);
      CREATE INDEX idx_stock_movements_batch ON stock_movements (batch_id);
      -- Trace any movement back to the sale or purchase that caused it.
      CREATE INDEX idx_stock_movements_ref ON stock_movements (ref_type, ref_id);
    `)
  }
}
