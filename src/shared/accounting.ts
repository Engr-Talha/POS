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

  /**
   * Totals of the rows ABOVE — i.e. the sum of the debit column and of the credit column as they are
   * actually printed. These are what a report footer must show, or the Total line does not add up to
   * the numbers directly above it.
   */
  totalDebit: number
  totalCredit: number

  /**
   * Every debit and every credit ever posted, summed raw — NOT netted per account.
   *
   * These are the conventional trial-balance totals, and they show the true VOLUME of activity: a
   * shop that took Rs 100,000 in and paid Rs 30,000 out has gross totals of 130,000, while the
   * printed columns (net positions) only add to 100,000.
   *
   * Either pair detects an imbalance equally well — for every row,
   *     displayed.debit − displayed.credit === raw.debit − raw.credit
   * so summing gives (totalDebit − totalCredit) === (grossDebit − grossCredit), always. `balanced`
   * is computed from the gross pair because that is the conventional check, not because the netted
   * one is weaker.
   */
  grossDebit: number
  grossCredit: number

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
