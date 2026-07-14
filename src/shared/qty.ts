/**
 * QUANTITY IS AN INTEGER. ALWAYS. (CLAUDE.md §4)
 *
 * Quantity is stored as an INTEGER number of THOUSANDTHS of the base unit ("qty_m").
 *
 *   1 piece   ->  1000
 *   3 pieces  ->  3000
 *   1.234 kg  ->  1234
 *   0.5 kg    ->   500
 *
 * WHY: the shop sells weighed goods (kg) as well as countable ones. A float quantity multiplied by
 * an integer price reintroduces exactly the drift that integer money was meant to eliminate. Same
 * discipline, applied to quantity: integers only, converted at the edges.
 *
 * 3 decimal places is the standard for retail scales (grams).
 */

export const QTY_SCALE = 1000

/** One whole unit. Use this instead of typing 1000. */
export const ONE_UNIT = QTY_SCALE

/** Parse user input ("2", "1.234", "0.5") into integer thousandths. Null if invalid. */
export function parseQty(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '')
  if (cleaned === '') return null
  if (!/^\d*(\.\d*)?$/.test(cleaned)) return null

  const [whole = '', fraction = ''] = cleaned.split('.')
  if (whole === '' && fraction === '') return null
  if (fraction.length > 3) return null // a retail scale gives grams; more than that is a typo

  const qtyM = Number(whole || '0') * QTY_SCALE + Number(fraction.padEnd(3, '0'))
  return Number.isSafeInteger(qtyM) ? qtyM : null
}

/** Format integer thousandths for display. Whole quantities show as "2", not "2.000". */
export function formatQty(qtyM: number): string {
  if (!Number.isInteger(qtyM)) {
    throw new Error(`formatQty received a non-integer: ${qtyM}. Quantity must be integer thousandths.`)
  }

  const negative = qtyM < 0
  const abs = Math.abs(qtyM)
  const whole = Math.trunc(abs / QTY_SCALE)
  const fraction = abs % QTY_SCALE

  const body =
    fraction === 0
      ? String(whole)
      : `${whole}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`

  return negative ? `-${body}` : body
}

/**
 * Convert a quantity between a purchase unit and a sale unit.
 * e.g. 1 carton of 24 pieces: fromPurchaseUnits(1000, 24) -> 24000 (= 24 pieces).
 *
 * Buy in cartons, sell in pieces. Stock, cost and every report must respect this.
 */
export function purchaseToSaleUnits(qtyM: number, conversionFactor: number): number {
  return qtyM * conversionFactor
}
