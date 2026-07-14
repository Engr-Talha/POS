export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export type Account = {
  id: number
  code: string
  name: string
  type: AccountType
  isSystem: boolean
  isActive: boolean
}

export type TrialBalanceRow = {
  code: string
  name: string
  type: AccountType
  debit: number
  credit: number
}

export type TrialBalance = {
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  /** If this is ever false, something wrote to the books without going through the posting engine. */
  balanced: boolean
}

/**
 * INVENTORY COSTING: WEIGHTED AVERAGE. (Owner's decision, Phase 2.)
 *
 * Every purchase re-averages an item's cost:
 *
 *   buy 10 @ Rs 100  ->  10 units, avg cost Rs 100
 *   buy 10 @ Rs 120  ->  20 units, avg cost Rs 110
 *   sell 5           ->  COGS = 5 x Rs 110, avg cost stays Rs 110
 *
 * WHY: the profit on an item shouldn't lurch about depending on which physical unit happened to be
 * sold. It is also what the legacy system's single "UNIT COST" field was already doing, so the
 * shop's mental model does not have to change.
 *
 * The average is held at 4-decimal precision (see shared/cost.ts) — Rs 2185 / 24 per piece is
 * 91.0417, and rounding that to the paisa on every purchase would bleed the profit report.
 */
export const COSTING_METHOD = 'weighted_average' as const

/** Default fiscal year start. Configurable in Settings — Pakistan's tax year runs 1 July–30 June. */
export const DEFAULT_FISCAL_YEAR_START_MONTH = 7
