/**
 * MONEY IS AN INTEGER. ALWAYS. (CLAUDE.md §4)
 *
 * Every amount in this app — prices, totals, tax, payments, journal lines — is stored and computed
 * as an INTEGER number of MINOR UNITS (paisa / cents). Never a float. Never a REAL column.
 * Decimal places are fixed at 2.
 *
 *   Rs 1,234.50  ->  123450
 *
 * Floats cannot represent 0.1 exactly. Add enough of them together and a day's till is off by a
 * rupee, and nobody can tell you why. Integers cannot drift.
 *
 * The ONLY place a money value becomes a string is at display time, through `formatMoney`.
 */

export const MINOR_UNITS_PER_MAJOR = 100

/**
 * Parse user input ("1234.5", "1,234.50", "  12 ") into integer minor units.
 * Returns null if it is not a valid amount — the caller decides what to tell the user.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '')
  if (cleaned === '') return null
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return null

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [whole = '', fraction = ''] = unsigned.split('.')
  if (whole === '' && fraction === '') return null

  // Take exactly 2 decimal places. We do NOT round a 3rd — there is no rounding in this app
  // (PLAN.md §1), and silently absorbing a digit the user typed would be a lie.
  if (fraction.length > 2) return null

  const paddedFraction = fraction.padEnd(2, '0')
  const minor = Number(whole || '0') * MINOR_UNITS_PER_MAJOR + Number(paddedFraction)
  if (!Number.isSafeInteger(minor)) return null

  return negative ? -minor : minor
}

/**
 * Format integer minor units for display. THE ONLY PLACE MONEY BECOMES A STRING.
 *
 * The currency symbol is passed in because it is configurable in Settings. Changing the currency
 * changes the LABEL ONLY — it never converts stored values (PLAN.md §1).
 */
export function formatMoney(
  minor: number,
  options: { symbol?: string; grouping?: boolean } = {}
): string {
  const { symbol, grouping = true } = options

  if (!Number.isInteger(minor)) {
    // A float reached the money layer. That is a bug, and it is the kind that quietly costs the
    // shop money, so we make it loud rather than rounding it away.
    throw new Error(`formatMoney received a non-integer: ${minor}. Money must be integer minor units.`)
  }

  const negative = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.trunc(abs / MINOR_UNITS_PER_MAJOR)
  const fraction = abs % MINOR_UNITS_PER_MAJOR

  const wholeText = grouping ? whole.toLocaleString('en-US') : String(whole)
  const body = `${wholeText}.${String(fraction).padStart(2, '0')}`

  return `${negative ? '-' : ''}${symbol ? `${symbol} ` : ''}${body}`
}

/** Split integer minor units into major/minor parts, for receipt layouts that need them apart. */
export function splitMoney(minor: number): { whole: number; fraction: number } {
  const abs = Math.abs(minor)
  return {
    whole: Math.trunc(abs / MINOR_UNITS_PER_MAJOR),
    fraction: abs % MINOR_UNITS_PER_MAJOR
  }
}
