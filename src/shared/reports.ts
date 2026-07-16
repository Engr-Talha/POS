import { z } from 'zod'
import type { TrialBalance } from './accounting'

/**
 * THE REPORTS CONTRACT — the param and result types the reports service and its callers agree on.
 *
 * ── REPORTS READ. THEY NEVER WRITE, AND THEY NEVER RECOMPUTE A FROZEN NUMBER. ────────────────────
 *
 * Every figure here is DERIVED from records that are already frozen: a sale line's net/tax/cost, a
 * stock movement's value_minor, a journal line's debit/credit. A report re-reads those integers and
 * groups them — it never re-prices a sale from today's catalog, never re-costs stock from today's
 * average, never re-taxes a line from today's rate. That is the whole reason the sale line, the
 * movement and the journal freeze what they freeze (CLAUDE.md §4).
 *
 * ── AND THEY RECONCILE WITH THE LEDGER. ─────────────────────────────────────────────────────────
 *
 * The numbers a shopkeeper trusts are the ones that tie out, so the reports are built so they cannot
 * disagree with the books:
 *
 *     stock valuation total   ===  GL Inventory        (ACC.INVENTORY)
 *     customer aging total     ===  GL Receivable       (ACC.RECEIVABLE)
 *     supplier aging total     ===  GL Payable          (ACC.PAYABLE)
 *     trial balance                balances
 *     balance sheet                assets === liabilities + equity
 *     P&L net profit           ===  period net revenue − period expenses
 *
 * Each of those is asserted by a test after a realistic scenario, not just hoped for.
 *
 * ── THREE INTEGER SCALES, AS EVERYWHERE. NOT ONE FLOAT. ─────────────────────────────────────────
 *
 *     money  — INTEGER minor units (paisa),  2 dp    every *Value / *Total / amount / net / tax field
 *     cost   — INTEGER ten-thousandths,      4 dp    avgCost (the frozen weighted average)
 *     qty_m  — INTEGER thousandths,          3 dp    onHandM
 *
 * A margin is the one genuine ratio, and it is expressed in BASIS POINTS (integer, 3333 = 33.33%) so
 * that even the ratio stays off the float path — the same convention tax rates already use.
 *
 * Dates in and out are 'YYYY-MM-DD' strings (`IsoDate`), validated in MAIN like every other service.
 */

// ── Shared date params ─────────────────────────────────────────────────────────

/** ISO date, YYYY-MM-DD. The same shape sales.ts / catalog.ts validate their dates with. */
export const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')

/** A period: [from, to], both inclusive of the whole day. */
export const DateRangeInput = z.object({
  from: IsoDate,
  to: IsoDate
})
export type DateRangeInput = z.infer<typeof DateRangeInput>

/** A point in time: everything up to and including this day. */
export const AsOfInput = z.object({
  asOf: IsoDate
})
export type AsOfInput = z.infer<typeof AsOfInput>

/** Stock valuation is "as of NOW" — it reads the current on-hand — with one optional knob. */
export const StockValuationInput = z.object({
  /** Batches expiring within this many days count as near-expiry. Absent → the shop's setting. */
  nearExpiryDays: z.number().int().min(0).max(3650).optional()
})
export type StockValuationInput = z.infer<typeof StockValuationInput>

/**
 * PAGINATION. Assume 100k+ rows and never SELECT * unbounded (CLAUDE.md §4).
 *
 * The same shape every other paginated input in this app uses (`Page` / `PageSize` in shared/ipc.ts):
 * 1-based `page`, `pageSize` capped at 200 so a runaway renderer cannot ask for the whole book in one
 * call. Both optional — a report called with no paging still answers, with the service's defaults.
 */
const Page = z.number().int().positive().optional()
const PageSize = z.number().int().positive().max(200).optional()

/** A period + a page of it. The item-wise/category-wise/cash-book/GL reports all take this. */
export const PagedDateRangeInput = DateRangeInput.extend({ page: Page, pageSize: PageSize })
export type PagedDateRangeInput = z.infer<typeof PagedDateRangeInput>

/** The re-order report: "as of now", paged. The threshold comes from the DB, never the caller. */
export const LowStockReportInput = z.object({ page: Page, pageSize: PageSize })
export type LowStockReportInput = z.infer<typeof LowStockReportInput>

/**
 * NEAR EXPIRY, paged. `withinDays` OVERRIDES the shop's 'stock.nearExpiryDays' setting for one run
 * (the Reports screen's "show me 90 days instead" knob); absent → the setting, which is the default
 * the shop chose. There is deliberately no `asOf`: what has expired is the clock's answer, not the
 * renderer's opinion — the service takes `now` from MAIN (injectable only for deterministic tests).
 */
export const NearExpiryReportInput = z.object({
  withinDays: z.number().int().min(0).max(3650).optional(),
  page: Page,
  pageSize: PageSize
})
export type NearExpiryReportInput = z.infer<typeof NearExpiryReportInput>

/**
 * ONE ACCOUNT's ledger over a period. `accountCode` is the CODE, never the id or the name — codes are
 * the contract the posting engine itself uses (see chart-of-accounts.ts), so an owner renaming
 * "Cash in Hand" cannot break a saved report.
 */
export const GeneralLedgerInput = PagedDateRangeInput.extend({
  accountCode: z.string().trim().min(1, 'Please choose an account.')
})
export type GeneralLedgerInput = z.infer<typeof GeneralLedgerInput>

// ── Which report, and its params, as ONE validated shape ────────────────────────

/**
 * WHAT THE CALLER ASKS FOR: a report `kind`, carrying exactly that report's params.
 *
 * One discriminated union so the boundary validates a report request in ONE place, and the seventeen
 * tags are the same seventeen the export layer switches on (`ReportKind` in report-export.ts). The IPC
 * dispatch (reports.buildReport) maps this union onto `ReportPayload` in one exhaustive switch, so a tag
 * that is missing or misspelled here cannot compile there — the request shape and the result shape are
 * kept in lockstep by the compiler, not by hand.
 *
 * The params split four ways, exactly as the reports do:
 *   a PERIOD [from, to]  — salesSummary, profit, leakage, profitAndLoss, taxSummary
 *   a PERIOD + a page    — itemWise, categoryWise, paymentMethodBreakdown, cashBook, generalLedger
 *                          (+ generalLedger's accountCode: the one account it walks)
 *   an AS-OF date        — customerAging, supplierAging, trialBalance, balanceSheet
 *   "as of now" + a knob — stockValuation, lowStock, nearExpiry
 *
 * Dates are the same `IsoDate` every other service input uses, validated in MAIN before a query runs.
 */
export const ReportRequest = z.discriminatedUnion('kind', [
  DateRangeInput.extend({ kind: z.literal('salesSummary') }),
  DateRangeInput.extend({ kind: z.literal('profit') }),
  StockValuationInput.extend({ kind: z.literal('stockValuation') }),
  AsOfInput.extend({ kind: z.literal('customerAging') }),
  AsOfInput.extend({ kind: z.literal('supplierAging') }),
  DateRangeInput.extend({ kind: z.literal('leakage') }),
  AsOfInput.extend({ kind: z.literal('trialBalance') }),
  DateRangeInput.extend({ kind: z.literal('profitAndLoss') }),
  AsOfInput.extend({ kind: z.literal('balanceSheet') }),
  PagedDateRangeInput.extend({ kind: z.literal('itemWise') }),
  PagedDateRangeInput.extend({ kind: z.literal('categoryWise') }),
  PagedDateRangeInput.extend({ kind: z.literal('paymentMethodBreakdown') }),
  DateRangeInput.extend({ kind: z.literal('taxSummary') }),
  LowStockReportInput.extend({ kind: z.literal('lowStock') }),
  NearExpiryReportInput.extend({ kind: z.literal('nearExpiry') }),
  PagedDateRangeInput.extend({ kind: z.literal('cashBook') }),
  GeneralLedgerInput.extend({ kind: z.literal('generalLedger') })
])
export type ReportRequest = z.infer<typeof ReportRequest>

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SALES SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/** One payment method, and everything tendered through it in the period. */
export type TenderBreakdownRow = {
  methodLookupId: number
  label: string
  /** 2-dp money. Σ sale_payments.amount for this method — what was TENDERED (change not netted off). */
  amount: number
}

/** One trading day. */
export type SalesByDayRow = {
  /** 'YYYY-MM-DD'. */
  date: string
  count: number
  /** 2-dp money. Σ grand_total that day. */
  gross: number
}

export type SalesSummaryReport = {
  from: string
  to: string
  /** Completed sales in the period. Voided / held / quoted are excluded. */
  count: number
  /** 2-dp money. Σ grand_total — the total the customers were charged. */
  grossTotal: number
  /**
   * 2-dp money. Σ subtotal_net — the EX-TAX NET REVENUE.
   *
   * NOT `Σ subtotal_net − Σ cart_discount`: in this codebase the cart discount is APPORTIONED INTO
   * the lines at sale time (sales.ts, priceCart), so `sales.subtotal_net` (= Σ sale_lines.net) is
   * ALREADY net of it. Subtracting it again would double-count. This figure is exactly what the sale
   * journal left in Sales less Discounts (CR Sales listNet − DR Discounts discountNet === subtotalNet),
   * which is what keeps the summary tied to the P&L and the ledger.
   */
  netSales: number
  /**
   * 2-dp money. Σ line_discount + Σ cart_discount — the NOMINAL discount the cashier keyed, for the
   * "how much did we give away" line. Informational; the ex-tax cost of discounting lives in the P&L
   * (Discounts Given). Not a reconciliation figure.
   */
  totalDiscount: number
  /** 2-dp money. Σ tax_total — output tax collected. */
  totalTax: number
  /** Grouped by payment method. Σ of the amounts === Σ paid_total across the period's sales. */
  byTender: TenderBreakdownRow[]
  byDay: SalesByDayRow[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PROFIT (gross margin on the period's sales)
// ═══════════════════════════════════════════════════════════════════════════════

export type ProfitByDayRow = {
  date: string
  /** 2-dp money. */
  revenue: number
  /** 2-dp money. */
  cogs: number
  /** 2-dp money. revenue − cogs. */
  grossProfit: number
}

export type ProfitReport = {
  from: string
  to: string
  /** 2-dp money. Ex-tax net revenue of completed sales — same basis as SalesSummary.netSales. */
  revenue: number
  /**
   * 2-dp money. The FROZEN cost of what those sales took off the shelf — Σ of the sale stock
   * movements' own `value_minor` (migration 0006), never a fresh qty×cost multiply and never today's
   * average. This is exactly what the sale journals debited to COGS, so profit ties to the books.
   */
  cogs: number
  /** 2-dp money. revenue − cogs. */
  grossProfit: number
  /** BASIS POINTS (integer): grossProfit / revenue. 3333 = 33.33%. 0 when there is no revenue. */
  marginBp: number
  byDay: ProfitByDayRow[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. STOCK VALUATION (as of now)
// ═══════════════════════════════════════════════════════════════════════════════

export type StockValuationRow = {
  productId: number
  sku: string
  name: string
  isActive: boolean
  /** 3-dp qty. SUM(stock_movements.qty_m). */
  onHandM: number
  /** 4-dp cost. The stored weighted average (products.cost_price). */
  avgCost: number
  /** 2-dp money. SUM(stock_movements.value_minor) — the frozen value, the number the ledger posted. */
  valueMinor: number
  /** 3-dp qty. The re-order level (products.min_stock_m). */
  minStockM: number
  /** onHandM <= minStockM — the item is at or below its re-order level. */
  isBelowReorder: boolean
}

export type StockValuationReport = {
  rows: StockValuationRow[]
  /**
   * 2-dp money. SUM(stock_movements.value_minor) across ALL movements. MUST equal
   * ledger.accountBalance(ACC.INVENTORY) — asserted by a test (and by the migration-0006 invariant).
   */
  totalValue: number
  /** Active items at or below their re-order level. */
  lowStockCount: number
  /** Batches with stock left, expiring within `nearExpiryDays` (already-expired included). */
  nearExpiryCount: number
  nearExpiryDays: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4 & 5. AGING (receivables and payables)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The five aging buckets, by the age of the UNPAID amount as of the report date. Payments and
 * credit-note returns are applied OLDEST-FIRST, so what remains is bucketed by how old it is.
 * All 2-dp money.
 */
export type AgingBuckets = {
  /** Dated on or after the report date (age <= 0). */
  current: number
  /** 1–30 days old. */
  d1_30: number
  /** 31–60 days old. */
  d31_60: number
  /** 61–90 days old. */
  d61_90: number
  /** More than 90 days old. */
  d90plus: number
}

export type CustomerAgingRow = AgingBuckets & {
  customerId: number
  name: string
  /** 2-dp money. sales.outstandingCredit — the one figure the ledger screen uses. Σ of buckets. */
  total: number
}

export type CustomerAgingReport = {
  asOf: string
  rows: CustomerAgingRow[]
  /** Column totals + the grand total. `total` === GL Receivable — asserted by a test. */
  totals: AgingBuckets & { total: number }
}

export type SupplierAgingRow = AgingBuckets & {
  supplierId: number
  name: string
  /** 2-dp money. supplier-ledger.balance — what the shop owes this supplier. Σ of buckets. */
  total: number
}

export type SupplierAgingReport = {
  asOf: string
  rows: SupplierAgingRow[]
  /** Column totals + the grand total. `total` === GL Payable — asserted by a test. */
  totals: AgingBuckets & { total: number }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. LEAKAGE (anti-theft, grouped by user)
// ═══════════════════════════════════════════════════════════════════════════════

/** Everything one user did in the period that the audit trail exists to surface. */
export type LeakageRow = {
  userId: number
  name: string
  role: string
  /** Over-threshold discounts they rang up (audit 'sale.discount.over_threshold'). */
  overThresholdDiscountCount: number
  /** 2-dp money. Σ of the discount actually given on those sales. */
  overThresholdDiscountValue: number
  /** Sales they voided. */
  voidCount: number
  /** 2-dp money. Σ grand_total of the voided sales. */
  voidValue: number
  /** Returns they processed. */
  returnCount: number
  /** 2-dp money. Σ grand_total refunded / credited. */
  returnValue: number
  /** Times they popped the drawer with no sale (cash_movements type 'no_sale'). */
  noSaleCount: number
}

export type LeakageTotals = {
  overThresholdDiscountCount: number
  overThresholdDiscountValue: number
  voidCount: number
  voidValue: number
  returnCount: number
  returnValue: number
  noSaleCount: number
}

export type LeakageReport = {
  from: string
  to: string
  rows: LeakageRow[]
  totals: LeakageTotals
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. TRIAL BALANCE
// ═══════════════════════════════════════════════════════════════════════════════

/** ledger.trialBalance, stamped with the date it was taken as of. `balanced` must be true. */
export type TrialBalanceReport = TrialBalance & {
  asOf: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. PROFIT & LOSS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One account's contribution to its section, SIGNED toward that section's total.
 *   income:  Sales is positive; the contra accounts (Sales Returns, Discounts) are negative.
 *   expense: every row is positive.
 */
export type PnlRow = {
  code: string
  name: string
  /** 2-dp money, signed as above. */
  amount: number
}

export type ProfitAndLossReport = {
  from: string
  to: string
  /** Sales (+) and its contra accounts (−). Σ === netRevenue. */
  income: PnlRow[]
  /** 2-dp money. Σ income = Sales − Sales Returns − Discounts. */
  netRevenue: number
  /** COGS, Stock Adjustments, and every expense account — each positive. */
  expenses: PnlRow[]
  /** 2-dp money. Σ expenses. */
  totalExpenses: number
  /** 2-dp money. netRevenue − totalExpenses. */
  netProfit: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. BALANCE SHEET
// ═══════════════════════════════════════════════════════════════════════════════

/** One line of the balance sheet, at its natural (positive-means-more-of-what-it-is) balance. */
export type BalanceSheetLine = {
  code: string
  name: string
  /** 2-dp money. */
  amount: number
}

export type BalanceSheetReport = {
  asOf: string
  /** Cash, Bank, Receivable, Inventory, Input Tax (every asset account). */
  assets: BalanceSheetLine[]
  totalAssets: number
  /** Payable, Output Tax, Loyalty (every liability account). */
  liabilities: BalanceSheetLine[]
  totalLiabilities: number
  /**
   * Owner Equity, Opening Balance Equity, Retained Earnings — and, as its own line, the period-to-date
   * NET PROFIT that has not yet been closed into Retained Earnings. Σ === totalEquity.
   */
  equity: BalanceSheetLine[]
  totalEquity: number
  /** 2-dp money. Income − expenses accumulated up to `asOf`, folded into equity so the sheet balances. */
  netProfit: number
  /** totalAssets === totalLiabilities + totalEquity. MUST be true — asserted by a test. */
  balanced: boolean
}

// ═══════════════════════════════════════════════════════════════════════════════
// Paging — the envelope every long report comes back in
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A page of rows, and the TOTALS OF THE WHOLE REPORT — not of the page.
 *
 * That distinction is the entire point. `total` is how many rows exist; the report's own totals (each
 * report names its own) are computed in SQL across every matching row, never by summing `rows`. Page 2
 * of an item-wise report must still footer the period's real gross, or the shopkeeper reads a total
 * that changes when he clicks "next".
 */
export type PagedReport<T> = {
  rows: T[]
  /** How many rows match in total — NOT rows.length. */
  total: number
  /** 1-based. */
  page: number
  pageSize: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. ITEM-WISE SALES
// ═══════════════════════════════════════════════════════════════════════════════

/** One product's trade over the period. Every figure read back FROZEN off the sale lines. */
export type ItemWiseRow = {
  /** NULL for an OPEN ITEM ("Misc — Rs 50"): it sold and it earned, but no product backs it. */
  productId: number | null
  sku: string
  /** The FROZEN name_snapshot — what the receipt said, not what the catalog says today. */
  name: string
  /** 3-dp qty. Σ sale_lines.qty_m. */
  qtyM: number
  /** 2-dp money. Σ sale_lines.net — ex-tax, cart discount already apportioned in. */
  net: number
  /** 2-dp money. Σ sale_lines.tax_amount, frozen at the rate charged that day. */
  tax: number
  /** 2-dp money. Σ sale_lines.gross === net + tax. */
  gross: number
  /**
   * 2-dp money. What these units COST the shop, from the FROZEN `unit_cost` on the sale line
   * (4-dp cost × 3-dp qty, scaled down to money once per line — never today's average).
   */
  cogs: number
  /** 2-dp money. net − cogs. Negative when it sold below cost, and it must show that honestly. */
  grossProfit: number
  /** BASIS POINTS (integer): grossProfit / net. 3333 = 33.33%. 0 when the item earned no net. */
  marginBp: number
}

export type ItemWiseReport = PagedReport<ItemWiseRow> & {
  from: string
  to: string
  /** The WHOLE period's totals, across every item — not just this page. */
  totals: { qtyM: number; net: number; tax: number; gross: number; cogs: number; grossProfit: number }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. CATEGORY-WISE SALES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One category's trade. Same money as item-wise, cut by the product's category lookup.
 *
 * A product with NO category still appears, under `categoryId: null` / "Uncategorised" — the same way
 * customerAging surfaces its "Unassigned (walk-in credit)" line. Dropping it would make the category
 * report's total disagree with the item-wise report's, and the shopkeeper would never know which lied.
 */
export type CategoryWiseRow = {
  /** NULL = the product has no category, or the line was an open item with no product at all. */
  categoryId: number | null
  /** The lookup's label, or 'Uncategorised'. */
  name: string
  qtyM: number
  net: number
  tax: number
  gross: number
  cogs: number
  grossProfit: number
  marginBp: number
}

export type CategoryWiseReport = PagedReport<CategoryWiseRow> & {
  from: string
  to: string
  totals: { qtyM: number; net: number; tax: number; gross: number; cogs: number; grossProfit: number }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. PAYMENT-METHOD BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One tender, and the money that moved BOTH WAYS through it.
 *
 * This is NOT salesSummary.byTender with extra columns. That one answers "what was tendered?" — one
 * number per method. This one answers the question a shopkeeper actually asks at closing: "how much
 * cash should be in this drawer?", which needs what came IN, what went back OUT through the same
 * tender, and the NET. A refund paid in cash leaves the till; a tender report that cannot see it will
 * tell the cashier he is over when he is square.
 */
export type PaymentMethodRow = {
  methodLookupId: number
  code: string
  label: string
  /** How many sale_payments rows used this tender. A split payment counts once per tender it used. */
  count: number
  /** 2-dp money. Σ sale_payments.amount — TENDERED IN (change not netted off; see `changeGiven`). */
  tendered: number
  /** How many returns were refunded back through this tender. */
  refundCount: number
  /**
   * 2-dp money. Σ returns.grand_total settled 'refund' through this tender — money OUT.
   * A 'customer_credit' or 'exchange' return paid nothing out and is deliberately not here.
   */
  refunded: number
  /**
   * 2-dp money. Change handed back — CASH ONLY, and only on sales tendered in cash, because change
   * always comes out of the drawer whatever the customer paid with. 0 for every other tender.
   */
  changeGiven: number
  /** 2-dp money. tendered − changeGiven − refunded. What this tender actually netted the shop. */
  net: number
  /** BASIS POINTS (integer): this tender's `net` as a share of the period's total net takings. */
  shareBp: number
}

export type PaymentMethodBreakdownReport = PagedReport<PaymentMethodRow> & {
  from: string
  to: string
  totals: {
    count: number
    tendered: number
    refundCount: number
    refunded: number
    changeGiven: number
    /** 2-dp money. Σ net across every tender — the denominator `shareBp` is a share of. */
    net: number
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. TAX SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One tax RATE, and the trade taxed at it. Read FROZEN off the sale lines — `tax_rate_bp` and
 * `tax_amount` as they were charged, never re-derived from today's product settings. A product moved
 * from 17% to 0% next month does not rewrite last month's return.
 */
export type TaxSummaryRateRow = {
  /** BASIS POINTS: 1700 = 17%. 0 = zero-rated or exempt — both legitimately show as their own row. */
  taxRateBp: number
  /** 2-dp money. Σ sale_lines.net at this rate — the BASE the tax was charged on. */
  netBase: number
  /** 2-dp money. Σ sale_lines.tax_amount at this rate. */
  taxAmount: number
}

/**
 * WHAT THE SHOP OWES THE GOVERNMENT for the period: output tax collected on sales, less input tax
 * paid on purchases.
 *
 * ── THIS REPORT TIES TO THE LEDGER, AND THE TEST ASSERTS IT ──────────────────────────────────────
 *
 *     outputTax  ===  the GL movement on ACC.OUTPUT_TAX over the period
 *     inputTax   ===  the GL movement on ACC.INPUT_TAX  over the period
 *
 * Which is why `outputTax` is NOT simply Σ sale_lines.tax_amount. Tax comes back off that account too:
 * a RETURN debits Output Tax, and a VOID contra-posts the whole sale journal, tax leg included. So the
 * report states output tax as COLLECTED − REVERSED, the same three movements the GL account sees, and
 * `byRate` (sales only) is the analysis of the collected side. Same on the buying side: a purchase
 * return credits Input Tax back.
 */
export type TaxSummaryReport = {
  from: string
  to: string
  /** Output tax on SALES, grouped by the rate it was charged at. Σ taxAmount === `taxCollected`. */
  byRate: TaxSummaryRateRow[]
  /** 2-dp money. Σ sale_lines.tax_amount over completed sales in the period. */
  taxCollected: number
  /** 2-dp money. Tax handed back: Σ returns.tax_total + the tax leg of every voided sale. */
  taxReversed: number
  /** 2-dp money. taxCollected − taxReversed. === the GL movement on ACC.OUTPUT_TAX. */
  outputTax: number
  /** 2-dp money. Σ purchases.tax_total in the period — recoverable tax paid to suppliers. */
  inputTaxPaid: number
  /** 2-dp money. Σ purchase_returns.tax_total — reclaimed tax handed back with returned goods. */
  inputTaxReversed: number
  /** 2-dp money. inputTaxPaid − inputTaxReversed. === the GL movement on ACC.INPUT_TAX. */
  inputTax: number
  /**
   * 2-dp money. outputTax − inputTax. POSITIVE = the shop owes the government; NEGATIVE = the
   * government owes the shop (more tax was paid on stock than was collected on sales — a normal
   * result in a month of heavy buying, and it must be shown as the refund it is, not clamped to 0).
   */
  netPayable: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 14. LOW STOCK (the re-order report)
// ═══════════════════════════════════════════════════════════════════════════════

/** One item at or below its re-order level, and who to buy it from. */
export type LowStockRow = {
  productId: number
  sku: string
  name: string
  /** 3-dp qty. SUM(stock_movements.qty_m). Negative when sold into the red. */
  onHandM: number
  /**
   * 3-dp qty. The level this item is judged against: `products.min_stock_m`, or — when that is 0 —
   * the shop's 'stock.lowStockDefault' SETTING (whole units, converted to qty_m). Never a literal.
   */
  thresholdM: number
  /** true when the threshold came from the setting rather than the item's own override. */
  usesDefaultThreshold: boolean
  /** 3-dp qty. thresholdM − onHandM: how many to buy to get back to the line. Always > 0. */
  shortfallM: number
  /** The preferred supplier (product_suppliers.is_preferred), if one is named. */
  preferredSupplierId: number | null
  preferredSupplierName: string | null
  /** That supplier's own code for this item — what goes on the purchase order. */
  supplierItemCode: string | null
}

export type LowStockReport = PagedReport<LowStockRow> & {
  /** The 'stock.lowStockDefault' setting in force, in qty_m — what the rows without an override used. */
  defaultThresholdM: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 15. NEAR EXPIRY
// ═══════════════════════════════════════════════════════════════════════════════

/** One batch with stock left on it, and how long the shop has to sell it. */
export type NearExpiryRow = {
  productId: number
  sku: string
  name: string
  batchId: number
  batchNo: string
  /** ISO date. Never null — a batch with no expiry date cannot be near one. */
  expiryDate: string
  /** Whole days from today to the expiry. NEGATIVE = ALREADY EXPIRED, and it is still listed. */
  daysRemaining: number
  expired: boolean
  /** 3-dp qty. Stock left ON THIS BATCH. Always > 0 — an empty batch is not a problem. */
  onHandM: number
  /** 2-dp money. Σ value_minor of this batch's movements — the FROZEN cost the shop stands to lose. */
  valueMinor: number
}

export type NearExpiryReport = PagedReport<NearExpiryRow> & {
  /** The window used: `withinDays` if given, else the 'stock.nearExpiryDays' setting. */
  withinDays: number
  /** 2-dp money. The value at risk across EVERY matching batch, not just this page. */
  totalValueMinor: number
  /** How many of the matching batches are already past their date. */
  expiredCount: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 16. CASH BOOK
// ═══════════════════════════════════════════════════════════════════════════════

/** One journal line that touched Cash, with the balance after it. */
export type CashBookRow = {
  journalId: number
  /** ISO timestamp — the cash book is chronological, and two entries can share a day. */
  at: string
  /** What it was: the journal's memo ("Sale INV-0001", "Rent — March"). */
  memo: string
  /** What caused it: the journal's ref_type ('sale', 'expense', 'supplier_payment'…). */
  refType: string
  refId: string | null
  /** 2-dp money. Money IN — the debit to Cash. */
  inMinor: number
  /** 2-dp money. Money OUT — the credit to Cash. */
  outMinor: number
  /** 2-dp money. The running balance AFTER this line, from `opening` down the period in order. */
  balanceMinor: number
}

/**
 * THE CASH ACCOUNT'S STORY over a period: what was in the drawer at the start, every movement, and
 * what is in it at the end.
 *
 * TWO reconciliations, both asserted by a test:
 *     closing === opening + Σ in − Σ out          (the arithmetic of the page itself)
 *     closing === the GL Cash balance as of `to`  (the arithmetic agrees with the books)
 */
export type CashBookReport = PagedReport<CashBookRow> & {
  from: string
  to: string
  /** 2-dp money. The GL Cash balance the instant before `from`. */
  opening: number
  /** 2-dp money. Σ every debit to Cash in the period — across ALL rows, not just this page. */
  totalIn: number
  /** 2-dp money. Σ every credit to Cash in the period. */
  totalOut: number
  /** 2-dp money. opening + totalIn − totalOut, and === GL Cash as of `to`. */
  closing: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 17. GENERAL LEDGER (one account, with a running balance)
// ═══════════════════════════════════════════════════════════════════════════════

/** One journal line on the account, with the balance after it. */
export type GeneralLedgerRow = {
  journalId: number
  at: string
  memo: string
  refType: string
  refId: string | null
  /** 2-dp money, as posted. */
  debit: number
  /** 2-dp money, as posted. */
  credit: number
  /**
   * 2-dp money. The running balance after this line, ON THE ACCOUNT'S NATURAL SIDE — a liability is
   * credit-natured, so a credit RAISES its balance. Read it any other way and every payable in the
   * book prints negative.
   */
  balanceMinor: number
}

export type GeneralLedgerReport = PagedReport<GeneralLedgerRow> & {
  from: string
  to: string
  accountCode: string
  accountName: string
  accountType: 'asset' | 'liability' | 'equity' | 'income' | 'expense'
  /** true when a debit RAISES this account (assets, expenses — and a contra account, inverted). */
  isDebitNatured: boolean
  /** 2-dp money. The account's natural balance the instant before `from`. */
  opening: number
  /** 2-dp money. Σ debits in the period, across ALL rows. */
  totalDebit: number
  /** 2-dp money. Σ credits in the period. */
  totalCredit: number
  /** 2-dp money. opening ± the period's movement, on the natural side. === the GL balance as of `to`. */
  closing: number
}
