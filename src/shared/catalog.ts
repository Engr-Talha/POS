import { z } from 'zod'

/**
 * THE CATALOG CONTRACT — the types and input schemas main and renderer agree on. (Migration 0003.)
 *
 * THREE INTEGER SCALES LIVE IN THIS FILE AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   money  — INTEGER minor units (paisa), 2 dp     retailPrice, wholesalePrice, stockValue
 *            helpers: shared/money.ts   (parseMoney / formatMoney)
 *   cost   — INTEGER ten-thousandths,    4 dp      costPrice, unitCost, supplierPrice, pack cost
 *            helpers: shared/cost.ts    (parseCost / formatCost / costPerUnit / costToPriceMinor)
 *   qty_m  — INTEGER thousandths,        3 dp      qtyM, minStockM, packSize, onHandM
 *            helpers: shared/qty.ts     (parseQty / formatQty)
 *
 * Passing a cost to formatMoney() prints a number a hundred times too big. Convert explicitly with
 * costToPriceMinor(). Nothing here is ever a float.
 *
 * STOCK IS DERIVED. `onHandM` is always SUM(stock_movements.qty_m) — computed on read, never stored,
 * never editable. There is no field anywhere in this file that lets anyone type a stock figure in.
 * To change stock you post a movement, with a reason and your name against it.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const ITEM_TYPES = ['inventory', 'non_inventory'] as const
export type ItemType = (typeof ITEM_TYPES)[number]

export const PRICE_ENTRY_MODES = ['inclusive', 'exclusive'] as const
export type PriceEntryMode = (typeof PRICE_ENTRY_MODES)[number]

/**
 * Every way stock can move. `sale`, `purchase`, `sale_return` and `purchase_return` are posted by
 * those documents' own services and are NEVER posted by hand — see MANUAL_MOVEMENT_TYPES.
 */
export const STOCK_MOVEMENT_TYPES = [
  'opening',
  'purchase',
  'sale',
  'sale_return',
  'purchase_return',
  'adjustment',
  'damage',
  'stock_take'
] as const
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number]

/**
 * The only movement types a human may post directly from the stock screen. A sale movement must come
 * from a sale — otherwise stock and the sales ledger drift apart with nothing to reconcile them.
 */
export const MANUAL_MOVEMENT_TYPES = ['opening', 'adjustment', 'damage', 'stock_take'] as const
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number]

export const SERIAL_STATUSES = ['in_stock', 'sold', 'returned'] as const
export type SerialStatus = (typeof SERIAL_STATUSES)[number]

// ── Row types ────────────────────────────────────────────────────────────────

// NOTE: the SUPPLIER record type and its create/update/list schemas live in '@shared/suppliers' —
// the canonical party contract shared with the Suppliers screen, the supplier ledger and the
// `supplier:*` IPC channels. This file owns only `ProductSupplier` (the product↔supplier LINK, the
// "Multiple Suppliers" grid), which is a different thing.

export type VariantGroup = {
  id: number
  name: string
  /** The axes the children vary on, e.g. ["size", "colour"]. */
  attributeKeys: string[]
}

export type Product = {
  id: number
  /** Legacy "STOCK CODE". */
  sku: string
  name: string
  /** Urdu. Printed on the receipt. */
  nameOtherLang: string | null

  // All lookups-driven. Never a hardcoded <Select>.
  departmentId: number | null
  categoryId: number | null
  subCategoryId: number | null
  brandId: number | null
  locationId: number | null
  favouriteGroupId: number | null

  /** lookups('uom'). The BASE unit. Every qtyM in the app is in this unit. */
  saleUomId: number
  /** Legacy "SIZE (VOLUME)", free text, e.g. "1.5 L". */
  sizeVolume: string | null

  /** 4-dp COST — weighted average. NOT money. */
  costPrice: number
  /** 2-dp money minor units. */
  retailPrice: number
  /** 2-dp money minor units. */
  wholesalePrice: number

  /** Basis points: 17% = 1700. */
  taxRateBp: number
  priceEntryMode: PriceEntryMode
  isTaxExempt: boolean

  itemType: ItemType
  trackBatches: boolean
  trackSerials: boolean
  isWeighted: boolean

  /** RE-ORDER LEVEL, in qty_m. */
  minStockM: number
  imagePath: string | null

  variantGroupId: number | null
  /** {"size":"M","colour":"red"} — keys come from the variant group. */
  attributes: Record<string, string> | null

  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ProductBarcode = {
  id: number
  productId: number
  barcode: string
  /** The one printed on new labels. At most one per product. */
  isPrimary: boolean
}

export type BarcodeReplacement = {
  id: number
  productId: number
  oldBarcode: string
  newBarcode: string
  at: string
  userId: number | null
}

/**
 * The legacy "ALTERNATE PACKINGS" grid. Buy a carton, sell a piece.
 * `packSize` is qty_m OF THE BASE SALE UNIT: a carton of 24 pieces is 24000.
 */
export type ProductPack = {
  id: number
  productId: number
  /** lookups('uom'). */
  uomId: number
  /** qty_m of base units in one pack. Carton of 24 -> 24000. */
  packSize: number
  /** 4-dp cost. */
  cost: number
  /** 2-dp money. */
  retailPrice: number
  /** 2-dp money. */
  wholesalePrice: number
  /** Scanning this sells the PACK, not one base unit. Unique across packs AND product_barcodes. */
  barcode: string | null
  /** Exactly one base pack per product (packSize = 1000). */
  isBase: boolean
}

export type ProductSupplier = {
  id: number
  productId: number
  supplierId: number
  /** What THIS supplier calls it. Goes on the purchase order. */
  supplierItemCode: string | null
  /** 4-dp cost. */
  supplierPrice: number
  /** Basis points off the supplier price: 5% = 500. */
  discountBp: number
  isPreferred: boolean
  /** Convenience for lists — joined, not stored. */
  supplierName?: string
}

export type Batch = {
  id: number
  productId: number
  batchNo: string
  /** ISO date. Null = does not expire. */
  expiryDate: string | null
  /** 4-dp cost — what THIS batch cost. */
  cost: number
}

export type SerialNumber = {
  id: number
  productId: number
  serial: string
  status: SerialStatus
  purchaseId: number | null
  saleId: number | null
  at: string
}

export type StockMovement = {
  id: number
  at: string
  type: StockMovementType
  productId: number
  batchId: number | null
  /** SIGNED qty_m: + into the shop, − out of it. Never zero. */
  qtyM: number
  /** 4-dp cost at the moment of the movement. Frozen — never recomputed from today's average. */
  unitCost: number
  refType: string | null
  refId: string | null
  reasonCode: string | null
  note: string | null
  userId: number | null
  /** Convenience for the history screen — joined, not stored. */
  userName?: string
}

/** Stock on hand. DERIVED: onHandM is SUM(stock_movements.qty_m). Never a stored column. */
export type StockLevel = {
  productId: number
  sku: string
  name: string
  /** SUM of every movement's qty_m, in qty_m. Can be negative — a negative-stock sale is allowed. */
  onHandM: number
  /** Re-order level, qty_m. */
  minStockM: number
  /** onHandM <= minStockM. What the low-stock report filters on. */
  isBelowReorder: boolean
  /** 4-dp weighted-average cost. */
  avgCost: number
  /** onHand x avgCost, converted to 2-dp money minor units for display. */
  stockValueMinor: number
}

/** A row in the products list. Carries the derived stock so the list needs no second call. */
export type ProductListItem = Pick<
  Product,
  | 'id'
  | 'sku'
  | 'name'
  | 'nameOtherLang'
  | 'categoryId'
  | 'brandId'
  | 'itemType'
  | 'costPrice'
  | 'retailPrice'
  | 'wholesalePrice'
  | 'minStockM'
  | 'isActive'
> & {
  /** DERIVED from stock_movements. Read-only, always. */
  onHandM: number
  isBelowReorder: boolean
  primaryBarcode: string | null
  categoryLabel: string | null
  brandLabel: string | null
  /** The shelf. Searchable already; shown so "what is meant to be here?" is answerable at a glance. */
  locationLabel: string | null
}

/** Everything the product form needs, in one call. */
export type ProductDetail = {
  product: Product
  barcodes: ProductBarcode[]
  packs: ProductPack[]
  suppliers: ProductSupplier[]
  batches: Batch[]
  /** BALANCE QUANTITY on the form — READ-ONLY. Derived from movements. */
  stock: StockLevel
}

/** The legacy "SHOW HISTORY" panel. */
export type ProductHistory = {
  movements: StockMovement[]
  /** Price changes, straight from the audit log. */
  priceChanges: {
    at: string
    userName: string
    userRole: string
    field: string
    before: string | null
    after: string | null
  }[]
}

/** Every list in this app is paginated — assume 100k+ rows. (CLAUDE.md §4) */
export type PagedResult<T> = {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches a service. The renderer is not trusted to have
// validated anything.
//
// UPDATE SCHEMAS CARRY ONLY EDITABLE FIELDS, and every field is optional:
//   undefined -> "the form did not touch this; leave it alone"
//   null      -> "the user cleared it"  (that is what .nullish() is for)
// We NEVER post a whole object back to a save endpoint — that is how the fields a form never loaded
// get wiped. (CLAUDE.md §4, trap #18)

/** Integer money, in minor units. Never a float. */
const MoneyMinor = z.number().int().min(0)
/** Integer cost, in ten-thousandths. A DIFFERENT scale from money. */
const CostUnits = z.number().int().min(0)
/** Integer quantity, in thousandths. Unsigned — a signed qty is spelled out where it is allowed. */
const QtyM = z.number().int().min(0)
/** A lookups(id). */
const LookupId = z.number().int().positive()
const RowId = z.number().int().positive()

const Sku = z.string().trim().min(1, 'Please enter a stock code.').max(50)
const ProductName = z.string().trim().min(1, 'Please enter an item name.').max(200)
const Barcode = z.string().trim().min(1, 'Please enter a barcode.').max(64)
const TaxRateBp = z.number().int().min(0).max(100_000)
const DiscountBp = z.number().int().min(0).max(10_000)

// ── Suppliers ────────────────────────────────────────────────────────────────
// The supplier record and its create/update/list schemas are the canonical party contract and live
// in '@shared/suppliers' (used by the Suppliers screen, the supplier ledger and the `supplier:*` IPC
// channels). This file's only supplier-facing type is `ProductSupplier` — the product↔supplier LINK.

// ── Variant groups ───────────────────────────────────────────────────────────

export const CreateVariantGroupInput = z.object({
  name: z.string().trim().min(1, 'Please name this variant group.').max(200),
  /** The axes the children vary on, e.g. ["size", "colour"]. */
  attributeKeys: z.array(z.string().trim().min(1).max(50)).min(1, 'Add at least one attribute.')
})

// ── Products ─────────────────────────────────────────────────────────────────

/** A pack row as typed into the "Alternate Packings" grid. */
export const ProductPackInput = z.object({
  uomId: LookupId,
  /** qty_m of BASE units in one pack. Carton of 24 pieces -> 24000. */
  packSize: z.number().int().positive('A pack must hold at least some of the base unit.'),
  cost: CostUnits.default(0),
  retailPrice: MoneyMinor.default(0),
  wholesalePrice: MoneyMinor.default(0),
  barcode: Barcode.nullish(),
  isBase: z.boolean().default(false)
})

/** A supplier row as typed into the "Multiple Suppliers" grid. */
export const ProductSupplierInput = z.object({
  supplierId: RowId,
  supplierItemCode: z.string().trim().max(100).nullish(),
  supplierPrice: CostUnits.default(0),
  discountBp: DiscountBp.default(0),
  isPreferred: z.boolean().default(false)
})

/**
 * The whole legacy Item Detail form, on Save.
 *
 * NOTE WHAT IS ABSENT: there is no opening-stock field and no balance quantity. Stock cannot be
 * typed. To give a new product an opening balance you post an `opening` movement (AdjustStockInput),
 * which records who did it and why. The legacy form let you type over the balance; that is exactly
 * the habit this schema exists to break.
 */
export const CreateProductInput = z.object({
  sku: Sku,
  name: ProductName,
  /** Urdu. Prints on the receipt. */
  nameOtherLang: z.string().trim().max(200).nullish(),

  departmentId: LookupId.nullish(),
  categoryId: LookupId.nullish(),
  subCategoryId: LookupId.nullish(),
  brandId: LookupId.nullish(),
  locationId: LookupId.nullish(),
  favouriteGroupId: LookupId.nullish(),

  /** Required: every product is sold in SOME unit, and every qty_m is measured in it. */
  saleUomId: LookupId,
  sizeVolume: z.string().trim().max(100).nullish(),

  /** 4-dp cost. Seeded from the price chain in the form; re-averaged by every purchase after that. */
  costPrice: CostUnits.default(0),
  retailPrice: MoneyMinor.default(0),
  wholesalePrice: MoneyMinor.default(0),

  taxRateBp: TaxRateBp.default(0),
  priceEntryMode: z.enum(PRICE_ENTRY_MODES).default('exclusive'),
  isTaxExempt: z.boolean().default(false),

  itemType: z.enum(ITEM_TYPES).default('inventory'),
  trackBatches: z.boolean().default(false),
  trackSerials: z.boolean().default(false),
  isWeighted: z.boolean().default(false),

  /** RE-ORDER LEVEL, qty_m. */
  minStockM: QtyM.default(0),
  imagePath: z.string().trim().max(500).nullish(),

  variantGroupId: RowId.nullish(),
  attributes: z.record(z.string(), z.string()).nullish(),

  /** Saved in the same transaction as the product. The first one becomes primary if none is marked. */
  barcodes: z.array(Barcode).max(50).optional(),
  packs: z.array(ProductPackInput).max(20).optional(),
  suppliers: z.array(ProductSupplierInput).max(20).optional()
})

/**
 * ONLY the fields the product form edits. Packs, suppliers and barcodes have their own endpoints —
 * they are grids, not fields, and posting them back wholesale is how a row nobody touched disappears.
 */
export const UpdateProductInput = z.object({
  id: RowId,

  sku: Sku.optional(),
  name: ProductName.optional(),
  nameOtherLang: z.string().trim().max(200).nullish(),

  departmentId: LookupId.nullish(),
  categoryId: LookupId.nullish(),
  subCategoryId: LookupId.nullish(),
  brandId: LookupId.nullish(),
  locationId: LookupId.nullish(),
  favouriteGroupId: LookupId.nullish(),

  saleUomId: LookupId.optional(),
  sizeVolume: z.string().trim().max(100).nullish(),

  /**
   * NOTE: there is NO costPrice here, on purpose.
   *
   * cost_price is the weighted average of what the shop actually PAID — derived from
   * stock_movements, exactly like stock on hand. It is not a field you type; it is a consequence of
   * buying things. Letting the form write it (which it used to) meant editing an item's supplier
   * price silently revalued stock already sitting on the shelf, with no movement and no journal
   * behind it — so the ledger and the stock report quietly disagreed and nothing caught it.
   *
   * Retail and wholesale ARE typed by a human, so they stay. A change to either is a PRICE CHANGE
   * and the service audit-logs it (who, when, before, after).
   */
  retailPrice: MoneyMinor.optional(),
  wholesalePrice: MoneyMinor.optional(),

  taxRateBp: TaxRateBp.optional(),
  priceEntryMode: z.enum(PRICE_ENTRY_MODES).optional(),
  isTaxExempt: z.boolean().optional(),

  itemType: z.enum(ITEM_TYPES).optional(),
  trackBatches: z.boolean().optional(),
  trackSerials: z.boolean().optional(),
  isWeighted: z.boolean().optional(),

  minStockM: QtyM.optional(),
  imagePath: z.string().trim().max(500).nullish(),

  variantGroupId: RowId.nullish(),
  attributes: z.record(z.string(), z.string()).nullish(),

  isActive: z.boolean().optional()
  // NO STOCK FIELD. Stock is derived from movements and cannot be typed. This is not an oversight.
})

export const ProductListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** Matches sku, name, name_other_lang or barcode. */
  search: z.string().trim().max(100).optional(),
  departmentId: LookupId.optional(),
  categoryId: LookupId.optional(),
  subCategoryId: LookupId.optional(),
  brandId: LookupId.optional(),
  locationId: LookupId.optional(),
  favouriteGroupId: LookupId.optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  includeInactive: z.boolean().optional(),
  /** Only items at or below their re-order level. */
  belowReorderOnly: z.boolean().optional(),
  sortBy: z.enum(['name', 'sku', 'retail_price', 'on_hand']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
})

export const ProductGetInput = z.object({ id: RowId })

/** The scanner's hot path. Resolves against product_barcodes AND product_packs.barcode. */
export const ResolveBarcodeInput = z.object({
  barcode: Barcode
})

/** What a scan resolves to. A pack barcode sells the PACK — packSize base units at the pack price. */
export type BarcodeMatch = {
  product: Product
  /** Null when the scanned code is a plain product barcode (one base unit). */
  pack: ProductPack | null
}

// ── Barcodes ─────────────────────────────────────────────────────────────────

export const AddBarcodeInput = z.object({
  productId: RowId,
  barcode: Barcode,
  isPrimary: z.boolean().optional()
})

/**
 * The legacy "REPLACE BARCODE" panel.
 *
 * The old barcode is NOT deleted. It stops being primary and keeps resolving to this product
 * forever, because the labels carrying it are already stuck to stock sitting on the shelf, and those
 * tins have to keep scanning at the counter until the last one is sold.
 */
export const ReplaceBarcodeInput = z.object({
  productId: RowId,
  oldBarcode: Barcode,
  newBarcode: Barcode
})

// ── Packs ────────────────────────────────────────────────────────────────────

export const SaveProductPackInput = ProductPackInput.extend({
  /** Omitted = insert. Present = update that row. */
  id: RowId.optional(),
  productId: RowId
})

export const DeleteProductPackInput = z.object({ id: RowId })

// ── Product suppliers ────────────────────────────────────────────────────────

export const SaveProductSupplierInput = ProductSupplierInput.extend({
  id: RowId.optional(),
  productId: RowId
})

export const DeleteProductSupplierInput = z.object({ id: RowId })

// ── Batches ──────────────────────────────────────────────────────────────────

export const CreateBatchInput = z.object({
  productId: RowId,
  batchNo: z.string().trim().min(1, 'Please enter a batch number.').max(100),
  /** ISO date (YYYY-MM-DD). Null = does not expire. */
  expiryDate: z.string().trim().max(10).nullish(),
  cost: CostUnits.default(0)
})

export const BatchListInput = z.object({
  productId: RowId.optional(),
  /** Batches expiring on or before this ISO date — the near-expiry report. */
  expiringBefore: z.string().trim().max(10).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

// ── Serial numbers ───────────────────────────────────────────────────────────

export const AddSerialsInput = z.object({
  productId: RowId,
  serials: z.array(z.string().trim().min(1).max(100)).min(1, 'Please enter at least one serial.'),
  purchaseId: RowId.nullish()
})

export const SerialListInput = z.object({
  productId: RowId.optional(),
  status: z.enum(SERIAL_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

// ── Stock ────────────────────────────────────────────────────────────────────

/**
 * The ONLY way a human changes stock. There is no "set stock to N" anywhere in this app: you post a
 * movement, signed, with a reason code and your name on it, and the balance re-sums itself.
 *
 * `qtyM` is SIGNED — negative takes stock out (damage, shrinkage), positive puts it in.
 * `type` is restricted to the movements a person may post by hand: a `sale` movement can only ever
 * come from a sale, or stock and the sales ledger start telling different stories.
 */
export const AdjustStockInput = z.object({
  productId: RowId,
  type: z.enum(MANUAL_MOVEMENT_TYPES).default('adjustment'),
  qtyM: z
    .number()
    .int()
    .refine((v) => v !== 0, 'Please enter a quantity — it cannot be zero.'),
  /** 4-dp cost. Used for an `opening` movement; otherwise the product's average cost is applied. */
  unitCost: CostUnits.optional(),
  batchId: RowId.nullish(),
  /** From lookups('adjustment_reason'). Required: an unexplained stock change is a red flag. */
  reasonCode: z.string().trim().min(1, 'Please choose a reason.').max(50),
  note: z.string().trim().max(500).nullish()
})

export const StockLevelInput = z.object({ productId: RowId })

export const StockMovementListInput = z.object({
  productId: RowId.optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  /** ISO datetimes. */
  from: z.string().trim().max(30).optional(),
  to: z.string().trim().max(30).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

/** The legacy "SHOW HISTORY" button. */
export const ProductHistoryInput = z.object({
  productId: RowId,
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

// ── Inferred input types ─────────────────────────────────────────────────────

export type CreateVariantGroupInput = z.infer<typeof CreateVariantGroupInput>
export type ProductPackInput = z.infer<typeof ProductPackInput>
export type ProductSupplierInput = z.infer<typeof ProductSupplierInput>
export type CreateProductInput = z.infer<typeof CreateProductInput>
export type UpdateProductInput = z.infer<typeof UpdateProductInput>
export type ProductListInput = z.infer<typeof ProductListInput>
export type ProductGetInput = z.infer<typeof ProductGetInput>
export type ResolveBarcodeInput = z.infer<typeof ResolveBarcodeInput>
export type AddBarcodeInput = z.infer<typeof AddBarcodeInput>
export type ReplaceBarcodeInput = z.infer<typeof ReplaceBarcodeInput>
export type SaveProductPackInput = z.infer<typeof SaveProductPackInput>
export type DeleteProductPackInput = z.infer<typeof DeleteProductPackInput>
export type SaveProductSupplierInput = z.infer<typeof SaveProductSupplierInput>
export type DeleteProductSupplierInput = z.infer<typeof DeleteProductSupplierInput>
export type CreateBatchInput = z.infer<typeof CreateBatchInput>
export type BatchListInput = z.infer<typeof BatchListInput>
export type AddSerialsInput = z.infer<typeof AddSerialsInput>
export type SerialListInput = z.infer<typeof SerialListInput>
export type AdjustStockInput = z.infer<typeof AdjustStockInput>
export type StockLevelInput = z.infer<typeof StockLevelInput>
export type StockMovementListInput = z.infer<typeof StockMovementListInput>
export type ProductHistoryInput = z.infer<typeof ProductHistoryInput>
