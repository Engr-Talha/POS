/**
 * COST IS AN INTEGER TOO — but at FOUR decimal places, not two. (Owner decision, Phase 3.)
 *
 * PRICES (retail, wholesale, totals, tax, payments) are 2 dp — that is money the customer sees.
 * COST is an INTERNAL number and is stored at 4 dp: integer TEN-THOUSANDTHS of the major unit.
 *
 *   Rs 2185.0000  ->  21_850_000
 *
 * WHY 4 dp: a carton of 24 bought for Rs 2185 costs 2185 / 24 = Rs 91.041666… per piece. Forced to
 * 2 dp that is 91.04, and 0.0017 lost on every piece, across a year of sales, quietly falsifies the
 * profit and COGS reports. The customer never sees cost, so the extra precision is free at the
 * counter and honest in the books.
 *
 * This is a DIFFERENT type from money-minor-units on purpose. Do NOT pass a cost value to
 * formatMoney(), and do NOT pass a price to formatCost() — they have different scales. Convert
 * explicitly with costToPriceMinor().
 */
import { MINOR_UNITS_PER_MAJOR } from './money'

export const COST_UNITS_PER_MAJOR = 10_000

/** 4-dp cost integer per 2-dp money-minor unit. 10000 / 100 = 100. */
const COST_PER_MINOR = COST_UNITS_PER_MAJOR / MINOR_UNITS_PER_MAJOR

/** Parse cost input ("2185", "91.0417", "2,185.00") into integer ten-thousandths. Null if invalid. */
export function parseCost(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '')
  if (cleaned === '') return null
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return null

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [whole = '', fraction = ''] = unsigned.split('.')
  if (whole === '' && fraction === '') return null
  if (fraction.length > 4) return null // 4 dp is the limit; more is a typo

  const cost = Number(whole || '0') * COST_UNITS_PER_MAJOR + Number(fraction.padEnd(4, '0'))
  if (!Number.isSafeInteger(cost)) return null
  return negative ? -cost : cost
}

/** Format integer ten-thousandths for display. Always shows 4 dp — cost is where precision lives. */
export function formatCost(cost: number, options: { symbol?: string; grouping?: boolean } = {}): string {
  const { symbol, grouping = true } = options
  if (!Number.isInteger(cost)) {
    throw new Error(`formatCost received a non-integer: ${cost}. Cost must be integer ten-thousandths.`)
  }

  const negative = cost < 0
  const abs = Math.abs(cost)
  const whole = Math.trunc(abs / COST_UNITS_PER_MAJOR)
  const fraction = abs % COST_UNITS_PER_MAJOR

  const wholeText = grouping ? whole.toLocaleString('en-US') : String(whole)
  const body = `${wholeText}.${String(fraction).padStart(4, '0')}`
  return `${negative ? '-' : ''}${symbol ? `${symbol} ` : ''}${body}`
}

/**
 * Divide a pack cost across the units in the pack — the carton-to-piece step.
 * Returns integer ten-thousandths, rounded to the nearest 1/10000, so precision survives the split.
 */
export function costPerUnit(packCost: number, unitsInPack: number): number {
  if (unitsInPack <= 0) throw new Error('unitsInPack must be positive')
  return Math.round(packCost / unitsInPack)
}

/**
 * Convert a 4-dp cost to a 2-dp money-minor value (e.g. to seed a suggested price, or to value
 * stock on a report). Rounds to the nearest paisa — the point where an internal number becomes a
 * customer-facing one.
 */
export function costToPriceMinor(cost: number): number {
  return Math.round(cost / COST_PER_MINOR)
}
