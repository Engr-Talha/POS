/**
 * WHAT A RECEIPT NEEDS TO KNOW.
 *
 * Deliberately a PLAIN DATA STRUCTURE with no database in it. The printing layer takes this and
 * returns HTML; it never queries anything. That means a receipt can be rendered in a test, or to a
 * PDF I can actually look at, without a sale existing — which is the only way to obey the rule that
 * says never ship a print layout you have not seen.
 *
 * Every money field is INTEGER MINOR UNITS. The receipt is the last place money becomes a string,
 * and it does it through formatMoney like everywhere else.
 */

export type ReceiptWidth = '58mm' | '80mm'

export type ReceiptLine = {
  name: string
  /** Urdu / second language. Printed under the name when present. */
  nameOtherLang?: string | null
  /** qty_m — integer thousandths. 1 piece = 1000, 1.234 kg = 1234. */
  qtyM: number
  unitPrice: number
  lineDiscount: number
  /** Frozen at sale time. The receipt NEVER recomputes tax from today's settings. */
  net: number
  taxRateBp: number
  taxAmount: number
  gross: number
  /** The unit it is sold in — "pcs", "kg". */
  uom?: string | null
}

export type ReceiptPayment = {
  method: string
  amount: number
  /** For a cheque. */
  reference?: string | null
}

export type ReceiptTaxSummaryRow = {
  taxRateBp: number
  net: number
  tax: number
}

export type ReceiptData = {
  shop: {
    name: string
    address?: string | null
    phone?: string | null
    taxNumber?: string | null
  }

  invoiceNo: string
  at: string
  cashierName: string
  customerName?: string | null

  lines: ReceiptLine[]

  subtotalNet: number
  cartDiscount: number
  taxTotal: number
  grandTotal: number

  taxSummary: ReceiptTaxSummaryRow[]
  payments: ReceiptPayment[]
  changeDue: number

  currencySymbol: string

  /**
   * The shop's own country ('shop.country'), which decides how a DATE is written on this paper —
   * 22/07/2026 in Karachi, 07/22/2026 in Denver. It travels ON the receipt, exactly as currencySymbol
   * does, because the renderer has no settings and must never guess: left to the machine's locale, a
   * Pakistani shop on a US Windows image prints 7/22/2026 for its own customers. Optional so an older
   * caller still compiles; absent means day-first, which is right for five of the six countries the app
   * offers. (See shared/dates.ts for why this is not a locale string.)
   */
  country?: string | null

  /** A reprint is stamped DUPLICATE. A second copy of a receipt must never look like the first. */
  isDuplicate?: boolean

  /** Loyalty, when the shop uses it. */
  pointsEarned?: number | null
  pointsBalance?: number | null

  footer?: string | null

  /**
   * The vendor's advertising line — "made by Malgary Labs", a phone number, a tagline. Printed small,
   * below "Thank you", separate from the shop's own `footer`. Editable in Settings (`advert.slipLine`)
   * so it can change without a rebuild. Null/blank prints nothing.
   */
  advertLine?: string | null
}
