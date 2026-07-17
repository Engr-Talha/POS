import type { DB } from '../db'
import { AppError, ErrorCode } from '@shared/result'
import type {
  Batch,
  BarcodeMatch,
  BarcodeReplacement,
  PagedResult,
  Product,
  ProductBarcode,
  ProductPack,
  ProductSupplier,
  SerialNumber,
  SerialStatus
} from '@shared/catalog'
import * as settings from './settings'
import { ONE_UNIT } from '@shared/qty'
import { normalizeBarcode } from '@shared/barcode'
// The supplier RECORD (create/update/list/getById) is the canonical party service. This file keeps
// only the product↔supplier LINK; it reaches into suppliers.getById to prove a supplier exists before
// linking a product to it. No cycle: suppliers.ts does not import catalog.ts.
import * as suppliers from './suppliers'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'

/**
 * CATALOG — the parts of the legacy "Item Detail" form that hang off a product:
 * its BARCODES, its ALTERNATE PACKINGS, its MULTIPLE SUPPLIERS, its BATCHES and its SERIALS.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import anywhere.
 * The IPC layer zod-validates, checks the permission, and wraps whatever comes back in a Result.
 *
 * FOUR THINGS IN HERE ARE LOAD-BEARING. Read them before changing anything.
 *
 * 1. AN OLD BARCODE NEVER STOPS SCANNING.
 *    When a barcode is replaced, the old row STAYS in product_barcodes. It only stops being the
 *    primary (the one printed on new labels). The tins already on the shelf carry the old label and
 *    they must keep ringing up at the counter until the last one is sold — possibly for years. A
 *    "replacement" that deleted the old code would strand real stock at the till. See replaceBarcode.
 *
 * 2. A BARCODE MUST BE UNIQUE ACROSS TWO TABLES, AND SQLITE CANNOT DO THAT.
 *    product_barcodes.barcode sells ONE BASE UNIT. product_packs.barcode sells THE PACK — 24 pieces
 *    at the carton price. Each column is UNIQUE in its own table, but nothing in the schema stops the
 *    same code appearing in both, or on two different products. That would make the scanner
 *    ambiguous: one beep, two possible answers. So the check lives here, in assertBarcodeAvailable,
 *    and it is called by every path that can create a barcode. It has tests.
 *
 * 3. STOCK IS NOT IN THIS FILE, AND THAT IS THE POINT.
 *    Nothing here writes to stock_movements and nothing here reads a stock column, because there is
 *    no stock column. On-hand is SUM(stock_movements.qty_m). Scanning a carton barcode returns the
 *    pack's packSize (24000 = 24 pieces) so the SALE moves 24 pieces of stock — this file supplies
 *    the multiplier, the sale supplies the movement.
 *
 * 4. THREE INTEGER SCALES, NEVER MIXED.
 *      money  2 dp  retail_price, wholesale_price       shared/money.ts
 *      cost   4 dp  cost, supplier_price                shared/cost.ts
 *      qty_m  3 dp  pack_size                           shared/qty.ts
 *    A pack of 24 pieces has pack_size = 24000, not 24. Nothing here is ever a float.
 */

// ── Row types (snake_case, straight from SQLite) ─────────────────────────────

type ProductRow = {
  id: number
  sku: string
  name: string
  name_other_lang: string | null
  department_id: number | null
  category_id: number | null
  sub_category_id: number | null
  brand_id: number | null
  location_id: number | null
  favourite_group_id: number | null
  sale_uom_id: number
  size_volume: string | null
  cost_price: number
  retail_price: number
  wholesale_price: number
  tax_rate_bp: number
  price_entry_mode: string
  is_tax_exempt: number
  item_type: string
  track_batches: number
  track_serials: number
  is_weighted: number
  min_stock_m: number
  image_path: string | null
  variant_group_id: number | null
  attributes_json: string | null
  is_active: number
  created_at: string
  updated_at: string
}

type BarcodeRow = {
  id: number
  product_id: number
  barcode: string
  is_primary: number
}

type PackRow = {
  id: number
  product_id: number
  uom_id: number
  pack_size: number
  cost: number
  retail_price: number
  wholesale_price: number
  barcode: string | null
  is_base: number
}

type ProductSupplierRow = {
  id: number
  product_id: number
  supplier_id: number
  supplier_item_code: string | null
  supplier_price: number
  discount_bp: number
  is_preferred: number
  supplier_name?: string
}

type BatchRow = {
  id: number
  product_id: number
  batch_no: string
  expiry_date: string | null
  cost: number
}

type SerialRow = {
  id: number
  product_id: number
  serial: string
  status: string
  purchase_id: number | null
  sale_id: number | null
  at: string
}

// ── Row → domain mappers ─────────────────────────────────────────────────────

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    nameOtherLang: row.name_other_lang,
    departmentId: row.department_id,
    categoryId: row.category_id,
    subCategoryId: row.sub_category_id,
    brandId: row.brand_id,
    locationId: row.location_id,
    favouriteGroupId: row.favourite_group_id,
    saleUomId: row.sale_uom_id,
    sizeVolume: row.size_volume,
    costPrice: row.cost_price,
    retailPrice: row.retail_price,
    wholesalePrice: row.wholesale_price,
    taxRateBp: row.tax_rate_bp,
    priceEntryMode: row.price_entry_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    isTaxExempt: Boolean(row.is_tax_exempt),
    itemType: row.item_type === 'non_inventory' ? 'non_inventory' : 'inventory',
    trackBatches: Boolean(row.track_batches),
    trackSerials: Boolean(row.track_serials),
    isWeighted: Boolean(row.is_weighted),
    minStockM: row.min_stock_m,
    imagePath: row.image_path,
    variantGroupId: row.variant_group_id,
    attributes: parseAttributes(row.attributes_json),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A corrupt attributes_json must never crash a scan. Worst case the variant chips don't show. */
function parseAttributes(json: string | null): Record<string, string> | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return null
  } catch {
    return null
  }
}

function toBarcode(row: BarcodeRow): ProductBarcode {
  return {
    id: row.id,
    productId: row.product_id,
    barcode: row.barcode,
    isPrimary: Boolean(row.is_primary)
  }
}

function toPack(row: PackRow): ProductPack {
  return {
    id: row.id,
    productId: row.product_id,
    uomId: row.uom_id,
    packSize: row.pack_size,
    cost: row.cost,
    retailPrice: row.retail_price,
    wholesalePrice: row.wholesale_price,
    barcode: row.barcode,
    isBase: Boolean(row.is_base)
  }
}

function toProductSupplier(row: ProductSupplierRow): ProductSupplier {
  const link: ProductSupplier = {
    id: row.id,
    productId: row.product_id,
    supplierId: row.supplier_id,
    supplierItemCode: row.supplier_item_code,
    supplierPrice: row.supplier_price,
    discountBp: row.discount_bp,
    isPreferred: Boolean(row.is_preferred)
  }
  if (row.supplier_name != null) link.supplierName = row.supplier_name
  return link
}

function toBatch(row: BatchRow): Batch {
  return {
    id: row.id,
    productId: row.product_id,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    cost: row.cost
  }
}

function toSerial(row: SerialRow): SerialNumber {
  return {
    id: row.id,
    productId: row.product_id,
    serial: row.serial,
    status: row.status as SerialStatus,
    purchaseId: row.purchase_id,
    saleId: row.sale_id,
    at: row.at
  }
}

// ── Shared little helpers ────────────────────────────────────────────────────

function pageOf(input: { page?: number | undefined; pageSize?: number | undefined }): {
  page: number
  pageSize: number
  offset: number
} {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** Scanners append whitespace and newlines. Trim, and nothing else — case can be significant. */
function normalizeCode(raw: string, what: string): string {
  // A barcode gets its AIM identifier (]C1, ]E0, …) stripped so it is STORED the same way it will later
  // be SEARCHED (findProductByBarcode uses the same normaliser). A non-barcode code — a SKU typed by
  // hand — has no AIM identifier, so normalizeBarcode only trims it, which is what we want anyway.
  const code = what === 'barcode' ? normalizeBarcode(raw) : raw.trim()
  if (!code) {
    throw new AppError(ErrorCode.VALIDATION, `Please enter a ${what}.`, `empty ${what}`)
  }
  return code
}

function productRow(db: DB, productId: number): ProductRow {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
    | ProductRow
    | undefined
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That item no longer exists.', `product id=${productId}`)
  }
  return row
}

function productLabel(db: DB, productId: number): string {
  const row = db.prepare('SELECT sku, name FROM products WHERE id = ?').get(productId) as
    | { sku: string; name: string }
    | undefined
  return row ? `${row.name} (${row.sku})` : `item #${productId}`
}

// ═════════════════════════════════════════════════════════════════════════════
// BARCODES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE CROSS-TABLE UNIQUENESS CHECK. (See note 2 in the header.)
 *
 * A barcode may exist in exactly ONE place in the whole database: one row of product_barcodes, or
 * one row of product_packs — never both, never twice. SQLite enforces uniqueness within each table
 * but has no way to enforce it across the two, so this is the only thing standing between the shop
 * and a scanner that beeps and rings up the wrong item.
 *
 * `ignore` lets a row keep its own barcode when it is being updated.
 */
export function assertBarcodeAvailable(
  db: DB,
  barcode: string,
  ignore: { barcodeId?: number; packId?: number } = {}
): void {
  // Pack barcodes now live in product_barcodes too (migration 0004), carrying a pack_id — so a pack
  // editing its OWN barcode must not collide with its own row.
  const existing = db
    .prepare('SELECT id, product_id, pack_id FROM product_barcodes WHERE barcode = ?')
    .get(barcode) as { id: number; product_id: number; pack_id: number | null } | undefined

  // Skip ONLY the row that belongs to the thing we are currently editing — a pack re-saving its own
  // barcode must not collide with itself. Everything else is a genuine clash.
  const isOwnRow =
    existing != null &&
    ((ignore.barcodeId != null && existing.id === ignore.barcodeId) ||
      (ignore.packId != null && existing.pack_id === ignore.packId))

  if (existing && !isOwnRow) {
    // Name it accurately: "a pack of Rice" is a very different thing to fix than "Rice".
    const owner =
      existing.pack_id != null
        ? `a pack of ${productLabel(db, existing.product_id)}`
        : productLabel(db, existing.product_id)

    throw new AppError(
      ErrorCode.VALIDATION,
      `Barcode ${barcode} is already used by ${owner}. A barcode can only belong to one item, or the scanner would not know which one to ring up.`,
      `barcode ${barcode} already on product_barcodes id=${existing.id} product=${existing.product_id} pack=${existing.pack_id}`
    )
  }

  const pack = db.prepare('SELECT id, product_id FROM product_packs WHERE barcode = ?').get(
    barcode
  ) as { id: number; product_id: number } | undefined

  if (pack && pack.id !== ignore.packId) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Barcode ${barcode} is already used by a pack of ${productLabel(db, pack.product_id)}. A barcode can only belong to one item, or the scanner would not know which one to ring up.`,
      `barcode ${barcode} already on product_packs id=${pack.id} product=${pack.product_id}`
    )
  }
}

export type AddBarcodeArgs = {
  productId: number
  barcode: string
  /** Print this one on new labels. The FIRST barcode on a product becomes primary automatically. */
  isPrimary?: boolean | undefined
}

export function addBarcode(db: DB, input: AddBarcodeArgs, now = new Date()): ProductBarcode {
  const barcode = normalizeCode(input.barcode, 'barcode')
  productRow(db, input.productId)
  assertBarcodeAvailable(db, barcode)

  const write = db.transaction((): number => {
    const hasAny = db
      .prepare('SELECT 1 FROM product_barcodes WHERE product_id = ? LIMIT 1')
      .pluck()
      .get(input.productId) as number | undefined

    // The first barcode a product ever gets is its primary — otherwise a product could end up with
    // barcodes and nothing to print on a label.
    const isPrimary = input.isPrimary ?? !hasAny

    if (isPrimary) demotePrimaryBarcode(db, input.productId)

    return Number(
      db
        .prepare(
          `INSERT INTO product_barcodes (product_id, barcode, is_primary, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.productId, barcode, isPrimary ? 1 : 0, now.toISOString()).lastInsertRowid
    )
  })

  return getBarcode(db, write())
}

/** Only one primary per product (partial unique index) — clear the old one before setting a new. */
function demotePrimaryBarcode(db: DB, productId: number): void {
  db.prepare('UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ? AND is_primary = 1').run(
    productId
  )
}

function getBarcode(db: DB, id: number): ProductBarcode {
  return toBarcode(
    db.prepare('SELECT * FROM product_barcodes WHERE id = ?').get(id) as BarcodeRow
  )
}

/** Every code that scans this item. The primary first — that is the one on new labels. */
export function listBarcodes(db: DB, productId: number): ProductBarcode[] {
  const rows = db
    .prepare(
      'SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, id ASC'
    )
    .all(productId) as BarcodeRow[]

  return rows.map(toBarcode)
}

/**
 * THE SCANNER'S HOT PATH. Everything else in this file can afford to be slow; this cannot.
 *
 * One prepared statement. Both arms of the UNION are exact-match lookups on a UNIQUE index
 * (product_barcodes.barcode, product_packs.barcode), so this is two B-tree seeks and a row fetch —
 * it does not care whether the shop has 100 products or 100,000.
 *
 * A PLAIN barcode resolves to the product and `pack: null` — sell one base unit.
 * A PACK barcode resolves to the product AND the pack, whose `packSize` is in qty_m of the BASE
 * unit: a carton of 24 pieces is 24000. The caller sells the pack at the PACK's price and moves
 * `packSize` of stock — which is how scanning one carton takes 24 pieces off the shelf.
 *
 * Returns null when nothing matches. An unknown barcode is an everyday event at a counter (a
 * customer's loyalty card, a coupon, a smudged label) — it is not an error, and it must not throw.
 */
export function findProductByBarcode(db: DB, rawBarcode: string): BarcodeMatch | null {
  // Normalise the SAME way the code was stored (addBarcode → normalizeCode → normalizeBarcode), or a
  // scanner that prepends an AIM identifier (]C1, ]E0, …) would search for a code that never matches
  // what is on file. Store and lookup must agree; this is the one place that guarantees they do.
  const barcode = normalizeBarcode(rawBarcode)
  if (!barcode) return null

  const row = db
    .prepare(
      // ONE table, ONE indexed lookup. The scanner is the hot path — a cashier with a queue is
      // waiting on this query, so it must be a single index hit, never a UNION of two scans.
      //
      // A barcode row with a pack_id is a PACK barcode (a carton of 24). Old pack barcodes are kept
      // as rows forever, so a carton label already stuck on shelf stock keeps scanning even after
      // the pack's barcode has been changed. That is the whole point of migration 0004.
      `SELECT p.*,
              k.id                AS pack_id,
              k.uom_id            AS pack_uom_id,
              k.pack_size         AS pack_pack_size,
              k.cost              AS pack_cost,
              k.retail_price      AS pack_retail_price,
              k.wholesale_price   AS pack_wholesale_price,
              b.barcode           AS pack_barcode,
              k.is_base           AS pack_is_base
       FROM product_barcodes b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN product_packs k ON k.id = b.pack_id
       WHERE b.barcode = @barcode
       LIMIT 1`
    )
    .get({ barcode }) as
    | (ProductRow & {
        pack_id: number | null
        pack_uom_id: number | null
        pack_pack_size: number | null
        pack_cost: number | null
        pack_retail_price: number | null
        pack_wholesale_price: number | null
        pack_barcode: string | null
        pack_is_base: number | null
      })
    | undefined

  if (!row) return null

  const product = toProduct(row)

  if (row.pack_id == null) return { product, pack: null }

  return {
    product,
    pack: toPack({
      id: row.pack_id,
      product_id: row.id,
      uom_id: row.pack_uom_id!,
      pack_size: row.pack_pack_size!,
      cost: row.pack_cost ?? 0,
      retail_price: row.pack_retail_price ?? 0,
      wholesale_price: row.pack_wholesale_price ?? 0,
      barcode: row.pack_barcode,
      is_base: row.pack_is_base ?? 0
    })
  }
}

export type ReplaceBarcodeArgs = {
  productId: number
  oldBarcode: string
  newBarcode: string
}

/**
 * THE LEGACY "REPLACE BARCODE" PANEL — and the whole reason it exists:
 *
 *      THE OLD BARCODE IS NOT DELETED. IT KEEPS SCANNING. FOREVER.
 *
 * A supplier reprints a label with a new number. Meanwhile forty tins carrying the OLD number are
 * already on the shelf, and a customer will bring one to the counter tomorrow, and next month, and
 * possibly next year. If "replace" removed the old code, every one of those tins would fail to scan
 * and a cashier with a queue would start typing prices in by hand.
 *
 * So a replacement does exactly three things:
 *   1. adds the new barcode and makes it PRIMARY (the one printed on new labels),
 *   2. DEMOTES the old barcode — it stays, it just isn't printed any more,
 *   3. records the swap in barcode_replacements: who, what, when.
 *
 * All three in one transaction. A test asserts the old code still resolves to the product afterwards.
 */
export function replaceBarcode(
  db: DB,
  input: ReplaceBarcodeArgs,
  userId: number | null = null,
  now = new Date()
): { old: ProductBarcode; new: ProductBarcode; replacement: BarcodeReplacement } {
  const oldBarcode = normalizeCode(input.oldBarcode, 'barcode')
  const newBarcode = normalizeCode(input.newBarcode, 'barcode')

  productRow(db, input.productId)

  if (oldBarcode === newBarcode) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'The new barcode is the same as the old one. Nothing to replace.',
      `replaceBarcode called with old === new (${oldBarcode})`
    )
  }

  const existing = db
    .prepare('SELECT * FROM product_barcodes WHERE barcode = ? AND product_id = ?')
    .get(oldBarcode, input.productId) as BarcodeRow | undefined

  if (!existing) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `Barcode ${oldBarcode} is not one of this item's barcodes, so it cannot be replaced.`,
      `old barcode ${oldBarcode} not found on product ${input.productId}`
    )
  }

  assertBarcodeAvailable(db, newBarcode)

  const write = db.transaction((): { newId: number; replacementId: number } => {
    // Demote every primary on this product — including the old code — before inserting the new
    // primary, or the partial unique index (one primary per product) refuses the insert.
    demotePrimaryBarcode(db, input.productId)

    const newId = Number(
      db
        .prepare(
          `INSERT INTO product_barcodes (product_id, barcode, is_primary, created_at)
           VALUES (?, ?, 1, ?)`
        )
        .run(input.productId, newBarcode, now.toISOString()).lastInsertRowid
    )

    // NOTE: no DELETE. Not here, not anywhere. The old row survives this function on purpose.
    const replacementId = Number(
      db
        .prepare(
          `INSERT INTO barcode_replacements
             (product_id, old_barcode, new_barcode, at, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.productId,
          oldBarcode,
          newBarcode,
          now.toISOString(),
          userId,
          now.toISOString()
        ).lastInsertRowid
    )

    return { newId, replacementId }
  })

  const { newId, replacementId } = write()

  const replacementRow = db
    .prepare('SELECT * FROM barcode_replacements WHERE id = ?')
    .get(replacementId) as {
    id: number
    product_id: number
    old_barcode: string
    new_barcode: string
    at: string
    user_id: number | null
  }

  return {
    old: getBarcode(db, existing.id),
    new: getBarcode(db, newId),
    replacement: {
      id: replacementRow.id,
      productId: replacementRow.product_id,
      oldBarcode: replacementRow.old_barcode,
      newBarcode: replacementRow.new_barcode,
      at: replacementRow.at,
      userId: replacementRow.user_id
    }
  }
}

/** The audit trail of every swap on this item, newest first. */
export function listBarcodeReplacements(db: DB, productId: number): BarcodeReplacement[] {
  const rows = db
    .prepare('SELECT * FROM barcode_replacements WHERE product_id = ? ORDER BY at DESC, id DESC')
    .all(productId) as Array<{
    id: number
    product_id: number
    old_barcode: string
    new_barcode: string
    at: string
    user_id: number | null
  }>

  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    oldBarcode: row.old_barcode,
    newBarcode: row.new_barcode,
    at: row.at,
    userId: row.user_id
  }))
}

// ═════════════════════════════════════════════════════════════════════════════
// PACKS — the legacy "ALTERNATE PACKINGS" grid
// ═════════════════════════════════════════════════════════════════════════════

export type PackArgs = {
  /** Omitted = insert. Present = update that row. */
  id?: number | undefined
  productId: number
  /** lookups('uom') — Pieces, Box, Carton. Never a hardcoded dropdown. */
  uomId: number
  /** qty_m of BASE units in one pack. A carton of 24 pieces is 24000, NOT 24. */
  packSize: number
  /** 4-dp cost. A carton is not simply 24 x the piece cost — the shop prices it on its own. */
  cost?: number | undefined
  /** 2-dp money. */
  retailPrice?: number | undefined
  /** 2-dp money. */
  wholesalePrice?: number | undefined
  /** Scanning this sells the PACK. Unique across product_packs AND product_barcodes. */
  barcode?: string | null | undefined
  /** The base unit itself. Exactly one per product, and its packSize is one whole unit (1000). */
  isBase?: boolean | undefined
}

/** Insert or update one row of the Alternate Packings grid. */
export function savePack(db: DB, input: PackArgs, now = new Date()): ProductPack {
  productRow(db, input.productId)

  if (!Number.isSafeInteger(input.packSize) || input.packSize <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A pack must contain at least some of the base unit. Please enter how many it holds.',
      `packSize=${input.packSize} (qty_m; a carton of 24 pieces is 24000)`
    )
  }

  const isBase = input.isBase ?? false

  // The base pack IS the base unit, so it holds exactly one of it. If the base row could hold 24,
  // "one unit" would mean two different things in the same product and every qty_m in the app —
  // stock, sales, cost — would be measured against a moving ruler.
  if (isBase && input.packSize !== ONE_UNIT) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'The base pack is the single unit this item is sold in, so it must hold exactly 1. Give the larger pack (box, carton) its own row instead.',
      `base pack packSize=${input.packSize}, expected ${ONE_UNIT}`
    )
  }

  const barcode = input.barcode == null || input.barcode.trim() === '' ? null : input.barcode.trim()
  if (barcode) assertBarcodeAvailable(db, barcode, input.id != null ? { packId: input.id } : {})

  const existingForUom = db
    .prepare('SELECT id FROM product_packs WHERE product_id = ? AND uom_id = ?')
    .get(input.productId, input.uomId) as { id: number } | undefined

  // One row per unit of measure: "sell as Carton" has to mean one unambiguous thing. Two carton
  // sizes means two lookups ("Carton (12)", "Carton (24)"), not two rows fighting over one word.
  if (existingForUom && existingForUom.id !== input.id) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This item already has a pack in that unit. Edit that pack, or choose a different unit.',
      `duplicate pack uom product=${input.productId} uom=${input.uomId}`
    )
  }

  // On an UPDATE, a field the form did not send must KEEP ITS OLD VALUE — it must not be reset to 0.
  //
  // This was `input.cost ?? 0`, which meant any save that did not resend the cost silently wiped the
  // pack's cost, retail and wholesale prices to zero. That is trap #18 wearing a different hat: never
  // let an absent field mean "set it to nothing". A carton priced Rs 2,300 would have quietly become
  // a carton priced Rs 0 — and it has a barcode, so it would then scan at the till as FREE.
  const existing =
    input.id != null
      ? (db
          .prepare('SELECT cost, retail_price, wholesale_price, barcode FROM product_packs WHERE id = ?')
          .get(input.id) as
          | { cost: number; retail_price: number; wholesale_price: number; barcode: string | null }
          | undefined)
      : undefined

  const cost = input.cost ?? existing?.cost ?? 0
  const retailPrice = input.retailPrice ?? existing?.retail_price ?? 0
  const wholesalePrice = input.wholesalePrice ?? existing?.wholesale_price ?? 0
  const finalBarcode = barcode ?? existing?.barcode ?? null

  // A PACK WITH NO RETAIL PRICE IS PURCHASE-ONLY, AND THAT IS LEGITIMATE.
  //
  // "Buy in cartons, sell in pieces" is the shop's normal way of working: the carton carries the
  // supplier's barcode (so a delivery can be scanned in) and has no selling price, because a carton
  // is never sold as a carton. Refusing to save it would break the main use case.
  //
  // The danger is only at the TILL: scanning such a carton to SELL it would ring up as free.
  // So the rule lives where the risk is —
  //
  //     >> PHASE 5 (Sell screen): a pack with retail_price <= 0 MUST NOT be sellable. Scanning it
  //     >> at the till is a receiving action, not a sale, and the sell path must refuse it rather
  //     >> than ring up a free carton. <<
  //
  // — and not here, where it would only get in the shopkeeper's way.

  const values = {
    productId: input.productId,
    uomId: input.uomId,
    packSize: input.packSize,
    cost,
    retailPrice,
    wholesalePrice,
    barcode: finalBarcode,
    isBase: isBase ? 1 : 0,
    now: now.toISOString()
  }

  const write = db.transaction((): number => {
    // Exactly one base pack per product (partial unique index) — demote before promoting.
    if (isBase) {
      db.prepare(
        'UPDATE product_packs SET is_base = 0, updated_at = ? WHERE product_id = ? AND is_base = 1'
      ).run(values.now, input.productId)
    }

    if (input.id != null) {
      const found = db.prepare('SELECT id FROM product_packs WHERE id = ?').get(input.id)
      if (!found) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That pack no longer exists.', `pack id=${input.id}`)
      }

      db.prepare(
        `UPDATE product_packs SET
           uom_id = @uomId, pack_size = @packSize, cost = @cost,
           retail_price = @retailPrice, wholesale_price = @wholesalePrice,
           barcode = @barcode, is_base = @isBase, updated_at = @now
         WHERE id = @id`
      ).run({ ...values, id: input.id })

      registerPackBarcode(db, input.productId, input.id, values.barcode, values.now)
      return input.id
    }

    const newId = Number(
      db
        .prepare(
          `INSERT INTO product_packs
             (product_id, uom_id, pack_size, cost, retail_price, wholesale_price, barcode, is_base,
              created_at, updated_at)
           VALUES
             (@productId, @uomId, @packSize, @cost, @retailPrice, @wholesalePrice, @barcode, @isBase,
              @now, @now)`
        )
        .run(values).lastInsertRowid
    )

    registerPackBarcode(db, input.productId, newId, values.barcode, values.now)
    return newId
  })

  return getPack(db, write())
}

/**
 * ADD the pack's barcode to product_barcodes — never overwrite, never delete.
 *
 * The pack's own `barcode` column holds its CURRENT label (that is what the form shows). But every
 * barcode a pack has ever carried stays as a row here, so a carton already sitting on the shelf with
 * an older label on it KEEPS SCANNING — and still resolves to the right pack, so it still moves 24
 * pieces of stock and not 1.
 *
 * This is the same promise product barcodes already make. A pack is no different: the label is on
 * physical stock in the shop, and we do not get to reach into the shop and re-sticker it.
 */
function registerPackBarcode(
  db: DB,
  productId: number,
  packId: number,
  barcode: string | null,
  now: string
): void {
  if (!barcode) return

  db.prepare(
    `INSERT OR IGNORE INTO product_barcodes (product_id, barcode, pack_id, is_primary, created_at)
     VALUES (?, ?, ?, 0, ?)`
  ).run(productId, barcode, packId, now)
}

/** Add a pack. Sugar over savePack for the "+ add packing" button. */
export function addPack(db: DB, input: Omit<PackArgs, 'id'>, now = new Date()): ProductPack {
  return savePack(db, input, now)
}

/** Edit an existing pack row. */
export function updatePack(
  db: DB,
  input: PackArgs & { id: number },
  now = new Date()
): ProductPack {
  return savePack(db, input, now)
}

function getPack(db: DB, id: number): ProductPack {
  return toPack(db.prepare('SELECT * FROM product_packs WHERE id = ?').get(id) as PackRow)
}

/** Every packing this item sells in. Base unit first, then the bigger packs. */
export function listPacks(db: DB, productId: number, includeRetired = false): ProductPack[] {
  // Retired packs are hidden from the Alternate Packings grid, but their rows (and their barcodes)
  // live on so that cartons already on the shelf keep scanning. See deletePack.
  const rows = db
    .prepare(
      `SELECT * FROM product_packs
       WHERE product_id = ? ${includeRetired ? '' : 'AND is_active = 1'}
       ORDER BY is_base DESC, pack_size ASC`
    )
    .all(productId) as PackRow[]

  return rows.map(toPack)
}

/**
 * RETIRE a pack. It is never hard-deleted.
 *
 * This used to be a DELETE, and a DELETE takes the pack's barcode down with it — while the cartons
 * carrying that barcode are still sitting on the shelf. The next one scanned would come up as an
 * unknown item and the cashier would be stuck in front of a customer.
 *
 * So the row stays, marked inactive: it disappears from the Alternate Packings grid and from any new
 * label you print, but the barcodes it owns keep resolving. Same reason a lookup deactivates instead
 * of deleting, and the same reason a sale from last year can still be reprinted.
 */
export function deletePack(db: DB, id: number, now = new Date()): void {
  const found = db.prepare('SELECT id, is_base FROM product_packs WHERE id = ?').get(id) as
    | { id: number; is_base: number }
    | undefined

  if (!found) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That pack no longer exists.', `pack id=${id}`)
  }

  // The base pack IS the unit the item's stock is measured in. Removing it would leave every qty_m
  // in the product's history measured against a ruler that no longer exists.
  if (found.is_base) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This is the item’s base unit, so it cannot be removed. Every quantity for this item is counted in it.',
      `attempt to remove base pack ${id}`
    )
  }

  db.prepare('UPDATE product_packs SET is_active = 0, updated_at = ? WHERE id = ?').run(
    now.toISOString(),
    id
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// THE LEGACY "MULTIPLE SUPPLIER" PANEL — the product↔supplier LINK
//
// The SUPPLIER RECORD itself (create / update / retire / read / list) is NOT here. It is the canonical
// party service in `services/suppliers.ts`, the mirror of `customers.ts`, and it is what the Suppliers
// screen, the supplier ledger and the `supplier:*` IPC channels all use. This file owns only the LINK
// between a product and a supplier — one product, many suppliers, each with their own item code and
// price — and it reaches into `suppliers.getById()` to prove a supplier exists before linking to it.
// ═════════════════════════════════════════════════════════════════════════════

export type LinkSupplierArgs = {
  /** Omitted = insert or update the existing link for this (product, supplier). */
  id?: number | undefined
  productId: number
  supplierId: number
  /** What THIS supplier calls the item. Goes on the purchase order and matches their invoice back. */
  supplierItemCode?: string | null | undefined
  /** 4-dp cost — THIS supplier's price. Two suppliers for one product will differ. */
  supplierPrice?: number | undefined
  /** Basis points off their price: 5% = 500. */
  discountBp?: number | undefined
  isPreferred?: boolean | undefined
}

/**
 * The legacy "MULTIPLE SUPPLIER" panel: one product, many suppliers, and EACH ONE has its own item
 * code and its own price. That is not a nicety — the supplier's invoice arrives with THEIR code on
 * it, and without this the shop cannot match it back to the product it bought.
 *
 * The link is upserted on (product_id, supplier_id): adding the same supplier twice edits the
 * existing row rather than failing on a constraint the cashier cannot interpret.
 */
export function linkSupplierToProduct(
  db: DB,
  input: LinkSupplierArgs,
  now = new Date()
): ProductSupplier {
  productRow(db, input.productId)
  suppliers.getById(db, input.supplierId) // throws NOT_FOUND in plain language if it is gone

  const existing = (
    input.id != null
      ? db.prepare('SELECT * FROM product_suppliers WHERE id = ?').get(input.id)
      : db
          .prepare('SELECT * FROM product_suppliers WHERE product_id = ? AND supplier_id = ?')
          .get(input.productId, input.supplierId)
  ) as ProductSupplierRow | undefined

  if (input.id != null && !existing) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That supplier link no longer exists.',
      `product_suppliers id=${input.id}`
    )
  }

  const discountBp = input.discountBp ?? existing?.discount_bp ?? 0
  if (discountBp < 0 || discountBp > 10_000) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A discount must be between 0% and 100%.',
      `discountBp=${discountBp}`
    )
  }

  const hasAny = db
    .prepare('SELECT 1 FROM product_suppliers WHERE product_id = ? LIMIT 1')
    .pluck()
    .get(input.productId) as number | undefined

  // The first supplier a product gets is the preferred one — the purchase form has to start
  // somewhere, and a product with suppliers but no default just makes the user pick every time.
  const isPreferred = input.isPreferred ?? (existing ? Boolean(existing.is_preferred) : !hasAny)

  const values = {
    productId: input.productId,
    supplierId: input.supplierId,
    supplierItemCode:
      input.supplierItemCode === undefined
        ? (existing?.supplier_item_code ?? null)
        : (input.supplierItemCode?.trim() || null),
    supplierPrice: input.supplierPrice ?? existing?.supplier_price ?? 0,
    discountBp,
    isPreferred: isPreferred ? 1 : 0,
    now: now.toISOString()
  }

  const write = db.transaction((): number => {
    // One preferred supplier per product (partial unique index) — demote before promoting.
    if (isPreferred) {
      db.prepare(
        'UPDATE product_suppliers SET is_preferred = 0, updated_at = ? WHERE product_id = ? AND is_preferred = 1'
      ).run(values.now, input.productId)
    }

    if (existing) {
      db.prepare(
        `UPDATE product_suppliers SET
           supplier_item_code = @supplierItemCode,
           supplier_price = @supplierPrice,
           discount_bp = @discountBp,
           is_preferred = @isPreferred,
           updated_at = @now
         WHERE id = @id`
      ).run({ ...values, id: existing.id })

      return existing.id
    }

    return Number(
      db
        .prepare(
          `INSERT INTO product_suppliers
             (product_id, supplier_id, supplier_item_code, supplier_price, discount_bp, is_preferred,
              created_at, updated_at)
           VALUES
             (@productId, @supplierId, @supplierItemCode, @supplierPrice, @discountBp, @isPreferred,
              @now, @now)`
        )
        .run(values).lastInsertRowid
    )
  })

  const id = write()

  return toProductSupplier(
    db
      .prepare(
        `SELECT ps.*, s.name AS supplier_name
         FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
         WHERE ps.id = ?`
      )
      .get(id) as ProductSupplierRow
  )
}

/** Everyone who sells us this item — each with their own code and their own price. Preferred first. */
export function listSuppliersForProduct(db: DB, productId: number): ProductSupplier[] {
  const rows = db
    .prepare(
      `SELECT ps.*, s.name AS supplier_name
       FROM product_suppliers ps
       JOIN suppliers s ON s.id = ps.supplier_id
       WHERE ps.product_id = ?
       ORDER BY ps.is_preferred DESC, s.name`
    )
    .all(productId) as ProductSupplierRow[]

  return rows.map(toProductSupplier)
}

export function unlinkSupplierFromProduct(db: DB, id: number): void {
  const found = db.prepare('SELECT id FROM product_suppliers WHERE id = ?').get(id)
  if (!found) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That supplier link no longer exists.',
      `product_suppliers id=${id}`
    )
  }
  db.prepare('DELETE FROM product_suppliers WHERE id = ?').run(id)
}

// ═════════════════════════════════════════════════════════════════════════════
// BATCHES
// ═════════════════════════════════════════════════════════════════════════════

export type AddBatchArgs = {
  productId: number
  batchNo: string
  /** ISO date (YYYY-MM-DD). Null = does not expire. */
  expiryDate?: string | null | undefined
  /** 4-dp cost — what THIS batch cost. */
  cost?: number | undefined
}

/**
 * A batch is a batch number and an expiry date. Only for products flagged track_batches — the
 * cashier never picks one at the till (FEFO auto-picks in Phase 5); this is what makes that possible
 * and what makes the near-expiry report tell the truth.
 */
export function addBatch(db: DB, input: AddBatchArgs, now = new Date()): Batch {
  const product = productRow(db, input.productId)

  if (!product.track_batches) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not set up for batch tracking. Turn on batch tracking for this item first.`,
      `addBatch on product ${product.id} with track_batches = 0`
    )
  }

  const batchNo = normalizeCode(input.batchNo, 'batch number')

  const clash = db
    .prepare('SELECT id FROM batches WHERE product_id = ? AND batch_no = ?')
    .get(input.productId, batchNo)

  if (clash) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Batch ${batchNo} already exists for this item.`,
      `duplicate batch product=${input.productId} batch_no=${batchNo}`
    )
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO batches (product_id, batch_no, expiry_date, cost, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.productId,
        batchNo,
        input.expiryDate?.trim() || null,
        input.cost ?? 0,
        now.toISOString()
      ).lastInsertRowid
  )

  return toBatch(db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow)
}

export type BatchListArgs = {
  productId?: number | undefined
  /** Batches expiring on or before this ISO date. */
  expiringBefore?: string | undefined
  page?: number | undefined
  pageSize?: number | undefined
}

export function listBatches(db: DB, input: BatchListArgs = {}): PagedResult<Batch> {
  const { page, pageSize, offset } = pageOf(input)

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.productId != null) {
    where.push('product_id = @productId')
    params['productId'] = input.productId
  }
  if (input.expiringBefore) {
    where.push('expiry_date IS NOT NULL AND expiry_date <= @expiringBefore')
    params['expiringBefore'] = input.expiringBefore
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db.prepare(`SELECT COUNT(*) FROM batches ${whereSql}`).pluck().get(params) as number

  // Nulls last: a batch that never expires is not "the most urgent thing in the shop".
  const rows = db
    .prepare(
      `SELECT * FROM batches ${whereSql}
       ORDER BY (expiry_date IS NULL), expiry_date ASC, id ASC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset }) as BatchRow[]

  return { rows: rows.map(toBatch), total, page, pageSize }
}

/**
 * A near-expiry batch, with the qty still on hand — which is DERIVED, like all stock, by summing the
 * movements against that batch. A batch nobody has any of left is not a problem to act on.
 */
export type NearExpiryBatch = Batch & {
  sku: string
  productName: string
  /** SUM(stock_movements.qty_m) for this batch, in qty_m. Derived, never stored. */
  onHandM: number
  /** Already past its expiry date as of the date asked about. */
  isExpired: boolean
}

export type NearExpiryArgs = {
  /** How far ahead to look. Default 30 days. */
  days?: number | undefined
  /** Treat this as "today" (tests, and reprinting last month's report). */
  asOf?: Date | undefined
  page?: number | undefined
  pageSize?: number | undefined
}

/**
 * THE NEAR-EXPIRY REPORT: what is about to go out of date, soonest first. Already-expired batches
 * are included — they are the most urgent thing on the list, not something to hide.
 */
export function nearExpiry(db: DB, input: NearExpiryArgs = {}): PagedResult<NearExpiryBatch> {
  const { page, pageSize, offset } = pageOf(input)

  const asOf = input.asOf ?? new Date()
  // How far ahead to look is the SHOP's call, not this file's (CLAUDE.md §4: if a number could
  // reasonably differ between two shops, it is a setting). A bakery worries weeks ahead; a hardware shop
  // never. `input.days` is the caller asking for one specific run; otherwise the owner's setting decides,
  // whose registry default is 30 — so a shop that never touched it sees exactly what it always saw.
  const days =
    input.days ??
    settings.get<number>(
      db,
      'stock.nearExpiryDays',
      REGISTRY_DEFAULTS['stock.nearExpiryDays'] as number
    )

  const horizon = new Date(asOf.getTime())
  horizon.setDate(horizon.getDate() + days)

  const today = isoDate(asOf)
  const before = isoDate(horizon)

  const total = db
    .prepare(
      'SELECT COUNT(*) FROM batches WHERE expiry_date IS NOT NULL AND expiry_date <= @before'
    )
    .pluck()
    .get({ before }) as number

  const rows = db
    .prepare(
      `SELECT b.*,
              p.sku  AS sku,
              p.name AS product_name,
              COALESCE((SELECT SUM(m.qty_m) FROM stock_movements m WHERE m.batch_id = b.id), 0)
                AS on_hand_m
       FROM batches b
       JOIN products p ON p.id = b.product_id
       WHERE b.expiry_date IS NOT NULL AND b.expiry_date <= @before
       ORDER BY b.expiry_date ASC, b.id ASC
       LIMIT @limit OFFSET @offset`
    )
    .all({ before, limit: pageSize, offset }) as Array<
    BatchRow & { sku: string; product_name: string; on_hand_m: number }
  >

  return {
    rows: rows.map((row) => ({
      ...toBatch(row),
      sku: row.sku,
      productName: row.product_name,
      onHandM: row.on_hand_m,
      isExpired: row.expiry_date != null && row.expiry_date < today
    })),
    total,
    page,
    pageSize
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// ═════════════════════════════════════════════════════════════════════════════
// SERIAL / IMEI NUMBERS
// ═════════════════════════════════════════════════════════════════════════════

export type AddSerialsArgs = {
  productId: number
  serials: string[]
  purchaseId?: number | null | undefined
}

/**
 * Capture serials — at purchase, and again matched at sale.
 *
 * ONLY for products flagged track_serials. A phone shop needs an IMEI against every handset; a
 * grocery does not, and must never be asked for one — a tin of beans has to scan in ONE keystroke.
 * That is why the flag is per product and why this refuses to run without it.
 *
 * All-or-nothing: twenty scanned handsets with one duplicate among them insert NOTHING, so the user
 * fixes the one bad code and rescans, rather than hunting for which nineteen already went in.
 */
export function addSerials(db: DB, input: AddSerialsArgs, now = new Date()): SerialNumber[] {
  const product = productRow(db, input.productId)

  if (!product.track_serials) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not set up for serial number tracking. Turn on serial tracking for this item first.`,
      `addSerials on product ${product.id} with track_serials = 0`
    )
  }

  const serials = input.serials.map((s) => normalizeCode(s, 'serial number'))
  if (serials.length === 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please enter at least one serial number.',
      'addSerials called with an empty list'
    )
  }

  // Duplicates inside the same batch of scans — caught before we touch the database.
  const seen = new Set<string>()
  for (const serial of serials) {
    if (seen.has(serial)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `Serial number ${serial} appears twice in this list.`,
        `duplicate serial within input: ${serial}`
      )
    }
    seen.add(serial)
  }

  const write = db.transaction((): number[] => {
    const findOne = db.prepare('SELECT product_id FROM serial_numbers WHERE serial = ?')
    const insert = db.prepare(
      `INSERT INTO serial_numbers (product_id, serial, status, purchase_id, at, created_at)
       VALUES (?, ?, 'in_stock', ?, ?, ?)`
    )

    const ids: number[] = []

    for (const serial of serials) {
      // A serial is unique across the WHOLE shop, not per product: an IMEI identifies one physical
      // handset, and two products claiming the same one means one of them is wrong.
      const clash = findOne.get(serial) as { product_id: number } | undefined
      if (clash) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `Serial number ${serial} is already recorded${
            clash.product_id === input.productId ? ' for this item' : ` for ${productLabel(db, clash.product_id)}`
          }.`,
          `duplicate serial ${serial} (existing product=${clash.product_id})`
        )
      }

      ids.push(
        Number(
          insert.run(
            input.productId,
            serial,
            input.purchaseId ?? null,
            now.toISOString(),
            now.toISOString()
          ).lastInsertRowid
        )
      )
    }

    return ids
  })

  const ids = write()
  const get = db.prepare('SELECT * FROM serial_numbers WHERE id = ?')
  return ids.map((id) => toSerial(get.get(id) as SerialRow))
}

/** One serial. Sugar over addSerials — same rules, same errors. */
export function addSerial(
  db: DB,
  input: { productId: number; serial: string; purchaseId?: number | null | undefined },
  now = new Date()
): SerialNumber {
  const args: AddSerialsArgs = { productId: input.productId, serials: [input.serial] }
  if (input.purchaseId !== undefined) args.purchaseId = input.purchaseId
  return addSerials(db, args, now)[0]!
}

/** What the counter needs when an IMEI is scanned: which item is this, and is it still ours to sell? */
export type SerialMatch = {
  serial: SerialNumber
  product: Product
}

export function findBySerial(db: DB, rawSerial: string): SerialMatch | null {
  const serial = rawSerial.trim()
  if (!serial) return null

  const row = db.prepare('SELECT * FROM serial_numbers WHERE serial = ?').get(serial) as
    | SerialRow
    | undefined

  if (!row) return null

  return {
    serial: toSerial(row),
    product: toProduct(productRow(db, row.product_id))
  }
}

/**
 * Sell one specific physical unit. A serial can only be sold once — selling it twice would mean the
 * shop has two of a handset it has one of, and the second customer is walking out with somebody
 * else's phone.
 *
 * `productId` IS REQUIRED, AND IT IS CHECKED. The caller must say WHICH item it believes it is selling,
 * and the serial has to actually belong to it.
 *
 * Without that check this function would happily mark an IMEI sold against a line for a completely
 * different product: the phone on the line leaves the shop with no serial recorded against it, while
 * some OTHER handset — still sitting in the cabinet — is marked sold and can never be sold again. Both
 * halves of that are silent. The renderer names the serials, and the renderer is not a security
 * boundary (CLAUDE.md §4), so the ownership check belongs here, where it cannot be skipped.
 */
export function markSold(
  db: DB,
  input: { productId: number; serial: string; saleId?: number | null | undefined },
  now = new Date()
): SerialNumber {
  const serial = normalizeCode(input.serial, 'serial number')

  const row = db.prepare('SELECT * FROM serial_numbers WHERE serial = ?').get(serial) as
    | SerialRow
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `Serial number ${serial} is not in stock. Check the number, or record it on the purchase first.`,
      `unknown serial ${serial}`
    )
  }

  if (row.status === 'sold') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Serial number ${serial} has already been sold.`,
      `serial ${serial} is already sold (sale_id=${row.sale_id})`
    )
  }

  if (row.product_id !== input.productId) {
    const owner = productRow(db, row.product_id)
    throw new AppError(
      ErrorCode.VALIDATION,
      `Serial number ${serial} belongs to "${owner.name}", not to the item on this line. Please scan the serial from the item you are selling.`,
      `serial ${serial} belongs to product ${row.product_id}, not ${input.productId}`
    )
  }

  db.prepare(
    `UPDATE serial_numbers SET status = 'sold', sale_id = ?, at = ? WHERE id = ?`
  ).run(input.saleId ?? null, now.toISOString(), row.id)

  return toSerial(db.prepare('SELECT * FROM serial_numbers WHERE id = ?').get(row.id) as SerialRow)
}

export type SerialListArgs = {
  productId?: number | undefined
  status?: SerialStatus | undefined
  search?: string | undefined
  page?: number | undefined
  pageSize?: number | undefined
}

export function listSerials(db: DB, input: SerialListArgs = {}): PagedResult<SerialNumber> {
  const { page, pageSize, offset } = pageOf(input)

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.productId != null) {
    where.push('product_id = @productId')
    params['productId'] = input.productId
  }
  if (input.status) {
    where.push('status = @status')
    params['status'] = input.status
  }

  const search = input.search?.trim()
  if (search) {
    where.push('serial LIKE @search')
    params['search'] = `%${search}%`
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(`SELECT COUNT(*) FROM serial_numbers ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT * FROM serial_numbers ${whereSql}
       ORDER BY at DESC, id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset }) as SerialRow[]

  return { rows: rows.map(toSerial), total, page, pageSize }
}
