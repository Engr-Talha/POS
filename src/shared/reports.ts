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

// ── Which report, and its params, as ONE validated shape ────────────────────────

/**
 * WHAT THE CALLER ASKS FOR: a report `kind`, carrying exactly that report's params.
 *
 * One discriminated union so the boundary validates a report request in ONE place, and the nine tags
 * are the same nine the export layer switches on (`ReportKind` in report-export.ts). The IPC dispatch
 * (reports.buildReport) maps this union onto `ReportPayload` in one exhaustive switch, so a tag that is
 * missing or misspelled here cannot compile there — the request shape and the result shape are kept in
 * lockstep by the compiler, not by hand.
 *
 * The params split three ways, exactly as the reports do:
 *   a PERIOD [from, to]  — salesSummary, profit, leakage, profitAndLoss
 *   an AS-OF date        — customerAging, supplierAging, trialBalance, balanceSheet
 *   "as of now" + a knob — stockValuation (near-expiry window; absent → the shop's setting)
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
  AsOfInput.extend({ kind: z.literal('balanceSheet') })
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
