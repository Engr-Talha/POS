import type { Migration } from './index'

/**
 * 0004 — pack barcodes become permanent, and packs retire instead of dying.
 *
 * THE RULE THIS FIXES (the owner was explicit about it): a barcode label already stuck on shelf stock
 * MUST KEEP SCANNING, FOREVER. Product barcodes already worked that way — many rows in
 * product_barcodes, and a "replacement" adds a new one without deleting the old.
 *
 * PACK barcodes did not. A pack (a carton of 24) held its barcode in a single column on
 * product_packs, so:
 *   - changing a carton's barcode OVERWROTE it, and every carton already on the shelf stopped
 *     scanning;
 *   - deleting a pack HARD-DELETED the row, taking a live shelf barcode down with it.
 *
 * The fix is to let a pack own MANY barcodes, exactly like a product does — by giving
 * product_barcodes an optional pack_id. A barcode row with a pack_id is a pack barcode: scanning it
 * finds the product AND tells the till it is a carton of 24, so one scan moves 24 pieces of stock
 * rather than 1.
 *
 * Forward-only: nothing is dropped, nothing is renamed, and the existing pack barcodes are copied
 * across rather than moved.
 */
export const migration0004: Migration = {
  version: 4,
  name: 'pack barcodes are permanent; packs retire instead of being deleted',
  up: (db) => {
    db.exec(`
      -- A barcode may now belong to a PACK as well as to the product.
      -- NULL pack_id = a plain product barcode (a single piece). This is the common case.
      ALTER TABLE product_barcodes ADD COLUMN pack_id INTEGER REFERENCES product_packs (id);

      -- Packs RETIRE. They are never deleted, because a retired pack's barcode must still resolve —
      -- there may be cartons of it sitting on the shelf right now.
      ALTER TABLE product_packs ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

      CREATE INDEX idx_product_barcodes_pack ON product_barcodes (pack_id);
    `)

    // Copy every existing pack barcode into product_barcodes so it resolves through the one place
    // the scanner looks. The column on product_packs stays (forward-only — we never drop a column
    // holding user data) and continues to hold the pack's CURRENT barcode for the form to show.
    db.exec(`
      INSERT OR IGNORE INTO product_barcodes (product_id, barcode, pack_id, is_primary, created_at)
      SELECT k.product_id, k.barcode, k.id, 0, COALESCE(k.created_at, datetime('now'))
      FROM product_packs k
      WHERE k.barcode IS NOT NULL AND TRIM(k.barcode) <> ''
    `)
  }
}
