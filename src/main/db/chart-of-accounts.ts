import type { DB } from './index'

/**
 * THE CHART OF ACCOUNTS — a standard retail set, seeded so the owner never has to think about it.
 *
 * The cashier never sees these. The shopkeeper never sees these. They exist so that at any moment we
 * can produce a Trial Balance, a Profit & Loss and a Balance Sheet that genuinely add up — and hand
 * them to an accountant who will recognise them instantly.
 *
 * ACCOUNT CODES ARE THE CONTRACT. The posting engine refers to accounts BY CODE (`ACC.CASH`), never
 * by name and never by id, so the owner can rename "Cash in Hand" to whatever they like without the
 * engine losing its footing.
 */

/** The accounts the posting engine names directly. Renameable by the owner; never deletable. */
export const ACC = {
  CASH: '1000',
  BANK: '1010',
  RECEIVABLE: '1100', // customers who owe us — udhaar
  INVENTORY: '1200',
  INPUT_TAX: '1300', // sales tax we paid to suppliers (recoverable)

  PAYABLE: '2000', // suppliers we owe
  OUTPUT_TAX: '2100', // sales tax we collected and owe the government
  LOYALTY: '2200', // points owed back to customers — a real liability

  OWNER_EQUITY: '3000',
  OPENING_BALANCE_EQUITY: '3100', // the other side of day-one opening balances
  RETAINED_EARNINGS: '3200',

  SALES: '4000',
  SALES_RETURNS: '4100', // contra-income
  DISCOUNTS: '4200', // contra-income — what discounting REALLY costs, visible in one place

  COGS: '5000', // cost of goods sold
  STOCK_ADJUSTMENT: '5100', // shrinkage, damage, stock-take corrections
  EXPENSE_GENERAL: '5900'
} as const

type SeedAccount = {
  code: string
  name: string
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'
  system?: boolean
  /** Works backwards from its type: an income account that REDUCES income (see migration 0002). */
  contra?: boolean
}

const ACCOUNTS: SeedAccount[] = [
  // Assets — what the shop HAS
  { code: ACC.CASH, name: 'Cash in Hand', type: 'asset', system: true },
  { code: ACC.BANK, name: 'Bank Account', type: 'asset', system: true },
  { code: ACC.RECEIVABLE, name: 'Customer Receivables (Udhaar)', type: 'asset', system: true },
  { code: ACC.INVENTORY, name: 'Inventory (Stock)', type: 'asset', system: true },
  { code: ACC.INPUT_TAX, name: 'Input Tax (Recoverable)', type: 'asset', system: true },

  // Liabilities — what the shop OWES
  { code: ACC.PAYABLE, name: 'Supplier Payables', type: 'liability', system: true },
  { code: ACC.OUTPUT_TAX, name: 'Sales Tax Payable', type: 'liability', system: true },
  { code: ACC.LOYALTY, name: 'Loyalty Points Liability', type: 'liability', system: true },

  // Equity — what the shop is WORTH to its owner
  { code: ACC.OWNER_EQUITY, name: "Owner's Equity", type: 'equity', system: true },
  { code: ACC.OPENING_BALANCE_EQUITY, name: 'Opening Balance Equity', type: 'equity', system: true },
  { code: ACC.RETAINED_EARNINGS, name: 'Retained Earnings', type: 'equity', system: true },

  // Income. Returns and discounts are CONTRA-income: they are revenue we did not get, so they carry
  // a debit balance. Net revenue = Sales − Sales Returns − Discounts.
  { code: ACC.SALES, name: 'Sales', type: 'income', system: true },
  { code: ACC.SALES_RETURNS, name: 'Sales Returns', type: 'income', system: true, contra: true },
  { code: ACC.DISCOUNTS, name: 'Discounts Given', type: 'income', system: true, contra: true },

  // Expenses
  { code: ACC.COGS, name: 'Cost of Goods Sold', type: 'expense', system: true },
  { code: ACC.STOCK_ADJUSTMENT, name: 'Stock Adjustments & Damage', type: 'expense', system: true },
  { code: '5200', name: 'Rent', type: 'expense' },
  { code: '5210', name: 'Salaries & Wages', type: 'expense' },
  { code: '5220', name: 'Utilities (Bills)', type: 'expense' },
  { code: '5230', name: 'Transport', type: 'expense' },
  { code: '5240', name: 'Repairs & Maintenance', type: 'expense' },
  { code: ACC.EXPENSE_GENERAL, name: 'General Expenses', type: 'expense', system: true }
]

/** Idempotent. Only ever inserts what is missing — it can never undo an owner's rename. */
export function seedChartOfAccounts(db: DB, now = new Date()): void {
  const insert = db.prepare(
    `INSERT INTO accounts (code, name, type, is_contra, is_system, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (code) DO NOTHING`
  )

  const run = db.transaction(() => {
    for (const account of ACCOUNTS) {
      insert.run(
        account.code,
        account.name,
        account.type,
        account.contra ? 1 : 0,
        account.system ? 1 : 0,
        now.toISOString(),
        now.toISOString()
      )
    }
  })

  run()
}
