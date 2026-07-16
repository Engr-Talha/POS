import type { z } from 'zod'
import type { DB } from '../db'
import type { AccountType } from '@shared/accounting'
import { AppError, ErrorCode } from '@shared/result'
import { BASIS_POINTS } from '@shared/tax'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import {
  AsOfInput,
  DateRangeInput,
  StockValuationInput,
  ReportRequest,
  type AgingBuckets,
  type BalanceSheetLine,
  type BalanceSheetReport,
  type CustomerAgingReport,
  type CustomerAgingRow,
  type LeakageReport,
  type LeakageRow,
  type LeakageTotals,
  type PnlRow,
  type ProfitAndLossReport,
  type ProfitReport,
  type SalesSummaryReport,
  type StockValuationReport,
  type StockValuationRow,
  type SupplierAgingReport,
  type SupplierAgingRow,
  type TrialBalanceReport
} from '@shared/reports'
import type { ReportPayload } from '@shared/report-export'
import * as ledger from './ledger'
import * as settings from './settings'
import { outstandingCredit } from './sales'
import { balance as supplierBalance } from './supplier-ledger'

/**
 * THE REPORTS SERVICE — the payoff. Every screen so far existed so that THIS one could tell the truth.
 *
 * A REPORT READS. It never writes, and it never recomputes a frozen number (CLAUDE.md §4): a sale
 * line's net/tax/cost, a movement's `value_minor`, a journal line's debit/credit are read back exactly
 * as they were frozen. Nothing here re-prices, re-costs or re-taxes anything from today's settings.
 *
 * AND IT RECONCILES WITH THE BOOKS. The reconciliations are not a nice-to-have — they are what makes a
 * report worth trusting, and each is proven by a test after a realistic scenario:
 *
 *     stock valuation total  ===  GL Inventory
 *     customer aging total    ===  GL Receivable
 *     supplier aging total    ===  GL Payable
 *     trial balance                balances
 *     balance sheet                assets === liabilities + equity
 *     P&L net profit          ===  period net revenue − period expenses
 *
 * Transport-agnostic (CLAUDE.md §3): plain params in (dates as 'YYYY-MM-DD', validated in MAIN), plain
 * data out. No `electron`, no Result envelope, no HTML — the IPC layer wraps it, the printing/excel
 * layers render it.
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
 * THE DATE-RANGE CONVENTION, shared with sales.ts. A stored `at` is a full ISO timestamp; a report
 * bound is a DATE. `from` matches by `at >= from` (the date string sorts before any time on that day),
 * and `to` matches by `at < dayAfter(to)` so the WHOLE of the `to` day is inside the range — a sale at
 * 18:40 must not fall out of "today's" report. Getting this wrong drops a day's takings silently.
 */
function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString()
}

/** The last instant of a day, for a `<=` upTo bound (ledger.trialBalance takes a Date). */
function endOfDay(isoDate: string): Date {
  return new Date(`${isoDate}T23:59:59.999Z`)
}

/** The date part of a stored timestamp (or an already-bare date). 'YYYY-MM-DD'. */
function dateOnly(at: string): string {
  return at.slice(0, 10)
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Negative when `to` is before `from`. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / (24 * 60 * 60 * 1000))
}

function setting<T>(db: DB, key: string): T {
  return settings.get<T>(db, key, REGISTRY_DEFAULTS[key] as T)
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. SALES SUMMARY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * SALES SUMMARY over the COMPLETED sales in [from, to]. Voided, held and quoted rows are not sales and
 * are excluded. `netSales` is Σ subtotal_net — see the note in shared/reports.ts on why the cart
 * discount is NOT subtracted again (it is already apportioned into the lines).
 */
export function salesSummary(db: DB, raw: unknown): SalesSummaryReport {
  const { from, to } = parseOrThrow(DateRangeInput, raw, 'reports.salesSummary')
  const bounds = { from, toExclusive: dayAfter(to) }

  const header = db
    .prepare(
      `SELECT COUNT(*)                              AS count,
              COALESCE(SUM(grand_total), 0)         AS grossTotal,
              COALESCE(SUM(subtotal_net), 0)        AS netSales,
              COALESCE(SUM(cart_discount), 0)       AS cartDiscount,
              COALESCE(SUM(tax_total), 0)           AS totalTax
       FROM sales
       WHERE status = 'completed' AND at >= @from AND at < @toExclusive`
    )
    .get(bounds) as {
    count: number
    grossTotal: number
    netSales: number
    cartDiscount: number
    totalTax: number
  }

  // Line discounts live on sale_lines; the cart discount on the sale. The "nominal discount given" is
  // the sum of both, as the cashier keyed them.
  const lineDiscount = db
    .prepare(
      `SELECT COALESCE(SUM(sl.line_discount), 0)
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.status = 'completed' AND s.at >= @from AND s.at < @toExclusive`
    )
    .pluck()
    .get(bounds) as number

  const byTender = db
    .prepare(
      `SELECT l.id AS methodLookupId, l.label AS label, COALESCE(SUM(sp.amount), 0) AS amount
       FROM sale_payments sp
       JOIN sales s   ON s.id = sp.sale_id
       JOIN lookups l ON l.id = sp.method_lookup_id
       WHERE s.status = 'completed' AND s.at >= @from AND s.at < @toExclusive
       GROUP BY l.id, l.label
       ORDER BY amount DESC, l.label`
    )
    .all(bounds) as Array<{ methodLookupId: number; label: string; amount: number }>

  const byDay = db
    .prepare(
      `SELECT date(at) AS date, COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS gross
       FROM sales
       WHERE status = 'completed' AND at >= @from AND at < @toExclusive
       GROUP BY date(at)
       ORDER BY date(at)`
    )
    .all(bounds) as Array<{ date: string; count: number; gross: number }>

  return {
    from,
    to,
    count: header.count,
    grossTotal: header.grossTotal,
    netSales: header.netSales,
    totalDiscount: lineDiscount + header.cartDiscount,
    totalTax: header.totalTax,
    byTender,
    byDay
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. PROFIT (gross margin on the period's sales)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GROSS PROFIT on the period's completed sales.
 *
 *   revenue = Σ subtotal_net                    (ex-tax net revenue — the sale summary's netSales)
 *   cogs    = Σ |stock_movement.value_minor|    (the FROZEN cost the sale journals debited to COGS,
 *                                                read back, never a fresh multiply — migration 0006)
 *
 * COGS is summed from the SALE movements (type 'sale') of completed sales, so it is exactly what the
 * books recorded. A restocked return posts a 'sale_return' movement that credits COGS — that lives in
 * the P&L, not here; this is the gross margin on what was sold.
 */
export function profit(db: DB, raw: unknown): ProfitReport {
  const { from, to } = parseOrThrow(DateRangeInput, raw, 'reports.profit')
  const bounds = { from, toExclusive: dayAfter(to) }

  const revenue = db
    .prepare(
      `SELECT COALESCE(SUM(subtotal_net), 0)
       FROM sales
       WHERE status = 'completed' AND at >= @from AND at < @toExclusive`
    )
    .pluck()
    .get(bounds) as number

  const cogs = db.prepare(COGS_SQL).pluck().get(bounds) as number

  const revenueByDay = db
    .prepare(
      `SELECT date(at) AS date, COALESCE(SUM(subtotal_net), 0) AS revenue
       FROM sales
       WHERE status = 'completed' AND at >= @from AND at < @toExclusive
       GROUP BY date(at)`
    )
    .all(bounds) as Array<{ date: string; revenue: number }>

  const cogsByDay = db
    .prepare(
      `SELECT date(s.at) AS date, COALESCE(SUM(ABS(m.value_minor)), 0) AS cogs
       FROM stock_movements m
       JOIN sales s ON CAST(m.ref_id AS INTEGER) = s.id
       WHERE m.type = 'sale' AND m.ref_type = 'sale'
         AND s.status = 'completed' AND s.at >= @from AND s.at < @toExclusive
       GROUP BY date(s.at)`
    )
    .all(bounds) as Array<{ date: string; cogs: number }>

  const cogsMap = new Map(cogsByDay.map((row) => [row.date, row.cogs]))
  const revMap = new Map(revenueByDay.map((row) => [row.date, row.revenue]))
  const days = [...new Set([...revMap.keys(), ...cogsMap.keys()])].sort()

  const byDay = days.map((date) => {
    const dayRevenue = revMap.get(date) ?? 0
    const dayCogs = cogsMap.get(date) ?? 0
    return { date, revenue: dayRevenue, cogs: dayCogs, grossProfit: dayRevenue - dayCogs }
  })

  const grossProfit = revenue - cogs

  return {
    from,
    to,
    revenue,
    cogs,
    grossProfit,
    // Basis points, integer — a margin is the one true ratio, kept off the float path (3333 = 33.33%).
    marginBp: revenue > 0 ? Math.round((grossProfit * BASIS_POINTS) / revenue) : 0,
    byDay
  }
}

/** COGS = the frozen value of the SALE movements of completed sales in the period. Shared by total/day. */
const COGS_SQL = `
  SELECT COALESCE(SUM(ABS(m.value_minor)), 0)
  FROM stock_movements m
  JOIN sales s ON CAST(m.ref_id AS INTEGER) = s.id
  WHERE m.type = 'sale' AND m.ref_type = 'sale'
    AND s.status = 'completed' AND s.at >= @from AND s.at < @toExclusive
`

// ═════════════════════════════════════════════════════════════════════════════
// 3. STOCK VALUATION (as of now)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WHAT THE STOCK IS WORTH, RIGHT NOW. Per product: on-hand (SUM qty_m), the weighted cost, and the
 * value — SUM(stock_movements.value_minor), the very numbers the ledger posted. `totalValue` is the
 * sum across ALL movements, which is why it equals GL Inventory to the paisa (migration 0006).
 *
 * Rows include every inventory product that is active OR still carries a movement, so a product
 * deactivated with stock still on it is not silently dropped from the total. `now` is injectable for
 * deterministic near-expiry tests.
 */
export function stockValuation(db: DB, raw: unknown = {}, now = new Date()): StockValuationReport {
  const input = parseOrThrow(StockValuationInput, raw, 'reports.stockValuation')
  const nearExpiryDays = input.nearExpiryDays ?? setting<number>(db, 'stock.nearExpiryDays')

  const rows = (
    db
      .prepare(
        `SELECT p.id          AS productId,
                p.sku         AS sku,
                p.name        AS name,
                p.is_active   AS isActive,
                p.cost_price  AS avgCost,
                p.min_stock_m AS minStockM,
                (SELECT COALESCE(SUM(m.qty_m), 0)       FROM stock_movements m WHERE m.product_id = p.id) AS onHandM,
                (SELECT COALESCE(SUM(m.value_minor), 0) FROM stock_movements m WHERE m.product_id = p.id) AS valueMinor
         FROM products p
         WHERE p.item_type = 'inventory'
           AND (p.is_active = 1 OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id))
         ORDER BY p.name, p.id`
      )
      .all() as Array<{
      productId: number
      sku: string
      name: string
      isActive: number
      avgCost: number
      minStockM: number
      onHandM: number
      valueMinor: number
    }>
  ).map(
    (row): StockValuationRow => ({
      productId: row.productId,
      sku: row.sku,
      name: row.name,
      isActive: Boolean(row.isActive),
      onHandM: row.onHandM,
      avgCost: row.avgCost,
      valueMinor: row.valueMinor,
      minStockM: row.minStockM,
      isBelowReorder: row.onHandM <= row.minStockM
    })
  )

  // The total is summed over EVERY movement — not over the rows — so it equals GL Inventory even if the
  // row set ever excluded a movement's product. In normal operation the two are identical.
  const totalValue = db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number

  const cutoff = dateOnly(new Date(now.getTime() + nearExpiryDays * 24 * 60 * 60 * 1000).toISOString())
  const nearExpiryCount = db
    .prepare(
      `SELECT COUNT(*)
       FROM batches b
       WHERE b.expiry_date IS NOT NULL AND b.expiry_date <= @cutoff
         AND (SELECT COALESCE(SUM(m.qty_m), 0) FROM stock_movements m WHERE m.batch_id = b.id) > 0`
    )
    .pluck()
    .get({ cutoff }) as number

  return {
    rows,
    totalValue,
    lowStockCount: rows.filter((row) => row.isActive && row.isBelowReorder).length,
    nearExpiryCount,
    nearExpiryDays
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4 & 5. AGING — receivables and payables
// ═════════════════════════════════════════════════════════════════════════════

type Charge = { at: string; amount: number }

const EMPTY_BUCKETS: AgingBuckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }

/**
 * Distribute a party's UNPAID balance into age buckets.
 *
 * `charges` are the debits that raised the balance (opening balance, then each credit sale / purchase
 * on account), in any order. `credits` is the total that has since paid it down (payments + credit
 * notes). We apply the credits OLDEST-FIRST — the way a shop actually clears an account — and bucket
 * whatever is left by how old it is as of the report date.
 *
 * The credits total is derived as `Σ charges − balance`, where `balance` is the SAME figure the ledger
 * screen shows (outstandingCredit / supplier balance). That is what guarantees the buckets sum to the
 * balance exactly — and therefore that the report total cannot disagree with the general ledger. An
 * overpaid account (balance below zero) lands its surplus in `current`, honestly negative.
 */
function ageBuckets(charges: Charge[], balance: number, asOf: string): AgingBuckets {
  const buckets: AgingBuckets = { ...EMPTY_BUCKETS }
  const totalCharges = charges.reduce((sum, charge) => sum + charge.amount, 0)
  let remainingCredit = totalCharges - balance // = payments + credit notes, by construction

  const oldestFirst = [...charges].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  for (const charge of oldestFirst) {
    let unpaid = charge.amount
    if (remainingCredit > 0) {
      const applied = Math.min(remainingCredit, unpaid)
      unpaid -= applied
      remainingCredit -= applied
    }
    if (unpaid === 0) continue
    addToBucket(buckets, daysBetween(dateOnly(charge.at), asOf), unpaid)
  }

  // Credit left over = the account is in credit (they/we overpaid). Reflect it in `current`, so the
  // buckets still sum to the (negative) balance.
  if (remainingCredit > 0) buckets.current -= remainingCredit

  return buckets
}

function addToBucket(buckets: AgingBuckets, age: number, amount: number): void {
  if (age <= 0) buckets.current += amount
  else if (age <= 30) buckets.d1_30 += amount
  else if (age <= 60) buckets.d31_60 += amount
  else if (age <= 90) buckets.d61_90 += amount
  else buckets.d90plus += amount
}

function bucketsTotal(buckets: AgingBuckets): number {
  return buckets.current + buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90plus
}

function addBuckets(into: AgingBuckets & { total: number }, from: AgingBuckets & { total: number }): void {
  into.current += from.current
  into.d1_30 += from.d1_30
  into.d31_60 += from.d31_60
  into.d61_90 += from.d61_90
  into.d90plus += from.d90plus
  into.total += from.total
}

/**
 * CUSTOMER AGING as of a date. Per customer with a non-zero balance, what they owe bucketed by the age
 * of the unpaid amount. The per-customer total is `sales.outstandingCredit` — the exact figure the
 * customer-ledger screen shows — so `Σ totals === GL Receivable`.
 *
 * The go-live date carries the opening receivable; each completed credit sale carries its own date and
 * its CREDIT portion (the ex-cash part never touched the account). This is precisely the set
 * outstandingCredit sums, so the buckets reconcile with it customer by customer.
 */
export function customerAging(db: DB, raw: unknown): CustomerAgingReport {
  const { asOf } = parseOrThrow(AsOfInput, raw, 'reports.customerAging')

  const goLive = openingDate(db)

  // Every customer with any receivable activity — opening, a credit sale, a payment, or a return.
  const customerIds = db
    .prepare(
      `SELECT DISTINCT id FROM (
         SELECT customer_id AS id FROM opening_receivables
         UNION SELECT customer_id FROM sales WHERE status = 'completed' AND customer_id IS NOT NULL
         UNION SELECT customer_id FROM customer_payments
       ) WHERE id IS NOT NULL`
    )
    .pluck()
    .all() as number[]

  // Everything dated STRICTLY BEFORE this instant is "on or before asOf" — the same boundary the balance
  // sheet and trial balance use (accountActivity's `j.at < dayAfter(asOf)`). Bounding the aging the same
  // way is what makes `Σ aging === GL Receivable AS OF asOf`: a report backdated to a past month-end must
  // agree with the balance sheet for that month-end, not show today's balance aged against an old date.
  const bound = dayAfter(asOf)
  const openingCounts = dateOnly(goLive) <= asOf

  const openingCharge = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) FROM opening_receivables WHERE customer_id = ?'
  )
  // One row per completed credit sale UP TO asOf, carrying the credit-tender portion and its own date.
  const creditSales = db.prepare(
    `SELECT s.at AS at,
            (SELECT COALESCE(SUM(sp.amount), 0)
               FROM sale_payments sp JOIN lookups l ON l.id = sp.method_lookup_id
              WHERE sp.sale_id = s.id AND l.code = 'credit') AS amount
     FROM sales s
     WHERE s.customer_id = @customerId AND s.status = 'completed' AND s.at < @bound`
  )
  // What has paid the account down BY asOf: udhaar payments + returns credited to the account. Exactly
  // the credits outstandingCredit subtracts — but date-bounded, so the as-of balance is honest.
  const paymentsUpTo = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE customer_id = @customerId AND at < @bound'
  )
  const creditReturnsUpTo = db.prepare(
    `SELECT COALESCE(SUM(r.grand_total), 0)
       FROM returns r JOIN sales s ON s.id = r.sale_id
      WHERE s.customer_id = @customerId AND r.settlement IN ('customer_credit', 'exchange') AND r.at < @bound`
  )
  const nameOf = db.prepare('SELECT name FROM customers WHERE id = ?')

  const rows: CustomerAgingRow[] = []
  const totals: AgingBuckets & { total: number } = { ...EMPTY_BUCKETS, total: 0 }

  for (const customerId of customerIds) {
    const charges: Charge[] = []
    if (openingCounts) {
      const opening = openingCharge.pluck().get(customerId) as number
      if (opening > 0) charges.push({ at: goLive, amount: opening })
    }
    for (const sale of creditSales.all({ customerId, bound }) as Charge[]) {
      if (sale.amount > 0) charges.push({ at: sale.at, amount: sale.amount })
    }

    const totalCharges = charges.reduce((sum, charge) => sum + charge.amount, 0)
    const credits =
      (paymentsUpTo.pluck().get({ customerId, bound }) as number) +
      (creditReturnsUpTo.pluck().get({ customerId, bound }) as number)
    const balance = totalCharges - credits // what they owe AS OF asOf; === their GL receivable then
    if (balance === 0) continue

    const buckets = ageBuckets(charges, balance, asOf)
    const row: CustomerAgingRow = {
      customerId,
      name: (nameOf.pluck().get(customerId) as string | undefined) ?? `Customer #${customerId}`,
      total: balance,
      ...buckets
    }
    rows.push(row)
    addBuckets(totals, { ...buckets, total: balance })
  }

  // ANONYMOUS UDHAAR. When selling.requireCustomerForCredit is OFF, a credit sale can be rung with NO
  // customer — it still DR Receivable, so it MUST appear here or the aging stops reconciling with the GL
  // (Σ aging === GL Receivable). It cannot be paid down through customer_payments (those need a customer),
  // so it stays fully outstanding, aged by each sale's own date, shown as one line. (Reports audit.)
  const unassigned = (
    db
      .prepare(
        `SELECT s.at AS at,
                (SELECT COALESCE(SUM(sp.amount), 0)
                   FROM sale_payments sp JOIN lookups l ON l.id = sp.method_lookup_id
                  WHERE sp.sale_id = s.id AND l.code = 'credit') AS amount
           FROM sales s
          WHERE s.customer_id IS NULL AND s.status = 'completed' AND s.at < @bound`
      )
      .all({ bound }) as Charge[]
  ).filter((charge) => charge.amount > 0)
  if (unassigned.length > 0) {
    const balance = unassigned.reduce((sum, charge) => sum + charge.amount, 0)
    const buckets = ageBuckets(unassigned, balance, asOf) // no credits — anonymous udhaar cannot be repaid
    rows.push({ customerId: 0, name: 'Unassigned (walk-in credit)', total: balance, ...buckets })
    addBuckets(totals, { ...buckets, total: balance })
  }

  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return { asOf, rows, totals }
}

/**
 * SUPPLIER AGING as of a date. The mirror of customer aging: what the shop OWES each supplier, bucketed
 * by age. The per-supplier total is `supplier-ledger.balance`, so `Σ totals === GL Payable`.
 *
 * The go-live date carries the opening payable; each purchase that left something owing carries its own
 * date and its UNPAID remainder (grand_total − paid_total) — exactly what the supplier balance sums.
 *
 * Goods sent BACK on credit (purchase_returns settled 'supplier_credit') DEBIT Payable, so they are a
 * CREDIT here alongside payments — the shop owes that much less. Leave them out and this report chases a
 * distributor for stock they already took back. A 'refund' return came back as real money and never
 * touched Payable, so it is deliberately excluded. (CLAUDE.md trap #17 — same set `supplier-ledger`
 * subtracts, which is what keeps Σ aging === GL Payable.)
 */
export function supplierAging(db: DB, raw: unknown): SupplierAgingReport {
  const { asOf } = parseOrThrow(AsOfInput, raw, 'reports.supplierAging')

  const goLive = openingDate(db)

  // A supplier with a return needs no fourth source here: a return is reachable only from the purchase
  // it reverses (migration 0016), so its supplier is already in the purchases branch.
  const supplierIds = db
    .prepare(
      `SELECT DISTINCT id FROM (
         SELECT supplier_id AS id FROM opening_payables
         UNION SELECT supplier_id FROM purchases
         UNION SELECT supplier_id FROM supplier_payments
       ) WHERE id IS NOT NULL`
    )
    .pluck()
    .all() as number[]

  // Same asOf boundary as the balance sheet, so Σ supplier aging === GL Payable AS OF asOf (see the
  // matching note in customerAging).
  const bound = dayAfter(asOf)
  const openingCounts = dateOnly(goLive) <= asOf

  const openingCharge = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) FROM opening_payables WHERE supplier_id = ?'
  )
  // One row per purchase UP TO asOf that left something owing, carrying its unpaid remainder (frozen at
  // receipt: paid_total is the tenders paid then; later supplier_payments are the credits below).
  const owedPurchases = db.prepare(
    `SELECT at AS at, (grand_total - paid_total) AS amount
     FROM purchases
     WHERE supplier_id = @supplierId AND (grand_total - paid_total) > 0 AND at < @bound`
  )
  // What the shop has PAID this supplier by asOf, reducing the payable oldest-first.
  const paymentsUpTo = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_id = @supplierId AND at < @bound'
  )
  // Goods sent back ON CREDIT by asOf — a debit to Payable, so a credit here (see the note above). The
  // supplier comes from the return's PURCHASE, the only thing that says whose goods these were.
  const creditReturnsUpTo = db.prepare(
    `SELECT COALESCE(SUM(pr.grand_total), 0)
       FROM purchase_returns pr
       JOIN purchases p ON p.id = pr.purchase_id
      WHERE p.supplier_id = @supplierId AND pr.settlement = 'supplier_credit' AND pr.at < @bound`
  )
  const nameOf = db.prepare('SELECT name FROM suppliers WHERE id = ?')

  const rows: SupplierAgingRow[] = []
  const totals: AgingBuckets & { total: number } = { ...EMPTY_BUCKETS, total: 0 }

  for (const supplierId of supplierIds) {
    const charges: Charge[] = []
    if (openingCounts) {
      const opening = openingCharge.pluck().get(supplierId) as number
      if (opening > 0) charges.push({ at: goLive, amount: opening })
    }
    for (const purchase of owedPurchases.all({ supplierId, bound }) as Charge[]) {
      charges.push({ at: purchase.at, amount: purchase.amount })
    }

    const totalCharges = charges.reduce((sum, charge) => sum + charge.amount, 0)
    const credits =
      (paymentsUpTo.pluck().get({ supplierId, bound }) as number) +
      (creditReturnsUpTo.pluck().get({ supplierId, bound }) as number)
    const balance = totalCharges - credits // what the shop owes AS OF asOf; === GL payable then
    if (balance === 0) continue

    const buckets = ageBuckets(charges, balance, asOf)
    const row: SupplierAgingRow = {
      supplierId,
      name: (nameOf.pluck().get(supplierId) as string | undefined) ?? `Supplier #${supplierId}`,
      total: balance,
      ...buckets
    }
    rows.push(row)
    addBuckets(totals, { ...buckets, total: balance })
  }

  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return { asOf, rows, totals }
}

/** The accounting date opening balances are AS AT — what the opening receivables/payables are dated to. */
function openingDate(db: DB): string {
  const goLive = db
    .prepare('SELECT go_live_date FROM opening_setup WHERE id = 1')
    .pluck()
    .get() as string | undefined
  return goLive ?? '1970-01-01'
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. LEAKAGE — the anti-theft report, grouped by user
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WHO IS DOING THE THINGS A SHOP GETS ROBBED THROUGH — over-threshold discounts, voids, returns and
 * no-sale drawer pops — counted and valued per user over [from, to]. This is what the whole audit
 * trail exists to surface (CLAUDE.md §4).
 *
 * Each category is attributed to the USER WHO DID IT: the cashier who rang the discounted sale, the
 * user who voided, the user who processed the return, the user who popped the drawer. Names and roles
 * are resolved from the users table (an operational report shows who someone is now).
 */
export function leakage(db: DB, raw: unknown): LeakageReport {
  const { from, to } = parseOrThrow(DateRangeInput, raw, 'reports.leakage')
  const bounds = { from, toExclusive: dayAfter(to) }

  const acc = new Map<number, LeakageRow>()
  const rowFor = (userId: number): LeakageRow => {
    let row = acc.get(userId)
    if (!row) {
      row = {
        userId,
        name: '',
        role: '',
        overThresholdDiscountCount: 0,
        overThresholdDiscountValue: 0,
        voidCount: 0,
        voidValue: 0,
        returnCount: 0,
        returnValue: 0,
        noSaleCount: 0
      }
      acc.set(userId, row)
    }
    return row
  }

  // Over-threshold discounts — from the audit log. The value given is frozen in after_json.
  const discounts = db
    .prepare(
      `SELECT user_id AS userId, COUNT(*) AS count,
              COALESCE(SUM(json_extract(after_json, '$.discountGiven')), 0) AS value
       FROM audit_log
       WHERE action = 'sale.discount.over_threshold' AND user_id IS NOT NULL
         AND at >= @from AND at < @toExclusive
       GROUP BY user_id`
    )
    .all(bounds) as Array<{ userId: number; count: number; value: number }>
  for (const d of discounts) {
    const row = rowFor(d.userId)
    row.overThresholdDiscountCount = d.count
    row.overThresholdDiscountValue = d.value
  }

  // Voids — attributed to whoever cancelled the sale, valued at the voided grand_total.
  const voids = db
    .prepare(
      `SELECT voided_by AS userId, COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS value
       FROM sales
       WHERE status = 'voided' AND voided_by IS NOT NULL
         AND voided_at >= @from AND voided_at < @toExclusive
       GROUP BY voided_by`
    )
    .all(bounds) as Array<{ userId: number; count: number; value: number }>
  for (const v of voids) {
    const row = rowFor(v.userId)
    row.voidCount = v.count
    row.voidValue = v.value
  }

  // Returns / refunds — attributed to the user who processed them.
  const refunds = db
    .prepare(
      `SELECT user_id AS userId, COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS value
       FROM returns
       WHERE at >= @from AND at < @toExclusive
       GROUP BY user_id`
    )
    .all(bounds) as Array<{ userId: number; count: number; value: number }>
  for (const r of refunds) {
    const row = rowFor(r.userId)
    row.returnCount = r.count
    row.returnValue = r.value
  }

  // No-sale drawer pops — the classic vector. No money moves, so it is a count only.
  const noSales = db
    .prepare(
      `SELECT user_id AS userId, COUNT(*) AS count
       FROM cash_movements
       WHERE type = 'no_sale' AND at >= @from AND at < @toExclusive
       GROUP BY user_id`
    )
    .all(bounds) as Array<{ userId: number; count: number }>
  for (const n of noSales) {
    rowFor(n.userId).noSaleCount = n.count
  }

  // Resolve identities once, at the end.
  const identify = db.prepare('SELECT full_name AS name, role FROM users WHERE id = ?')
  for (const row of acc.values()) {
    const who = identify.get(row.userId) as { name: string; role: string } | undefined
    row.name = who?.name ?? `User #${row.userId}`
    row.role = who?.role ?? ''
  }

  const rows = [...acc.values()].sort(
    (a, b) =>
      b.voidValue + b.returnValue + b.overThresholdDiscountValue -
        (a.voidValue + a.returnValue + a.overThresholdDiscountValue) || a.name.localeCompare(b.name)
  )

  const totals: LeakageTotals = {
    overThresholdDiscountCount: 0,
    overThresholdDiscountValue: 0,
    voidCount: 0,
    voidValue: 0,
    returnCount: 0,
    returnValue: 0,
    noSaleCount: 0
  }
  for (const row of rows) {
    totals.overThresholdDiscountCount += row.overThresholdDiscountCount
    totals.overThresholdDiscountValue += row.overThresholdDiscountValue
    totals.voidCount += row.voidCount
    totals.voidValue += row.voidValue
    totals.returnCount += row.returnCount
    totals.returnValue += row.returnValue
    totals.noSaleCount += row.noSaleCount
  }

  return { from, to, rows, totals }
}

// ═════════════════════════════════════════════════════════════════════════════
// The financial statements — one primitive, three reports
// ═════════════════════════════════════════════════════════════════════════════

type AccountActivity = {
  code: string
  name: string
  type: AccountType
  isContra: boolean
  debit: number
  credit: number
}

/**
 * Every account with its total debit and credit over an optional date window — the primitive the P&L
 * (a period) and the balance sheet (up to a date) are both built from. A LEFT JOIN keeps zero-activity
 * accounts present, and the date filter sits INSIDE the join to the lines so an out-of-window line
 * contributes nothing (filtering in an outer WHERE would drop the whole account, or leak its lines).
 */
function accountActivity(db: DB, window: { from?: string; toExclusive?: string }): AccountActivity[] {
  const rows = db
    .prepare(
      `SELECT a.code AS code, a.name AS name, a.type AS type, a.is_contra AS isContra,
              COALESCE(SUM(l.debit), 0)  AS debit,
              COALESCE(SUM(l.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN (
         SELECT jl.account_id AS account_id, jl.debit AS debit, jl.credit AS credit
         FROM journal_lines jl
         JOIN journals j ON j.id = jl.journal_id
         WHERE (@from IS NULL OR j.at >= @from)
           AND (@toExclusive IS NULL OR j.at < @toExclusive)
       ) l ON l.account_id = a.id
       GROUP BY a.id
       ORDER BY a.code`
    )
    .all({ from: window.from ?? null, toExclusive: window.toExclusive ?? null }) as Array<{
    code: string
    name: string
    type: AccountType
    isContra: number
    debit: number
    credit: number
  }>

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    type: row.type,
    isContra: Boolean(row.isContra),
    debit: row.debit,
    credit: row.credit
  }))
}

/** The account's balance on its natural side (positive = more of what it is for). Same rule as ledger. */
function naturalBalance(row: AccountActivity): number {
  return ledger.isDebitNatured(row.type, row.isContra)
    ? row.debit - row.credit
    : row.credit - row.debit
}

/**
 * NET PROFIT over a window, from the journal: income (net of its contra accounts) minus expenses.
 *
 *   net revenue = Σ Sales(non-contra income) − Σ (Sales Returns + Discounts)(contra income)
 *   expenses    = Σ COGS + Stock Adjustments + expense accounts
 *   net profit  = net revenue − expenses
 *
 * Used directly by the P&L (a period) and folded into equity by the balance sheet (up to a date).
 */
function netProfitOver(activity: AccountActivity[]): { netRevenue: number; expenses: number; netProfit: number } {
  let netRevenue = 0
  let expenses = 0
  for (const row of activity) {
    const natural = naturalBalance(row)
    if (row.type === 'income') netRevenue += row.isContra ? -natural : natural
    else if (row.type === 'expense') expenses += natural
  }
  return { netRevenue, expenses, netProfit: netRevenue - expenses }
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. TRIAL BALANCE
// ═════════════════════════════════════════════════════════════════════════════

/** The trial balance as of a date. Reuses the posting engine's own trialBalance — it must balance. */
export function trialBalance(db: DB, raw: unknown): TrialBalanceReport {
  const { asOf } = parseOrThrow(AsOfInput, raw, 'reports.trialBalance')
  return { asOf, ...ledger.trialBalance(db, { upTo: endOfDay(asOf) }) }
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. PROFIT & LOSS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PROFIT & LOSS for [from, to], from the journal lines in the period grouped by account. Net profit
 * ties, by construction, to net revenue − expenses for the period — which is the reconciliation a test
 * proves against the sales and returns documents.
 */
export function profitAndLoss(db: DB, raw: unknown): ProfitAndLossReport {
  const { from, to } = parseOrThrow(DateRangeInput, raw, 'reports.profitAndLoss')
  const activity = accountActivity(db, { from, toExclusive: dayAfter(to) })

  const income: PnlRow[] = []
  const expenses: PnlRow[] = []

  for (const row of activity) {
    const natural = naturalBalance(row)
    if (row.type === 'income') {
      const amount = row.isContra ? -natural : natural
      if (amount !== 0) income.push({ code: row.code, name: row.name, amount })
    } else if (row.type === 'expense') {
      if (natural !== 0) expenses.push({ code: row.code, name: row.name, amount: natural })
    }
  }

  const { netRevenue, expenses: totalExpenses, netProfit } = netProfitOver(activity)

  return { from, to, income, netRevenue, expenses, totalExpenses, netProfit }
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. BALANCE SHEET
// ═════════════════════════════════════════════════════════════════════════════

/**
 * BALANCE SHEET as of a date. Assets = Liabilities + Equity, and it MUST balance — asserted by a test.
 *
 * It balances as ALGEBRA, not luck. The trial balance guarantees Σ(debit − credit) = 0 across every
 * account, which rearranges to exactly:
 *
 *     assets = liabilities + equity-accounts + (income − expenses)
 *
 * so the period-to-date net profit — the income and expense accounts, which are never auto-closed into
 * Retained Earnings in this app — is folded into equity as its own line. Nothing here can make it fail
 * to balance without the ledger itself being unbalanced.
 */
export function balanceSheet(db: DB, raw: unknown): BalanceSheetReport {
  const { asOf } = parseOrThrow(AsOfInput, raw, 'reports.balanceSheet')
  const activity = accountActivity(db, { toExclusive: dayAfter(asOf) })

  const assets: BalanceSheetLine[] = []
  const liabilities: BalanceSheetLine[] = []
  const equity: BalanceSheetLine[] = []
  let totalAssets = 0
  let totalLiabilities = 0
  let equityAccounts = 0

  for (const row of activity) {
    const natural = naturalBalance(row)
    if (row.type === 'asset') {
      totalAssets += natural
      if (natural !== 0) assets.push({ code: row.code, name: row.name, amount: natural })
    } else if (row.type === 'liability') {
      totalLiabilities += natural
      if (natural !== 0) liabilities.push({ code: row.code, name: row.name, amount: natural })
    } else if (row.type === 'equity') {
      equityAccounts += natural
      if (natural !== 0) equity.push({ code: row.code, name: row.name, amount: natural })
    }
  }

  const { netProfit } = netProfitOver(activity)
  // The undistributed earnings that keep the sheet balancing — always shown, even at zero, so the
  // reader can see the P&L result carried onto the balance sheet.
  equity.push({ code: 'NET_PROFIT', name: 'Net Profit (period to date)', amount: netProfit })
  const totalEquity = equityAccounts + netProfit

  return {
    asOf,
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    totalEquity,
    netProfit,
    balanced: totalAssets === totalLiabilities + totalEquity
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE DISPATCH — one request in, the TAGGED report out
// ═════════════════════════════════════════════════════════════════════════════

/**
 * RUN THE REPORT THE CALLER ASKED FOR, and TAG it with its kind.
 *
 * The nine reports above each return BARE data. The export writers (reports-excel / reports-pdf) must
 * know WHICH report they were handed, so the tag is attached HERE, in one exhaustive switch the compiler
 * checks — the `never` default proves every `ReportRequest` kind is covered, so adding a report without
 * teaching this function about it fails to compile. This is the ONE place a request becomes a report:
 * the IPC `get` / `exportExcel` / `exportPdf` handlers all route through it, so the screen, the
 * spreadsheet and the printout can never be built from three different dispatch tables and disagree.
 *
 * A READ, like everything else in this file. It writes nothing and recomputes no frozen number, and it
 * validates its own input (`parseOrThrow`) — so calling it directly, from a test or a future LAN server,
 * is safe without the IPC layer having pre-validated. `now` is injectable for deterministic near-expiry
 * tests, threaded through to stockValuation.
 */
export function buildReport(db: DB, raw: unknown, now = new Date()): ReportPayload {
  const request = parseOrThrow(ReportRequest, raw, 'reports.buildReport')

  switch (request.kind) {
    case 'salesSummary':
      return { kind: 'salesSummary', data: salesSummary(db, request) }
    case 'profit':
      return { kind: 'profit', data: profit(db, request) }
    case 'stockValuation':
      return { kind: 'stockValuation', data: stockValuation(db, request, now) }
    case 'customerAging':
      return { kind: 'customerAging', data: customerAging(db, request) }
    case 'supplierAging':
      return { kind: 'supplierAging', data: supplierAging(db, request) }
    case 'leakage':
      return { kind: 'leakage', data: leakage(db, request) }
    case 'trialBalance':
      return { kind: 'trialBalance', data: trialBalance(db, request) }
    case 'profitAndLoss':
      return { kind: 'profitAndLoss', data: profitAndLoss(db, request) }
    case 'balanceSheet':
      return { kind: 'balanceSheet', data: balanceSheet(db, request) }
    default: {
      const never: never = request
      throw new AppError(
        ErrorCode.VALIDATION,
        'That report is not available.',
        `reports.buildReport: unknown report kind ${JSON.stringify(never)}`
      )
    }
  }
}
