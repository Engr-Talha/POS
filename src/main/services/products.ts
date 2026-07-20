import { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { normalizeBarcode } from '@shared/barcode'
import {
  CreateProductInput,
  CreateVariantGroupInput,
  ProductListInput,
  UpdateProductInput,
  type Batch,
  type PagedResult,
  type PriceEntryMode,
  type Product,
  type ProductDetail,
  type ProductListItem,
  type VariantGroup
} from '@shared/catalog'
import { costPerUnit, costToPriceMinor } from '@shared/cost'
import { ONE_UNIT, QTY_SCALE } from '@shared/qty'
import { BASIS_POINTS, priceExclusiveFromInclusive, priceInclusiveFromExclusive } from '@shared/tax'
import * as audit from './audit'
import * as catalog from './catalog'
import * as stock from './stock'

/**
 * THE PRODUCT CATALOGUE — the service behind the legacy "Item Detail" form.
 *
 * Read this before you touch anything below it.
 *
 * ── THREE SCALES, AND THEY ARE NOT INTERCHANGEABLE ──────────────────────────────────────────────
 *
 *   money  2 dp  integer minor units (paisa)   retailPrice, wholesalePrice, netProfit
 *   cost   4 dp  integer ten-thousandths       costPrice, unitCost, supplierPrice, pack cost
 *   qty_m  3 dp  integer thousandths           qtyM, minStockM, packSize
 *
 * A cost is NOT a price. Rs 2185 is 218500 as money and 21_850_000 as cost. Comparing one with the
 * other — "profit = retail − cost" written naively — is off by a factor of a hundred, and it would
 * misprice the entire shop. The ONLY bridge between the two is costToPriceMinor(). Every place in
 * this file where a cost meets a price goes through it, and that is not an accident.
 *
 * Cost is 4 dp because a carton of 24 bought for Rs 2185 costs Rs 91.041666… a piece. At 2 dp that is
 * 91.04, and the 0.0017 lost on every piece quietly falsifies a year of profit.
 *
 * ── STOCK IS DERIVED ────────────────────────────────────────────────────────────────────────────
 *
 * There is no stock column and no way to type a stock figure in. On-hand is SUM(stock_movements.qty_m),
 * computed on read, every time. The BALANCE QUANTITY on the legacy form was typeable; here it is
 * read-only, because a stock figure that disagrees with its own history is a figure nobody can trust.
 * To change stock you post a movement, with a reason and your name on it.
 *
 * ── DERIVED FIGURES ARE NEVER STORED ────────────────────────────────────────────────────────────
 *
 * Profit %, margin %, unit cost and net profit are computed from cost + price, here, in one place.
 * Storing a typed-in profit % lets it drift out of step with the cost it was supposedly derived from,
 * and then two screens disagree about what the shop earns.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PRICE CHAIN — pure functions, integer maths, no database.
//
//     supplier price (4dp) ──discount (bp)──▶ COST PRICE (4dp) ──▶ unit cost (4dp)
//                                                   │
//                                                   ├──▶ RETAIL PRICE (2dp)  + profit %
//                                                   └──▶ WHOLESALE PRICE (2dp) + margin %
//                                                                                └──▶ NET PROFIT
//
// The form calls these live as the shopkeeper types. Nothing they produce is stored except the two
// ends of the chain (cost price, and the prices themselves).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * SUPPLIER PRICE → DISCOUNT → COST PRICE. All 4-dp cost units; the discount is basis points.
 *
 *   Rs 2185.0000 less 5%  ->  costFromSupplier(21_850_000, 500)  ->  20_757_500  (Rs 2075.7500)
 */
export function costFromSupplier(supplierPrice: number, discountBp: number): number {
  assertInteger(supplierPrice, 'supplier price')
  assertInteger(discountBp, 'discount')

  if (supplierPrice < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A supplier price cannot be negative.',
      `supplierPrice=${supplierPrice}`
    )
  }
  if (discountBp < 0 || discountBp > BASIS_POINTS) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A discount must be between 0% and 100%.',
      `discountBp=${discountBp}`
    )
  }

  // Rounded to the nearest 1/10000 of a rupee — the last place cost is allowed to have.
  return Math.round((supplierPrice * (BASIS_POINTS - discountBp)) / BASIS_POINTS)
}

/**
 * PACK COST → UNIT COST. The carton-to-piece step, and the reason cost carries 4 decimals.
 *
 * `packSizeM` is qty_m of the BASE unit: a carton of 24 pieces is 24000.
 *
 *   A carton of 24 costing Rs 2185:  unitCostFromPack(21_850_000, 24_000)  ->  910_417
 *   which is Rs 91.0417 — NOT Rs 91.04.
 */
export function unitCostFromPack(packCost: number, packSizeM: number): number {
  assertInteger(packCost, 'pack cost')
  assertInteger(packSizeM, 'pack size')

  if (packSizeM <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A pack must contain at least some of the base unit.',
      `packSizeM=${packSizeM}`
    )
  }

  // packSizeM is thousandths, so the number of base units in the pack is packSizeM / 1000. That may
  // legitimately be fractional (a 1.5 kg pack is 1500), and costPerUnit rounds the result back onto
  // the 4-dp grid — so the division happens once, at the end, and precision survives it.
  return costPerUnit(packCost, packSizeM / QTY_SCALE)
}

/**
 * PROFIT %, as the legacy form means it: markup ON COST.
 *
 *     (price − cost) / cost
 *
 * Returned in basis points (83.02% = 8302). Null when cost is zero — you cannot express a profit as a
 * percentage of nothing, and returning 0 there would read as "we make no money on this", which is the
 * opposite of the truth.
 *
 * NOTE THE SCALES. `costPrice` is 4-dp cost; `priceMinor` is 2-dp money. They are brought onto the
 * same scale with costToPriceMinor() before they are allowed near each other.
 */
export function markupBp(costPrice: number, priceMinor: number): number | null {
  assertInteger(costPrice, 'cost price')
  assertInteger(priceMinor, 'price')

  const costMinor = costToPriceMinor(costPrice)
  if (costMinor === 0) return null

  return Math.round(((priceMinor - costMinor) * BASIS_POINTS) / costMinor)
}

/**
 * MARGIN %: the share of the SELLING PRICE that is profit.
 *
 *     (price − cost) / price
 *
 * A different number from markupBp and a different question. Sell at Rs 2300 what cost Rs 2185 and
 * the markup is 5.26% while the margin is 5.00%. Both are true; they measure different things. Keep
 * them apart, and label them on screen exactly as the legacy form does.
 */
export function marginBp(costPrice: number, priceMinor: number): number | null {
  assertInteger(costPrice, 'cost price')
  assertInteger(priceMinor, 'price')

  if (priceMinor === 0) return null

  const costMinor = costToPriceMinor(costPrice)
  return Math.round(((priceMinor - costMinor) * BASIS_POINTS) / priceMinor)
}

/** One price, shown both ways — which is what the product form puts side by side. */
export type PriceView = {
  /** 2-dp money, before tax. */
  exclusive: number
  /** 2-dp money, tax included — what goes on the shelf label. */
  inclusive: number
  /** The rate used. 0 for a tax-exempt product, whatever the product's rate says. */
  taxRateBp: number
}

/**
 * The two boxes in the form that each fill the other in: "Price excl. tax" and "Price incl. tax".
 *
 * `price` is the number as the shopkeeper TYPED it, and `mode` says which box they typed it into.
 * Nothing is converted on the way into the database — the product records which mode it was entered
 * in, and the sale line resolves it at sale time and freezes the result.
 */
export function priceBothWays(price: number, taxRateBp: number, mode: PriceEntryMode): PriceView {
  return mode === 'inclusive'
    ? { exclusive: priceExclusiveFromInclusive(price, taxRateBp), inclusive: price, taxRateBp }
    : { exclusive: price, inclusive: priceInclusiveFromExclusive(price, taxRateBp), taxRateBp }
}

/** Everything the form's price panel shows. Every field here is DERIVED. None of it is stored. */
export type ProductPricing = {
  /** 4-dp cost, as stored. */
  costPrice: number
  /** The same cost as 2-dp money. The ONLY value that may be compared with a price. */
  costMinor: number
  /** The rate actually applied — 0 when the product is tax-exempt. */
  taxRateBp: number

  retail: PriceView
  wholesale: PriceView

  /** Legacy "PROFIT %" next to the retail price: markup on cost, basis points. */
  retailProfitBp: number | null
  /** The same retail price expressed as a margin on the selling price. */
  retailMarginBp: number | null
  /** Markup on cost for the wholesale price. */
  wholesaleProfitBp: number | null
  /** Legacy "MARGIN %" next to the wholesale price: margin on the selling price, basis points. */
  wholesaleMarginBp: number | null

  /** Legacy "NET PROFIT": retail EXCLUDING TAX, less cost. 2-dp money, per base unit. */
  netProfitMinor: number
  /** The same figure at the wholesale price. */
  wholesaleNetProfitMinor: number
}

/**
 * Compute the whole derived half of the price panel from the four numbers that ARE stored.
 *
 * PROFIT IS MEASURED ON THE TAX-EXCLUSIVE PRICE, always. The sales tax inside an inclusive price is
 * not the shop's money — it is collected for the government and handed over. Counting it as profit
 * would overstate the margin on every tax-inclusive item in the shop by the tax rate.
 */
export function pricing(
  product: Pick<
    Product,
    'costPrice' | 'retailPrice' | 'wholesalePrice' | 'taxRateBp' | 'isTaxExempt' | 'priceEntryMode'
  >
): ProductPricing {
  const taxRateBp = product.isTaxExempt ? 0 : product.taxRateBp

  const retail = priceBothWays(product.retailPrice, taxRateBp, product.priceEntryMode)
  const wholesale = priceBothWays(product.wholesalePrice, taxRateBp, product.priceEntryMode)
  const costMinor = costToPriceMinor(product.costPrice)

  return {
    costPrice: product.costPrice,
    costMinor,
    taxRateBp,
    retail,
    wholesale,
    retailProfitBp: markupBp(product.costPrice, retail.exclusive),
    retailMarginBp: marginBp(product.costPrice, retail.exclusive),
    wholesaleProfitBp: markupBp(product.costPrice, wholesale.exclusive),
    wholesaleMarginBp: marginBp(product.costPrice, wholesale.exclusive),
    netProfitMinor: retail.exclusive - costMinor,
    wholesaleNetProfitMinor: wholesale.exclusive - costMinor
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// STOCK — read-only, derived, and DEFINED IN ONE PLACE ONLY.
//
// On-hand, stock value and the below-re-order flag all belong to the stock service (stock.ts), and
// this file calls it rather than re-deriving them. Two modules each computing "is this item below its
// re-order level" is two modules that will eventually disagree — and then the product form and the
// low-stock report say different things about the same item on the same day, which is exactly the
// class of bug CLAUDE.md §4 is about. The predicate has ONE home; this is not it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type CreateInput = z.input<typeof CreateProductInput>
type UpdateInput = z.input<typeof UpdateProductInput>
type ListInput = z.input<typeof ProductListInput>
type VariantGroupInput = z.input<typeof CreateVariantGroupInput>

/**
 * Save a new item. The product, its barcodes, its alternate packings and its suppliers all land in
 * ONE transaction — a product that half-saved, with a barcode that scans to nothing, is worse than a
 * product that did not save at all.
 *
 * There is NO opening-stock argument here, deliberately. Stock arrives as a movement (an `opening`
 * one), with a reason and a user against it. See the header.
 */
export function create(db: DB, actor: User, raw: CreateInput, now = new Date()): ProductDetail {
  const input = parseOrThrow(CreateProductInput, raw, 'product.create')
  const at = now.toISOString()

  const write = db.transaction((): number => {
    assertSkuFree(db, input.sku)
    assertVariantAttributes(db, input.variantGroupId ?? null, input.attributes ?? null)

    const info = db
      .prepare(
        `INSERT INTO products (
           sku, name, name_other_lang,
           department_id, category_id, sub_category_id, brand_id, location_id, favourite_group_id,
           sale_uom_id, size_volume,
           cost_price, retail_price, wholesale_price,
           tax_rate_bp, price_entry_mode, is_tax_exempt,
           item_type, track_batches, track_serials, is_weighted,
           min_stock_m, image_path,
           variant_group_id, attributes_json,
           is_active, created_at, updated_at
         ) VALUES (
           @sku, @name, @nameOtherLang,
           @departmentId, @categoryId, @subCategoryId, @brandId, @locationId, @favouriteGroupId,
           @saleUomId, @sizeVolume,
           @costPrice, @retailPrice, @wholesalePrice,
           @taxRateBp, @priceEntryMode, @isTaxExempt,
           @itemType, @trackBatches, @trackSerials, @isWeighted,
           @minStockM, @imagePath,
           @variantGroupId, @attributesJson,
           1, @at, @at
         )`
      )
      .run({
        sku: input.sku,
        name: input.name,
        nameOtherLang: input.nameOtherLang ?? null,
        departmentId: input.departmentId ?? null,
        categoryId: input.categoryId ?? null,
        subCategoryId: input.subCategoryId ?? null,
        brandId: input.brandId ?? null,
        locationId: input.locationId ?? null,
        favouriteGroupId: input.favouriteGroupId ?? null,
        saleUomId: input.saleUomId,
        sizeVolume: input.sizeVolume ?? null,
        costPrice: input.costPrice,
        retailPrice: input.retailPrice,
        wholesalePrice: input.wholesalePrice,
        taxRateBp: input.taxRateBp,
        priceEntryMode: input.priceEntryMode,
        isTaxExempt: bool(input.isTaxExempt),
        itemType: input.itemType,
        trackBatches: bool(input.trackBatches),
        trackSerials: bool(input.trackSerials),
        isWeighted: bool(input.isWeighted),
        minStockM: input.minStockM,
        imagePath: input.imagePath ?? null,
        variantGroupId: input.variantGroupId ?? null,
        attributesJson: input.attributes ? JSON.stringify(input.attributes) : null,
        at
      })

    const productId = Number(info.lastInsertRowid)

    insertBarcodes(db, productId, input.barcodes ?? [], at)
    insertPacks(db, productId, input.packs ?? [], at)
    insertSuppliers(db, productId, input.suppliers ?? [], at)

    audit.record(
      db,
      actor,
      {
        action: 'product.create',
        entity: 'product',
        entityId: productId,
        after: {
          sku: input.sku,
          name: input.name,
          costPrice: input.costPrice,
          retailPrice: input.retailPrice,
          wholesalePrice: input.wholesalePrice
        }
      },
      now
    )

    return productId
  })

  const id = guard(() => write(), 'product.create')
  return getById(db, id)
}

/** The first barcode becomes the primary one — it is what a new shelf label will print. */
function insertBarcodes(db: DB, productId: number, barcodes: string[], at: string): void {
  const seen = new Set<string>()
  const insert = db.prepare(
    'INSERT INTO product_barcodes (product_id, barcode, is_primary, created_at) VALUES (?, ?, ?, ?)'
  )

  barcodes.forEach((raw) => {
    // Strip a scanner's AIM identifier (]C1, ]E0, …) HERE, so a barcode scanned straight into the
    // product form is STORED the same way findProductByBarcode will later SEARCH for it. Without this,
    // a Code-128 item created by a scan is saved as `]C19200108` but rung up as `9200108`, and never
    // matches — the exact bug this normaliser exists to close. Dedup and the availability check must see
    // the cleaned value too, or two scans of one item read as a clash.
    const barcode = normalizeBarcode(raw)
    if (seen.has(barcode)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `The barcode ${barcode} is listed twice on this item.`,
        `duplicate barcode ${barcode} in create input`
      )
    }
    seen.add(barcode)

    catalog.assertBarcodeAvailable(db, barcode)
    insert.run(productId, barcode, seen.size === 1 ? 1 : 0, at)
  })
}

/**
 * The ALTERNATE PACKINGS grid. One row per unit of measure, exactly one base pack, and every pack
 * barcode unique across BOTH barcode tables.
 */
function insertPacks(
  db: DB,
  productId: number,
  packs: z.output<typeof CreateProductInput>['packs'],
  at: string
): void {
  if (!packs?.length) return

  const uoms = new Set<number>()
  let baseCount = 0

  const insert = db.prepare(
    `INSERT INTO product_packs
       (product_id, uom_id, pack_size, cost, retail_price, wholesale_price, barcode, is_base, created_at, updated_at)
     VALUES (@productId, @uomId, @packSize, @cost, @retailPrice, @wholesalePrice, @barcode, @isBase, @at, @at)`
  )

  for (const pack of packs) {
    if (uoms.has(pack.uomId)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'This item has the same packing listed twice. Each packing may only appear once.',
        `duplicate pack uom ${pack.uomId}`
      )
    }
    uoms.add(pack.uomId)

    if (pack.isBase) {
      baseCount += 1
      if (baseCount > 1) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'Only one packing can be the base selling unit.',
          'more than one is_base pack'
        )
      }
      if (pack.packSize !== ONE_UNIT) {
        // The base pack IS one base unit. If it were anything else, every qty_m in the app would be
        // measured in a unit that does not match the one the product says it sells in.
        throw new AppError(
          ErrorCode.VALIDATION,
          'The base packing must be exactly one selling unit.',
          `base pack packSize=${pack.packSize}, expected ${ONE_UNIT}`
        )
      }
    }

    if (pack.barcode) catalog.assertBarcodeAvailable(db, pack.barcode)

    insert.run({
      productId,
      uomId: pack.uomId,
      packSize: pack.packSize,
      cost: pack.cost,
      retailPrice: pack.retailPrice,
      wholesalePrice: pack.wholesalePrice,
      barcode: pack.barcode ?? null,
      isBase: bool(pack.isBase),
      at
    })
  }
}

/** The MULTIPLE SUPPLIERS grid: each supplier's own item code and own price. */
function insertSuppliers(
  db: DB,
  productId: number,
  suppliers: z.output<typeof CreateProductInput>['suppliers'],
  at: string
): void {
  if (!suppliers?.length) return

  const seen = new Set<number>()
  let preferredCount = 0

  const insert = db.prepare(
    `INSERT INTO product_suppliers
       (product_id, supplier_id, supplier_item_code, supplier_price, discount_bp, is_preferred, created_at, updated_at)
     VALUES (@productId, @supplierId, @supplierItemCode, @supplierPrice, @discountBp, @isPreferred, @at, @at)`
  )

  for (const supplier of suppliers) {
    if (seen.has(supplier.supplierId)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'The same supplier is listed twice on this item.',
        `duplicate supplier ${supplier.supplierId}`
      )
    }
    seen.add(supplier.supplierId)

    if (supplier.isPreferred) {
      preferredCount += 1
      if (preferredCount > 1) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'Only one supplier can be the preferred one for an item.',
          'more than one is_preferred supplier'
        )
      }
    }

    insert.run({
      productId,
      supplierId: supplier.supplierId,
      supplierItemCode: supplier.supplierItemCode ?? null,
      supplierPrice: supplier.supplierPrice,
      discountBp: supplier.discountBp,
      isPreferred: bool(supplier.isPreferred),
      at
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// UPDATE — writes ONLY the fields the form actually edited.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Editable field -> its column. The whitelist IS the contract: nothing outside it can be written. */
const UPDATABLE: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  nameOtherLang: 'name_other_lang',
  departmentId: 'department_id',
  categoryId: 'category_id',
  subCategoryId: 'sub_category_id',
  brandId: 'brand_id',
  locationId: 'location_id',
  favouriteGroupId: 'favourite_group_id',
  saleUomId: 'sale_uom_id',
  sizeVolume: 'size_volume',
  // costPrice is DELIBERATELY NOT HERE.
  //
  // cost_price is the WEIGHTED AVERAGE of stock_movements.unit_cost — it is DERIVED STATE, exactly
  // like stock on hand, and derived state is never directly writable (CLAUDE.md §4).
  //
  // It used to be updatable, and the product form sent it on every save (it auto-derives a cost from
  // the SUPPLIER PRICE → DISCOUNT → PACK chain as you type). So typing a new supplier price silently
  // rewrote the average cost of stock ALREADY ON THE SHELF — with no stock movement and no journal.
  // The GL kept saying the inventory was worth Rs 1,000 while the stock valuation report started
  // saying Rs 1,500, and the trial balance still balanced, so nothing anywhere caught it.
  //
  // A cost correction is a BUSINESS EVENT, not a field edit. It goes through stock.adjust(), which
  // posts a movement and a balanced journal, so the books and the shelf can never drift apart.
  retailPrice: 'retail_price',
  wholesalePrice: 'wholesale_price',
  taxRateBp: 'tax_rate_bp',
  priceEntryMode: 'price_entry_mode',
  isTaxExempt: 'is_tax_exempt',
  itemType: 'item_type',
  trackBatches: 'track_batches',
  trackSerials: 'track_serials',
  isWeighted: 'is_weighted',
  minStockM: 'min_stock_m',
  imagePath: 'image_path',
  variantGroupId: 'variant_group_id',
  attributes: 'attributes_json',
  isActive: 'is_active'
}

/** A change to any of these is a PRICE CHANGE, and a price change is always audited. (CLAUDE.md §4) */
const PRICE_FIELDS = ['costPrice', 'retailPrice', 'wholesalePrice'] as const

/**
 * Save an edit.
 *
 * THIS WRITES ONLY THE KEYS THAT ARE ACTUALLY PRESENT ON `raw`. (CLAUDE.md trap #18.)
 *
 *   key absent  ->  the form never loaded this field. LEAVE IT ALONE.
 *   key = null  ->  the user cleared it. Write NULL.
 *
 * Those two are different, and the difference is why this builds its SET clause from the keys that
 * came in rather than posting a whole object back. Post the whole object and every field the form did
 * not happen to load — the Urdu name, the location, the re-order level — is silently wiped by the
 * next person who edits the price.
 *
 * And note what CANNOT be sent: stock. There is no stock field on the form, in the schema, or here.
 */
export function update(db: DB, actor: User, raw: UpdateInput, now = new Date()): ProductDetail {
  const input = parseOrThrow(UpdateProductInput, raw, 'product.update')
  const before = toProduct(getProductRow(db, input.id))

  // The keys the form ACTUALLY sent. `in`, not a truthiness test: `false`, `0` and `null` are all
  // real, intentional values that a truthiness test would throw away.
  const touched = Object.keys(UPDATABLE).filter((key) => key in input)

  if (touched.length === 0) return getById(db, input.id)

  const write = db.transaction(() => {
    if ('sku' in input && input.sku !== undefined && input.sku !== before.sku) {
      assertSkuFree(db, input.sku)
    }

    // Attributes are validated against the group the product will belong to AFTER this edit — which
    // may be the group it is being moved into by this very call.
    if ('attributes' in input || 'variantGroupId' in input) {
      const groupId = 'variantGroupId' in input ? (input.variantGroupId ?? null) : before.variantGroupId
      const attributes = 'attributes' in input ? (input.attributes ?? null) : before.attributes
      assertVariantAttributes(db, groupId, attributes)
    }

    const sets = touched.map((key) => `${UPDATABLE[key]} = @${key}`)
    const params: Record<string, unknown> = { id: input.id, at: now.toISOString() }

    for (const key of touched) {
      params[key] = toColumnValue(key, (input as Record<string, unknown>)[key])
    }

    db.prepare(`UPDATE products SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`).run(params)

    const after = toProduct(getProductRow(db, input.id))

    audit.record(
      db,
      actor,
      {
        action: 'product.update',
        entity: 'product',
        entityId: input.id,
        // Only what actually changed — an audit row nobody can read is an audit row nobody reads.
        before: pick(before, touched),
        after: pick(after, touched)
      },
      now
    )

    // A price change gets its OWN row, because "who changed the price of this, and when" is a
    // question the owner will ask, and it must be answerable without reading every product edit.
    const pricesChanged = PRICE_FIELDS.filter((field) => touched.includes(field) && before[field] !== after[field])

    if (pricesChanged.length > 0) {
      audit.record(
        db,
        actor,
        {
          action: 'product.price_change',
          entity: 'product',
          entityId: input.id,
          before: pick(before, pricesChanged),
          after: pick(after, pricesChanged)
        },
        now
      )
    }
  })

  guard(() => write(), 'product.update')
  return getById(db, input.id)
}

/**
 * Retire an item. It is NEVER deleted.
 *
 * Last year's sale points at this row, and last year's receipt must still print with the right name
 * on it. A deleted product turns every historical line that referenced it into a hole. So the row
 * stays, readable forever; it simply stops appearing in the lists a cashier picks from.
 */
export function deactivate(db: DB, actor: User, id: number, now = new Date()): Product {
  const before = toProduct(getProductRow(db, id))

  db.prepare('UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?').run(
    now.toISOString(),
    id
  )

  audit.record(
    db,
    actor,
    { action: 'product.deactivate', entity: 'product', entityId: id, before: { sku: before.sku, name: before.name } },
    now
  )

  return toProduct(getProductRow(db, id))
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// READ
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Everything the product form needs, in one call — including the READ-ONLY balance quantity.
 *
 * The barcodes, packs, suppliers and stock all come from the services that own them, so the form can
 * never show a barcode list that disagrees with what the barcode service thinks exists.
 */
export function getById(db: DB, id: number): ProductDetail {
  const product = toProduct(getProductRow(db, id))

  return {
    product,
    barcodes: catalog.listBarcodes(db, id),
    packs: catalog.listPacks(db, id),
    suppliers: catalog.listSuppliersForProduct(db, id),
    batches: listBatches(db, id),
    stock: stock.stockLevel(db, id)
  }
}

/** Throws if the stock code is unknown. Use findBySku when "not there" is an expected answer. */
export function getBySku(db: DB, sku: string): ProductDetail {
  const product = findBySku(db, sku)
  if (!product) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `No item was found with the stock code "${sku}".`,
      `sku=${sku}`
    )
  }
  return getById(db, product.id)
}

/** Null when there is no such stock code — what the "is this SKU taken?" check on the form asks. */
export function findBySku(db: DB, sku: string): Product | null {
  // COLLATE NOCASE. A stock code is an IDENTIFIER, and to the shopkeeper who typed it "abc" and
  // "ABC" are the same item — but SQLite's `=` is case-sensitive, so the Excel importer looked up
  // "abc", found nothing, and created a SECOND product alongside the existing "ABC". The opening
  // stock then landed on the new, empty duplicate while the real item stayed at zero.
  const row = db.prepare('SELECT * FROM products WHERE sku = ? COLLATE NOCASE').get(sku.trim()) as
    | ProductRow
    | undefined

  return row ? toProduct(row) : null
}

const SORT_COLUMNS: Record<string, string> = {
  name: 'p.name',
  sku: 'p.sku',
  retail_price: 'p.retail_price',
  on_hand: 'on_hand'
}

/**
 * THE PRODUCTS LIST. Paginated, indexed, and never a bare SELECT * — assume 100k rows. (CLAUDE.md §4)
 *
 * Searches stock code, item name, the Urdu name, the SHELF it sits on, and barcodes (product barcodes
 * AND pack barcodes, because both of them scan). A barcode is matched exactly or by prefix, never by
 * "contains" — an exact match rides the unique index, and nobody searches for the middle of a barcode.
 *
 * The shelf is in there because a shopkeeper looking at a shelf and asking "what is meant to be here?"
 * is a real question a real shop asked, and it is the one search term they had that did not work.
 *
 * `on_hand` is SUM(stock_movements.qty_m), joined in — so the list can show and sort by a stock
 * figure without a second round trip, and without there being a stock column anywhere to go stale.
 */
export function list(db: DB, raw: ListInput = {}): PagedResult<ProductListItem> {
  const input = parseOrThrow(ProductListInput, raw, 'product.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (!input.includeInactive) where.push('p.is_active = 1')

  if (input.search) {
    // ESCAPE '\' is not optional: without it the backslashes escapeLike() adds are just characters,
    // and a search for "50% off" would match every product in the shop.
    where.push(`(
      p.sku LIKE @like ESCAPE '\\'
      OR p.name LIKE @like ESCAPE '\\'
      OR p.name_other_lang LIKE @like ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM product_barcodes b
                  WHERE b.product_id = p.id AND (b.barcode = @term OR b.barcode LIKE @prefix ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM product_packs k
                  WHERE k.product_id = p.id AND (k.barcode = @term OR k.barcode LIKE @prefix ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM lookups loc
                  WHERE loc.id = p.location_id AND loc.label LIKE @like ESCAPE '\\')
    )`)
    params['like'] = `%${escapeLike(input.search)}%`
    params['prefix'] = `${escapeLike(input.search)}%`
    params['term'] = input.search
  }

  for (const [field, column] of [
    ['departmentId', 'p.department_id'],
    ['categoryId', 'p.category_id'],
    ['subCategoryId', 'p.sub_category_id'],
    ['brandId', 'p.brand_id'],
    ['locationId', 'p.location_id'],
    ['favouriteGroupId', 'p.favourite_group_id'],
    ['itemType', 'p.item_type']
  ] as const) {
    const value = input[field]
    if (value !== undefined) {
      where.push(`${column} = @${field}`)
      params[field] = value
    }
  }

  if (input.belowReorderOnly) {
    // THE SAME PREDICATE THE STOCK SERVICE USES (stock.ts, stockLevels/lowStock): an INVENTORY item
    // whose on-hand is at or below its re-order level. It is written out here rather than shared only
    // because this list joins its own stock aggregate — if it ever changes, it changes in BOTH places,
    // or the flag on a row in this list starts disagreeing with membership of the low-stock report.
    //
    // item_type IS PART OF THE PREDICATE, and leaving it out was a real bug. A non-inventory item — a
    // bag charge, a service — has no stock and a re-order level of 0, so `0 <= 0` flagged EVERY ONE of
    // them as needing re-ordering, forever. That fills the owner's re-order list with things that can
    // never be bought and buries the items that genuinely have run out. Stock reports exclude
    // non-inventory items (stock.ts); so does this.
    //
    // COALESCE spelled out rather than the `on_hand` alias: SQLite happens to allow an output alias
    // in WHERE, but that is an extension, and this query has no business depending on one.
    where.push("p.item_type = 'inventory' AND COALESCE(s.on_hand, 0) <= p.min_stock_m")
  }

  const from = `
    FROM products p
    LEFT JOIN (
      SELECT product_id, SUM(qty_m) AS on_hand FROM stock_movements GROUP BY product_id
    ) s ON s.product_id = p.id
  `
  // COALESCE, not the raw sum: a product that has never moved has no row in the aggregate, and its
  // on-hand is 0 — not NULL, which would sort and compare as neither.
  const onHand = 'COALESCE(s.on_hand, 0) AS on_hand'
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // The count runs over the same FROM and the same WHERE. If it did not, the page count would
  // disagree with the pages — which is the kind of bug a user reports as "it says 51 but I can only
  // see 50".
  const total = db
    .prepare(`SELECT COUNT(*) FROM (SELECT p.id, ${onHand} ${from} ${whereSql})`)
    .pluck()
    .get(params) as number

  const sortColumn = SORT_COLUMNS[input.sortBy ?? 'name'] ?? 'p.name'
  const sortDir = input.sortDir === 'desc' ? 'DESC' : 'ASC'

  const rows = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.name_other_lang, p.category_id, p.brand_id, p.item_type,
              p.cost_price, p.retail_price, p.wholesale_price, p.min_stock_m, p.is_active,
              ${onHand},
              cat.label AS category_label,
              br.label  AS brand_label,
              (SELECT barcode FROM product_barcodes pb
                WHERE pb.product_id = p.id AND pb.is_primary = 1) AS primary_barcode
       ${from}
       LEFT JOIN lookups cat ON cat.id = p.category_id
       LEFT JOIN lookups br  ON br.id  = p.brand_id
       ${whereSql}
       ORDER BY ${sortColumn} ${sortDir}, p.id ASC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as ListRow[]

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      nameOtherLang: row.name_other_lang,
      categoryId: row.category_id,
      brandId: row.brand_id,
      itemType: row.item_type,
      costPrice: row.cost_price,
      retailPrice: row.retail_price,
      wholesalePrice: row.wholesale_price,
      minStockM: row.min_stock_m,
      isActive: Boolean(row.is_active),
      onHandM: row.on_hand,
      // EXACTLY the predicate the belowReorderOnly filter uses above — including item_type. If the
      // flag and the filter disagree, a row shows a "low stock" badge that the low-stock report does
      // not list (or the other way round), and the owner cannot tell which of the two screens lied.
      // A non-inventory item has no stock, so it can never be below a re-order level.
      isBelowReorder: row.item_type === 'inventory' && row.on_hand <= row.min_stock_m,
      primaryBarcode: row.primary_barcode,
      categoryLabel: row.category_label,
      brandLabel: row.brand_label
    }))
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// VARIANTS — one group, many children, each a real product with its own SKU, barcode, price, stock.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A variant group names the AXES its children vary on: ["size", "colour"].
 *
 * The children are ordinary products — they are what the shop actually counts and sells, and each one
 * has its own stock and its own barcode. The group exists so the Sell screen can offer a picker
 * instead of making the cashier hunt for "T-Shirt / M / Red" among 400 SKUs.
 */
export function createVariantGroup(
  db: DB,
  actor: User,
  raw: VariantGroupInput,
  now = new Date()
): VariantGroup {
  const input = parseOrThrow(CreateVariantGroupInput, raw, 'variantGroup.create')

  const info = db
    .prepare(
      'INSERT INTO variant_groups (name, attribute_keys_json, created_at) VALUES (?, ?, ?)'
    )
    .run(input.name, JSON.stringify(input.attributeKeys), now.toISOString())

  const id = Number(info.lastInsertRowid)

  audit.record(
    db,
    actor,
    { action: 'variant_group.create', entity: 'variant_group', entityId: id, after: input },
    now
  )

  return getVariantGroup(db, id)
}

export function getVariantGroup(db: DB, id: number): VariantGroup {
  const row = db.prepare('SELECT * FROM variant_groups WHERE id = ?').get(id) as
    | { id: number; name: string; attribute_keys_json: string }
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That variant group could not be found.',
      `variant_group id=${id}`
    )
  }

  return { id: row.id, name: row.name, attributeKeys: parseJson<string[]>(row.attribute_keys_json) ?? [] }
}

/** The children of a group — each its own product row, its own price, its own stock. */
export function listVariants(db: DB, variantGroupId: number): Product[] {
  const rows = db
    .prepare('SELECT * FROM products WHERE variant_group_id = ? ORDER BY name, sku')
    .all(variantGroupId) as ProductRow[]

  return rows.map(toProduct)
}

/**
 * A child's attributes may only use the axes its group declares. "T-Shirt" varies on size and colour;
 * a child that carries `{flavour: "mango"}` is a child of the wrong group, and the Sell screen's
 * picker would have no column to show it in.
 */
function assertVariantAttributes(
  db: DB,
  variantGroupId: number | null,
  attributes: Record<string, string> | null
): void {
  if (variantGroupId == null) return

  const group = getVariantGroup(db, variantGroupId)
  if (!attributes) return

  const allowed = new Set(group.attributeKeys)
  for (const key of Object.keys(attributes)) {
    if (!allowed.has(key)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `"${group.name}" items do not have a "${key}". They vary by: ${group.attributeKeys.join(', ')}.`,
        `attribute "${key}" not in group ${variantGroupId} keys [${group.attributeKeys.join(',')}]`
      )
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Rows -> plain data
// ═══════════════════════════════════════════════════════════════════════════════════════════════

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
  price_entry_mode: PriceEntryMode
  is_tax_exempt: number
  item_type: 'inventory' | 'non_inventory'
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

/** EXACTLY the columns the list query selects — not ProductRow, which would claim columns it does not. */
type ListRow = Pick<
  ProductRow,
  | 'id'
  | 'sku'
  | 'name'
  | 'name_other_lang'
  | 'category_id'
  | 'brand_id'
  | 'item_type'
  | 'cost_price'
  | 'retail_price'
  | 'wholesale_price'
  | 'min_stock_m'
  | 'is_active'
> & {
  on_hand: number
  category_label: string | null
  brand_label: string | null
  primary_barcode: string | null
}

function getProductRow(db: DB, id: number): ProductRow {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined

  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That item could not be found.', `product id=${id}`)
  }
  return row
}

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
    priceEntryMode: row.price_entry_mode,
    isTaxExempt: Boolean(row.is_tax_exempt),
    itemType: row.item_type,
    trackBatches: Boolean(row.track_batches),
    trackSerials: Boolean(row.track_serials),
    isWeighted: Boolean(row.is_weighted),
    minStockM: row.min_stock_m,
    imagePath: row.image_path,
    variantGroupId: row.variant_group_id,
    attributes: parseJson<Record<string, string>>(row.attributes_json),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Every batch of ONE product, oldest expiry first (never-expires last) — the order FEFO will pick in.
 *
 * Not catalog.listBatches(): that one is paginated, and a page-sized slice of a product's batches is
 * exactly the kind of quiet truncation that makes a form lie. This is bounded by one product_id, on
 * an index, which is a bound worth having.
 */
function listBatches(db: DB, productId: number): Batch[] {
  const rows = db
    .prepare(
      'SELECT id, product_id, batch_no, expiry_date, cost FROM batches WHERE product_id = ? ORDER BY expiry_date IS NULL, expiry_date, id'
    )
    .all(productId) as Array<{
    id: number
    product_id: number
    batch_no: string
    expiry_date: string | null
    cost: number
  }>

  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    cost: row.cost
  }))
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function assertSkuFree(db: DB, sku: string): void {
  // Case-insensitive, to match findBySku — otherwise "ABC" could be created alongside "abc" and the
  // scanner, the reports and the shopkeeper would each disagree about which one is the real item.
  const existing = db
    .prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE')
    .pluck()
    .get(sku) as
    | number
    | undefined

  if (existing !== undefined) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `The stock code "${sku}" is already used by another item.`,
      `duplicate sku ${sku} (product ${existing})`
    )
  }
}

/** SQLite has no booleans. 1 and 0, and never the string "false", which is truthy everywhere. */
function bool(value: boolean): 1 | 0 {
  return value ? 1 : 0
}

/** Turn one validated field into the value its column stores. */
function toColumnValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (key === 'attributes') return JSON.stringify(value)
  if (typeof value === 'boolean') return bool(value)
  return value
}

function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    out[key] = (source as Record<string, unknown>)[key]
  }
  return out
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    // A row we cannot read is not a reason to take the whole product screen down.
    return null
  }
}

/** `%` and `_` are wildcards in LIKE. A shopkeeper searching for "50% off" means the characters. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

function assertInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That number could not be used. Please check it and try again.',
      `${what} must be a safe integer, got ${value}`
    )
  }
}

/**
 * Validate in the SERVICE too, not only at the IPC edge — a future LAN server, a migration script or
 * a test calls straight in here, and "the caller validated it" is an assumption, not a guarantee.
 *
 * The messages come from the zod schemas, which are already written in language a cashier reads.
 */
function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown, context: string): z.output<S> {
  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AppError(
      ErrorCode.VALIDATION,
      issue?.message ?? 'Please check the details and try again.',
      `${context}: ${JSON.stringify(parsed.error.issues)}`
    )
  }

  return parsed.data as z.output<S>
}

/**
 * A constraint error from SQLite says "UNIQUE constraint failed: products.sku". A cashier must never
 * see that. This turns what the database says into what a person needs to hear, and keeps the real
 * text for the log.
 */
function guard<T>(run: () => T, context: string): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof AppError) throw error

    const code = (error as { code?: string }).code ?? ''
    const technical = `${context}: ${error instanceof Error ? error.message : String(error)}`

    if (code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'One of the options chosen for this item no longer exists. Please pick it again.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Something on this item — the stock code or a barcode — is already used by another item.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That item could not be saved. Please check the details and try again.',
        technical
      )
    }

    throw new AppError(
      ErrorCode.DB,
      'Something went wrong saving that item. Please try again.',
      technical
    )
  }
}
