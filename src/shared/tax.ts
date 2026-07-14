/**
 * TAX. (CLAUDE.md §4, PLAN.md §1)
 *
 * Rates are stored in BASIS POINTS: 17% = 1700, 0% = 0, 5% = 500. Integers, not floats.
 *
 * A product records whether its price was entered INCLUSIVE or EXCLUSIVE of tax. A single cart may
 * mix both — a bakery item priced tax-inclusive on the shelf and a phone priced tax-exclusive can
 * sit on the same receipt. So tax is resolved PER LINE, never once for the cart.
 *
 * ON ROUNDING: the app does NO CASH ROUNDING — the total is never nudged to the nearest 5 or 10,
 * and there is no rounding line (PLAN.md §1). But tax itself must land on a whole paisa: 17% of
 * Rs 9.99 is 169.83 paisa, and there is no such coin. So tax is rounded to the nearest minor unit,
 * ONCE, per line — and then `net`, `tax`, `gross` are FROZEN onto the sale line so that
 * gross === net + tax exactly, forever, no matter what the settings say next year.
 */

export const BASIS_POINTS = 10_000

export type TaxMode = 'inclusive' | 'exclusive'

export type LineTax = {
  /** Amount before tax, integer minor units. */
  net: number
  /** Tax rate applied, basis points. Frozen onto the line. */
  taxRateBp: number
  /** Tax amount, integer minor units. */
  tax: number
  /** Amount charged to the customer, integer minor units. Always net + tax. */
  gross: number
}

/** Round to the nearest whole minor unit, halves away from zero (what a human expects). */
function roundMinor(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Resolve one sale line into net / tax / gross.
 *
 * @param amount integer minor units — the line total AT the given tax mode.
 *               If mode is 'exclusive' this is the net; if 'inclusive' it is the gross.
 * @param taxRateBp basis points (17% = 1700)
 * @param mode whether `amount` already contains the tax
 */
export function computeLineTax(amount: number, taxRateBp: number, mode: TaxMode): LineTax {
  if (!Number.isInteger(amount)) {
    throw new Error(`computeLineTax got a non-integer amount: ${amount}. Money must be integer minor units.`)
  }
  if (!Number.isInteger(taxRateBp) || taxRateBp < 0) {
    throw new Error(`computeLineTax got an invalid tax rate: ${taxRateBp}. Use basis points (17% = 1700).`)
  }

  if (taxRateBp === 0) {
    return { net: amount, taxRateBp, tax: 0, gross: amount }
  }

  if (mode === 'exclusive') {
    const net = amount
    const tax = roundMinor((net * taxRateBp) / BASIS_POINTS)
    // gross is DERIVED from the two integers we just fixed, so net + tax === gross by construction.
    return { net, taxRateBp, tax, gross: net + tax }
  }

  // inclusive: the customer-facing price already contains the tax; work backwards out of it.
  const gross = amount
  const net = roundMinor((gross * BASIS_POINTS) / (BASIS_POINTS + taxRateBp))
  // Take tax as the REMAINDER, not as a second rounded multiplication — otherwise rounding each
  // side independently can leave net + tax off gross by one paisa, and the receipt won't add up.
  return { net, taxRateBp, tax: gross - net, gross }
}

/**
 * The two prices shown side by side in the product form: type either, the other fills in.
 * (Owner's requirement: the product form shows BOTH "Price excl. tax" and "Price incl. tax".)
 */
export function priceInclusiveFromExclusive(exclusive: number, taxRateBp: number): number {
  return computeLineTax(exclusive, taxRateBp, 'exclusive').gross
}

export function priceExclusiveFromInclusive(inclusive: number, taxRateBp: number): number {
  return computeLineTax(inclusive, taxRateBp, 'inclusive').net
}
