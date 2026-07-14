import type { SaleLineInput } from './sales'
import type { ScannedItem } from './ipc'
import type { TaxMode } from './tax'
import { computeLineTax } from './tax'
import { apportionCartDiscount, extendPrice } from './pricing'
import { ONE_UNIT } from './qty'

/**
 * THE RUNNING TOTAL ON THE TILL — A PREDICTION, NOT THE TRUTH.
 *
 * A cashier watches a total climb as he scans. The sale service (`main/services/sales.ts`) decides what
 * that total ACTUALLY is: it re-resolves every price from the catalogue, every tax rate from the product
 * and every cost from the weighted average, and FREEZES them onto the sale. Nothing in this file is ever
 * sent back to main as fact — main would not trust it, and it is right not to.
 *
 * So why does this exist at all? Because the number on the screen and the number on the paper MUST BE
 * THE SAME NUMBER. A shopkeeper who quotes Rs 394.88 and charges Rs 394.89 has an argument at the
 * counter, and no way to explain it.
 *
 * ── HOW IT CANNOT DRIFT ──────────────────────────────────────────────────────────────────────────
 *
 * It does not contain any arithmetic of its own. Every figure below comes out of the SAME three pure
 * functions the sale service freezes the sale with:
 *
 *     extendPrice           shared/pricing.ts    unit price x quantity, rounded once
 *     apportionCartDiscount shared/pricing.ts    the cart discount, split exactly, largest-remainder
 *     computeLineTax        shared/tax.ts        net / tax / gross, per line, per mode
 *
 * and it composes them in the SAME ORDER, in the same two passes. `sell-preview.test.ts` drives a cart
 * through THIS file and through the REAL `sales.complete()` and asserts, line by line and to the paisa,
 * that they agree — for weighed goods, mixed inclusive/exclusive tax, line discounts, cart discounts
 * that do not divide by three, and cartons.
 *
 * This file lives in `shared/` so that test can reach both sides. It is pure: no React, no database,
 * no clock.
 */

/** The shop-wide tax settings an OPEN ITEM falls back on — it has no catalogue row to read them from. */
export type TaxDefaults = {
  taxEnabled: boolean
  defaultTaxRateBp: number
  defaultTaxMode: TaxMode
}

/**
 * What the screen remembers about a line, taken from the scanner's answer (`ScannedItem`).
 *
 * A cart line carries INTENT — what was scanned, and how many. It does not carry a name or a price, and
 * main neither wants nor trusts one. But the screen has to DRAW something, so it keeps this, keyed by
 * product+pack.
 */
export type LineInfo = {
  name: string
  nameOtherLang: string | null
  uom: string | null
  packLabel: string | null

  /**
   * qty_m of BASE units in one pack — a carton of 24 is 24000. Needed to turn a line's base quantity back
   * into a number of CARTONS, because the price on such a line is the carton's price.
   *
   * NULL on a RESUMED pack line: `sales.get` returns the frozen figures but not the pack size, and a
   * cashier may not read the catalogue (`catalog.listPacks` needs 'report.view'). Such a line is drawn
   * from `frozen` below and is locked against re-quantifying. It is never shown a number we cannot stand
   * behind.
   */
  packSizeM: number | null

  /** 2-dp money — the price of ONE of what was scanned (one piece, or one whole carton), at this tier. */
  unitPrice: number
  /** ALREADY EFFECTIVE: `scanBarcode` has applied `tax.enabled` and the product's exemption. */
  taxRateBp: number
  taxMode: TaxMode

  isWeighted: boolean
  trackSerials: boolean

  /** A service has no shelf. Without this a bag charge would warn "not enough stock" on every sale. */
  itemType: 'inventory' | 'non_inventory'
  /** DERIVED, snapshotted at scan time. NULL = unknown (a resumed line); the shortage check skips it. */
  onHandM: number | null

  /** The barcode it came in on, so switching the price tier can re-price it. NULL on a resumed line. */
  barcode: string | null
  /** A resumed PACK line: main's frozen figures, because we cannot recompute them. See `packSizeM`. */
  frozen: { net: number; tax: number; gross: number } | null
}

export type LineInfos = ReadonlyMap<string, LineInfo>

/** Product + pack identify a price. A tin and its carton are two entries; two of the same tin are one. */
export function infoKey(line: Pick<SaleLineInput, 'productId' | 'packId'>): string {
  return `${line.productId ?? ''}:${line.packId ?? ''}`
}

/**
 * WHAT THE SCANNER JUST TOLD US, in the shape the screen draws from.
 *
 * It lives here rather than in the Sell screen for one reason: `sell-preview.test.ts` builds its carts
 * through THIS function, so the test is exercising the very mapping the till uses — not a copy of it
 * that could quietly disagree. A `packSizeM` read wrong here would be a carton priced twenty-four times
 * over, and a test that built its own LineInfo would never see it.
 */
export function lineInfoFromScan(item: ScannedItem, barcode: string): LineInfo {
  return {
    name: item.name,
    nameOtherLang: item.nameOtherLang,
    uom: item.uom,
    packLabel: item.packLabel,
    // What ONE scan of this barcode sells, in base units. For a pack barcode, that IS the pack size.
    packSizeM: item.packId != null ? item.qtyM : null,
    unitPrice: item.unitPrice,
    taxRateBp: item.taxRateBp,
    taxMode: item.taxMode,
    isWeighted: item.isWeighted,
    trackSerials: item.trackSerials,
    itemType: item.itemType,
    onHandM: item.onHandM,
    barcode,
    frozen: null
  }
}

export type LineMath = {
  unitPrice: number
  lineDiscount: number
  taxRateBp: number
  /** The line before its own discount — what the strike-through shows. */
  listGross: number
  net: number
  tax: number
  gross: number
  /** False for a resumed pack line: we can draw it, but we cannot re-price it. Qty/discount are locked. */
  editable: boolean
}

export type CartMath = {
  lines: LineMath[]
  subtotalNet: number
  taxTotal: number
  grandTotal: number
  /** SUM(line gross) BEFORE the cart discount. grandTotal === this − cartDiscount, exactly. */
  preDiscountGross: number
  listGross: number
  /** What the customer got off in total — line discounts AND the cart discount. The threshold is on this. */
  discountGiven: number
}

export const EMPTY_CART: CartMath = {
  lines: [],
  subtotalNet: 0,
  taxTotal: 0,
  grandTotal: 0,
  preDiscountGross: 0,
  listGross: 0,
  discountGiven: 0
}

function resolveLine(
  unitPrice: number,
  pricedQtyM: number,
  taxRateBp: number,
  taxMode: TaxMode,
  lineDiscount: number
): LineMath {
  const listAmount = extendPrice(unitPrice, pricedQtyM)
  const list = computeLineTax(listAmount, taxRateBp, taxMode)

  // A discount bigger than the line is a typo. Main refuses it in plain language; we clamp so the screen
  // never flashes a negative line while it is still being typed.
  const amount = Math.max(0, listAmount - lineDiscount)
  const pre = computeLineTax(amount, taxRateBp, taxMode)

  return {
    unitPrice,
    lineDiscount,
    taxRateBp,
    listGross: list.gross,
    net: pre.net,
    tax: pre.tax,
    gross: pre.gross,
    editable: true
  }
}

/** PASS 1, per line — the same three steps `priceLine` takes in the sale service, in the same order. */
export function priceLine(
  line: SaleLineInput,
  info: LineInfo | undefined,
  tax: TaxDefaults
): LineMath {
  const lineDiscount = line.lineDiscount ?? 0

  // AN OPEN ITEM carries its own price and its own tax — there is no catalogue row behind it to read
  // either from. `taxRateFor` in main zeroes the rate when tax is off shop-wide; so do we.
  if (line.openItem != null) {
    const rate = tax.taxEnabled ? (line.openItem.taxRateBp ?? tax.defaultTaxRateBp) : 0
    const mode = line.openItem.taxMode ?? tax.defaultTaxMode
    return resolveLine(line.openItem.unitPrice, line.qtyM, rate, mode, lineDiscount)
  }

  // Resumed as a whole pack, and we cannot re-price it. Show main's frozen figures, untouched.
  if (info?.frozen != null) {
    return {
      unitPrice: info.unitPrice,
      lineDiscount,
      taxRateBp: info.taxRateBp,
      listGross: info.frozen.gross,
      net: info.frozen.net,
      tax: info.frozen.tax,
      gross: info.frozen.gross,
      editable: false
    }
  }

  // We were never told about this line. Show zeroes rather than guess: main prices it correctly on
  // completion regardless, and an invented number on the screen is worse than an obvious blank.
  if (info == null) {
    return {
      unitPrice: 0,
      lineDiscount,
      taxRateBp: 0,
      listGross: 0,
      net: 0,
      tax: 0,
      gross: 0,
      editable: false
    }
  }

  // A PRICE OVERRIDE replaces the catalogue price. It is not a discount — unit_price IS what was charged,
  // and main stamps the line with whoever authorised it.
  const unitPrice = line.priceOverride ?? info.unitPrice

  // A PACK IS SOLD BY THE PACK. `qtyM` is in BASE units (a carton of 24 is 24000) because that is what
  // stock is measured in — but the money is extended over CARTONS. Backwards, and one carton rings up as
  // twenty-four of them.
  const pricedQtyM =
    line.packId != null && info.packSizeM != null && info.packSizeM > 0
      ? (line.qtyM / info.packSizeM) * ONE_UNIT
      : line.qtyM

  return resolveLine(unitPrice, pricedQtyM, info.taxRateBp, info.taxMode, lineDiscount)
}

/**
 * PRICE THE WHOLE CART — `priceCart`'s two passes, exactly.
 *
 * PASS 2 splits the cart discount across the lines in proportion to what each is worth, and re-resolves
 * each discounted line's tax on what the customer NOW pays for it. Anything else here — subtracting the
 * discount from the gross total, say — would put a tax figure on the screen that the receipt will not
 * print, and a different one in the shop's tax return.
 */
export function priceCart(
  cart: readonly SaleLineInput[],
  infos: LineInfos,
  cartDiscount: number,
  tax: TaxDefaults
): CartMath {
  const lines = cart.map((line) => priceLine(line, infos.get(infoKey(line)), tax))

  const preDiscountGross = lines.reduce((total, line) => total + line.gross, 0)
  const listGross = lines.reduce((total, line) => total + line.listGross, 0)

  // Main throws if the discount is bigger than the sale. Clamp for the preview so the totals stay sane
  // while it is being typed; the Pay button is blocked separately, and main refuses it regardless.
  const applied = Math.min(Math.max(0, cartDiscount), preDiscountGross)
  const shares = apportionCartDiscount(
    applied,
    lines.map((line) => line.gross)
  )

  const settled = lines.map((line, index) => {
    const share = shares[index] ?? 0
    if (share === 0) return line // untouched — its figures are already right

    // The discounted amount IS what the customer pays, tax included. Backing the tax out of it returns
    // gross === charged exactly, which is what makes the shares sum to the discount with no rounding line.
    const charged = line.gross - share
    const t = computeLineTax(charged, line.taxRateBp, 'inclusive')
    return { ...line, net: t.net, tax: t.tax, gross: t.gross }
  })

  const subtotalNet = settled.reduce((total, line) => total + line.net, 0)
  const taxTotal = settled.reduce((total, line) => total + line.tax, 0)
  const grandTotal = settled.reduce((total, line) => total + line.gross, 0)

  return {
    lines: settled,
    subtotalNet,
    taxTotal,
    grandTotal,
    preDiscountGross,
    listGross,
    discountGiven: listGross - grandTotal
  }
}

/**
 * WHAT WOULD GO NEGATIVE — asked once per PRODUCT, not once per line.
 *
 * Two lines of 3 against 5 on the shelf IS a shortage, even though neither line is one on its own.
 * Asking per line would wave that sale straight through, unflagged. (Main aggregates the same way.)
 */
export type Shortage = { productId: number; name: string; onHandM: number; wantedM: number }

export function findShortages(cart: readonly SaleLineInput[], infos: LineInfos): Shortage[] {
  const wanted = new Map<number, Shortage>()

  for (const line of cart) {
    if (line.productId == null) continue
    const info = infos.get(infoKey(line))

    // A service or a bag charge has no shelf, and a resumed line's stock we simply do not know
    // (`onHandM: null`). Neither can be short of anything. Main checks both anyway, authoritatively.
    if (info == null || info.itemType !== 'inventory' || info.onHandM == null) continue

    const existing = wanted.get(line.productId)
    wanted.set(line.productId, {
      productId: line.productId,
      name: info.name,
      onHandM: info.onHandM,
      wantedM: (existing?.wantedM ?? 0) + line.qtyM
    })
  }

  return [...wanted.values()].filter((row) => row.wantedM > row.onHandM)
}
