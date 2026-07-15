import type {
  BalanceSheetReport,
  CustomerAgingReport,
  LeakageReport,
  ProfitAndLossReport,
  ProfitReport,
  SalesSummaryReport,
  StockValuationReport,
  SupplierAgingReport,
  TrialBalanceReport
} from './reports'

/**
 * THE REPORT-EXPORT CONTRACT — the one thing the Excel writer and the PDF writer both read.
 *
 * A report is DATA (services/reports.ts computes it). Excel and PDF are two ways to LOOK at the same
 * data, and the shopkeeper must never be able to open the two and find them disagreeing. So neither
 * renderer is allowed to decide, on its own, which columns a report has, which rows, or which line is
 * the total — that would be two chances to get it wrong. Instead this file turns a report into ONE
 * neutral `ReportView` (title, params, sections of typed cells), and each renderer only formats it.
 *
 * ── PRECISION LIVES IN THE INTEGER, AND ONLY IN THE INTEGER (CLAUDE.md §4) ────────────────────────
 *
 * A `Cell` never carries a formatted string for a number. It carries the RAW INTEGER and its SCALE:
 *
 *     money   — integer minor units (paisa),  2 dp
 *     cost    — integer ten-thousandths,      4 dp
 *     qty     — integer thousandths,          3 dp
 *     percent — basis points (3333 = 33.33%)
 *     int     — a plain count
 *
 * The Excel writer turns that integer into a REAL number (`raw / scale`) and hands Excel a number
 * format, so the owner can sum the column himself. The PDF writer turns the SAME integer into a
 * string through the app's one money/cost/qty formatter. Both start from the integer; neither rounds
 * it. A float can never enter here — `cellValue` in the writers asserts the raw is an integer, loudly,
 * the way `formatMoney` does, because a float in a money column is the exact bug this app was built to
 * make impossible.
 */

export type ReportKind =
  | 'salesSummary'
  | 'profit'
  | 'stockValuation'
  | 'customerAging'
  | 'supplierAging'
  | 'leakage'
  | 'trialBalance'
  | 'profitAndLoss'
  | 'balanceSheet'

/**
 * A report and the tag that says which one it is. The reports service returns bare data with no
 * discriminant, so the caller (the IPC layer) tags it here — one obvious place, checked by the
 * compiler — instead of either writer trying to guess a report's shape at runtime.
 */
export type ReportPayload =
  | { kind: 'salesSummary'; data: SalesSummaryReport }
  | { kind: 'profit'; data: ProfitReport }
  | { kind: 'stockValuation'; data: StockValuationReport }
  | { kind: 'customerAging'; data: CustomerAgingReport }
  | { kind: 'supplierAging'; data: SupplierAgingReport }
  | { kind: 'leakage'; data: LeakageReport }
  | { kind: 'trialBalance'; data: TrialBalanceReport }
  | { kind: 'profitAndLoss'; data: ProfitAndLossReport }
  | { kind: 'balanceSheet'; data: BalanceSheetReport }

/** The human title of each report — the sheet name, the PDF heading. Data-driven, one source. */
export const REPORT_TITLES: Record<ReportKind, string> = {
  salesSummary: 'Sales Summary',
  profit: 'Profit (Gross Margin)',
  stockValuation: 'Stock Valuation',
  customerAging: 'Customer Aging (Receivables)',
  supplierAging: 'Supplier Aging (Payables)',
  leakage: 'Leakage',
  trialBalance: 'Trial Balance',
  profitAndLoss: 'Profit & Loss',
  balanceSheet: 'Balance Sheet'
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE NEUTRAL VIEW — what both renderers consume
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** How a number is scaled back to a real value. `text` is a plain label, aligned left. */
export type CellKind = 'text' | 'money' | 'cost' | 'qty' | 'percent' | 'int'

/**
 * One cell. A text cell carries its string; a numeric cell carries the RAW INTEGER — never a rounded
 * or pre-formatted value. The scale in `kind` is what the writer uses to display it.
 */
export type Cell =
  | { kind: 'text'; text: string }
  | { kind: 'money' | 'cost' | 'qty' | 'percent' | 'int'; raw: number }

export type Align = 'left' | 'right'
export type Column = { header: string; align: Align }
export type Row = Cell[]

/** A titled block of rows: a header, the rows, and optionally a bold TOTAL line under them. */
export type Section = {
  heading?: string
  columns: Column[]
  rows: Row[]
  totalRow?: Row
}

/** A `label: value` line under the title — the report's parameters (period, as-of, status). */
export type Meta = { label: string; value: string }

export type ReportView = {
  title: string
  meta: Meta[]
  sections: Section[]
  /** A loud warning line (e.g. a trial balance that does not balance). Absent when all is well. */
  note?: string
}

// ── Cell constructors — the only way a number gets in, always as its raw integer ────────────────

const text = (value: string): Cell => ({ kind: 'text', text: value })
const money = (raw: number): Cell => ({ kind: 'money', raw })
const cost = (raw: number): Cell => ({ kind: 'cost', raw })
const qty = (raw: number): Cell => ({ kind: 'qty', raw })
const percentBp = (raw: number): Cell => ({ kind: 'percent', raw })
const count = (raw: number): Cell => ({ kind: 'int', raw })

const LEFT: Align = 'left'
const RIGHT: Align = 'right'
const col = (header: string, align: Align = LEFT): Column => ({ header, align })

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BUILD
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Turn a tagged report into the neutral view. Pure: no clock, no DB, no formatting — just which
 * integer goes in which typed cell. Exhaustive over `ReportKind` (the `never` default proves it),
 * so adding a report to the union without teaching this function about it fails to compile.
 */
export function buildReportView(payload: ReportPayload): ReportView {
  switch (payload.kind) {
    case 'salesSummary':
      return salesSummaryView(payload.data)
    case 'profit':
      return profitView(payload.data)
    case 'stockValuation':
      return stockValuationView(payload.data)
    case 'customerAging':
      return customerAgingView(payload.data)
    case 'supplierAging':
      return supplierAgingView(payload.data)
    case 'leakage':
      return leakageView(payload.data)
    case 'trialBalance':
      return trialBalanceView(payload.data)
    case 'profitAndLoss':
      return profitAndLossView(payload.data)
    case 'balanceSheet':
      return balanceSheetView(payload.data)
    default: {
      const never: never = payload
      throw new Error(`unknown report kind: ${JSON.stringify(never)}`)
    }
  }
}

function period(from: string, to: string): Meta {
  return { label: 'Period', value: `${from} to ${to}` }
}

function asAt(date: string): Meta {
  return { label: 'As at', value: date }
}

const MEASURE = [col('Measure'), col('Value', RIGHT)]

function salesSummaryView(r: SalesSummaryReport): ReportView {
  return {
    title: REPORT_TITLES.salesSummary,
    meta: [period(r.from, r.to)],
    sections: [
      {
        heading: 'Summary',
        columns: MEASURE,
        rows: [
          [text('Sales'), count(r.count)],
          [text('Gross total'), money(r.grossTotal)],
          [text('Net sales (ex-tax)'), money(r.netSales)],
          [text('Discounts given'), money(r.totalDiscount)],
          [text('Tax collected'), money(r.totalTax)]
        ]
      },
      {
        heading: 'By payment method',
        columns: [col('Method'), col('Amount', RIGHT)],
        rows: r.byTender.map((row) => [text(row.label), money(row.amount)]),
        totalRow: [text('Total'), money(sum(r.byTender.map((row) => row.amount)))]
      },
      {
        heading: 'By day',
        columns: [col('Date'), col('Sales', RIGHT), col('Gross', RIGHT)],
        rows: r.byDay.map((row) => [text(row.date), count(row.count), money(row.gross)]),
        totalRow: [text('Total'), count(r.count), money(r.grossTotal)]
      }
    ]
  }
}

function profitView(r: ProfitReport): ReportView {
  return {
    title: REPORT_TITLES.profit,
    meta: [period(r.from, r.to)],
    sections: [
      {
        heading: 'Summary',
        columns: MEASURE,
        rows: [
          [text('Net revenue'), money(r.revenue)],
          [text('Cost of goods sold'), money(r.cogs)],
          [text('Gross profit'), money(r.grossProfit)],
          [text('Gross margin'), percentBp(r.marginBp)]
        ]
      },
      {
        heading: 'By day',
        columns: [col('Date'), col('Revenue', RIGHT), col('COGS', RIGHT), col('Gross profit', RIGHT)],
        rows: r.byDay.map((row) => [
          text(row.date),
          money(row.revenue),
          money(row.cogs),
          money(row.grossProfit)
        ]),
        totalRow: [text('Total'), money(r.revenue), money(r.cogs), money(r.grossProfit)]
      }
    ]
  }
}

function stockValuationView(r: StockValuationReport): ReportView {
  return {
    title: REPORT_TITLES.stockValuation,
    meta: [
      { label: 'Near-expiry window', value: `${r.nearExpiryDays} days` },
      { label: 'Items low on stock', value: String(r.lowStockCount) },
      { label: 'Near-expiry batches', value: String(r.nearExpiryCount) }
    ],
    sections: [
      {
        columns: [
          col('Code'),
          col('Item'),
          col('Active'),
          col('On hand', RIGHT),
          col('Avg cost', RIGHT),
          col('Value', RIGHT),
          col('Re-order')
        ],
        rows: r.rows.map((row) => [
          text(row.sku),
          text(row.name),
          text(row.isActive ? 'Yes' : 'No'),
          qty(row.onHandM),
          cost(row.avgCost),
          money(row.valueMinor),
          text(row.isBelowReorder ? 'Below' : '')
        ]),
        totalRow: [
          text('Total'),
          text(''),
          text(''),
          text(''),
          text(''),
          money(r.totalValue),
          text('')
        ]
      }
    ]
  }
}

function agingView(
  title: string,
  asOf: string,
  partyHeader: string,
  rows: Array<{
    name: string
    current: number
    d1_30: number
    d31_60: number
    d61_90: number
    d90plus: number
    total: number
  }>,
  totals: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; total: number }
): ReportView {
  const columns = [
    col(partyHeader),
    col('Current', RIGHT),
    col('1-30', RIGHT),
    col('31-60', RIGHT),
    col('61-90', RIGHT),
    col('90+', RIGHT),
    col('Total', RIGHT)
  ]
  return {
    title,
    meta: [asAt(asOf)],
    sections: [
      {
        columns,
        rows: rows.map((row) => [
          text(row.name),
          money(row.current),
          money(row.d1_30),
          money(row.d31_60),
          money(row.d61_90),
          money(row.d90plus),
          money(row.total)
        ]),
        totalRow: [
          text('Total'),
          money(totals.current),
          money(totals.d1_30),
          money(totals.d31_60),
          money(totals.d61_90),
          money(totals.d90plus),
          money(totals.total)
        ]
      }
    ]
  }
}

function customerAgingView(r: CustomerAgingReport): ReportView {
  return agingView(REPORT_TITLES.customerAging, r.asOf, 'Customer', r.rows, r.totals)
}

function supplierAgingView(r: SupplierAgingReport): ReportView {
  return agingView(REPORT_TITLES.supplierAging, r.asOf, 'Supplier', r.rows, r.totals)
}

function leakageView(r: LeakageReport): ReportView {
  const columns = [
    col('User'),
    col('Role'),
    col('Over-disc #', RIGHT),
    col('Over-disc value', RIGHT),
    col('Voids #', RIGHT),
    col('Void value', RIGHT),
    col('Returns #', RIGHT),
    col('Return value', RIGHT),
    col('No-sale #', RIGHT)
  ]
  return {
    title: REPORT_TITLES.leakage,
    meta: [period(r.from, r.to)],
    sections: [
      {
        columns,
        rows: r.rows.map((row) => [
          text(row.name),
          text(row.role),
          count(row.overThresholdDiscountCount),
          money(row.overThresholdDiscountValue),
          count(row.voidCount),
          money(row.voidValue),
          count(row.returnCount),
          money(row.returnValue),
          count(row.noSaleCount)
        ]),
        totalRow: [
          text('Total'),
          text(''),
          count(r.totals.overThresholdDiscountCount),
          money(r.totals.overThresholdDiscountValue),
          count(r.totals.voidCount),
          money(r.totals.voidValue),
          count(r.totals.returnCount),
          money(r.totals.returnValue),
          count(r.totals.noSaleCount)
        ]
      }
    ]
  }
}

function trialBalanceView(r: TrialBalanceReport): ReportView {
  return {
    title: REPORT_TITLES.trialBalance,
    meta: [asAt(r.asOf), { label: 'Status', value: r.balanced ? 'Balanced' : 'NOT BALANCED' }],
    sections: [
      {
        columns: [col('Code'), col('Account'), col('Debit', RIGHT), col('Credit', RIGHT)],
        rows: r.rows.map((row) => [
          text(row.code),
          text(row.name),
          money(row.debit),
          money(row.credit)
        ]),
        totalRow: [text('Total'), text(''), money(r.totalDebit), money(r.totalCredit)]
      }
    ],
    note: r.balanced ? undefined : 'WARNING: the trial balance does not balance.'
  }
}

function profitAndLossView(r: ProfitAndLossReport): ReportView {
  const accountColumns = [col('Code'), col('Account'), col('Amount', RIGHT)]
  return {
    title: REPORT_TITLES.profitAndLoss,
    meta: [period(r.from, r.to)],
    sections: [
      {
        heading: 'Income',
        columns: accountColumns,
        rows: r.income.map((row) => [text(row.code), text(row.name), money(row.amount)]),
        totalRow: [text(''), text('Net revenue'), money(r.netRevenue)]
      },
      {
        heading: 'Expenses',
        columns: accountColumns,
        rows: r.expenses.map((row) => [text(row.code), text(row.name), money(row.amount)]),
        totalRow: [text(''), text('Total expenses'), money(r.totalExpenses)]
      },
      {
        heading: 'Result',
        columns: MEASURE,
        rows: [],
        totalRow: [text('Net profit'), money(r.netProfit)]
      }
    ]
  }
}

function balanceSheetView(r: BalanceSheetReport): ReportView {
  const accountColumns = [col('Code'), col('Account'), col('Amount', RIGHT)]
  const sectionOf = (heading: string, lines: Array<{ code: string; name: string; amount: number }>, totalLabel: string, total: number): Section => ({
    heading,
    columns: accountColumns,
    rows: lines.map((row) => [text(row.code), text(row.name), money(row.amount)]),
    totalRow: [text(''), text(totalLabel), money(total)]
  })
  return {
    title: REPORT_TITLES.balanceSheet,
    meta: [asAt(r.asOf), { label: 'Status', value: r.balanced ? 'Balanced' : 'NOT BALANCED' }],
    sections: [
      sectionOf('Assets', r.assets, 'Total assets', r.totalAssets),
      sectionOf('Liabilities', r.liabilities, 'Total liabilities', r.totalLiabilities),
      sectionOf('Equity', r.equity, 'Total equity', r.totalEquity)
    ],
    note: r.balanced ? undefined : 'WARNING: the balance sheet does not balance.'
  }
}
