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

  /** A reprint is stamped DUPLICATE. A second copy of a receipt must never look like the first. */
  isDuplicate?: boolean

  /** Loyalty, when the shop uses it. */
  pointsEarned?: number | null
  pointsBalance?: number | null

  footer?: string | null
}
