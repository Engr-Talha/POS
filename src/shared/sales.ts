import { z } from 'zod'
import { PRICE_ENTRY_MODES } from './catalog'
import type { TaxMode } from './tax'
// A quotation prints the SAME line and tax-summary shapes a receipt does — one definition, so the offer
// and the sale it becomes can never disagree about what a line looked like. (See QuotationData.)
import type { ReceiptLine, ReceiptTaxSummaryRow } from './receipt'

/**
 * THE SELLING CONTRACT — the types and input schemas main and renderer agree on. (Migration 0007.)
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ──────────────────────────────────────────
 *
 * This is the single most important thing in this file, and it is why the input schemas look the way
 * they do. A cart line says WHAT the cashier scanned and HOW MANY — it does NOT say what it costs.
 * `net`, `taxAmount` and `gross` appear NOWHERE in any input type here. Main resolves the price from
 * the catalog, the tax rate from the product, the mode from the product, and FREEZES the result onto
 * the sale line.
 *
 * If the renderer could post its own totals, a tampered renderer could sell a Rs 200,000 television
 * for Rs 1 with a perfectly balanced journal behind it, and every report would agree that it happened.
 * The renderer is not a security boundary (CLAUDE.md §4). There are exactly TWO places a price legally
 * enters from outside, and both are deliberate, permissioned and audited:
 *
 *   OPEN ITEM       there is no catalog row to read a price from — the cashier types it. That is the
 *                   whole point of an open item, and it is why `openItem` carries a price and a tax
 *                   rate while a catalogued line carries neither.
 *   PRICE OVERRIDE  an explicit act, allowed only to the role in the SETTING
 *                   `selling.priceOverrideRole`, stamped onto the line as `price_override_by`, and
 *                   written to the audit log with a reason.
 *
 * ── THE CLOCK IS MAIN'S. ────────────────────────────────────────────────────────────────────────
 *
 * Note what is ALSO absent from every input: `at`. A sale is timestamped by the main process, never
 * by the caller. A client clock — wrong, or set wrong on purpose — could otherwise backdate a sale
 * into a month the owner has already locked and reported to the tax man.
 *
 * ── THREE INTEGER SCALES, AND THEY ARE NOT INTERCHANGEABLE. ─────────────────────────────────────
 *
 *   money  — INTEGER minor units (paisa),  2 dp   unitPrice, lineDiscount, cartDiscount, amount,
 *            helpers: shared/money.ts             net, taxAmount, gross, grandTotal, changeDue
 *   cost   — INTEGER ten-thousandths,      4 dp   SaleLine.unitCost — THE FROZEN COGS
 *            helpers: shared/cost.ts
 *   qty_m  — INTEGER thousandths,          3 dp   qtyM   (1 piece = 1000, 1.234 kg = 1234)
 *            helpers: shared/qty.ts
 *
 * `unitCost` and `unitPrice` sit one line apart and are A HUNDRED TIMES APART in scale. Nothing here
 * is ever a float.
 *
 * ── EVERY LINE IS FROZEN. ───────────────────────────────────────────────────────────────────────
 *
 * A `SaleLine` is a HISTORICAL RECORD, not a view of the catalog. Its name, price, tax rate, tax
 * amount and cost are what they were AT THE MOMENT OF THE SALE. Reprint the receipt next year — after
 * the product is renamed, the tax rate changed and the cost re-averaged — and it prints exactly what
 * it printed on the day. Nothing in this file ever recomputes a historical line from today's settings.
 */

// ── Enums & constants ────────────────────────────────────────────────────────

/**
 * 'held'      a parked cart — the customer went back for the milk. NO INVOICE NUMBER.
 * 'quote'     a price the shop offered. May never become a sale. NO INVOICE NUMBER.
 * 'completed' it happened: money moved, stock moved, the journal posted. HAS A NUMBER.
 * 'voided'    it happened and was cancelled. IT KEEPS ITS NUMBER — never reused, never renumbered.
 *
 * The number is drawn ONLY on completion, in the same transaction as the sale insert. That, and only
 * that, is what makes numbering gapless. (PLAN.md §1.)
 */
export const SALE_STATUSES = ['held', 'completed', 'voided', 'quote'] as const
export type SaleStatus = (typeof SALE_STATUSES)[number]

/** Which price column was charged. 'customer' = a per-customer agreed price (customer_prices). */
export const PRICE_TIERS = ['retail', 'wholesale', 'customer'] as const
export type PriceTier = (typeof PRICE_TIERS)[number]

/**
 * The `ref_type` every sale's journal and every sale's stock movement carries. One string, shared, so
 * that the code which WRITES the movement and the report which asks "show me the sales" cannot drift
 * apart over a typo. (Same reasoning as OPENING_REF_TYPE.)
 */
export const SALE_REF_TYPE = 'sale'

/**
 * The invoice-counter series a normal sale draws from. `invoice_counters` is keyed (series, year) so
 * a separate quotation or exchange stream can be added later without touching the table.
 */
export const SALE_SERIES = 'sale'

/**
 * The `year` key used when the shop does NOT reset its numbering each year
 * (Settings: `invoice.resetYearly` = false). The counter is then a single row that runs on forever,
 * and 0 is the key it lives under — a year that cannot collide with a real one.
 */
export const NO_YEAR_RESET = 0

// ── Row types ────────────────────────────────────────────────────────────────

/** One sale document. Every money field is 2-dp INTEGER minor units. */
export type Sale = {
  id: number

  /** The number on the receipt. NULL while held or quoted — assigned only on completion. */
  invoiceNo: string | null
  /** The raw sequence it was drawn from, kept apart from the formatted string. */
  invoiceSeq: number | null
  invoiceYear: number | null

  at: string
  customerId: number | null
  /** WHO sold it. Never null. */
  userId: number

  priceTier: PriceTier
  status: SaleStatus

  /** SUM(lines.net) — after line discounts, before tax. */
  subtotalNet: number
  /** A discount on the WHOLE cart, on top of any per-line discounts. */
  cartDiscount: number
  /** SUM(lines.taxAmount). */
  taxTotal: number
  /** What the customer owes. NO CASH ROUNDING — 2 decimals, exact. */
  grandTotal: number
  /** SUM(payments.amount). MAY EXCEED grandTotal — they paid with a 500 note. */
  paidTotal: number
  /** paidTotal − grandTotal when they overpaid in cash. */
  changeDue: number

  /**
   * THE FLAG. The shop sold stock it did not have. The sale stands, and this row is visibly flagged
   * in every list it appears in (PLAN.md §1). A boolean — it says THAT it happened, not how much.
   */
  hadNegativeStock: boolean

  /** lookups('void_reason').code. Present only on a voided sale. */
  voidReasonCode: string | null
  voidedByUserId: number | null
  voidedAt: string | null

  /** An EXCHANGE is a return and a sale sharing this id. Not a foreign key — a correlation id. */
  exchangeGroupId: number | null

  /**
   * THE DAY THE OFFER LAPSES — ISO 'YYYY-MM-DD', a DAY and not an instant. (Migration 0015.)
   *
   * NON-NULL IF AND ONLY IF `status === 'quote'`. A held cart, a completed sale and a voided sale all
   * carry NULL: it is an OFFER's expiry, not a document's, so the moment the quote becomes the sale
   * (the SAME row — PLAN.md §2) money has changed hands and the date is meaningless. `complete()`
   * clears it.
   *
   * SQLite cannot bolt a table CHECK on with ALTER TABLE, so THE SERVICE OWNS THAT INVARIANT
   * (`saveQuote` sets it, `hold`/`complete` clear it) and a test proves it holds across all three
   * paths. It is called out here, and in the migration, so the next reader does not assume the
   * database is guarding it.
   *
   * Nothing is BLOCKED when it lapses — an expired quote is a conversation with the customer ("this
   * price was good until the 14th"), not something the till should refuse.
   */
  validUntil: string | null

  createdAt: string
}

/**
 * One line of the sale, FROZEN. This is not a view of the product — it is what was sold, priced as it
 * was priced, taxed as it was taxed, and costed as it cost, on the day.
 */
export type SaleLine = {
  id: number
  saleId: number

  /** NULL for an OPEN ITEM ("Misc — Rs 50"), which has no catalog row behind it. */
  productId: number | null
  /** FROZEN: the product's name AT SALE TIME. A later rename does not rewrite an old receipt. */
  nameSnapshot: string
  /** Urdu / second language, frozen the same way. Prints under the name. */
  nameOtherLang: string | null

  /** FEFO auto-picked. The cashier never chooses a batch. */
  batchId: number | null
  /**
   * Set when a PACK barcode was scanned (a carton). `unitPrice` is then the CARTON's price and
   * `qtyM` is in BASE units — a carton of 24 pieces is 24000.
   */
  packId: number | null

  /** 3-dp qty in the product's BASE unit. Always positive — giving something back is a return. */
  qtyM: number
  /** FROZEN unit name ("pcs", "kg"). */
  uom: string | null

  /** 2-dp money. */
  unitPrice: number
  /** The quantity the line was PRICED on — 1 carton, not its 24 base units. Frozen at sale time. */
  pricedQtyM: number
  lineDiscount: number

  /** THE FROZEN TAX. gross === net + taxAmount, always, by construction. */
  net: number
  taxRateBp: number
  taxAmount: number
  gross: number
  /** Whether this line's price contained the tax. One cart may legitimately mix both. */
  taxMode: TaxMode

  /**
   * 4-dp COST — A DIFFERENT SCALE FROM EVERY MONEY FIELD ABOVE. The weighted-average cost at the
   * instant of the sale, frozen: THE COGS. Never recomputed from today's average.
   */
  unitCost: number

  isOpenItem: boolean
  /** Non-null = this line was NOT sold at the catalog price, and there is an audit row to match. */
  priceOverrideByUserId: number | null

  /**
   * The IMEIs scanned onto this line — empty for the tin of beans that is most lines in most shops.
   *
   * This is what lets a PARKED cart be picked back up without forgetting which handset the customer is
   * holding. For a COMPLETED sale, the authoritative record of which unit went out is
   * `serial_numbers.sale_id`; this is the cart's memory, not a second source of truth.
   */
  serials: string[]

  /**
   * THE SHOP'S OWN OFFERS THAT DISCOUNTED THIS LINE, FROZEN — the name they had ON THE DAY and the money
   * they gave. Empty for almost every line. (Migration 0018, `sale_line_promotions`.)
   *
   * A COMPONENT OF `lineDiscount` ABOVE, NEVER A SECOND SOURCE OF TRUTH. `lineDiscount` is the one figure
   * the sale's own maths, its journal and a return all read; this is the WHY behind part of it — what
   * lets the shop ask "what did that Sunday special actually cost me?" and lets the Sell screen tell the
   * customer why the price changed.
   *
   * FROZEN means frozen: an offer later renamed, re-priced or switched off never rewrites what an old
   * sale says it cost.
   */
  promotions: SaleLinePromotion[]

  createdAt: string
}

/** One offer's contribution to one line's discount, frozen at sale time. (Migration 0018.) */
export type SaleLinePromotion = {
  /** The offer it came from. It may since have been renamed, re-priced or switched off. */
  promotionId: number
  /** FROZEN: what the offer was CALLED on the day. What the receipt and the Sell screen show. */
  name: string
  /** FROZEN 2-dp money: what THIS offer took off THIS line. */
  discountMinor: number
}

/**
 * How they paid. A SPLIT PAYMENT IS SEVERAL ROWS.
 *
 * CREDIT (udhaar) is a payment row too — the customer "paid" with a promise, and the sale posts
 * DR Accounts Receivable instead of DR Cash. That is what makes `paidTotal = SUM(amount)` hold for
 * every sale in the book, and what gives the customer ledger a row to point at.
 */
export type SalePayment = {
  id: number
  saleId: number
  /** lookups('payment_method').id. NEVER a hardcoded dropdown. */
  methodLookupId: number
  /** 2-dp money, positive. */
  amount: number

  /** A post-dated cheque: the money is not in the bank yet. */
  chequeNo: string | null
  chequeDate: string | null
  /** JazzCash / Easypaisa transaction reference. */
  walletRef: string | null

  createdAt: string
}

/** A sale with everything hanging off it — what the receipt and the sale detail screen read. */
export type SaleDetail = Sale & {
  lines: SaleLine[]
  payments: SalePayment[]
  /** Joined for display — not stored on the sale. */
  customerName?: string | null
  cashierName?: string | null
  /** lookups('payment_method').label, joined per payment row. */
  paymentMethodLabels?: Record<number, string>
  /**
   * Are there returns recorded against this sale? A sale WITH returns cannot be voided (voidSale
   * refuses it — a void reverses the whole sale, but a return has already reversed part of it), so the
   * "Correct this invoice" action on the Sales screen hides itself rather than offer a dead end.
   * Derived, never stored.
   */
  hasReturns?: boolean
}

/** One row of the sales list. Deliberately narrow — a list of 100k sales does not load its lines. */
export type SaleListItem = Pick<
  Sale,
  | 'id'
  | 'invoiceNo'
  | 'at'
  | 'status'
  | 'grandTotal'
  | 'paidTotal'
  | 'priceTier'
  | 'hadNegativeStock'
  | 'customerId'
  | 'userId'
  // The quote tray's whole job: "which of my open quotes are about to lapse". Narrow as this list is,
  // it cannot answer that without the date, and loading the full SaleDetail for a tray of quotes to
  // read one column would defeat the point of the list being narrow. NULL on every non-quote row.
  | 'validUntil'
> & {
  customerName?: string | null
  cashierName?: string | null
  lineCount?: number
}

/**
 * The document totals.
 *
 * DELIBERATELY A TYPE AND NOT A FUNCTION. `subtotalNet` and `taxTotal` are plain sums of the frozen
 * lines, but how `cartDiscount` meets tax is a BUSINESS RULE, not arithmetic:
 *
 *   apportion it across the lines and re-resolve tax  ->  the customer is not taxed on money they
 *                                                         never paid, and the tax return is right;
 *   subtract it from the gross total                  ->  simpler, but the shop has then collected
 *                                                         output tax on a discount it gave away.
 *
 * For a tax-registered (FBR Tier-1) shop those two produce different tax returns. Inventing the
 * answer here would bury it in a helper nobody re-reads. The rule is the sale service's to state, out
 * loud, once — and the owner's to confirm. (CLAUDE.md §7: ask before inventing a business rule.)
 */
export type SaleTotals = {
  subtotalNet: number
  cartDiscount: number
  taxTotal: number
  grandTotal: number
  paidTotal: number
  changeDue: number
}

/**
 * WHAT A QUOTATION PRINTS. A DIFFERENT DOCUMENT FROM A RECEIPT — deliberately not a `ReceiptData`.
 *
 * A receipt is proof that money changed hands. A quotation is an OFFER, and it must never be mistakable
 * for the other: this is why the type refuses to carry the fields that would let it pretend.
 *
 *   NO invoiceNo    a quote HAS no number, and that is the mechanism that keeps numbering gapless
 *                   (PLAN.md §1/§2) — it draws one only on completion. Leave the field on the type and
 *                   the template prints a blank, or a placeholder, where a real invoice number goes.
 *   NO payments     nothing has been paid.
 *   NO changeDue    nothing has been tendered.
 *   NO isDuplicate  a reprinted OFFER is not a second receipt for one sale. There is nothing to
 *                   double-spend, so there is nothing to stamp DUPLICATE.
 *
 * What it carries instead is the thing a receipt has no concept of: HOW LONG THE PRICE HOLDS.
 *
 * The lines and the money are the SAME SHAPES the receipt uses (`ReceiptLine`, `ReceiptTaxSummaryRow`)
 * and are built by the same code, so a quote and the sale it becomes can never disagree about a
 * pricedQty or an apportioned cart discount.
 */
export type QuotationData = {
  shop: {
    name: string
    address?: string | null
    phone?: string | null
    taxNumber?: string | null
  }

  /** The DOCUMENT id — NOT an invoice number. A quote has no invoice number, by design. */
  quoteId: number
  /** When the offer was made (the quote's own timestamp). */
  at: string
  /** Who offered it. */
  cashierName: string
  customerName?: string | null

  /**
   * THE DAY THE PRICE STOPS HOLDING — ISO 'YYYY-MM-DD'. Never null on a printable quotation: a quote
   * always has one (the service's invariant), and an offer with no stated expiry is the promise this
   * whole feature exists to stop the shop making.
   */
  validUntil: string
  /** `validUntil` is in the past. The paper says so plainly — the till still refuses nothing. */
  isExpired: boolean

  lines: ReceiptLine[]

  /** Ex-tax, and it reconciles exactly as the receipt does:
   *  subtotalNet − cartDiscount + taxTotal === grandTotal. */
  subtotalNet: number
  cartDiscount: number
  taxTotal: number
  grandTotal: number

  taxSummary: ReceiptTaxSummaryRow[]

  currencySymbol: string

  /**
   * The shop's own country ('shop.country'), which decides how the dates on this paper are written —
   * 22/07/2026 in Karachi, 07/22/2026 in Denver. It travels ON the document, exactly as currencySymbol
   * does, because the renderer has no settings and must never guess: left to the machine's locale, a
   * Pakistani shop on a US Windows image prints its own customer an American date. It matters more here
   * than anywhere: "Valid until 07/22/2026" read as day-first is a promise held four months too long.
   * (See shared/dates.ts for why this is not a locale string.)
   */
  country?: string | null

  footer?: string | null
}

/** Every list in this app is paginated — assume years of sales. (CLAUDE.md §4) */
export type PagedResult<T> = {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

// ── The invoice number, formatted in ONE place ───────────────────────────────

/**
 * Build the number the customer sees, from the SETTINGS that define it
 * (`invoice.prefix`, `invoice.padding`, `invoice.includeYear`).
 *
 * Lives in shared — pure, integer-in, string-out — so that the service which ASSIGNS the number and
 * the Settings screen which PREVIEWS the format ("INV-2026-000001") produce it from the same line of
 * code. Two implementations of one format is how the preview ends up promising a shape the books do
 * not use. (Same reasoning as `openingBalanceEquityMinor` in shared/opening.ts.)
 *
 * This FORMATS a sequence that has already been drawn. It does not draw one — that happens in the
 * sale's transaction, against `invoice_counters`, and nowhere else.
 */
export function formatInvoiceNo(parts: {
  /** `invoice.prefix`, e.g. "INV-". May be empty. */
  prefix: string
  /** `invoice.padding` — zero-pad the sequence to this width. */
  padding: number
  /** `invoice.includeYear` — put the year in the number. */
  includeYear: boolean
  /** The year the sequence was drawn under. */
  year: number
  /** The sequence itself. */
  seq: number
}): string {
  const seq = String(parts.seq).padStart(Math.max(1, parts.padding), '0')
  return parts.includeYear ? `${parts.prefix}${parts.year}-${seq}` : `${parts.prefix}${seq}`
}

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches a service. The renderer is not trusted to have validated
// anything, and neither is a future LAN client.
//
// UPDATE SCHEMAS CARRY ONLY EDITABLE FIELDS, and every field is optional:
//   undefined -> "the form did not touch this; leave it alone"
//   null      -> "the user cleared it"  (that is what .nullish() is for)
// We NEVER post a whole object back to a save endpoint. (CLAUDE.md §4, trap #18)

/** Integer money, minor units. Unsigned. */
const MoneyMinor = z.number().int().min(0)
/** Integer money that must actually be an amount. A zero payment is not a payment. */
const PositiveMoneyMinor = z.number().int().positive('Please enter an amount greater than zero.')
const RowId = z.number().int().positive()
/**
 * WHOLE LOYALTY POINTS — a count of promises, not money and not a quantity. It is NOT scaled: not minor
 * units, not thousandths. Its rupee value is `points × loyalty.redeemValueMinor`, decided in MAIN.
 * (shared/loyalty.ts states the same rule; this is the sale's own door for it.)
 */
const PositiveInt = z
  .number()
  .int('Points must be a whole number.')
  .positive('Please enter a number of points greater than zero.')
/** A lookups(id) — payment methods are chosen by ID. */
const LookupId = z.number().int().positive()
/**
 * A lookups(...).code — reason codes are stored and passed as CODES, not ids, exactly as
 * `stock_movements.reason_code` does. A code survives a row being re-seeded; an id does not.
 */
const ReasonCode = z.string().trim().min(1).max(50)
const TaxRateBp = z.number().int().min(0).max(100_000)
/** ISO date, YYYY-MM-DD. A cheque is dated to a DAY, not a timestamp. */
// A real calendar day, from ONE definition (shared/dates.ts). The bare regex this used to be let
// 2026-02-30 through, and JS silently rolls that to March 2 — a date in the wrong month, with no
// error. Imported, not re-implemented: seven copies of the guard is seven chances to miss the eighth.
import { IsoDate } from './dates'

// ── A cart line ──────────────────────────────────────────────────────────────

/**
 * An OPEN ITEM — "Misc — Rs 50". There is no catalog row behind it, so the cashier types the name and
 * the price, and this is the ONE place in a cart line where a price legitimately arrives from outside
 * main. It carries its own tax rate because there is no product to read one from; absent, the service
 * applies the shop default (`tax.defaultRateBp` / `tax.defaultMode`).
 *
 * An open item moves NO STOCK and has NO COGS — there is nothing in the catalog to take off a shelf.
 */
export const OpenItemInput = z.object({
  name: z.string().trim().min(1, 'Please name this item.').max(200),
  /** 2-dp money. Zero is allowed — a giveaway still prints on the receipt. */
  unitPrice: MoneyMinor,
  /** Basis points. Absent -> the shop default. */
  taxRateBp: TaxRateBp.optional(),
  /** Absent -> the shop default (`tax.defaultMode`). */
  taxMode: z.enum(PRICE_ENTRY_MODES).optional()
})

/**
 * ONE LINE OF THE CART — WHAT was scanned and HOW MANY. Not what it costs.
 *
 * EXACTLY ONE of `productId` / `openItem` is present, and the refine below enforces it: a line is
 * either something in the catalog or something typed at the till, and a line that is somehow both has
 * no defined price, no defined tax and no defined stock movement.
 *
 * NOTE WHAT IS NOT HERE: net, taxAmount, gross, unitCost. Main computes and freezes all four. See the
 * file header — this is the difference between a POS and a way to steal a television.
 */
export const SaleLineInput = z
  .object({
    /** The catalogued product. NULL/absent -> this is an open item, and `openItem` must be set. */
    productId: RowId.nullish(),

    /**
     * Set when a PACK barcode was scanned (a carton). The line is then priced at the PACK's price and
     * moves `pack_size` of stock — which is how scanning one carton takes 24 pieces off the shelf.
     * Resolved by catalog.findProductByBarcode(); the renderer passes back what it was given.
     */
    packId: RowId.nullish(),

    /** 3-dp qty in the BASE unit. 1 piece = 1000; 1.234 kg = 1234. Positive. */
    qtyM: z.number().int().positive('Please enter a quantity.'),

    /** An open/miscellaneous item. Mutually exclusive with `productId`. */
    openItem: OpenItemInput.nullish(),

    /**
     * A PRICE OVERRIDE on a CATALOGUED line — 2-dp money. Permitted only to the role in the setting
     * `selling.priceOverrideRole`, checked in MAIN, stamped onto the line as `price_override_by` and
     * written to the audit log. Absent = sell at the catalog price for the sale's price tier, which
     * is what happens on essentially every line the shop ever rings up.
     */
    priceOverride: MoneyMinor.nullish(),

    /** 2-dp money off THIS line. A discount above the threshold needs approval — see the sale input. */
    lineDiscount: MoneyMinor.default(0),
    /** lookups('discount_reason').code. Required by the service once the discount needs approval. */
    discountReasonCode: ReasonCode.nullish(),

    /**
     * Normally absent: batches are auto-picked FIRST-EXPIRY-FIRST-OUT and the cashier never chooses.
     * Present only where a service deliberately allows an explicit pick.
     */
    batchId: RowId.nullish(),

    /**
     * Serials/IMEIs being sold on this line — ONLY for a product flagged `track_serials`, and then
     * one per unit. A tin of beans never carries this and never costs the cashier a keystroke for it.
     */
    serials: z.array(z.string().trim().min(1).max(100)).optional()
  })
  .refine((line) => (line.productId == null) !== (line.openItem == null), {
    message: 'A line must be either a catalogue item or an open item — not both, and not neither.',
    path: ['productId']
  })
  .refine((line) => line.openItem == null || line.packId == null, {
    message: 'An open item has no pack — there is no catalogue item behind it.',
    path: ['packId']
  })

// ── A payment ────────────────────────────────────────────────────────────────

/**
 * ONE PAYMENT. A split payment is several of these — Rs 200 cash + Rs 260 card is two rows, and that
 * is the only way a payment-method breakdown can ever be honest.
 *
 * CREDIT (udhaar) is a payment method like any other (lookups: code 'credit'). Whether it may be used
 * without naming a customer is the SETTING `selling.requireCustomerForCredit`, and what happens when
 * the customer is over their limit is `selling.creditLimit` — neither is a constant in the code.
 */
export const SalePaymentInput = z.object({
  /** lookups('payment_method').id. NEVER a hardcoded dropdown (CLAUDE.md §4). */
  methodLookupId: LookupId,
  /** 2-dp money. Positive. May overshoot the total — that is a cash overpayment, and it makes change. */
  amount: PositiveMoneyMinor,

  /** A POST-DATED CHEQUE: which cheque, dated when. */
  chequeNo: z.string().trim().max(50).nullish(),
  chequeDate: IsoDate.nullish(),
  /** JazzCash / Easypaisa transaction reference. */
  walletRef: z.string().trim().max(100).nullish()
})

// ── The cart itself ──────────────────────────────────────────────────────────

/** The fields every cart carries, whether it is being held, quoted or completed. */
const CartShape = {
  /**
   * An existing 'held' or 'quote' row being carried forward. Absent = a brand-new cart.
   * A COMPLETED or VOIDED sale is never re-opened — it is history.
   */
  saleId: RowId.optional(),

  /** NULL = a walk-in. Required for a credit sale when `selling.requireCustomerForCredit` is on. */
  customerId: RowId.nullish(),

  /**
   * Which price column to charge. Switching off 'retail' is permitted only to the role in the setting
   * `selling.wholesaleTierRole`, checked in MAIN.
   */
  priceTier: z.enum(PRICE_TIERS).default('retail'),

  lines: z.array(SaleLineInput).min(1, 'There is nothing in the cart.'),

  /** 2-dp money off the WHOLE cart, on top of any line discounts. */
  cartDiscount: MoneyMinor.default(0),
  /** lookups('discount_reason').code. */
  cartDiscountReasonCode: ReasonCode.nullish()
}

/**
 * PARK THE CART. The customer went back for the milk they forgot, and the queue behind them is
 * moving. A held sale TAKES NO INVOICE NUMBER — that is what keeps numbering gapless — and it moves
 * NO STOCK and posts NO JOURNAL. Nothing has happened yet.
 */
export const HoldSaleInput = z.object(CartShape)

/**
 * A QUOTATION. A price the shop offered, which may never become a sale. Like a held cart it takes no
 * number, moves no stock and posts no journal. It becomes real — and only then draws a number —
 * when it is completed. (PLAN.md §2.)
 */
export const SaveQuoteInput = z.object(CartShape)

/**
 * WHICH OF THE SHOP'S OWN OFFERS WOULD FIRE ON THIS CART, RIGHT NOW — a look, not a sale.
 * (Migration 0018.)
 *
 * The Sell screen asks this as the cashier scans, so it can show "Sunday special −Rs 20" on the line
 * and the customer can be told why the price changed. IT IS ANSWERED BY THE SAME CODE THAT FREEZES THE
 * SALE (`priceCart`), so the discount on the screen and the discount on the receipt cannot drift apart.
 *
 * NOTE WHAT IS ABSENT, and why:
 *   cartDiscount   it is apportioned AFTER the promotions and changes none of them.
 *   at             THE CLOCK IS MAIN'S (see the header). A caller that could name the day could ask
 *                  what Sunday's prices are on a Tuesday and show a price the till will not honour.
 *
 * An EMPTY cart is legal here — the screen asks on every keystroke, including the one that empties it.
 */
export const PreviewPromotionsInput = z.object({
  customerId: RowId.nullish(),
  priceTier: z.enum(PRICE_TIERS).default('retail'),
  lines: z.array(SaleLineInput)
})

/** Pick a parked cart or a quote back up. */
export const ResumeSaleInput = z.object({ id: RowId })

/** Throw a parked cart away. Only 'held' and 'quote' rows can be deleted; history cannot. */
export const DiscardSaleInput = z.object({ id: RowId })

/**
 * RING IT UP. The one that matters.
 *
 * This is the moment — and the ONLY moment — at which, in a single transaction:
 *
 *   the invoice number is drawn from `invoice_counters` and the counter incremented,
 *   every line's price, tax and cost are computed and FROZEN,
 *   stock moves (stock.record(), which freezes each movement's cost and value_minor),
 *   the journal posts and balances,
 *   the payments are written.
 *
 * All of it, or none of it. A number drawn for a sale that then failed to insert is a gap in the
 * book, and a gap in the book is what a tax inspector is trained to look for.
 */
export const CompleteSaleInput = z.object({
  ...CartShape,

  /**
   * The money that crossed the counter. It may legitimately be EMPTY — and only since points became a
   * tender (migration 0017): a customer with enough points can pay for the whole sale with them and
   * hand over nothing, exactly as if they had paid the lot in cash.
   *
   * "A sale must be paid for" is therefore NOT a rule about this array's length, and it never really
   * was — an array of one Rs 1 payment against a Rs 500 sale would satisfy `.min(1)` and still be
   * short. The real rule is arithmetic (tendered >= the grand total), it counts the points, and
   * `complete()` in MAIN enforces it in one place with a sentence that says how much is missing.
   */
  payments: z.array(SalePaymentInput),

  /**
   * The SUPERVISOR who approved a discount above the threshold
   * (settings `selling.discountApprovalPercent` / `selling.discountApprovalAmount`, whichever is
   * reached first). MAIN decides whether approval was needed and whether this user may give it —
   * a renderer that simply omits the field must not be able to skip the check. It is recorded in the
   * audit log with the approver's name and role. (CLAUDE.md §4.)
   */
  /**
   * The SUPERVISOR'S PIN, typed on the approval prompt when a discount, price override or wholesale
   * tier crosses the threshold. MAIN verifies it and derives the approver FROM it — the renderer
   * never says who approved. An unverified id would let a cashier self-approve and frame a
   * supervisor. (CLAUDE.md §4 — the renderer is not a security boundary.)
   */
  approverPin: z.string().trim().min(4).max(12).nullish(),

  /**
   * The cashier has SEEN the negative-stock warning and chosen to continue. Meaningful only when the
   * setting `selling.negativeStock` is 'warn'; when it is 'block', MAIN refuses regardless of what
   * this says. The sale is flagged (`had_negative_stock`) and audit-logged either way.
   */
  acceptNegativeStock: z.boolean().default(false),

  /**
   * The customer is over their credit limit and the cashier has chosen to continue. Meaningful only
   * when `selling.creditLimit` is 'warn'; when it is 'block', MAIN refuses.
   */
  acceptOverCreditLimit: z.boolean().default(false),

  /**
   * LOYALTY POINTS SPENT ON THIS SALE — a TENDER, not a discount (migration 0017).
   *
   * The renderer sends WHOLE POINTS and nothing else. It never sends a rupee figure: MAIN values them
   * at `loyalty.redeemValueMinor`, freezes that value onto the movement, and tenders THAT — a renderer
   * that could send the money could tell the shop what its own points are worth. The points pay for
   * the goods exactly as cash does, so revenue and output tax are untouched and the frozen lines are
   * never recomputed. (CLAUDE.md §4 — the renderer sends intent, MAIN decides the money.)
   *
   * Requires a named customer, loyalty switched on, and at least `loyalty.minPointsToRedeem` — all
   * enforced in MAIN by the loyalty service, never here and never by the UI.
   */
  redeemPoints: PositiveInt.nullish()
})

// ── Void ─────────────────────────────────────────────────────────────────────

/**
 * CANCEL A COMPLETED SALE. Supervisor-only, enforced in MAIN.
 *
 * A void REVERSES: it posts the reversing journal and puts the stock back. It does NOT delete, and it
 * does NOT release the invoice number — the voided sale KEEPS it, forever. A book that renumbers
 * itself around a cancellation is a book that cannot be audited.
 *
 * The reason code is REQUIRED, here and in the database (see the CHECK in migration 0007). "Every
 * void carries a reason and a name" is the whole point of the audit log (CLAUDE.md §4).
 */
export const VoidSaleInput = z.object({
  id: RowId,
  /** lookups('void_reason').code. Never a hardcoded dropdown. */
  reasonCode: ReasonCode,
  /** Free text the supervisor adds on top of the code. */
  reasonText: z.string().trim().max(500).nullish()
})

// ── Reading ──────────────────────────────────────────────────────────────────

export const SaleGetInput = z.object({ id: RowId })

/** Look a sale up by the number printed on the customer's receipt — the returns desk's first move. */
export const SaleByInvoiceNoInput = z.object({
  invoiceNo: z.string().trim().min(1, 'Please enter the invoice number.').max(64)
})

export const SaleListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),

  /** Matches the invoice number or the customer's name. */
  search: z.string().trim().max(100).optional(),
  status: z.enum(SALE_STATUSES).optional(),
  customerId: RowId.optional(),
  /** Whose takings — the per-cashier report, and the leakage report. */
  userId: RowId.optional(),

  /** ISO dates, inclusive. */
  from: IsoDate.optional(),
  to: IsoDate.optional(),

  /** THE LEAKAGE FILTER: show me only the sales that went out against stock we did not have. */
  hadNegativeStock: z.boolean().optional()
})

/**
 * REPRINT. A second copy of a receipt must never be mistakable for the first — it is stamped
 * DUPLICATE (PLAN.md §5), and every reprint is audit-logged, because "print it again" is how a
 * receipt ends up in two customers' hands.
 */
export const SaleReceiptInput = z.object({
  id: RowId,
  isDuplicate: z.boolean().default(true)
})

/**
 * PRINT THE QUOTATION — the offer, on paper, in the customer's hand.
 *
 * No `isDuplicate`: re-printing an OFFER is not re-printing a receipt. There is no sale to double-count
 * and no money to be claimed twice, so there is nothing to stamp. (See `QuotationData`.)
 */
export const SaleQuotationInput = z.object({ id: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────

export type OpenItemInput = z.infer<typeof OpenItemInput>
export type SaleLineInput = z.infer<typeof SaleLineInput>
export type SalePaymentInput = z.infer<typeof SalePaymentInput>
export type HoldSaleInput = z.infer<typeof HoldSaleInput>
export type SaveQuoteInput = z.infer<typeof SaveQuoteInput>
export type ResumeSaleInput = z.infer<typeof ResumeSaleInput>
export type PreviewPromotionsInput = z.infer<typeof PreviewPromotionsInput>
export type DiscardSaleInput = z.infer<typeof DiscardSaleInput>
export type CompleteSaleInput = z.infer<typeof CompleteSaleInput>
export type VoidSaleInput = z.infer<typeof VoidSaleInput>
export type SaleGetInput = z.infer<typeof SaleGetInput>
export type SaleByInvoiceNoInput = z.infer<typeof SaleByInvoiceNoInput>
export type SaleListInput = z.infer<typeof SaleListInput>
export type SaleReceiptInput = z.infer<typeof SaleReceiptInput>
export type SaleQuotationInput = z.infer<typeof SaleQuotationInput>
