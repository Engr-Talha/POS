import type {
  BalanceSheetReport,
  CashBookReport,
  CategoryWiseReport,
  CustomerAgingReport,
  GeneralLedgerReport,
  ItemWiseReport,
  LeakageReport,
  LowStockReport,
  NearExpiryReport,
  PaymentMethodBreakdownReport,
  ProfitAndLossReport,
  ProfitReport,
  SalesSummaryReport,
  StockValuationReport,
  SupplierAgingReport,
  TaxSummaryReport,
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
  | 'itemWise'
  | 'categoryWise'
  | 'paymentMethodBreakdown'
  | 'taxSummary'
  | 'lowStock'
  | 'nearExpiry'
  | 'cashBook'
  | 'generalLedger'

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
  | { kind: 'itemWise'; data: ItemWiseReport }
  | { kind: 'categoryWise'; data: CategoryWiseReport }
  | { kind: 'paymentMethodBreakdown'; data: PaymentMethodBreakdownReport }
  | { kind: 'taxSummary'; data: TaxSummaryReport }
  | { kind: 'lowStock'; data: LowStockReport }
  | { kind: 'nearExpiry'; data: NearExpiryReport }
  | { kind: 'cashBook'; data: CashBookReport }
  | { kind: 'generalLedger'; data: GeneralLedgerReport }

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
  balanceSheet: 'Balance Sheet',
  itemWise: 'Item-wise Sales',
  categoryWise: 'Category-wise Sales',
  paymentMethodBreakdown: 'Payment Methods',
  taxSummary: 'Tax Summary',
  lowStock: 'Low Stock (Re-order)',
  nearExpiry: 'Near Expiry',
  cashBook: 'Cash Book',
  generalLedger: 'General Ledger'
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
    case 'itemWise':
      return itemWiseView(payload.data)
    case 'categoryWise':
      return categoryWiseView(payload.data)
    case 'paymentMethodBreakdown':
      return paymentMethodBreakdownView(payload.data)
    case 'taxSummary':
      return taxSummaryView(payload.data)
    case 'lowStock':
      return lowStockView(payload.data)
    case 'nearExpiry':
      return nearExpiryView(payload.data)
    case 'cashBook':
      return cashBookView(payload.data)
    case 'generalLedger':
      return generalLedgerView(payload.data)
    default: {
      const never: never = payload
      throw new Error(`unknown report kind: ${JSON.stringify(never)}`)
    }
  }
}

/**
 * A PAGED report says so on its face. The export is of the PAGE the owner is looking at, while the
 * total row under it is the WHOLE period's — so the sheet must state which page this is, or a reader
 * finds rows that do not add up to the total beneath them and has no way to know why.
 */
function pageMeta(r: { rows: unknown[]; total: number; page: number; pageSize: number }): Meta {
  const first = r.total === 0 ? 0 : (r.page - 1) * r.pageSize + 1
  return {
    label: 'Rows',
    value:
      r.total <= r.rows.length && r.page === 1
        ? `${r.total}`
        : `${first}-${first + r.rows.length - 1} of ${r.total} (page ${r.page})`
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

/** Item-wise and category-wise print the same columns — they are the same money, cut two ways. */
const TRADE_COLUMNS = [
  col('Qty', RIGHT),
  col('Net', RIGHT),
  col('Tax', RIGHT),
  col('Gross', RIGHT),
  col('COGS', RIGHT),
  col('Gross profit', RIGHT),
  col('Margin', RIGHT)
]

function tradeTotalRow(t: {
  qtyM: number
  net: number
  tax: number
  gross: number
  cogs: number
  grossProfit: number
}): Row {
  return [
    text('Total'),
    text(''),
    qty(t.qtyM),
    money(t.net),
    money(t.tax),
    money(t.gross),
    money(t.cogs),
    money(t.grossProfit),
    text('')
  ]
}

function itemWiseView(r: ItemWiseReport): ReportView {
  return {
    title: REPORT_TITLES.itemWise,
    meta: [period(r.from, r.to), pageMeta(r)],
    sections: [
      {
        columns: [col('Code'), col('Item'), ...TRADE_COLUMNS],
        rows: r.rows.map((row) => [
          text(row.sku),
          text(row.name),
          qty(row.qtyM),
          money(row.net),
          money(row.tax),
          money(row.gross),
          money(row.cogs),
          money(row.grossProfit),
          percentBp(row.marginBp)
        ]),
        totalRow: tradeTotalRow(r.totals)
      }
    ]
  }
}

function categoryWiseView(r: CategoryWiseReport): ReportView {
  return {
    title: REPORT_TITLES.categoryWise,
    meta: [period(r.from, r.to), pageMeta(r)],
    sections: [
      {
        columns: [col('Category'), col(''), ...TRADE_COLUMNS],
        rows: r.rows.map((row) => [
          text(row.name),
          text(''),
          qty(row.qtyM),
          money(row.net),
          money(row.tax),
          money(row.gross),
          money(row.cogs),
          money(row.grossProfit),
          percentBp(row.marginBp)
        ]),
        totalRow: tradeTotalRow(r.totals)
      }
    ]
  }
}

function paymentMethodBreakdownView(r: PaymentMethodBreakdownReport): ReportView {
  return {
    title: REPORT_TITLES.paymentMethodBreakdown,
    meta: [period(r.from, r.to), pageMeta(r)],
    sections: [
      {
        columns: [
          col('Method'),
          col('Sales #', RIGHT),
          col('Tendered', RIGHT),
          col('Change', RIGHT),
          col('Refunds #', RIGHT),
          col('Refunded', RIGHT),
          col('Net', RIGHT),
          col('Share', RIGHT)
        ],
        rows: r.rows.map((row) => [
          text(row.label),
          count(row.count),
          money(row.tendered),
          money(row.changeGiven),
          count(row.refundCount),
          money(row.refunded),
          money(row.net),
          percentBp(row.shareBp)
        ]),
        totalRow: [
          text('Total'),
          count(r.totals.count),
          money(r.totals.tendered),
          money(r.totals.changeGiven),
          count(r.totals.refundCount),
          money(r.totals.refunded),
          money(r.totals.net),
          text('')
        ]
      }
    ]
  }
}

function taxSummaryView(r: TaxSummaryReport): ReportView {
  return {
    title: REPORT_TITLES.taxSummary,
    meta: [period(r.from, r.to)],
    sections: [
      {
        heading: 'Output tax on sales, by rate',
        columns: [col('Rate', RIGHT), col('Net base', RIGHT), col('Tax', RIGHT)],
        rows: r.byRate.map((row) => [percentBp(row.taxRateBp), money(row.netBase), money(row.taxAmount)]),
        totalRow: [
          text('Collected'),
          money(r.byRate.reduce((a, row) => a + row.netBase, 0)),
          money(r.taxCollected)
        ]
      },
      {
        heading: 'Position',
        columns: MEASURE,
        rows: [
          [text('Output tax collected'), money(r.taxCollected)],
          [text('Less returned / cancelled'), money(r.taxReversed)],
          [text('Output tax'), money(r.outputTax)],
          [text('Input tax paid on purchases'), money(r.inputTaxPaid)],
          [text('Less returned to suppliers'), money(r.inputTaxReversed)],
          [text('Input tax'), money(r.inputTax)]
        ],
        // Negative = the government owes the shop. Labelled, so nobody reads a refund as a bill.
        totalRow: [
          text(r.netPayable >= 0 ? 'Net payable to government' : 'Net refundable to shop'),
          money(r.netPayable)
        ]
      }
    ]
  }
}

function lowStockView(r: LowStockReport): ReportView {
  return {
    title: REPORT_TITLES.lowStock,
    meta: [pageMeta(r)],
    sections: [
      {
        columns: [
          col('Code'),
          col('Item'),
          col('On hand', RIGHT),
          col('Re-order at', RIGHT),
          col('Short by', RIGHT),
          col('Preferred supplier'),
          col('Their code')
        ],
        rows: r.rows.map((row) => [
          text(row.sku),
          text(row.name),
          qty(row.onHandM),
          qty(row.thresholdM),
          qty(row.shortfallM),
          text(row.preferredSupplierName ?? ''),
          text(row.supplierItemCode ?? '')
        ])
      }
    ]
  }
}

function nearExpiryView(r: NearExpiryReport): ReportView {
  return {
    title: REPORT_TITLES.nearExpiry,
    meta: [
      { label: 'Window', value: `${r.withinDays} days` },
      { label: 'Already expired', value: String(r.expiredCount) },
      pageMeta(r)
    ],
    sections: [
      {
        columns: [
          col('Code'),
          col('Item'),
          col('Batch'),
          col('Expires'),
          col('Days left', RIGHT),
          col('On hand', RIGHT),
          col('Value', RIGHT)
        ],
        rows: r.rows.map((row) => [
          text(row.sku),
          text(row.name),
          text(row.batchNo),
          text(row.expiryDate),
          count(row.daysRemaining),
          qty(row.onHandM),
          money(row.valueMinor)
        ]),
        totalRow: [
          text('Total at risk'),
          text(''),
          text(''),
          text(''),
          text(''),
          text(''),
          money(r.totalValueMinor)
        ]
      }
    ],
    note:
      r.expiredCount > 0
        ? `${r.expiredCount} batch(es) have ALREADY EXPIRED and may still be on the shelf.`
        : undefined
  }
}

function cashBookView(r: CashBookReport): ReportView {
  return {
    title: REPORT_TITLES.cashBook,
    meta: [period(r.from, r.to), pageMeta(r)],
    sections: [
      {
        columns: [
          col('Date'),
          col('Detail'),
          col('In', RIGHT),
          col('Out', RIGHT),
          col('Balance', RIGHT)
        ],
        rows: [
          [text(r.from), text('Opening balance'), text(''), text(''), money(r.opening)],
          ...r.rows.map((row): Row => [
            text(row.at.slice(0, 10)),
            text(row.memo),
            money(row.inMinor),
            money(row.outMinor),
            money(row.balanceMinor)
          ])
        ],
        totalRow: [text('Closing'), text(''), money(r.totalIn), money(r.totalOut), money(r.closing)]
      }
    ]
  }
}

function generalLedgerView(r: GeneralLedgerReport): ReportView {
  return {
    title: REPORT_TITLES.generalLedger,
    meta: [
      { label: 'Account', value: `${r.accountCode} — ${r.accountName}` },
      period(r.from, r.to),
      pageMeta(r)
    ],
    sections: [
      {
        columns: [
          col('Date'),
          col('Detail'),
          col('Debit', RIGHT),
          col('Credit', RIGHT),
          col('Balance', RIGHT)
        ],
        rows: [
          [text(r.from), text('Opening balance'), text(''), text(''), money(r.opening)],
          ...r.rows.map((row): Row => [
            text(row.at.slice(0, 10)),
            text(row.memo),
            money(row.debit),
            money(row.credit),
            money(row.balanceMinor)
          ])
        ],
        totalRow: [
          text('Closing'),
          text(''),
          money(r.totalDebit),
          money(r.totalCredit),
          money(r.closing)
        ]
      }
    ]
  }
}
