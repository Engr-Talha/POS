import { AppError, ErrorCode } from './result'
import { QTY_SCALE } from './qty'

/**
 * THE TWO PURE FUNCTIONS THAT TURN A CART INTO MONEY.
 *
 * They live in `shared/` for one reason, and it is the same reason `formatInvoiceNo` and
 * `computeLineTax` live here: THE TILL MUST PREDICT MAIN'S TOTAL EXACTLY.
 *
 * The Sell screen shows a running total as the cashier scans. The sale service freezes the real one.
 * If those were two implementations of the same arithmetic, they would differ — not on the first sale,
 * but on the one weighed line, or the one cart discount that does not divide by three. The customer is
 * quoted Rs 394.88 on the screen and charged Rs 394.89 on the paper, and nobody can say why.
 *
 * So there is ONE implementation. `services/sales.ts` imports these to FREEZE the sale; the Sell screen
 * imports them to PREVIEW it. They cannot drift, because they are the same line of code.
 *
 * Both are pure integer arithmetic, and neither knows what a database is.
 */

/**
 * THE LINE EXTENSION: a unit price (2 dp) times a quantity (3 dp), as money (2 dp).
 *
 *     unit_price x qty_m / 1000
 *
 * Rounded half-up to the paisa, ONCE. BigInt for the multiply, exactly as `stock.movementValueCost`
 * does and for the same reason: 10,000 units of a Rs 100,000 item overflows a JS float's exact-integer
 * range, and past that point two different totals silently compare equal — the one failure mode integer
 * money exists to prevent.
 *
 * This is what makes a WEIGHED item exact. 1.234 kg at Rs 320.00/kg is 32000 x 1234 / 1000 = 39,488
 * paisa = Rs 394.88, with no float anywhere in it.
 */
export function extendPrice(unitPriceMinor: number, qtyM: number): number {
  if (!Number.isSafeInteger(unitPriceMinor) || !Number.isSafeInteger(qtyM)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Something went wrong with that price or quantity. Please try again.',
      `extendPrice got non-integer input: unitPrice=${unitPriceMinor} qtyM=${qtyM}`
    )
  }

  const scale = BigInt(QTY_SCALE)
  const raw = BigInt(Math.abs(unitPriceMinor)) * BigInt(Math.abs(qtyM))
  const value = (raw * 2n + scale) / (scale * 2n) // floor(raw/scale + 1/2) — round half up

  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That amount is too large to record. Please split it into smaller sales.',
      `line extension ${value} exceeds safe integer range (unitPrice=${unitPriceMinor} qtyM=${qtyM})`
    )
  }
  return result
}

/**
 * SPLIT A CART DISCOUNT ACROSS THE LINES — pro rata, and EXACTLY.
 *
 * Rs 100 off a cart of three lines does not divide into three whole paisa amounts. Naive rounding either
 * loses a paisa or invents one, and the answer to that is NOT a rounding line — this app does not have
 * one and never will (PLAN.md §1). So: LARGEST REMAINDER. Every line takes the floor of its exact share,
 * and the paisa left over go one each to the lines with the biggest fractional remainder.
 *
 *     SUM(shares) === total. Exactly. Always. For any weights, any total.
 *
 * A test asserts it across a thousand random carts, because this is the one place a rupee could quietly
 * go missing on every discounted sale in the shop's history.
 *
 * Ties break toward the earlier line, so the same cart always splits the same way.
 */
export function apportionCartDiscount(total: number, weights: readonly number[]): number[] {
  const shares = weights.map(() => 0)
  if (total <= 0 || weights.length === 0) return shares

  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  if (sum <= 0) return shares

  const totalBig = BigInt(total)
  const sumBig = BigInt(sum)

  const remainders: Array<{ index: number; remainder: bigint }> = []
  let allocated = 0

  weights.forEach((weight, index) => {
    const numerator = totalBig * BigInt(weight)
    const base = Number(numerator / sumBig)
    shares[index] = base
    allocated += base
    remainders.push({ index, remainder: numerator % sumBig })
  })

  // What floor() left on the table: strictly fewer paisa than there are lines.
  let left = total - allocated

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
  )

  for (const entry of remainders) {
    if (left <= 0) break
    shares[entry.index] = (shares[entry.index] ?? 0) + 1
    left--
  }

  return shares
}
