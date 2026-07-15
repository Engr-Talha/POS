import type { ReportPayload } from '@shared/report-export'

/**
 * SAMPLE REPORTS for the export tests — one of every kind, with DISTINCTIVE, INTERNALLY CONSISTENT
 * numbers so a test can assert an exact figure without it colliding with an unrelated cell.
 *
 * These are plain data literals on purpose: the Excel and PDF writers are pure functions of a report,
 * so a hand-built report exercises them exactly as a real one from services/reports.ts would (the
 * `ReportPayload` type is the same contract), without standing up a database and a day of sales just
 * to format it. The reconciliations (aging buckets summing to the total, a balanced sheet) are
 * honoured here too, so the samples read like something a real shop would produce.
 *
 * The values deliberately include the ones precision is easy to lose on:
 *   6169.83  a non-round total          91.0417  a 4-dp cost          1.234  a 3-dp weighed quantity
 */

export const SHOP_NAME = 'Insha Kiryana Store'

const salesSummary: ReportPayload = {
  kind: 'salesSummary',
  data: {
    from: '2026-07-01',
    to: '2026-07-31',
    count: 42,
    grossTotal: 616_983, // 6,169.83
    netSales: 527_336, // 5,273.36
    totalDiscount: 15_000, // 150.00
    totalTax: 74_647, // 746.47
    byTender: [
      { methodLookupId: 1, label: 'Cash', amount: 401_983 }, // 4,019.83
      { methodLookupId: 2, label: 'Card', amount: 215_000 } // 2,150.00
    ],
    byDay: [
      { date: '2026-07-14', count: 20, gross: 300_000 },
      { date: '2026-07-15', count: 22, gross: 316_983 }
    ]
  }
}

const profit: ReportPayload = {
  kind: 'profit',
  data: {
    from: '2026-07-01',
    to: '2026-07-31',
    revenue: 527_336, // 5,273.36
    cogs: 334_561, // 3,345.61
    grossProfit: 192_775, // 1,927.75
    marginBp: 3655, // 36.55%
    byDay: [
      { date: '2026-07-14', revenue: 250_000, cogs: 160_000, grossProfit: 90_000 },
      { date: '2026-07-15', revenue: 277_336, cogs: 174_561, grossProfit: 102_775 }
    ]
  }
}

const stockValuation: ReportPayload = {
  kind: 'stockValuation',
  data: {
    rows: [
      {
        productId: 1,
        sku: 'SUGAR-1KG',
        name: 'Sugar 1kg',
        isActive: true,
        onHandM: 60_000, // 60 pieces
        avgCost: 910_417, // 91.0417  (4-dp cost)
        valueMinor: 546_250, // 5,462.50
        minStockM: 10_000,
        isBelowReorder: false
      },
      {
        productId: 2,
        sku: 'RICE-BULK',
        name: 'Basmati Rice (loose)',
        isActive: true,
        onHandM: 1234, // 1.234 kg  (3-dp weighed quantity)
        avgCost: 250_000, // 25.0000
        valueMinor: 30_850, // 308.50
        minStockM: 5000,
        isBelowReorder: true
      }
    ],
    totalValue: 577_100, // 5,771.00
    lowStockCount: 1,
    nearExpiryCount: 0,
    nearExpiryDays: 30
  }
}

const customerAging: ReportPayload = {
  kind: 'customerAging',
  data: {
    asOf: '2026-07-15',
    rows: [
      { customerId: 1, name: 'Ali Traders', current: 10_000, d1_30: 15_000, d31_60: 0, d61_90: 0, d90plus: 0, total: 25_000 },
      { customerId: 2, name: 'Zara Store', current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 50_000, total: 50_000 }
    ],
    totals: { current: 10_000, d1_30: 15_000, d31_60: 0, d61_90: 0, d90plus: 50_000, total: 75_000 } // 750.00
  }
}

const supplierAging: ReportPayload = {
  kind: 'supplierAging',
  data: {
    asOf: '2026-07-15',
    rows: [
      { supplierId: 1, name: 'Acme Distributors', current: 10_000, d1_30: 0, d31_60: 25_000, d61_90: 0, d90plus: 0, total: 35_000 }
    ],
    totals: { current: 10_000, d1_30: 0, d31_60: 25_000, d61_90: 0, d90plus: 0, total: 35_000 } // 350.00
  }
}

const leakage: ReportPayload = {
  kind: 'leakage',
  data: {
    from: '2026-07-01',
    to: '2026-07-31',
    rows: [
      {
        userId: 1,
        name: 'Bilal Cashier',
        role: 'cashier',
        overThresholdDiscountCount: 1,
        overThresholdDiscountValue: 3000, // 30.00
        voidCount: 0,
        voidValue: 0,
        returnCount: 0,
        returnValue: 0,
        noSaleCount: 2
      },
      {
        userId: 2,
        name: 'Rashid Supervisor',
        role: 'supervisor',
        overThresholdDiscountCount: 0,
        overThresholdDiscountValue: 0,
        voidCount: 1,
        voidValue: 20_000, // 200.00
        returnCount: 1,
        returnValue: 20_000, // 200.00
        noSaleCount: 0
      }
    ],
    totals: {
      overThresholdDiscountCount: 1,
      overThresholdDiscountValue: 3000,
      voidCount: 1,
      voidValue: 20_000,
      returnCount: 1,
      returnValue: 20_000,
      noSaleCount: 2
    }
  }
}

const trialBalance: ReportPayload = {
  kind: 'trialBalance',
  data: {
    asOf: '2026-07-15',
    rows: [
      { code: '1000', name: 'Cash', type: 'asset', debit: 979_083, credit: 0 },
      { code: '1200', name: 'Inventory', type: 'asset', debit: 0, credit: 334_561 },
      { code: '4000', name: 'Sales', type: 'income', debit: 0, credit: 527_336 },
      { code: '5000', name: 'Cost of Goods Sold', type: 'expense', debit: 334_561, credit: 0 },
      { code: '3000', name: "Owner's Equity", type: 'equity', debit: 0, credit: 451_747 }
    ],
    totalDebit: 1_313_644, // 13,136.44
    totalCredit: 1_313_644,
    grossDebit: 1_313_644,
    grossCredit: 1_313_644,
    balanced: true
  }
}

const profitAndLoss: ReportPayload = {
  kind: 'profitAndLoss',
  data: {
    from: '2026-07-01',
    to: '2026-07-31',
    income: [
      { code: '4000', name: 'Sales', amount: 540_000 },
      { code: '4100', name: 'Sales Returns', amount: -12_664 }
    ],
    netRevenue: 527_336, // 5,273.36
    expenses: [
      { code: '5000', name: 'Cost of Goods Sold', amount: 334_561 },
      { code: '6000', name: 'Rent', amount: 50_000 }
    ],
    totalExpenses: 384_561,
    netProfit: 142_775 // 1,427.75
  }
}

const balanceSheet: ReportPayload = {
  kind: 'balanceSheet',
  data: {
    asOf: '2026-07-15',
    assets: [
      { code: '1000', name: 'Cash', amount: 401_983 },
      { code: '1200', name: 'Inventory', amount: 577_100 },
      { code: '1100', name: 'Accounts Receivable', amount: 75_000 }
    ],
    totalAssets: 1_054_083, // 10,540.83
    liabilities: [{ code: '2000', name: 'Accounts Payable', amount: 35_000 }],
    totalLiabilities: 35_000,
    equity: [
      { code: '3000', name: "Owner's Equity", amount: 876_308 },
      { code: 'NET_PROFIT', name: 'Net Profit (period to date)', amount: 142_775 }
    ],
    totalEquity: 1_019_083,
    netProfit: 142_775,
    balanced: true
  }
}

/** One of every report kind, in the order they appear in the app. */
export const SAMPLE_PAYLOADS: ReportPayload[] = [
  salesSummary,
  profit,
  stockValuation,
  customerAging,
  supplierAging,
  leakage,
  trialBalance,
  profitAndLoss,
  balanceSheet
]
