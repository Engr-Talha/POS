import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import type { Role } from '@shared/rbac'
import { AppError, ErrorCode } from '@shared/result'
import { ROLE_RANK, roleCan } from '@shared/rbac'
import { ACC } from '../db/chart-of-accounts'
import { computeLineTax, type TaxMode } from '@shared/tax'
import { formatMoney } from '@shared/money'
import { formatQty, ONE_UNIT } from '@shared/qty'
import { apportionCartDiscount, extendPrice } from '@shared/pricing'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import type { ReceiptData, ReceiptLine, ReceiptPayment, ReceiptTaxSummaryRow } from '@shared/receipt'
import {
  CompleteSaleInput,
  DiscardSaleInput,
  HoldSaleInput,
  NO_YEAR_RESET,
  SALE_REF_TYPE,
  SALE_SERIES,
  SaleByInvoiceNoInput,
  SaleGetInput,
  SaleListInput,
  SaleReceiptInput,
  SaveQuoteInput,
  VoidSaleInput,
  formatInvoiceNo,
  type PagedResult,
  type PriceTier,
  type Sale,
  type SaleDetail,
  type SaleLine,
  type SaleLineInput,
  type SaleListItem,
  type SalePayment,
  type SaleStatus
} from '@shared/sales'
import * as audit from './audit'
import * as auth from './auth'
import * as catalog from './catalog'
import * as ledger from './ledger'
import * as settings from './settings'
import * as stock from './stock'

/**
 * THE SALE ENGINE. Every rupee this shop takes passes through this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A cart line says WHAT was scanned and HOW MANY. It does not say what it costs. Every price, every tax
 * rate and every cost is resolved HERE, from the catalog, and FROZEN onto the sale line. There are
 * exactly two doors through which a price may enter from outside, and both are deliberate, permissioned
 * and audited: an OPEN ITEM (there is no catalog row to read a price from) and a PRICE OVERRIDE.
 * Anything else and a tampered renderer sells a television for one rupee behind a perfectly balanced
 * journal. The renderer is not a security boundary. (CLAUDE.md §4.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. THE CART DISCOUNT AND THE TAX — THE ONE REAL BUSINESS DECISION IN THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A cart discount is APPORTIONED ACROSS THE LINES, and each line's tax is then resolved on what the
 * customer ACTUALLY PAYS for it. (See `apportionCartDiscount` and `priceCart`.)
 *
 * THIS IS NOT A NEW RULE — IT IS THE ONE THE SCHEMA ALREADY APPLIES TO A LINE DISCOUNT. Migration 0007
 * defines `sale_lines.net` as "after line discounts, before tax", so a Rs 50 LINE discount already
 * reduces the tax charged on that line. If a Rs 50 CART discount did not, the same rupees would be
 * taxed differently depending on which box the cashier happened to type them into. That is not a
 * policy; it is an inconsistency.
 *
 * WHAT THE ALTERNATIVE COSTS. The other option is to leave the lines untouched and subtract the
 * discount from the gross total. It is simpler — and it means the shop declares output tax on money it
 * never received: on a Rs 100 discount at 17%, Rs 14.53 of the shop's own money, on every discounted
 * sale, forever. For a tax-registered (FBR Tier-1) shop the two produce DIFFERENT TAX RETURNS. The rule
 * is therefore stated out loud, here, in one place — not buried in a helper — and the owner should
 * confirm it. (CLAUDE.md §7: ask before inventing a business rule.)
 *
 * THE IDENTITIES THIS BUYS. All exact, all tested, and no rounding line anywhere (PLAN.md §1):
 *
 *     line.net + line.tax_amount                    === line.gross      (also a DB CHECK)
 *     SUM(line.net)  + SUM(line.tax_amount)         === grand_total
 *     SUM(line.gross)                               === grand_total
 *     SUM(pre-cart-discount gross) − cart_discount  === grand_total     the customer pays EXACTLY the
 *                                                                       discount less, to the paisa
 *
 * Note what is NOT an identity: `SUM(line.gross) − cart_discount === grand_total`. Under apportionment
 * the discount is already inside the lines, so subtracting it again would take it off twice. The
 * guarantee that formulation is reaching for — not one paisa lost or invented — is the fourth identity
 * above, and it is tested directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. THE JOURNAL, AND WHY IT CANNOT FAIL TO BALANCE
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *     DR  Cash / Bank / Receivable    grand_total     per payment method; 'credit' -> Receivable
 *     DR  Discounts Given             discountNet     contra-income: what discounting REALLY cost,
 *                                                     ex-tax, line discounts and cart discount alike
 *     CR  Sales                       listNet         the UNDISCOUNTED net — so the line above stays
 *                                                     visible instead of being silently netted away
 *     CR  Output Tax                  tax_total       the government's money, never the shop's
 *     DR  COGS   /  CR  Inventory     the movements' own frozen values, summed — never recomputed
 *
 * It balances as ALGEBRA, not as arithmetic that happens to work out:
 *
 *     grandTotal + discountNet  =  (subtotalNet + taxTotal) + (listNet − subtotalNet)
 *                               =  listNet + taxTotal                                          ∎
 *
 * — for any mix of tax rates, inclusive and exclusive pricing, line discounts and cart discounts.
 * Rounding cannot break it, because every term is a sum of the SAME frozen integers.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 4. THREE INTEGER SCALES. NEVER MIXED. NEVER A FLOAT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *     money   2 dp   minor units       unit_price, net, tax, gross, payments      shared/money.ts
 *     cost    4 dp   ten-thousandths   unit_cost — THE FROZEN COGS                shared/cost.ts
 *     qty_m   3 dp   thousandths       qty_m (1 pc = 1000, 1.234 kg = 1234)       shared/qty.ts
 *
 * `unit_cost` sits one column away from `unit_price` and they are A HUNDRED TIMES APART.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 5. WHAT THIS FILE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * It does not touch stock directly: `stock.record()` appends the movement, freezes its cost and its
 * value, and maintains the weighted average. It does not write HTML: it returns a `ReceiptData` and
 * `printing/receipt.ts` renders it. It does not import `electron` — a LAN server will call it one day
 * exactly as vitest calls it today. (CLAUDE.md §3.)
 */

// ═════════════════════════════════════════════════════════════════════════════
// Small shared helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today and a LAN server will call it tomorrow.
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
 * Read a setting, defaulting from the REGISTRY — never from a literal typed at the call site.
 *
 * "If a number could differ between two shops, it is a SETTING, not a constant" (CLAUDE.md §4), and the
 * registry is the single source of truth for its default. A `settings.get(db, key, 1000)` here would be
 * a second copy of that default, quietly free to disagree with the Settings screen.
 */
function setting<T>(db: DB, key: string): T {
  return settings.get<T>(db, key, REGISTRY_DEFAULTS[key] as T)
}

/** Money, for a message a CASHIER reads. Never for a stored value. */
function money(db: DB, minor: number): string {
  return formatMoney(minor, { symbol: setting<string>(db, 'currency.symbol') })
}

/**
 * THE LINE EXTENSION and THE CART-DISCOUNT SPLIT now live in `shared/pricing.ts`, and they are
 * re-exported here so every existing caller (and every existing test) still finds them on this module.
 *
 * WHY THEY MOVED. The Sell screen shows a running total as the cashier scans, and this service freezes
 * the real one. Two implementations of that arithmetic WILL differ — not on the first sale, but on the
 * one weighed line, or the one cart discount that does not divide by three — and then the customer is
 * quoted Rs 394.88 on the screen and charged Rs 394.89 on the paper. The renderer now imports THESE
 * functions, so the preview and the frozen sale are the same line of code and cannot drift.
 *
 * Same reasoning as `formatInvoiceNo` (shared/sales.ts) and `computeLineTax` (shared/tax.ts).
 */
export { apportionCartDiscount, extendPrice }

/** A real, CURRENT entry on the owner's own list. Never a hardcoded dropdown option. (CLAUDE.md §4.) */
function requireLookupByCode(
  db: DB,
  listKey: string,
  code: string,
  userMessage: string
): { id: number; code: string; label: string } {
  const row = db
    .prepare('SELECT id, code, label FROM lookups WHERE list_key = ? AND code = ? AND is_active = 1')
    .get(listKey, code) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      userMessage,
      `unknown or inactive ${listKey} code "${code}"`
    )
  }
  return row
}

function requireLookupById(
  db: DB,
  listKey: string,
  id: number,
  userMessage: string
): { id: number; code: string; label: string } {
  const row = db
    .prepare('SELECT id, code, label FROM lookups WHERE list_key = ? AND id = ? AND is_active = 1')
    .get(listKey, id) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      userMessage,
      `unknown or inactive ${listKey} lookup id=${id}`
    )
  }
  return row
}

/** lookups('uom').label — "Pieces", "Carton". Never a hardcoded unit list. */
function uomLabel(db: DB, uomId: number): string | null {
  return (
    (db.prepare('SELECT label FROM lookups WHERE id = ?').pluck().get(uomId) as string | undefined) ??
    null
  )
}

function loadUser(db: DB, id: number, what: string): User {
  const row = db
    .prepare('SELECT id, username, full_name, role, pin_hash, is_active FROM users WHERE id = ?')
    .get(id) as
    | {
        id: number
        username: string
        full_name: string
        role: Role
        pin_hash: string | null
        is_active: number
      }
    | undefined

  if (!row || !row.is_active) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${what} could not be found. Please have them sign in again.`,
      `user id=${id} does not exist or is inactive`
    )
  }

  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    hasPin: row.pin_hash != null,
    isActive: true
  }
}

/** Does this user hold at least the role a SETTING names? (e.g. `selling.priceOverrideRole`.) */
function roleAtLeast(user: User, required: string): boolean {
  const needed = ROLE_RANK[required as Role]
  // An unrecognised role in a setting LOCKS the door rather than opening it. A typo in Settings must
  // never be the thing that lets a cashier rewrite prices.
  if (needed == null) return false
  return ROLE_RANK[user.role] >= needed
}

// ═════════════════════════════════════════════════════════════════════════════
// Loading what a sale needs — lean, on purpose
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The columns — and ONLY the columns — a sale needs from a product. `products.getById` loads the whole
 * item detail (barcodes, packs, suppliers, batches) and the sell path has no use for any of it. Same
 * reasoning as `stock.ts`, which keeps its own lean loader for exactly this reason.
 */
type SellableProduct = {
  id: number
  name: string
  nameOtherLang: string | null
  saleUomId: number
  /** 4-dp COST — the weighted average. THE COGS. Never typed by a human. */
  costPrice: number
  retailPrice: number
  wholesalePrice: number
  taxRateBp: number
  priceEntryMode: TaxMode
  isTaxExempt: boolean
  itemType: 'inventory' | 'non_inventory'
  trackBatches: boolean
  trackSerials: boolean
  isWeighted: boolean
  isActive: boolean
}

function loadProduct(db: DB, productId: number): SellableProduct {
  const row = db
    .prepare(
      `SELECT id, name, name_other_lang, sale_uom_id, cost_price, retail_price, wholesale_price,
              tax_rate_bp, price_entry_mode, is_tax_exempt, item_type,
              track_batches, track_serials, is_weighted, is_active
       FROM products WHERE id = ?`
    )
    .get(productId) as
    | {
        id: number
        name: string
        name_other_lang: string | null
        sale_uom_id: number
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
        is_active: number
      }
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }

  return {
    id: row.id,
    name: row.name,
    nameOtherLang: row.name_other_lang,
    saleUomId: row.sale_uom_id,
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
    isActive: Boolean(row.is_active)
  }
}

type SellablePack = {
  id: number
  productId: number
  uomId: number
  /** qty_m of BASE units in one pack. A carton of 24 pieces is 24000. */
  packSize: number
  retailPrice: number
  wholesalePrice: number
}

function loadPack(db: DB, packId: number, productId: number, productName: string): SellablePack {
  const row = db
    .prepare(
      `SELECT id, product_id, uom_id, pack_size, retail_price, wholesale_price
       FROM product_packs WHERE id = ?`
    )
    .get(packId) as
    | {
        id: number
        product_id: number
        uom_id: number
        pack_size: number
        retail_price: number
        wholesale_price: number
      }
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That pack size could not be found. Please scan the item again.',
      `pack id=${packId} does not exist`
    )
  }

  // The pack must belong to the product on the line, or the cart would move one item's stock while
  // charging another item's carton price.
  if (row.product_id !== productId) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `That pack does not belong to "${productName}". Please scan the item again.`,
      `pack ${packId} belongs to product ${row.product_id}, not ${productId}`
    )
  }

  return {
    id: row.id,
    productId: row.product_id,
    uomId: row.uom_id,
    packSize: row.pack_size,
    retailPrice: row.retail_price,
    wholesalePrice: row.wholesale_price
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SCANNING — the hot path
// ═════════════════════════════════════════════════════════════════════════════

/** What the Sell screen needs the instant a barcode comes in. */
export type ScannedItem = {
  productId: number
  name: string
  nameOtherLang: string | null
  /** Set when a PACK barcode was scanned (a carton). Pass it straight back on the cart line. */
  packId: number | null
  /** The pack's unit, for the cart chip: "Carton". Null for a plain item. */
  packLabel: string | null
  /** qty_m of BASE units this ONE scan sells. A plain item: 1000. A carton of 24: 24000. */
  qtyM: number
  /** 2-dp money — the price of ONE of what was scanned (one piece, or one whole carton). */
  unitPrice: number
  taxRateBp: number
  taxMode: TaxMode
  /** Sold by weight — the Sell screen asks the scale, not the keyboard. */
  isWeighted: boolean
  /** ONLY a flagged item prompts for an IMEI. A tin of beans still scans in one keystroke. */
  trackSerials: boolean
  uom: string | null
  /**
   * A SERVICE OR A BAG CHARGE HAS NO SHELF. Without this the till cannot tell a non-inventory line from
   * a tin that has genuinely run out — both report `onHandM: 0` — and it would raise "not enough stock"
   * on every delivery fee the shop ever charged. A warning that cries wolf is a warning the cashier
   * learns to click through, which is worse than no warning at all.
   */
  itemType: 'inventory' | 'non_inventory'
  /** DERIVED, never stored. Shown so the cashier can see they are about to oversell. */
  onHandM: number
}

/**
 * SCAN. One indexed lookup — two B-tree seeks, whether the shop has 100 products or 100,000.
 *
 * A PACK BARCODE SELLS THE PACK. Scanning the carton of 24 puts ONE carton on the cart at the CARTON's
 * price, and it will move 24 PIECES of stock — because stock is measured in base units and always has
 * been. That is the whole of "buy in cartons, sell in pieces", and it is why `qtyM` comes back as 24000
 * rather than 1000.
 *
 * A PACK WITH NO SELLING PRICE IS PURCHASE-ONLY, AND IS REFUSED. (CLAUDE.md §4, Selling.) The carton
 * legitimately carries the supplier's barcode so a delivery can be scanned in, and it has no retail
 * price because a carton is never sold as one. Scanning it at the till is a RECEIVING action; the
 * alternative to refusing it is ringing up a free carton of stock.
 *
 * An unknown barcode returns null. It is an everyday event at a counter — a loyalty card, a coupon, a
 * smudged label — and it is not an error and must not throw.
 */
export function scanBarcode(
  db: DB,
  barcode: string,
  options: { tier?: PriceTier; customerId?: number | null } = {}
): ScannedItem | null {
  const match = catalog.findProductByBarcode(db, barcode)
  if (!match) return null

  const product = loadProduct(db, match.product.id)
  const pack = match.pack
    ? loadPack(db, match.pack.id, product.id, product.name)
    : null

  const tier = options.tier ?? 'retail'

  return {
    productId: product.id,
    name: product.name,
    nameOtherLang: product.nameOtherLang,
    packId: pack?.id ?? null,
    packLabel: pack ? uomLabel(db, pack.uomId) : null,
    qtyM: pack ? pack.packSize : ONE_UNIT,
    unitPrice: priceFor({ product, pack, tier }),
    taxRateBp: taxRateFor(db, product.taxRateBp, product.isTaxExempt),
    taxMode: product.priceEntryMode,
    isWeighted: product.isWeighted,
    trackSerials: product.trackSerials,
    uom: pack ? uomLabel(db, pack.uomId) : uomLabel(db, product.saleUomId),
    itemType: product.itemType,
    onHandM: product.itemType === 'inventory' ? stock.onHand(db, product.id) : 0
  }
}

/**
 * THE PRICE OF ONE UNIT OF WHAT WAS SCANNED — retail, wholesale, or a per-customer price.
 *
 * A PACK IS PRICED AS A PACK. A carton of 24 is not 24 x the piece price: the shop prices it in its own
 * right (product_packs.retail_price), and that is what the customer pays for it.
 *
 * NO WHOLESALE PRICE ON FILE FALLS BACK TO RETAIL. A wholesale_price of 0 means the shop never set one,
 * not that the item is free. Charging 0 would give the stock away; refusing to sell would stop the
 * counter dead in front of a customer. Retail is the only answer that can never cost the shop money.
 *
 * THE 'customer' TIER FALLS BACK TO RETAIL TOO — FOR NOW. `customer_prices` (PLAN.md §4) does not exist
 * yet; it arrives with the customer ledger in Phase 7. The tier is already in the schema and in the
 * enum, so the day that table lands, THIS is the one function that has to learn about it.
 */
export function priceFor(args: {
  product: Pick<SellableProduct, 'id' | 'name' | 'retailPrice' | 'wholesalePrice'>
  pack: Pick<SellablePack, 'id' | 'retailPrice' | 'wholesalePrice'> | null
  tier: PriceTier
  /** Phase 7 seam: a per-customer agreed price would be read against this. */
  customerId?: number | null
}): number {
  const { product, pack, tier } = args

  if (pack) {
    const price =
      tier === 'wholesale' && pack.wholesalePrice > 0 ? pack.wholesalePrice : pack.retailPrice

    // A pack with no selling price is PURCHASE-ONLY. Refuse it at the till rather than ring up a free
    // carton — the one rule CLAUDE.md §4 states explicitly for the sell path.
    if (price <= 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `That barcode is the carton (outer) for "${product.name}", and it has no selling price — it is used for taking a delivery in. Please scan the item itself to sell it.`,
        `pack id=${pack.id} is purchase-only (retail=${pack.retailPrice} wholesale=${pack.wholesalePrice})`
      )
    }
    return price
  }

  if (tier === 'wholesale' && product.wholesalePrice > 0) return product.wholesalePrice

  return product.retailPrice
}

/**
 * The rate that actually applies. Tax can be switched off shop-wide (`tax.enabled`), and an individual
 * product can be exempt. Either way the answer is 0 — and `computeLineTax` then returns net === gross,
 * which is exactly right.
 */
function taxRateFor(db: DB, productRateBp: number, isTaxExempt: boolean): number {
  if (isTaxExempt) return 0
  if (!setting<boolean>(db, 'tax.enabled')) return 0
  return productRateBp
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CART — plain, in-memory, transport-agnostic
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A cart is AN ARRAY OF LINE INPUTS and nothing more. These three functions are pure: no database, no
 * clock, no user. That is deliberate. The Sell screen holds the cart in memory and rings it up in one
 * call; a cart that only existed as rows in a table would mean a database write per keystroke on the
 * busiest screen in the shop.
 *
 * A cart that must SURVIVE (the customer went back for the milk they forgot) is a different thing: it is
 * HELD, which writes it to `sales` with status 'held' — no invoice number, no stock movement, no
 * journal. See `hold` and `resume`.
 */

/** Add a line. Scanning the same thing again bumps the quantity rather than stacking a second row. */
export function addLine(cart: readonly SaleLineInput[], line: SaleLineInput): SaleLineInput[] {
  // Only a PLAIN line merges. A line carrying a discount, an override, a batch or a serial is its own
  // thing with its own paperwork, and quietly folding it into another would erase that paperwork.
  const plain = (candidate: SaleLineInput): boolean =>
    candidate.priceOverride == null &&
    (candidate.lineDiscount ?? 0) === 0 &&
    (candidate.serials?.length ?? 0) === 0 &&
    candidate.batchId == null

  if (line.productId != null && plain(line)) {
    const index = cart.findIndex(
      (existing) =>
        existing.productId === line.productId &&
        (existing.packId ?? null) === (line.packId ?? null) &&
        plain(existing)
    )

    if (index >= 0) {
      const existing = cart[index]!
      const merged: SaleLineInput = { ...existing, qtyM: existing.qtyM + line.qtyM }
      return cart.map((row, i) => (i === index ? merged : row))
    }
  }

  return [...cart, line]
}

/** Change a line — its quantity, its discount, an override. Only the fields actually passed. */
export function updateLine(
  cart: readonly SaleLineInput[],
  index: number,
  changes: Partial<SaleLineInput>
): SaleLineInput[] {
  if (cart[index] == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That line is no longer in the cart.',
      `updateLine index=${index} out of range (cart has ${cart.length} lines)`
    )
  }

  return cart.map((row, i) => (i === index ? ({ ...row, ...changes } as SaleLineInput) : row))
}

export function removeLine(cart: readonly SaleLineInput[], index: number): SaleLineInput[] {
  if (cart[index] == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That line is no longer in the cart.',
      `removeLine index=${index} out of range (cart has ${cart.length} lines)`
    )
  }
  return cart.filter((_, i) => i !== index)
}

// ═════════════════════════════════════════════════════════════════════════════
// PRICING A CART — where every number on the receipt is decided
// ═════════════════════════════════════════════════════════════════════════════

/** One line, fully resolved and FROZEN — everything the sale, the stock leg and the journal need. */
type PricedLine = {
  input: SaleLineInput

  productId: number | null
  isOpenItem: boolean
  name: string
  nameOtherLang: string | null
  uom: string | null
  packId: number | null
  batchId: number | null

  /** qty_m in BASE units — WHAT MOVES IN STOCK. A carton of 24 is 24000. Zero for an open item. */
  stockQtyM: number
  /** qty_m of what is PRICED. A carton is 1000 (one carton), because unitPrice is the CARTON's price. */
  pricedQtyM: number

  unitPrice: number
  lineDiscount: number
  taxRateBp: number
  taxMode: TaxMode

  /** 4-dp COST — the weighted average at this instant. THE COGS. Zero for an open/non-stocked item. */
  unitCost: number
  movesStock: boolean
  /** A phone, not a tin of beans. ONLY a flagged item must carry an IMEI — see `assertSerials`. */
  trackSerials: boolean

  /** The line at LIST price, no discounts at all. CR Sales is grossed up to its net. */
  listNet: number
  listGross: number

  /**
   * The line's gross AFTER its line discount but BEFORE the cart discount. This is the weight the cart
   * discount is split across — a line worth twice as much takes twice as much of the discount.
   */
  preGross: number

  /** FROZEN, after everything. gross === net + tax, by construction and by DB CHECK. */
  net: number
  tax: number
  gross: number

  priceOverrideByUserId: number | null
  serials: string[]
}

type PricedCart = {
  lines: PricedLine[]

  /** SUM(line.net) — after ALL discounts, before tax. This is `sales.subtotal_net`. */
  subtotalNet: number
  taxTotal: number
  /** SUM(line.gross) === subtotalNet + taxTotal. What the customer owes. NO CASH ROUNDING. */
  grandTotal: number

  /** What the customer was given off the whole cart, as the cashier keyed it. 2-dp money. */
  cartDiscount: number
  /** SUM(line gross) BEFORE the cart discount. grandTotal === this − cartDiscount, exactly. */
  preDiscountGross: number

  /** SUM(line.listNet) — the undiscounted net. CR Sales. */
  listNet: number
  /** SUM(line.listGross) — what the cart would have cost with no discount at all. */
  listGross: number

  /** listNet − subtotalNet: EVERY discount on this document, line and cart, EX-TAX. DR Discounts. */
  discountNet: number
  /** listGross − grandTotal: what the customer actually got off. The threshold is measured on this. */
  discountGiven: number
}

/**
 * PRICE THE WHOLE CART. This is the heart of the file; read §2 of the header before changing a line.
 *
 * PASS 1 resolves each line against the catalog and applies its LINE discount, in the line's own tax
 *        mode — an exclusive price is a net and tax goes on top; an inclusive price already contains it.
 *        One cart may freely mix the two (CLAUDE.md §4), which is why tax is resolved PER LINE and never
 *        once for the cart.
 *
 * PASS 2 splits the CART discount across the lines in proportion to what each is actually worth, and
 *        re-resolves each discounted line's tax on what the customer now pays for it. The discounted
 *        amount IS the new gross, so `computeLineTax(charged, rate, 'inclusive')` gives back
 *        gross === charged exactly — which is what keeps the shares summing to the discount, to the
 *        paisa, with no rounding line.
 *
 * A line that takes no share is left completely untouched. So a sale with no cart discount — which is
 * almost every sale — is priced by exactly one call to computeLineTax per line, and nothing about the
 * common path is disturbed by the existence of the uncommon one.
 */
function priceCart(
  db: DB,
  actor: User,
  input: {
    lines: SaleLineInput[]
    priceTier: PriceTier
    cartDiscount: number
    customerId?: number | null | undefined
  },
  approver: User | null
): PricedCart {
  const lines = input.lines.map((line) =>
    priceLine(db, actor, line, input.priceTier, input.customerId ?? null, approver)
  )

  const preDiscountGross = sum(lines.map((line) => line.preGross))
  const cartDiscount = input.cartDiscount

  if (cartDiscount > preDiscountGross) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That discount is more than the sale itself. Please enter a smaller discount.',
      `cart discount ${cartDiscount} exceeds pre-discount gross ${preDiscountGross}`
    )
  }

  // ── PASS 2: the cart discount, split exactly, tax re-resolved on what is actually paid ──
  const shares = apportionCartDiscount(
    cartDiscount,
    lines.map((line) => line.preGross)
  )

  lines.forEach((line, index) => {
    const share = shares[index] ?? 0
    if (share === 0) return // untouched — its frozen figures are already right

    const charged = line.preGross - share

    // The discounted amount IS what the customer pays, tax included. Back the tax out of it: `gross`
    // comes back exactly equal to `charged`, which is what makes the shares sum to the discount without
    // a rounding line ever being needed.
    const resolved = computeLineTax(charged, line.taxRateBp, 'inclusive')
    line.net = resolved.net
    line.tax = resolved.tax
    line.gross = resolved.gross
  })

  const subtotalNet = sum(lines.map((line) => line.net))
  const taxTotal = sum(lines.map((line) => line.tax))
  const grandTotal = sum(lines.map((line) => line.gross))
  const listNet = sum(lines.map((line) => line.listNet))
  const listGross = sum(lines.map((line) => line.listGross))

  return {
    lines,
    subtotalNet,
    taxTotal,
    grandTotal,
    cartDiscount,
    preDiscountGross,
    listNet,
    listGross,
    discountNet: listNet - subtotalNet,
    discountGiven: listGross - grandTotal
  }
}

function priceLine(
  db: DB,
  actor: User,
  line: SaleLineInput,
  tier: PriceTier,
  customerId: number | null,
  approver: User | null
): PricedLine {
  const resolved =
    line.openItem != null
      ? resolveOpenItem(db, line)
      : resolveCatalogLine(db, actor, line, tier, customerId, approver)

  const lineDiscount = line.lineDiscount ?? 0

  // THE LINE AT LIST PRICE, no discounts at all. Its NET is what the journal credits to Sales, so that
  // "Discounts Given" can show what discounting really cost instead of it being silently netted away.
  // A PRICE OVERRIDE is not a discount: unit_price IS the price charged, and the override is recorded
  // as an override, with a name and an audit row against it.
  const listAmount = extendPrice(resolved.unitPrice, resolved.pricedQtyM)
  const list = computeLineTax(listAmount, resolved.taxRateBp, resolved.taxMode)

  // The LINE discount reduces the line's amount IN ITS OWN TAX MODE — which is precisely what migration
  // 0007 means by "net = after line discounts, before tax".
  const amount = listAmount - lineDiscount
  if (amount < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `The discount on "${resolved.name}" is more than the line itself. Please enter a smaller discount.`,
      `line discount ${lineDiscount} exceeds line amount ${listAmount}`
    )
  }

  const pre = computeLineTax(amount, resolved.taxRateBp, resolved.taxMode)

  return {
    ...resolved,
    input: line,
    lineDiscount,
    listNet: list.net,
    listGross: list.gross,
    preGross: pre.gross,
    net: pre.net,
    tax: pre.tax,
    gross: pre.gross,
    serials: line.serials ?? []
  }
}

type ResolvedLine = Pick<
  PricedLine,
  | 'productId'
  | 'isOpenItem'
  | 'name'
  | 'nameOtherLang'
  | 'uom'
  | 'packId'
  | 'batchId'
  | 'stockQtyM'
  | 'pricedQtyM'
  | 'unitPrice'
  | 'taxRateBp'
  | 'taxMode'
  | 'unitCost'
  | 'movesStock'
  | 'trackSerials'
  | 'priceOverrideByUserId'
>

/**
 * AN OPEN ITEM — "Misc — Rs 50". There is no catalog row behind it, so the cashier types the name and
 * the price, and this is the ONE place in a cart line where a price legitimately arrives from outside
 * main. It moves NO STOCK and has NO COGS: there is nothing on a shelf to take off.
 */
function resolveOpenItem(db: DB, line: SaleLineInput): ResolvedLine {
  const open = line.openItem!

  return {
    productId: null,
    isOpenItem: true,
    name: open.name,
    nameOtherLang: null,
    uom: null,
    packId: null,
    batchId: null,
    stockQtyM: 0,
    pricedQtyM: line.qtyM,
    unitPrice: open.unitPrice,
    taxRateBp: taxRateFor(db, open.taxRateBp ?? setting<number>(db, 'tax.defaultRateBp'), false),
    taxMode: open.taxMode ?? setting<TaxMode>(db, 'tax.defaultMode'),
    unitCost: 0,
    movesStock: false,
    // There is no catalogue row behind an open item, so there is nothing to have flagged.
    trackSerials: false,
    priceOverrideByUserId: null
  }
}

function resolveCatalogLine(
  db: DB,
  actor: User,
  line: SaleLineInput,
  tier: PriceTier,
  customerId: number | null,
  approver: User | null
): ResolvedLine {
  const productId = line.productId!
  const product = loadProduct(db, productId)
  const pack = line.packId != null ? loadPack(db, line.packId, productId, product.name) : null

  // A PACK IS SOLD BY THE PACK. `qtyM` arrives in BASE units (a carton of 24 is 24000) because that is
  // what stock is measured in — but the PRICE is the carton's, so the money is extended over CARTONS.
  // Get this backwards and one carton rings up as twenty-four of them.
  let pricedQtyM = line.qtyM
  if (pack) {
    if (pack.packSize <= 0 || line.qtyM % pack.packSize !== 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `"${product.name}" was scanned as a ${uomLabel(db, pack.uomId) ?? 'pack'}, so it can only be sold in whole ones. To sell part of it, scan the item itself.`,
        `pack line qtyM=${line.qtyM} is not a whole multiple of packSize=${pack.packSize}`
      )
    }
    pricedQtyM = (line.qtyM / pack.packSize) * ONE_UNIT
  }

  const catalogPrice = priceFor({ product, pack, tier, customerId })

  const unitPrice =
    line.priceOverride != null
      ? assertMayOverridePrice(db, actor, approver, product.name, line.priceOverride, catalogPrice)
      : catalogPrice

  if (line.batchId != null) assertBatchBelongsToProduct(db, line.batchId, productId, product.name)

  return {
    productId,
    isOpenItem: false,
    name: product.name,
    nameOtherLang: product.nameOtherLang,
    uom: pack ? uomLabel(db, pack.uomId) : uomLabel(db, product.saleUomId),
    packId: pack?.id ?? null,
    // FEFO auto-pick — the cashier NEVER chooses a batch (PLAN.md §1).
    batchId: line.batchId ?? (product.trackBatches ? pickBatchFefo(db, productId) : null),
    stockQtyM: product.itemType === 'inventory' ? line.qtyM : 0,
    pricedQtyM,
    unitPrice,
    taxRateBp: taxRateFor(db, product.taxRateBp, product.isTaxExempt),
    taxMode: product.priceEntryMode,
    // THE FROZEN COGS: the weighted average at this instant, at 4-dp cost scale. Ten purchases later,
    // when the average has moved on, this line still knows what the thing it sold actually cost.
    unitCost: product.costPrice,
    movesStock: product.itemType === 'inventory',
    trackSerials: product.trackSerials,
    priceOverrideByUserId: line.priceOverride != null ? (approver ?? actor).id : null
  }
}

/**
 * FEFO — FIRST EXPIRY, FIRST OUT. The cashier never picks a batch (PLAN.md §1); the shop sells the one
 * that goes off soonest, because the alternative is throwing it away.
 *
 * Only a batch with something still on the shelf is eligible: one that has sold out cannot be picked,
 * and stock that predates batch tracking simply carries no batch on the line.
 */
function pickBatchFefo(db: DB, productId: number): number | null {
  // onHandByBatch already returns them in expiry order, soonest first, nulls last.
  return stock.onHandByBatch(db, productId).find((batch) => batch.onHandM > 0)?.batchId ?? null
}

/**
 * Allocate a sale quantity ACROSS batches, first-expiry-first-out.
 *
 * Walk the batches in expiry order, taking min(remaining, what the batch holds) from each, until the
 * quantity is met. One entry per batch touched. If the shop is oversold (the quantity exceeds every
 * batch combined — allowed, warned and flagged elsewhere), the shortfall is booked against the
 * soonest-expiry batch, which is the one the cashier was reaching for; that batch simply goes
 * negative, honestly. The sum of the allocations always equals the quantity asked for.
 */
function allocateFefo(
  db: DB,
  productId: number,
  neededM: number
): Array<{ batchId: number | null; qtyM: number }> {
  const batches = stock.onHandByBatch(db, productId)
  const allocations: Array<{ batchId: number | null; qtyM: number }> = []

  let remaining = neededM
  for (const batch of batches) {
    if (remaining <= 0) break
    if (batch.onHandM <= 0) continue
    const take = Math.min(remaining, batch.onHandM)
    allocations.push({ batchId: batch.batchId, qtyM: take })
    remaining -= take
  }

  if (remaining > 0) {
    // Oversold. Put the rest on the soonest-expiry batch (the first with any allocation, else the
    // first batch that exists, else no batch at all).
    const fallback = allocations[0]?.batchId ?? batches[0]?.batchId ?? null
    const existing = allocations.find((a) => a.batchId === fallback)
    if (existing) existing.qtyM += remaining
    else allocations.push({ batchId: fallback, qtyM: remaining })
  }

  return allocations.length > 0 ? allocations : [{ batchId: null, qtyM: neededM }]
}

function assertBatchBelongsToProduct(
  db: DB,
  batchId: number,
  productId: number,
  productName: string
): void {
  const owner = db.prepare('SELECT product_id FROM batches WHERE id = ?').pluck().get(batchId) as
    | number
    | undefined

  if (owner !== productId) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `That batch does not belong to "${productName}". Please pick the right batch.`,
      `batch ${batchId} belongs to product ${owner ?? 'nothing'}, not ${productId}`
    )
  }
}

/**
 * A PRICE OVERRIDE is an explicit, permissioned, audited act. WHO may do it is the SETTING
 * `selling.priceOverrideRole` — not a constant, because one shop lets its cashiers haggle and the next
 * one does not.
 *
 * Either the cashier holds the role themselves, or a supervisor has come to the till and approved it.
 * Whoever authorised it is stamped onto the line as `price_override_by` and lands in the audit log with
 * their name and role — which is the only thing that will ever tell the owner that the shop's prices are
 * being quietly renegotiated at the counter.
 */
function assertMayOverridePrice(
  db: DB,
  actor: User,
  approver: User | null,
  productName: string,
  override: number,
  catalogPrice: number
): number {
  const required = setting<string>(db, 'selling.priceOverrideRole')

  if (!roleAtLeast(actor, required) && !(approver != null && roleAtLeast(approver, required))) {
    throw new AppError(
      ErrorCode.NEEDS_APPROVAL,
      `Changing the price of "${productName}" needs approval. Please ask a supervisor.`,
      `price override needs role >= ${required}; actor=${actor.role}, approver=${approver?.role ?? 'none'} (catalog ${catalogPrice}, tried ${override})`
    )
  }

  return override
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

// ═════════════════════════════════════════════════════════════════════════════
// HOLD / QUOTE / RESUME — a parked cart, which takes NO INVOICE NUMBER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PARK THE CART. The customer went back for the milk they forgot, and the queue behind them is moving.
 *
 * A HELD SALE TAKES NO INVOICE NUMBER, MOVES NO STOCK AND POSTS NO JOURNAL. Nothing has happened yet.
 * That is not a simplification — it IS the mechanism that keeps numbering gapless. A number issued to a
 * cart that is then abandoned is a hole in the book, and a book with holes in it is what a tax inspector
 * is trained to look for.
 *
 * The lines ARE written, priced as of now, so the cart survives the app being closed and reopened. When
 * it is resumed and rung up, `complete()` re-prices it from the catalog — the customer pays today's
 * price, not the one that was on the shelf when they walked away.
 */
export function hold(db: DB, actor: User, raw: unknown, now = new Date()): SaleDetail {
  return park(db, actor, parseOrThrow(HoldSaleInput, raw, 'sale.hold'), 'held', now)
}

/**
 * A QUOTATION — a price the shop offered, which may never become a sale. Like a held cart it takes no
 * number, moves no stock and posts no journal (PLAN.md §2). It draws a number only if it is completed.
 */
export function saveQuote(db: DB, actor: User, raw: unknown, now = new Date()): SaleDetail {
  return park(db, actor, parseOrThrow(SaveQuoteInput, raw, 'sale.quote'), 'quote', now)
}

function park(
  db: DB,
  actor: User,
  input: z.output<typeof HoldSaleInput>,
  status: Extract<SaleStatus, 'held' | 'quote'>,
  now: Date
): SaleDetail {
  // Nothing is being approved, because no money moves until this is completed. A discount that needs a
  // supervisor is checked when it is RUNG UP, not when it is parked.
  const priced = priceCart(db, actor, input, null)

  // Re-parking an existing cart UPDATES it, rather than leaving two carts for one customer.
  if (input.saleId != null) assertParked(db, input.saleId)

  const write = db.transaction((): number => {
    const saleId = writeSale(db, {
      parkedId: input.saleId ?? null,
      status,
      invoice: null, // NO NUMBER. That is the whole point of a parked cart.
      at: now,
      userId: actor.id,
      customerId: input.customerId ?? null,
      priceTier: input.priceTier,
      priced,
      paidTotal: 0,
      changeDue: 0,
      hadNegativeStock: false
    })

    insertLines(db, saleId, priced, now)
    return saleId
  })

  return getById(db, write())
}

/** Pick a parked cart back up. A completed or voided sale is history and is never reopened. */
export function resume(db: DB, raw: unknown): SaleDetail {
  const input = parseOrThrow(SaleGetInput, raw, 'sale.resume')
  return assertParked(db, input.id)
}

/**
 * Turn a resumed sale back into cart lines the Sell screen can show — and `complete()` can RE-PRICE.
 *
 * It carries back WHAT was scanned and HOW MANY, and nothing else. The price, the tax and the cost are
 * resolved again from the catalog when the sale is actually rung up, so a cart parked before this
 * morning's price change is sold at this morning's price. An OPEN ITEM is the exception, as always: it
 * has no catalog row to be re-priced from, so it carries its own price back with it.
 *
 * THE BATCH IS NOT CARRIED BACK. FEFO picks the batch when the goods actually leave the shelf, not when
 * a cart was parked — otherwise a cart held overnight would insist on a batch that sold out this
 * morning, and the near-expiry stock it should have taken would stay on the shelf and go off.
 *
 * THE SERIALS *ARE* CARRIED BACK, and that is not the same decision. A batch is picked BY THE SHOP and
 * can be picked again; an IMEI is the specific handset THE CUSTOMER IS HOLDING, and the cashier already
 * scanned it off the box. Dropping it here meant a held phone sale could never be completed at all —
 * main requires one serial per unit (`assertSerials`), and the Sell screen only prompts for one when the
 * item is first scanned. The cart remembers what was keyed into it. (Migration 0007, `serials_json`.)
 */
export function toCartLines(sale: SaleDetail): SaleLineInput[] {
  return sale.lines.map((line): SaleLineInput => {
    if (line.isOpenItem) {
      return {
        qtyM: line.qtyM,
        lineDiscount: line.lineDiscount,
        openItem: {
          name: line.nameSnapshot,
          unitPrice: line.unitPrice,
          taxRateBp: line.taxRateBp,
          taxMode: line.taxMode
        }
      }
    }

    return {
      productId: line.productId,
      packId: line.packId,
      qtyM: line.qtyM,
      lineDiscount: line.lineDiscount,
      // Carry the override back. A held cart or a quote froze its unit_price; if we drop it, resuming
      // re-prices from the catalogue and the customer is charged the FULL price the screen never
      // showed. complete() will re-run the approval check on the resumed override — which is right: a
      // cashier picking up a supervisor's parked cart must get it approved again, not have the till
      // quietly charge a different number.
      ...(line.priceOverrideByUserId != null ? { priceOverride: line.unitPrice } : {}),
      ...(line.serials.length > 0 ? { serials: line.serials } : {})
    }
  })
}

/** Every parked cart, newest first — the hold tray on the Sell screen. */
export function listHeld(
  db: DB,
  status: Extract<SaleStatus, 'held' | 'quote'> = 'held'
): SaleListItem[] {
  return list(db, { status, pageSize: 200 }).rows
}

/** Throw a parked cart away. Only 'held' and 'quote' rows are ever deleted; history is not. */
export function discard(db: DB, actor: User, raw: unknown, now = new Date()): void {
  const input = parseOrThrow(DiscardSaleInput, raw, 'sale.discard')
  const sale = assertParked(db, input.id)

  db.transaction(() => {
    db.prepare('DELETE FROM sales WHERE id = ?').run(input.id) // CASCADE takes the lines with it

    audit.record(
      db,
      actor,
      {
        action: 'sale.discard',
        entity: 'sale',
        entityId: input.id,
        before: { status: sale.status, grandTotal: sale.grandTotal, lines: sale.lines.length }
      },
      now
    )
  })()
}

function assertParked(db: DB, id: number): SaleDetail {
  const sale = getById(db, id)

  if (sale.status !== 'held' && sale.status !== 'quote') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That sale has already been completed, so it cannot be reopened or removed.',
      `sale ${id} has status "${sale.status}"`
    )
  }
  return sale
}

// ═════════════════════════════════════════════════════════════════════════════
// COMPLETE — the one that matters
// ═════════════════════════════════════════════════════════════════════════════

export type CompleteSaleResult = {
  sale: SaleDetail
  /** Ready for `printing/receipt.ts`. This service never writes HTML. */
  receipt: ReceiptData
  journalId: number
}

/**
 * RING IT UP. In ONE transaction, or not at all:
 *
 *   1. every line is priced, taxed and FROZEN               (priceCart — and §2 of the header)
 *   2. the discount rules are enforced                      (settings; a supervisor; a reason code)
 *   3. negative stock is checked                            (setting: warn | block | allow)
 *   4. the credit (udhaar) rules are enforced               (settings: customer required; credit limit)
 *   5. the invoice number is DRAWN and the counter bumped   in this same transaction. GAPLESS.
 *   6. stock moves                                          (stock.record: freezes the cost AND value)
 *   7. the journal posts, and BALANCES                      (ledger.post throws if it does not)
 *   8. the payments are written and the change worked out
 *
 * If any of it fails, ALL of it rolls back — including the invoice number, which the next sale then
 * takes instead. A number drawn for a sale that did not happen is a gap, and there are no gaps.
 */
export function complete(db: DB, actor: User, raw: unknown, now = new Date()): CompleteSaleResult {
  const input = parseOrThrow(CompleteSaleInput, raw, 'sale.complete')

  // THE APPROVER IS PROVEN, NOT CLAIMED.
  //
  // It used to be `loadUser(db, input.approvedByUserId)` — a plain fetch by an integer the renderer
  // sent. That is no authentication at all: a cashier passes the owner's id (usually 1), the role
  // check passes against the fetched owner, and a Rs 1 television walks out the door — with the audit
  // log naming a supervisor who was never at the till. The supervisor's own id is not a secret.
  //
  // So the approver is now whoever the APPROVAL PIN resolves to, established here in main. The
  // renderer cannot forge a PIN it does not know. No PIN → no approver → the over-threshold action is
  // refused, exactly as if no supervisor had come over. (The claimed id is ignored.)
  const approver = input.approverPin ? auth.verifyPin(db, input.approverPin) : null

  assertMayUseTier(db, actor, approver, input.priceTier)

  // Ringing up a parked cart CONVERTS it — the held row becomes this sale. Checked before the
  // transaction so a cashier who tries to re-ring a completed sale gets a sentence, not a constraint.
  if (input.saleId != null) assertParked(db, input.saleId)

  // ── 1. Price everything. Every figure below this line is now frozen. ──────
  const priced = priceCart(db, actor, input, approver)

  // ── 2. A discount above the threshold needs a supervisor AND a reason ─────
  const approval = checkDiscountApproval(db, priced, input, approver)

  // ── 3. Negative stock ─────────────────────────────────────────────────────
  const shortages = findShortages(db, priced)
  const hadNegativeStock = applyNegativeStockPolicy(db, shortages, input.acceptNegativeStock)

  // ── 3b. Serialised goods: one unit, one IMEI, counted in MAIN ─────────────
  assertSerials(db, priced)

  // ── 4. Credit (udhaar) ────────────────────────────────────────────────────
  const payments = resolvePayments(db, input.payments)
  const creditTotal = sum(
    payments.filter((payment) => payment.account === ACC.RECEIVABLE).map((payment) => payment.amount)
  )
  const customerId = assertCreditRules(db, creditTotal, input)

  // ── 5. The money that actually crossed the counter ────────────────────────
  const paidTotal = sum(payments.map((payment) => payment.amount))
  const changeDue = paidTotal - priced.grandTotal

  if (changeDue < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `The payment is short by ${money(db, -changeDue)}. Please take the rest, or add it as Credit (Udhaar).`,
      `paid ${paidTotal} < grand total ${priced.grandTotal}`
    )
  }

  const cashTendered = sum(
    payments.filter((payment) => payment.account === ACC.CASH).map((payment) => payment.amount)
  )

  // Change comes out of the drawer, so there has to be cash in the drawer to give it from. Anything
  // else is a data-entry mistake, and it would post a NEGATIVE debit to Cash.
  if (changeDue > cashTendered) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Change can only be given out of a cash payment. Please check the amounts taken.',
      `change due ${changeDue} exceeds cash tendered ${cashTendered}`
    )
  }

  // ── EVERYTHING BELOW HAPPENS TOGETHER, OR NOT AT ALL ─────────────────────
  const run = db.transaction((): { saleId: number; journalId: number } => {
    const invoice = drawInvoiceNumber(db, now)

    const saleId = writeSale(db, {
      // The parked cart BECOMES this sale — it does not sit in the tray waiting to be sold twice.
      parkedId: input.saleId ?? null,
      status: 'completed',
      invoice,
      at: now,
      userId: actor.id,
      customerId,
      priceTier: input.priceTier,
      priced,
      paidTotal,
      changeDue,
      hadNegativeStock
    })

    insertLines(db, saleId, priced, now)

    const insertPayment = db.prepare(
      `INSERT INTO sale_payments
         (sale_id, method_lookup_id, amount, cheque_no, cheque_date, wallet_ref, created_at)
       VALUES
         (@saleId, @methodLookupId, @amount, @chequeNo, @chequeDate, @walletRef, @createdAt)`
    )

    for (const payment of payments) {
      insertPayment.run({
        saleId,
        methodLookupId: payment.methodLookupId,
        amount: payment.amount, // what they HANDED OVER — the 500 note, not the 460 owed
        chequeNo: payment.chequeNo,
        chequeDate: payment.chequeDate,
        walletRef: payment.walletRef,
        createdAt: now.toISOString()
      })
    }

    // ── 6. STOCK. One movement per line, NEGATIVE, at the frozen average cost ──
    //
    // stock.record() freezes unit_cost and value_minor onto the movement and keeps the weighted average
    // honest. THE JOURNAL BELOW POSTS THE VALUE IT FROZE — it does not recompute it. That is what makes
    // GL Inventory and the stock valuation report equal BY CONSTRUCTION (migration 0006).
    let cogs = 0

    for (const line of priced.lines) {
      if (!line.movesStock || line.productId == null) continue

      // FEFO ACROSS BATCHES — not all onto one.
      //
      // A batch-tracked sale used to take its WHOLE quantity off the single soonest-expiry batch,
      // even when that batch did not hold enough: 5 units of milk against a 2-unit batch drove that
      // batch to −3 while a later batch still held 10. Total stock and the ledger stayed right, but
      // the per-batch figures — the whole reason batches exist (expiry, batch valuation) — were
      // nonsense. So the quantity is now allocated across batches in expiry order, soonest first, and
      // ONE movement is written per batch consumed. A non-batch line is a single allocation, exactly
      // as before.
      const allocations =
        line.batchId != null
          ? allocateFefo(db, line.productId, line.stockQtyM)
          : [{ batchId: line.batchId, qtyM: line.stockQtyM }]

      for (const allocation of allocations) {
        const movement = stock.record(db, {
          productId: line.productId,
          type: 'sale',
          qtyM: -allocation.qtyM, // NEGATIVE: stock leaves the shop. A carton takes its 24 pieces out.
          unitCost: line.unitCost,
          batchId: allocation.batchId,
          refType: SALE_REF_TYPE,
          refId: saleId,
          userId: actor.id,
          at: now
        })

        cogs += Math.abs(movementValue(db, movement.id))
      }

      // A serialised item (a phone) sells ONE PHYSICAL UNIT AT A TIME. `assertSerials` has already
      // counted them and proved every one of them belongs to THIS product and is still in stock.
      // markSold re-checks both — it refuses to sell the same IMEI twice, and it refuses to sell one
      // that belongs to another item, so the second customer cannot walk out with somebody else's phone.
      for (const serial of line.serials) {
        catalog.markSold(db, { productId: line.productId, serial, saleId }, now)
      }
    }

    // ── 7. THE JOURNAL (see §3 of the header — it balances as algebra) ───────
    const journalLines: ledger.JournalLineInput[] = []

    // DR what the shop actually received. Cash is NET OF THE CHANGE handed back: the drawer keeps
    // Rs 460, not the Rs 500 note.
    const byAccount = new Map<string, number>()
    for (const payment of payments) {
      byAccount.set(payment.account, (byAccount.get(payment.account) ?? 0) + payment.amount)
    }
    if (changeDue > 0) {
      byAccount.set(ACC.CASH, (byAccount.get(ACC.CASH) ?? 0) - changeDue)
    }
    for (const [account, amount] of byAccount) {
      if (amount > 0) journalLines.push({ account, debit: amount })
    }

    // DR what discounting COST — line discounts and the cart discount alike, at their ex-tax value.
    // Contra-income, so the owner can SEE it in one place instead of it vanishing into a smaller Sales
    // figure that nobody can question.
    if (priced.discountNet > 0) {
      journalLines.push({ account: ACC.DISCOUNTS, debit: priced.discountNet })
    }

    // CR the sale at its UNDISCOUNTED net, and the tax at what was ACTUALLY charged.
    if (priced.listNet > 0) journalLines.push({ account: ACC.SALES, credit: priced.listNet })
    if (priced.taxTotal > 0) journalLines.push({ account: ACC.OUTPUT_TAX, credit: priced.taxTotal })

    // What it COST the shop: the stock movements' own frozen values, summed. Never a fresh multiply —
    // sum-of-rounded is not round-of-sum, and that difference is exactly how the GL and the stock report
    // once drifted a paisa apart with the trial balance still green.
    if (cogs > 0) {
      journalLines.push({ account: ACC.COGS, debit: cogs })
      journalLines.push({ account: ACC.INVENTORY, credit: cogs })
    }

    const journalId = ledger.post(db, {
      at: now,
      refType: SALE_REF_TYPE,
      refId: saleId,
      memo: `Sale ${invoice.invoiceNo}`,
      userId: actor.id,
      lines: journalLines
    })

    // ── 8. WHO did WHAT, and WHY ─────────────────────────────────────────────
    writeSaleAuditTrail(db, actor, {
      saleId,
      invoiceNo: invoice.invoiceNo,
      priced,
      approval,
      approver,
      shortages,
      hadNegativeStock,
      now
    })

    return { saleId, journalId }
  })

  const { saleId, journalId } = run()
  const sale = getById(db, saleId)

  return { sale, receipt: buildReceipt(db, sale, false), journalId }
}

/** The money a movement moved, as IT froze it (migration 0006). Read, never recomputed. */
function movementValue(db: DB, movementId: number): number {
  return db
    .prepare('SELECT value_minor FROM stock_movements WHERE id = ?')
    .pluck()
    .get(movementId) as number
}

// ── The invoice number ───────────────────────────────────────────────────────

type DrawnInvoice = { invoiceNo: string; seq: number; year: number }

/**
 * DRAW THE NEXT NUMBER, and bump the counter — INSIDE THE CALLER'S TRANSACTION.
 *
 * Not before it, not after it, and not in a transaction of its own. If the sale rolls back, so does the
 * number, and the next sale takes it instead. Any other arrangement — reserving a number when the cart
 * opens, bumping the counter separately — puts holes in the book.
 *
 * The FORMAT comes from Settings (prefix, padding, year, yearly reset) and is built by `formatInvoiceNo`
 * in shared/, so the Settings screen's live preview and the number that actually goes on the receipt are
 * produced by the same line of code.
 */
function drawInvoiceNumber(db: DB, now: Date): DrawnInvoice {
  const year = now.getFullYear()
  const resetYearly = setting<boolean>(db, 'invoice.resetYearly')

  // COUPLING — this is what stops New Year's Day from bricking the till.
  //
  // If the sequence RESETS each year, the year MUST appear in the printed number, or 2027 re-issues
  // INV-000001 on top of 2026's, hits `sales.invoice_no UNIQUE`, and every sale from then on throws.
  // So `resetYearly` forces the year into the number, regardless of the cosmetic `includeYear`.
  // (A shop can still SHOW the year without resetting — includeYear on, resetYearly off — which is
  // safe, because the sequence then runs straight through and never repeats.)
  const includeYear = resetYearly || setting<boolean>(db, 'invoice.includeYear')

  // The counter resets per year ONLY when asked to; otherwise one continuous counter under a key no
  // real year collides with (NO_YEAR_RESET = 0).
  const counterYear = resetYearly ? year : NO_YEAR_RESET

  const prefix = setting<string>(db, 'invoice.prefix')
  const padding = setting<number>(db, 'invoice.padding')

  const current = db
    .prepare('SELECT next_seq FROM invoice_counters WHERE series = ? AND year = ?')
    .pluck()
    .get(SALE_SERIES, counterYear) as number | undefined

  let seq = current ?? 1

  // A NUMBER IS NEVER REUSED. Full stop.
  //
  // The counter is the fast path, but it is not trusted to be right after a settings toggle, a
  // restore, or a clock change. So before a number is used it is checked against the book, and if it
  // is somehow already there the sequence advances until it is free. A skipped number is a gap the
  // owner can see and explain; a DUPLICATE hits the UNIQUE constraint, rolls the sale back, takes the
  // counter bump with it, and bricks the till forever. A gap is recoverable. A brick is not.
  const exists = db.prepare('SELECT 1 FROM sales WHERE invoice_no = ?').pluck()
  let invoiceNo = formatInvoiceNo({ prefix, padding, includeYear, year, seq })
  while (exists.get(invoiceNo) != null) {
    seq += 1
    invoiceNo = formatInvoiceNo({ prefix, padding, includeYear, year, seq })
  }

  const at = now.toISOString()
  db.prepare(
    `INSERT INTO invoice_counters (series, year, next_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (series, year) DO UPDATE SET next_seq = excluded.next_seq, updated_at = excluded.updated_at`
  ).run(SALE_SERIES, counterYear, seq + 1, at, at)

  return { invoiceNo, seq, year }
}

// ── Discount approval ────────────────────────────────────────────────────────

type DiscountApproval = {
  required: boolean
  percentBp: number
  /** The reason code that was checked against lookups('discount_reason'), for the audit row. */
  reasonCode: string | null
}

/**
 * A DISCOUNT ABOVE THE THRESHOLD NEEDS A SUPERVISOR, A REASON CODE, AND A NAME AGAINST IT.
 *
 * BOTH limits are settings, and WHICHEVER IS REACHED FIRST applies:
 *
 *     selling.discountApprovalPercent   basis points, measured against what the cart would have cost
 *     selling.discountApprovalAmount    money — 0 means "use the percentage only"
 *
 * The discount measured here is what the customer ACTUALLY GOT OFF — list gross less what they paid — so
 * a line discount and a cart discount are weighed on the same scale, and neither can be used to slip
 * under a threshold the other would have tripped.
 *
 * Discounting is the classic way a till leaks money, and it leaks slowly enough that nobody notices for
 * a year. So above the line: a supervisor's name, a reason from the owner's own list, and an audit row.
 * Below it, a cashier can knock Rs 5 off a dented tin without calling anyone over.
 */
function checkDiscountApproval(
  db: DB,
  priced: PricedCart,
  input: z.output<typeof CompleteSaleInput>,
  approver: User | null
): DiscountApproval {
  const discount = priced.discountGiven
  if (discount <= 0) return { required: false, percentBp: 0, reasonCode: null }

  const percentBp = priced.listGross > 0 ? Math.round((discount * 10_000) / priced.listGross) : 0

  const limitPercent = setting<number>(db, 'selling.discountApprovalPercent')
  const limitAmount = setting<number>(db, 'selling.discountApprovalAmount')

  const overPercent = percentBp > limitPercent
  const overAmount = limitAmount > 0 && discount > limitAmount // 0 = "use the percentage only"

  if (!overPercent && !overAmount) return { required: false, percentBp, reasonCode: null }

  if (approver == null || !roleCan(approver.role, 'sale.discount.over_threshold')) {
    throw new AppError(
      ErrorCode.NEEDS_APPROVAL,
      `A discount of ${money(db, discount)} is more than a cashier may give on their own. Please ask a supervisor to approve it.`,
      `discount ${discount} (${percentBp}bp of ${priced.listGross}) is over the limits (percent=${limitPercent}bp, amount=${limitAmount}); approver=${approver?.role ?? 'none'}`
    )
  }

  // The reason must come from the owner's OWN list — never a string the renderer made up. Whichever
  // discount is on the document has to carry one, and the first one found is what the audit row cites.
  let reasonCode: string | null = null

  if (priced.cartDiscount > 0) {
    const code = input.cartDiscountReasonCode
    if (!code) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Please choose a reason for this discount from the list.',
        'discount over threshold with no cartDiscountReasonCode'
      )
    }
    reasonCode = requireLookupByCode(
      db,
      'discount_reason',
      code,
      'Please choose a reason for this discount from the list.'
    ).code
  }

  for (const line of priced.lines) {
    if (line.lineDiscount <= 0) continue

    const code = line.input.discountReasonCode
    if (!code) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `Please choose a reason for the discount on "${line.name}".`,
        'line discount over threshold with no discountReasonCode'
      )
    }
    const checked = requireLookupByCode(
      db,
      'discount_reason',
      code,
      `Please choose a reason for the discount on "${line.name}".`
    )
    reasonCode ??= checked.code
  }

  return { required: true, percentBp, reasonCode }
}

/** WHO may switch off retail prices is the SETTING `selling.wholesaleTierRole`. Not a constant. */
function assertMayUseTier(db: DB, actor: User, approver: User | null, tier: PriceTier): void {
  if (tier === 'retail') return

  const required = setting<string>(db, 'selling.wholesaleTierRole')
  if (roleAtLeast(actor, required) || (approver != null && roleAtLeast(approver, required))) return

  throw new AppError(
    ErrorCode.NEEDS_APPROVAL,
    'Selling at wholesale prices needs approval. Please ask a supervisor.',
    `price tier "${tier}" needs role >= ${required}; actor=${actor.role}, approver=${approver?.role ?? 'none'}`
  )
}

// ── Negative stock ───────────────────────────────────────────────────────────

type Shortage = { productId: number; name: string; onHandM: number; wantedM: number }

/**
 * WHAT WOULD GO NEGATIVE — asked ONCE PER PRODUCT, not once per line.
 *
 * Two lines of 3 against 5 on the shelf IS a shortage, even though neither line is one on its own.
 * Asking per line would wave that sale straight through, unflagged.
 */
function findShortages(db: DB, priced: PricedCart): Shortage[] {
  const wanted = new Map<number, number>()

  for (const line of priced.lines) {
    if (!line.movesStock || line.productId == null) continue
    wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.stockQtyM)
  }

  const shortages: Shortage[] = []

  for (const [productId, wantedM] of wanted) {
    // wouldGoNegative takes the SIGNED movement — a sale of 6 is −6000 — and already knows that a
    // service or a bag charge has no stock to be short of.
    if (!stock.wouldGoNegative(db, productId, -wantedM)) continue

    shortages.push({
      productId,
      name:
        (db.prepare('SELECT name FROM products WHERE id = ?').pluck().get(productId) as
          | string
          | undefined) ?? `item #${productId}`,
      onHandM: stock.onHand(db, productId),
      wantedM
    })
  }

  return shortages
}

/**
 * SELLING WHAT THE SHOP DOES NOT HAVE. The behaviour is the SETTING `selling.negativeStock`:
 *
 *   'warn'   the cashier is told, and may go ahead. The sale is FLAGGED and AUDIT-LOGGED.
 *   'block'  refused, in plain language.
 *   'allow'  nothing is asked — but the sale is STILL flagged and STILL audit-logged. "Silent" means
 *            silent TO THE CASHIER, never invisible to the owner. The leakage report is built on this
 *            flag, and a sale that quietly went out against stock that was not there is precisely what
 *            that report exists to show.
 *
 * On 'warn' the warning is enforced HERE, in MAIN — not in the renderer, which is not a security
 * boundary and is also not the thing that knows what is on the shelf. The Sell screen shows the message,
 * the cashier confirms, and it comes back with `acceptNegativeStock: true`. A warning that main did not
 * enforce would be a warning a renderer could simply not show.
 */
function applyNegativeStockPolicy(db: DB, shortages: Shortage[], accepted: boolean): boolean {
  if (shortages.length === 0) return false

  const policy = setting<string>(db, 'selling.negativeStock')
  const detail = shortages
    .map((s) => `${s.name} (${formatQty(s.onHandM)} in stock, selling ${formatQty(s.wantedM)})`)
    .join(', ')

  if (policy === 'block') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `There is not enough stock: ${detail}. Please take the delivery in first, or adjust the stock.`,
      `negative stock blocked by selling.negativeStock=block: ${detail}`
    )
  }

  if (policy === 'warn' && !accepted) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `There is not enough stock: ${detail}. The sale can still go through — a stock count is often simply out of date — but it will be flagged for the owner. Confirm to continue.`,
      `negative stock warning not yet accepted: ${detail}`
    )
  }

  return true // 'warn' and confirmed, or 'allow'. Either way: FLAG IT, and audit it.
}

// ── Serial numbers (IMEIs) ───────────────────────────────────────────────────

/**
 * ONE PHYSICAL UNIT, ONE IMEI — AND MAIN IS THE ONE THAT COUNTS THEM.
 *
 * `SaleLineInput.serials` already states the contract in words: "ONLY for a product flagged
 * `track_serials`, and then ONE PER UNIT". Nothing enforced it. The sale simply looped over whatever
 * serials the renderer happened to send, which meant all three of these went through silently:
 *
 *   NO SERIALS AT ALL     Sell two phones, send an empty array, and two handsets leave the shop with
 *                         nothing recorded against them. The warranty claim cannot be traced, the
 *                         stolen-handset check cannot be answered, and — because nothing was marked
 *                         sold — BOTH IMEIs are still "in stock" and can be sold to somebody else.
 *
 *   TOO FEW SERIALS       Sell two, name one. Same thing, for the phone nobody named.
 *
 *   SOMEONE ELSE'S IMEI   Name a serial belonging to a different product. `markSold` now refuses
 *                         this outright (catalog.ts), but the count has to be checked HERE, because
 *                         markSold only ever sees one serial at a time and cannot know how many the
 *                         line was owed.
 *
 * A serial is ONE UNIT of the base item, so the number required is `qtyM / ONE_UNIT` — which is the
 * right answer for a carton too: a box of 24 handsets is 24000 base units and needs 24 IMEIs.
 *
 * And the reverse rule matters just as much: a product that does NOT track serials must not carry
 * one, because the only thing main could do with it is mark some other item's IMEI sold.
 *
 * Checked BEFORE the transaction opens, so the cashier gets a sentence rather than a rolled-back
 * sale. `markSold` re-checks ownership inside it — belt and braces on the one thing that would let a
 * customer walk out with a phone the shop cannot account for.
 */
function assertSerials(db: DB, priced: PricedCart): void {
  const seen = new Map<string, string>() // serial -> the line that already claimed it

  for (const line of priced.lines) {
    if (!line.trackSerials) {
      if (line.serials.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `"${line.name}" is not a serial-tracked item, so it cannot take a serial number.`,
          `serials supplied for product ${line.productId} which has track_serials = 0`
        )
      }
      continue
    }

    // Half a phone is not a thing. (A weighed item is never serial-tracked; this says so out loud.)
    if (line.stockQtyM % ONE_UNIT !== 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `"${line.name}" is sold by the serial number, so it can only be sold in whole units.`,
        `serial-tracked product ${line.productId} has qty_m=${line.stockQtyM}, not a whole multiple of ${ONE_UNIT}`
      )
    }

    const required = line.stockQtyM / ONE_UNIT

    if (line.serials.length !== required) {
      throw new AppError(
        ErrorCode.VALIDATION,
        required === 1
          ? `Please scan the serial number for "${line.name}".`
          : `"${line.name}" needs ${required} serial numbers — ${line.serials.length} ${line.serials.length === 1 ? 'was' : 'were'} entered. Please scan one for each unit.`,
        `product ${line.productId} needs ${required} serial(s), got ${line.serials.length}`
      )
    }

    for (const raw of line.serials) {
      const serial = raw.trim()

      // The SAME IMEI twice on one document would sell one handset to one customer twice, and the
      // second markSold would throw mid-transaction — after the stock had already moved.
      const claimedBy = seen.get(serial)
      if (claimedBy != null) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `Serial number ${serial} has been entered twice on this sale.`,
          `duplicate serial ${serial} on this document (already on "${claimedBy}")`
        )
      }
      seen.set(serial, line.name)

      const row = db
        .prepare('SELECT product_id, status FROM serial_numbers WHERE serial = ?')
        .get(serial) as { product_id: number; status: string } | undefined

      if (!row) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          `Serial number ${serial} is not in stock. Check the number, or record it on the delivery first.`,
          `unknown serial ${serial}`
        )
      }
      if (row.status === 'sold') {
        throw new AppError(
          ErrorCode.VALIDATION,
          `Serial number ${serial} has already been sold.`,
          `serial ${serial} is already sold`
        )
      }
      if (row.product_id !== line.productId) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `Serial number ${serial} does not belong to "${line.name}". Please scan the serial from the item you are selling.`,
          `serial ${serial} belongs to product ${row.product_id}, not ${line.productId}`
        )
      }
    }
  }
}

// ── Payments and credit ──────────────────────────────────────────────────────

type ResolvedPayment = {
  methodLookupId: number
  code: string
  label: string
  amount: number
  account: string
  chequeNo: string | null
  chequeDate: string | null
  walletRef: string | null
}

/**
 * WHERE THE MONEY LANDS. Payment methods are LOOKUPS — the shop adds "Sadapay" itself, in Settings,
 * without a new release — so the account is chosen from the method's CODE, and anything the shop invents
 * that is neither cash nor a promise is money that arrives in the bank.
 */
const PAYMENT_ACCOUNTS: Record<string, string> = {
  cash: ACC.CASH,
  credit: ACC.RECEIVABLE // udhaar: they paid with a promise, and it becomes a receivable
}

function accountForPaymentMethod(code: string): string {
  return PAYMENT_ACCOUNTS[code] ?? ACC.BANK
}

function resolvePayments(
  db: DB,
  payments: z.output<typeof CompleteSaleInput>['payments']
): ResolvedPayment[] {
  return payments.map((payment) => {
    const method = requireLookupById(
      db,
      'payment_method',
      payment.methodLookupId,
      'Please choose how the customer is paying.'
    )

    return {
      methodLookupId: method.id,
      code: method.code,
      label: method.label,
      amount: payment.amount,
      account: accountForPaymentMethod(method.code),
      chequeNo: payment.chequeNo ?? null,
      chequeDate: payment.chequeDate ?? null,
      walletRef: payment.walletRef ?? null
    }
  })
}

/**
 * UDHAAR. A credit sale is money the shop has NOT been paid, and the two settings that guard it are
 * `selling.requireCustomerForCredit` and `selling.creditLimit`. Neither is a constant here.
 *
 * "Money owed with nobody attached to it is money you will not collect."
 */
function assertCreditRules(
  db: DB,
  creditTotal: number,
  input: z.output<typeof CompleteSaleInput>
): number | null {
  const customerId = input.customerId ?? null

  if (creditTotal <= 0) return customerId

  if (customerId == null) {
    if (setting<boolean>(db, 'selling.requireCustomerForCredit')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'A credit (udhaar) sale must be against a customer. Please choose who it is for.',
        'credit sale with no customer while selling.requireCustomerForCredit is on'
      )
    }
    return null
  }

  const customer = db
    .prepare('SELECT id, name, credit_limit FROM customers WHERE id = ? AND is_active = 1')
    .get(customerId) as { id: number; name: string; credit_limit: number } | undefined

  if (!customer) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That customer could not be found. They may have been removed.',
      `customer id=${customerId} does not exist or is inactive`
    )
  }

  const policy = setting<string>(db, 'selling.creditLimit')
  if (policy === 'ignore') return customerId

  const outstanding = outstandingCredit(db, customerId)

  // A credit limit of 0 is how an owner CUTS A CUSTOMER OFF — it does not mean "no limit". (customers.ts)
  if (outstanding + creditTotal <= customer.credit_limit) return customerId

  if (policy === 'block') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${customer.name} would go over their credit limit of ${money(db, customer.credit_limit)}. They already owe ${money(db, outstanding)}. Please take payment instead.`,
      `credit limit blocked: outstanding=${outstanding} + credit=${creditTotal} > limit=${customer.credit_limit}`
    )
  }

  if (!input.acceptOverCreditLimit) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${customer.name} already owes ${money(db, outstanding)}, and this would take them over their limit of ${money(db, customer.credit_limit)}. Confirm to give them more credit anyway.`,
      `credit limit warning not yet accepted: outstanding=${outstanding} + ${creditTotal} > ${customer.credit_limit}`
    )
  }

  return customerId
}

/**
 * WHAT A CUSTOMER OWES — DERIVED, never stored. There is no balance column and there never will be
 * (see customers.ts): a typed balance is one that can disagree with the invoices behind it, and then the
 * shop chases a customer for money the ledger says they do not owe.
 *
 *     opening udhaar  +  every credit payment on a COMPLETED sale
 *
 * A voided sale is excluded, because it did not happen.
 *
 * >> PHASE 7: WHEN `customer_payments` EXISTS, SUBTRACT IT HERE. Until then, a customer who has paid the
 * >> shop back still shows the old debt, and their credit limit bites sooner than it should. That is the
 * >> safe direction to be wrong in, and it is the only direction available before the ledger screen
 * >> exists. It is not a place to invent a number.
 */
export function outstandingCredit(db: DB, customerId: number): number {
  const opening = db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM opening_receivables WHERE customer_id = ?')
    .pluck()
    .get(customerId) as number

  const onCredit = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0)
       FROM sale_payments p
       JOIN sales s   ON s.id = p.sale_id
       JOIN lookups l ON l.id = p.method_lookup_id
       WHERE s.customer_id = ? AND s.status = 'completed' AND l.code = 'credit'`
    )
    .pluck()
    .get(customerId) as number

  return opening + onCredit
}

// ── Writing the rows ─────────────────────────────────────────────────────────

type WriteSaleArgs = {
  /**
   * The parked cart this document IS. It is UPDATED IN PLACE, never copied.
   *
   * That matters twice over. A held cart that was rung up must LEAVE THE HOLD TRAY — insert a second
   * row instead and the parked cart sits there for the next cashier to ring up all over again. And a
   * QUOTE that is accepted must BECOME the sale (PLAN.md §2: "a quote converts to a sale and only then
   * takes an invoice number") — the customer was quoted document #14, and document #14 is what they
   * should be invoiced against.
   */
  parkedId: number | null
  status: SaleStatus
  invoice: DrawnInvoice | null
  at: Date
  userId: number
  customerId: number | null
  priceTier: PriceTier
  priced: PricedCart
  paidTotal: number
  changeDue: number
  hadNegativeStock: boolean
}

/** Write the sale — converting the parked cart it came from, if there was one. */
function writeSale(db: DB, args: WriteSaleArgs): number {
  const { priced } = args

  const values = {
    // A held cart and a quote take NO NUMBER. The database refuses one if they try (migration 0007).
    invoiceNo: args.invoice?.invoiceNo ?? null,
    invoiceSeq: args.invoice?.seq ?? null,
    invoiceYear: args.invoice?.year ?? null,
    // The clock is MAIN'S, and a resumed cart is timestamped WHEN THE MONEY CHANGED HANDS — not when it
    // was parked. That is the date on the receipt, in the period, and in the tax return.
    at: args.at.toISOString(),
    customerId: args.customerId,
    userId: args.userId, // whoever RANG IT UP, who need not be whoever parked it
    priceTier: args.priceTier,
    status: args.status,
    subtotalNet: priced.subtotalNet,
    cartDiscount: priced.cartDiscount,
    taxTotal: priced.taxTotal,
    grandTotal: priced.grandTotal,
    paidTotal: args.paidTotal,
    changeDue: args.changeDue,
    hadNegativeStock: args.hadNegativeStock ? 1 : 0
  }

  if (args.parkedId != null) {
    // The cart was RE-PRICED from the catalog on the way through, so the snapshot taken when it was
    // parked is stale. Out it goes — the lines about to be written are the ones that happened.
    db.prepare('DELETE FROM sale_lines WHERE sale_id = ?').run(args.parkedId)

    db.prepare(
      `UPDATE sales SET
         invoice_no = @invoiceNo, invoice_seq = @invoiceSeq, invoice_year = @invoiceYear,
         at = @at, customer_id = @customerId, user_id = @userId, price_tier = @priceTier,
         status = @status, subtotal_net = @subtotalNet, cart_discount = @cartDiscount,
         tax_total = @taxTotal, grand_total = @grandTotal, paid_total = @paidTotal,
         change_due = @changeDue, had_negative_stock = @hadNegativeStock
       WHERE id = @id`
    ).run({ ...values, id: args.parkedId })

    return args.parkedId
  }

  return Number(
    db
      .prepare(
        `INSERT INTO sales
           (invoice_no, invoice_seq, invoice_year, at, customer_id, user_id, price_tier, status,
            subtotal_net, cart_discount, tax_total, grand_total, paid_total, change_due,
            had_negative_stock, created_at)
         VALUES
           (@invoiceNo, @invoiceSeq, @invoiceYear, @at, @customerId, @userId, @priceTier, @status,
            @subtotalNet, @cartDiscount, @taxTotal, @grandTotal, @paidTotal, @changeDue,
            @hadNegativeStock, @createdAt)`
      )
      .run({ ...values, createdAt: new Date().toISOString() }).lastInsertRowid
  )
}

function insertLines(db: DB, saleId: number, priced: PricedCart, now: Date): void {
  const insert = db.prepare(
    `INSERT INTO sale_lines
       (sale_id, product_id, name_snapshot, name_other_lang, batch_id, pack_id, qty_m, uom,
        unit_price, line_discount, net, tax_rate_bp, tax_amount, gross, tax_mode, unit_cost,
        is_open_item, price_override_by, serials_json, priced_qty_m, created_at)
     VALUES
       (@saleId, @productId, @nameSnapshot, @nameOtherLang, @batchId, @packId, @qtyM, @uom,
        @unitPrice, @lineDiscount, @net, @taxRateBp, @taxAmount, @gross, @taxMode, @unitCost,
        @isOpenItem, @priceOverrideBy, @serialsJson, @pricedQtyM, @createdAt)`
  )

  for (const line of priced.lines) {
    insert.run({
      saleId,
      productId: line.productId,
      // FROZEN: the quantity the line was PRICED on (1 carton, not its 24 base units). Frozen so a
      // later edit to the pack size cannot make a reprint disagree with the original. (migration 0008)
      pricedQtyM: line.pricedQtyM,
      nameSnapshot: line.name, // FROZEN. A later rename does not rewrite an old receipt.
      nameOtherLang: line.nameOtherLang,
      batchId: line.batchId,
      packId: line.packId,
      // BASE units — what stock is measured in. A carton of 24 is 24000, even though it PRICED as one.
      // An open item and a non-inventory item move no stock, so the quantity they were priced on is the
      // only quantity they have.
      qtyM: line.stockQtyM > 0 ? line.stockQtyM : line.input.qtyM,
      uom: line.uom,
      unitPrice: line.unitPrice,
      lineDiscount: line.lineDiscount,
      net: line.net,
      taxRateBp: line.taxRateBp,
      taxAmount: line.tax,
      gross: line.gross,
      taxMode: line.taxMode,
      unitCost: line.unitCost,
      isOpenItem: line.isOpenItem ? 1 : 0,
      priceOverrideBy: line.priceOverrideByUserId,
      // So that PARKING A CART DOES NOT FORGET THE IMEI. See migration 0007. A completed sale's real
      // record of which handset went out is serial_numbers.sale_id; this is the cart's memory.
      serialsJson: line.serials.length > 0 ? JSON.stringify(line.serials) : null,
      createdAt: now.toISOString()
    })
  }
}

/** WHO did WHAT and WHEN — name and ROLE copied in, never joined. (CLAUDE.md §4, audit.ts.) */
function writeSaleAuditTrail(
  db: DB,
  actor: User,
  args: {
    saleId: number
    invoiceNo: string
    priced: PricedCart
    approval: DiscountApproval
    approver: User | null
    shortages: Shortage[]
    hadNegativeStock: boolean
    now: Date
  }
): void {
  const { saleId, invoiceNo, priced, approval, approver, shortages, hadNegativeStock, now } = args

  if (approval.required && approver) {
    audit.record(
      db,
      actor,
      {
        action: 'sale.discount.over_threshold',
        entity: 'sale',
        entityId: saleId,
        approvedBy: approver, // the APPROVER'S NAME lands in the log, beside the cashier's
        ...(approval.reasonCode != null ? { reasonCode: approval.reasonCode } : {}),
        after: {
          invoiceNo,
          discountGiven: priced.discountGiven,
          discountPercentBp: approval.percentBp,
          cartDiscount: priced.cartDiscount,
          grandTotal: priced.grandTotal
        }
      },
      now
    )
  }

  if (hadNegativeStock) {
    audit.record(
      db,
      actor,
      {
        action: 'sale.negative_stock',
        entity: 'sale',
        entityId: saleId,
        after: {
          invoiceNo,
          // WHAT the shop sold that it did not have — item by item, with the figures at the time.
          shortages: shortages.map((s) => ({
            productId: s.productId,
            name: s.name,
            onHandM: s.onHandM,
            soldM: s.wantedM
          }))
        }
      },
      now
    )
  }

  for (const line of priced.lines) {
    if (line.priceOverrideByUserId == null) continue

    audit.record(
      db,
      actor,
      {
        action: 'sale.price_override',
        entity: 'sale',
        entityId: saleId,
        ...(approver ? { approvedBy: approver } : {}),
        after: {
          invoiceNo,
          product: line.name,
          productId: line.productId,
          soldAt: line.unitPrice,
          qtyM: line.input.qtyM
        }
      },
      now
    )
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// VOID — cancel a completed sale
// ═════════════════════════════════════════════════════════════════════════════

/**
 * CANCEL A COMPLETED SALE. Supervisor only, enforced HERE — not by hiding a button.
 *
 * A void REVERSES. It does not delete, and it does not release the number:
 *
 *   THE INVOICE KEEPS ITS NUMBER, FOREVER. 000002 stays 000002, and the next sale is 000004. A book that
 *   renumbers itself around a cancellation cannot be audited, and a number that gets reused means two
 *   different sales answer to the same invoice.
 *
 *   THE STOCK COMES BACK AT THE COST IT LEFT AT — the original movement's own frozen cost. So GL
 *   Inventory returns exactly where it was, and the stock valuation still agrees with it.
 *
 *   THE JOURNAL IS REVERSED WITH A CONTRA ENTRY. The original is NEVER touched. The ledger is
 *   append-only, like the stock ledger and like the audit log: a mistake is corrected by RECORDING the
 *   correction, not by erasing the evidence. The contra is built by MIRRORING the original journal's own
 *   lines, so it reverses exactly what was posted — even if the pricing code changes next year.
 *
 * `void` is a reserved word in JavaScript. Hence `voidSale`.
 */
export function voidSale(
  db: DB,
  actor: User,
  raw: unknown,
  approver: User | null = null,
  now = new Date()
): SaleDetail {
  const input = parseOrThrow(VoidSaleInput, raw, 'sale.void')

  // A cashier may void only with a supervisor standing at the till. The RBAC check is in MAIN, because
  // the UI is not a security boundary (CLAUDE.md §4).
  const authoriser = approver ?? actor
  if (!roleCan(authoriser.role, 'sale.void')) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Cancelling a sale needs a supervisor. Please ask one to approve it.',
      `sale.void needs supervisor; actor=${actor.role}, approver=${approver?.role ?? 'none'}`
    )
  }

  const sale = getById(db, input.id)

  if (sale.status === 'voided') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Invoice ${sale.invoiceNo} has already been cancelled.`,
      `sale ${input.id} is already voided`
    )
  }
  if (sale.status !== 'completed') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Only a completed sale can be cancelled. A parked cart is simply discarded.',
      `sale ${input.id} has status "${sale.status}"`
    )
  }

  // The reason must be on the owner's OWN void_reason list. The DATABASE refuses a void without one
  // (migration 0007); this is what turns that constraint into a sentence a person can act on.
  const reason = requireLookupByCode(
    db,
    'void_reason',
    input.reasonCode,
    'Please choose a reason for cancelling this sale.'
  )

  const run = db.transaction((): void => {
    // ── The stock goes back on the shelf, at the cost it left at ─────────────
    //
    // The ORIGINAL movement's frozen unit_cost, reused. Putting it back at TODAY'S average instead would
    // return the stock at a value the shop never paid, and GL Inventory and the stock report would part
    // company on the spot.
    const movements = db
      .prepare(
        `SELECT id, product_id, batch_id, qty_m, unit_cost
         FROM stock_movements
         WHERE ref_type = ? AND ref_id = ? AND type = 'sale' AND qty_m < 0`
      )
      .all(SALE_REF_TYPE, String(input.id)) as Array<{
      id: number
      product_id: number
      batch_id: number | null
      qty_m: number
      unit_cost: number
    }>

    for (const movement of movements) {
      stock.record(db, {
        productId: movement.product_id,
        type: 'sale',
        qtyM: -movement.qty_m, // the mirror image: what went out comes back
        unitCost: movement.unit_cost, // AT THE COST IT WENT OUT AT
        batchId: movement.batch_id,
        refType: SALE_REF_TYPE,
        refId: input.id,
        note: `Cancelled: ${sale.invoiceNo}`,
        userId: actor.id,
        at: now
      })
    }

    // ── The CONTRA journal. The original is not touched. ─────────────────────
    const original = db
      .prepare(
        `SELECT l.debit AS debit, l.credit AS credit, a.code AS code
         FROM journals j
         JOIN journal_lines l ON l.journal_id = j.id
         JOIN accounts a      ON a.id = l.account_id
         WHERE j.ref_type = ? AND j.ref_id = ?
         ORDER BY l.id`
      )
      .all(SALE_REF_TYPE, String(input.id)) as Array<{
      debit: number
      credit: number
      code: string
    }>

    if (original.length > 0) {
      ledger.post(db, {
        at: now,
        refType: 'sale_void',
        refId: input.id,
        memo: `Cancelled: ${sale.invoiceNo} (${reason.label})`,
        userId: actor.id,
        // Every debit becomes a credit, every credit a debit. It balances because the original did.
        lines: original.map((line) =>
          line.debit > 0
            ? { account: line.code, credit: line.debit }
            : { account: line.code, debit: line.credit }
        )
      })
    }

    // A serialised item goes back INTO stock — or that phone could never be sold to anybody else.
    db.prepare(
      `UPDATE serial_numbers SET status = 'in_stock', sale_id = NULL, at = ? WHERE sale_id = ?`
    ).run(now.toISOString(), input.id)

    // ── The sale is marked cancelled. IT KEEPS ITS NUMBER. ──────────────────
    db.prepare(
      `UPDATE sales
          SET status = 'voided', void_reason_code = ?, voided_by = ?, voided_at = ?
        WHERE id = ?`
    ).run(reason.code, actor.id, now.toISOString(), input.id)

    audit.record(
      db,
      actor,
      {
        action: 'sale.void',
        entity: 'sale',
        entityId: input.id,
        reasonCode: reason.code,
        ...(input.reasonText != null ? { reasonText: input.reasonText } : {}),
        ...(approver ? { approvedBy: approver } : {}),
        before: { status: 'completed', invoiceNo: sale.invoiceNo, grandTotal: sale.grandTotal },
        after: { status: 'voided', invoiceNo: sale.invoiceNo }
      },
      now
    )
  })

  run()
  return getById(db, input.id)
}

// ═════════════════════════════════════════════════════════════════════════════
// READING
// ═════════════════════════════════════════════════════════════════════════════

type SaleRow = {
  id: number
  invoice_no: string | null
  invoice_seq: number | null
  invoice_year: number | null
  at: string
  customer_id: number | null
  user_id: number
  price_tier: PriceTier
  status: SaleStatus
  subtotal_net: number
  cart_discount: number
  tax_total: number
  grand_total: number
  paid_total: number
  change_due: number
  had_negative_stock: number
  void_reason_code: string | null
  voided_by: number | null
  voided_at: string | null
  exchange_group_id: number | null
  created_at: string
}

function toSale(row: SaleRow): Sale {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    invoiceSeq: row.invoice_seq,
    invoiceYear: row.invoice_year,
    at: row.at,
    customerId: row.customer_id,
    userId: row.user_id,
    priceTier: row.price_tier,
    status: row.status,
    subtotalNet: row.subtotal_net,
    cartDiscount: row.cart_discount,
    taxTotal: row.tax_total,
    grandTotal: row.grand_total,
    paidTotal: row.paid_total,
    changeDue: row.change_due,
    hadNegativeStock: Boolean(row.had_negative_stock),
    voidReasonCode: row.void_reason_code,
    voidedByUserId: row.voided_by,
    voidedAt: row.voided_at,
    exchangeGroupId: row.exchange_group_id,
    createdAt: row.created_at
  }
}

type SaleLineRow = {
  id: number
  sale_id: number
  product_id: number | null
  name_snapshot: string
  name_other_lang: string | null
  batch_id: number | null
  pack_id: number | null
  qty_m: number
  uom: string | null
  unit_price: number
  priced_qty_m: number
  line_discount: number
  net: number
  tax_rate_bp: number
  tax_amount: number
  gross: number
  tax_mode: TaxMode
  unit_cost: number
  is_open_item: number
  price_override_by: number | null
  serials_json: string | null
  created_at: string
}

/**
 * The IMEIs the cashier scanned onto this line. A parked cart's memory — see migration 0007.
 *
 * A corrupt or hand-edited blob must not take the till down: a cart that cannot show its serials is a
 * cart main will simply refuse to complete (`assertSerials` counts them), which is the safe direction.
 */
function parseSerials(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

function toSaleLine(row: SaleLineRow): SaleLine {
  return {
    id: row.id,
    saleId: row.sale_id,
    productId: row.product_id,
    nameSnapshot: row.name_snapshot,
    nameOtherLang: row.name_other_lang,
    batchId: row.batch_id,
    packId: row.pack_id,
    qtyM: row.qty_m,
    uom: row.uom,
    unitPrice: row.unit_price,
    pricedQtyM: row.priced_qty_m,
    lineDiscount: row.line_discount,
    net: row.net,
    taxRateBp: row.tax_rate_bp,
    taxAmount: row.tax_amount,
    gross: row.gross,
    taxMode: row.tax_mode,
    unitCost: row.unit_cost,
    isOpenItem: Boolean(row.is_open_item),
    priceOverrideByUserId: row.price_override_by,
    serials: parseSerials(row.serials_json),
    createdAt: row.created_at
  }
}

type SalePaymentRow = {
  id: number
  sale_id: number
  method_lookup_id: number
  amount: number
  cheque_no: string | null
  cheque_date: string | null
  wallet_ref: string | null
  created_at: string
}

function toSalePayment(row: SalePaymentRow): SalePayment {
  return {
    id: row.id,
    saleId: row.sale_id,
    methodLookupId: row.method_lookup_id,
    amount: row.amount,
    chequeNo: row.cheque_no,
    chequeDate: row.cheque_date,
    walletRef: row.wallet_ref,
    createdAt: row.created_at
  }
}

/** One sale, with its lines and its payments — the sale detail screen, and the receipt. */
export function getById(db: DB, rawId: unknown): SaleDetail {
  const { id } = parseOrThrow(
    SaleGetInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'sale.get'
  )

  const row = db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SaleRow | undefined
  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That sale could not be found.',
      `sale id=${id} does not exist`
    )
  }

  return hydrate(db, row)
}

/** Look a sale up by the number printed on the customer's receipt — the returns desk's first move. */
export function getByInvoiceNo(db: DB, raw: unknown): SaleDetail {
  const input = parseOrThrow(SaleByInvoiceNoInput, raw, 'sale.getByInvoiceNo')

  const row = db.prepare('SELECT * FROM sales WHERE invoice_no = ?').get(input.invoiceNo) as
    | SaleRow
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `No sale was found with the number ${input.invoiceNo}. Please check the receipt.`,
      `no sale with invoice_no=${input.invoiceNo}`
    )
  }

  return hydrate(db, row)
}

function hydrate(db: DB, row: SaleRow): SaleDetail {
  const lines = (
    db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY id').all(row.id) as SaleLineRow[]
  ).map(toSaleLine)

  const payments = (
    db
      .prepare('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY id')
      .all(row.id) as SalePaymentRow[]
  ).map(toSalePayment)

  const paymentMethodLabels: Record<number, string> = {}
  for (const payment of payments) {
    paymentMethodLabels[payment.methodLookupId] =
      (db
        .prepare('SELECT label FROM lookups WHERE id = ?')
        .pluck()
        .get(payment.methodLookupId) as string | undefined) ?? 'Payment'
  }

  return {
    ...toSale(row),
    lines,
    payments,
    paymentMethodLabels,
    customerName:
      row.customer_id != null
        ? ((db
            .prepare('SELECT name FROM customers WHERE id = ?')
            .pluck()
            .get(row.customer_id) as string | undefined) ?? null)
        : null,
    cashierName:
      (db.prepare('SELECT full_name FROM users WHERE id = ?').pluck().get(row.user_id) as
        | string
        | undefined) ?? null
  }
}

/**
 * THE SALES LIST — paginated and indexed, always. Assume years of trading and 1000+ sales a day.
 *
 * Deliberately narrow: a list of 100,000 sales does not load 400,000 lines to show a page of 50.
 */
export function list(db: DB, raw: unknown = {}): PagedResult<SaleListItem> {
  const input = parseOrThrow(SaleListInput, raw, 'sale.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.status) {
    where.push('s.status = @status')
    params['status'] = input.status
  }
  if (input.customerId != null) {
    where.push('s.customer_id = @customerId')
    params['customerId'] = input.customerId
  }
  if (input.userId != null) {
    where.push('s.user_id = @userId')
    params['userId'] = input.userId
  }
  if (input.hadNegativeStock != null) {
    // THE LEAKAGE FILTER — and it has a partial index behind it (migration 0007).
    where.push('s.had_negative_stock = @hadNegativeStock')
    params['hadNegativeStock'] = input.hadNegativeStock ? 1 : 0
  }
  if (input.from) {
    where.push('s.at >= @from')
    params['from'] = input.from
  }
  if (input.to) {
    // `to` is a DATE, and the whole of that day is inside it — a sale at 18:40 must not fall out of a
    // report that says it covers that day.
    where.push('s.at < @toExclusive')
    params['toExclusive'] = dayAfter(input.to)
  }
  if (input.search) {
    where.push(`(s.invoice_no LIKE @like ESCAPE '\\' OR c.name LIKE @like ESCAPE '\\')`)
    params['like'] = `%${escapeLike(input.search)}%`
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(`SELECT COUNT(*) FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT s.id, s.invoice_no, s.at, s.status, s.grand_total, s.paid_total, s.price_tier,
              s.had_negative_stock, s.customer_id, s.user_id,
              c.name      AS customer_name,
              u.full_name AS cashier_name,
              (SELECT COUNT(*) FROM sale_lines l WHERE l.sale_id = s.id) AS line_count
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u     ON u.id = s.user_id
       ${whereSql}
       ORDER BY s.at DESC, s.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    id: number
    invoice_no: string | null
    at: string
    status: SaleStatus
    grand_total: number
    paid_total: number
    price_tier: PriceTier
    had_negative_stock: number
    customer_id: number | null
    user_id: number
    customer_name: string | null
    cashier_name: string | null
    line_count: number
  }>

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      invoiceNo: row.invoice_no,
      at: row.at,
      status: row.status,
      grandTotal: row.grand_total,
      paidTotal: row.paid_total,
      priceTier: row.price_tier,
      hadNegativeStock: Boolean(row.had_negative_stock),
      customerId: row.customer_id,
      userId: row.user_id,
      customerName: row.customer_name,
      cashierName: row.cashier_name,
      lineCount: row.line_count
    }))
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE RECEIPT — data only. This service never writes HTML.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * REPRINT. A second copy of a receipt must never be mistakable for the first, so it is stamped DUPLICATE
 * (PLAN.md §5) — and the reprint is AUDIT-LOGGED, because "just print it again" is how one sale's
 * receipt ends up in two customers' hands.
 */
export function receiptFor(db: DB, actor: User, raw: unknown, now = new Date()): ReceiptData {
  const input = parseOrThrow(SaleReceiptInput, raw, 'sale.receipt')
  const sale = getById(db, input.id)

  if (input.isDuplicate) {
    audit.record(
      db,
      actor,
      {
        action: 'sale.reprint',
        entity: 'sale',
        entityId: sale.id,
        after: { invoiceNo: sale.invoiceNo }
      },
      now
    )
  }

  return buildReceipt(db, sale, input.isDuplicate)
}

/**
 * WHAT THE PRINTER GETS. Plain data — `printing/receipt.ts` turns it into HTML and never asks the
 * database anything.
 *
 * THE PAPER HAS TO ADD UP. The shipped layout prints exactly this block:
 *
 *     Subtotal        subtotalNet
 *     Discount      − cartDiscount
 *     Tax           + taxTotal
 *     TOTAL           grandTotal
 *
 * So every figure above the Tax line is EX-TAX, and the two that carry the discount are what make it
 * reconcile:
 *
 *     subtotalNet  = the net BEFORE the cart discount  (= SUM(line.net) + the discount's ex-tax part)
 *     cartDiscount = the EX-TAX part of the discount   (the revenue actually given away)
 *
 *     subtotalNet − cartDiscount + taxTotal === grandTotal.   Exactly. Always. A tested invariant.
 *
 * In a shop with tax switched off — which is most of them — the ex-tax part IS the whole discount, and
 * the receipt reads precisely as the shopkeeper expects: "Discount 100.00". In a tax-registered shop it
 * reads as a tax invoice should: an ex-tax column, then the tax that was actually charged, then the
 * total. The TOTAL is always exactly the discount less than it would have been.
 *
 * A PACK LINE PRINTS AS A PACK. The sale line stores 24000 (base units — that is what left the shelf);
 * the customer bought ONE CARTON at the carton's price, and that is what the paper says.
 */
function buildReceipt(db: DB, sale: SaleDetail, isDuplicate: boolean): ReceiptData {
  const lines: ReceiptLine[] = sale.lines.map((line) => ({
    name: line.nameSnapshot,
    nameOtherLang: line.nameOtherLang,
    // A carton of 24, stored as 24000 base units, is ONE carton on the paper — at the carton's price.
    qtyM: pricedQtyOf(db, line),
    unitPrice: line.unitPrice,
    lineDiscount: line.lineDiscount,
    net: line.net,
    taxRateBp: line.taxRateBp,
    taxAmount: line.taxAmount,
    gross: line.gross,
    uom: line.uom
  }))

  const cartDiscountNet = cartDiscountNetOf(db, sale)

  return {
    shop: {
      name: setting<string>(db, 'shop.name'),
      address: setting<string>(db, 'shop.address') || null,
      phone: setting<string>(db, 'shop.phone') || null,
      taxNumber: setting<string>(db, 'shop.taxNumber') || null
    },

    invoiceNo: sale.invoiceNo ?? '(not issued yet)',
    at: sale.at,
    cashierName: sale.cashierName ?? '',
    customerName: sale.customerName ?? null,

    lines,

    // Ex-tax, and it reconciles: subtotalNet − cartDiscount + taxTotal === grandTotal.
    subtotalNet: sale.subtotalNet + cartDiscountNet,
    cartDiscount: cartDiscountNet,
    taxTotal: sale.taxTotal,
    grandTotal: sale.grandTotal,

    taxSummary: summariseTax(sale.lines),
    payments: sale.payments.map(
      (payment): ReceiptPayment => ({
        method: sale.paymentMethodLabels?.[payment.methodLookupId] ?? 'Payment',
        amount: payment.amount,
        reference: payment.chequeNo ?? payment.walletRef ?? null
      })
    ),
    changeDue: sale.changeDue,

    currencySymbol: setting<string>(db, 'currency.symbol'),
    isDuplicate
  }
}

/**
 * The quantity a line was PRICED on — which is not always the quantity that moved.
 *
 * A carton of 24 stores `qty_m = 24000` (base units, because that is what left the shelf) and is priced
 * at the CARTON's price. On paper the customer bought ONE carton, so that is what the receipt shows.
 */
function pricedQtyOf(_db: DB, line: SaleLine): number {
  // The quantity FROZEN on the line when it was sold (migration 0008). This used to be recomputed
  // from product_packs.pack_size read LIVE — so editing a pack's size later made a REPRINT of an old
  // receipt show a different number of cartons than the original. A receipt is a record; it does not
  // change because a setting changed. A pre-0008 line has priced_qty_m backfilled, never 0.
  return line.pricedQtyM > 0 ? line.pricedQtyM : line.qtyM
}

/**
 * THE EX-TAX PART OF THE CART DISCOUNT — the revenue actually given away, and the figure the receipt
 * prints on its "Discount" line.
 *
 * REBUILT FROM THE FROZEN LINES, ALWAYS — for the receipt printed at the till and for a reprint next
 * year, by the same function, from the same integers. That is the point of it.
 *
 * It would have been easy to hand this the live priced cart when ringing up and re-derive it only for a
 * reprint. Those two roads produce answers a PAISA APART (the sum of what each line's net actually
 * dropped by is not the same as the discount scaled by the sale's overall net-to-gross ratio), and the
 * shop would eventually hand a customer a duplicate receipt that disagreed with the one in their hand.
 * A duplicate that does not match the original is evidence of something that never happened.
 *
 * Every input is on the sale line already — unit_price, qty_m, line_discount, tax_rate_bp, tax_mode —
 * so the line as it stood BEFORE the cart discount can be recomputed exactly, and the net that the
 * discount removed is the difference. No catalog lookup, no stored extra column, no drift.
 */
function cartDiscountNetOf(db: DB, sale: SaleDetail): number {
  if (sale.cartDiscount <= 0) return 0

  let preDiscountNet = 0

  for (const line of sale.lines) {
    // Exactly what priceLine() did on the way in — from the line's OWN frozen figures.
    const listAmount = extendPrice(line.unitPrice, pricedQtyOf(db, line))
    const amount = Math.max(0, listAmount - line.lineDiscount)
    preDiscountNet += computeLineTax(amount, line.taxRateBp, line.taxMode).net
  }

  return preDiscountNet - sale.subtotalNet
}

/** The tax table at the foot of the receipt: how much net, and how much tax, at each rate. */
function summariseTax(lines: SaleLine[]): ReceiptTaxSummaryRow[] {
  const byRate = new Map<number, ReceiptTaxSummaryRow>()

  for (const line of lines) {
    if (line.taxRateBp <= 0) continue // a 0% row tells the customer nothing

    const row = byRate.get(line.taxRateBp) ?? { taxRateBp: line.taxRateBp, net: 0, tax: 0 }
    row.net += line.net
    row.tax += line.taxAmount
    byRate.set(line.taxRateBp, row)
  }

  return [...byRate.values()].sort((a, b) => a.taxRateBp - b.taxRateBp)
}

// ═════════════════════════════════════════════════════════════════════════════
// Odds and ends
// ═════════════════════════════════════════════════════════════════════════════

/** `%` and `_` are wildcards in LIKE. Somebody searching for "50%" means the characters. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

/** The day after an ISO date, so a `to` filter includes everything that happened on that day. */
function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString()
}
