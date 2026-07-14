import { describe, it, expect } from 'vitest'
import {
  computeLineTax,
  priceInclusiveFromExclusive,
  priceExclusiveFromInclusive
} from './tax'

const GST_17 = 1700 // Pakistan default, configurable per product

describe('tax — basis points, per-line, inclusive or exclusive', () => {
  it('adds tax on top of an exclusive price', () => {
    // Rs 100.00 excl. + 17% = Rs 117.00
    expect(computeLineTax(10_000, GST_17, 'exclusive')).toEqual({
      net: 10_000,
      taxRateBp: GST_17,
      tax: 1_700,
      gross: 11_700
    })
  })

  it('backs tax out of an inclusive price', () => {
    // Rs 117.00 incl. 17% => net Rs 100.00, tax Rs 17.00
    expect(computeLineTax(11_700, GST_17, 'inclusive')).toEqual({
      net: 10_000,
      taxRateBp: GST_17,
      tax: 1_700,
      gross: 11_700
    })
  })

  it('ALWAYS satisfies net + tax === gross, even where the rate does not divide cleanly', () => {
    // This is the invariant the receipt depends on. If it ever fails, the printed total does not
    // equal the sum of its own lines and the cashier cannot balance the till.
    const awkward = [999, 1, 7, 33, 12_345, 99_999, 1_000_001]
    const rates = [0, 100, 500, 1700, 1800, 2500]

    for (const amount of awkward) {
      for (const rate of rates) {
        for (const mode of ['inclusive', 'exclusive'] as const) {
          const line = computeLineTax(amount, rate, mode)
          expect(line.net + line.tax).toBe(line.gross)
          expect(Number.isInteger(line.net)).toBe(true)
          expect(Number.isInteger(line.tax)).toBe(true)
          expect(Number.isInteger(line.gross)).toBe(true)
        }
      }
    }
  })

  it('handles a zero-rated (tax-exempt) product', () => {
    expect(computeLineTax(5_000, 0, 'exclusive')).toEqual({
      net: 5_000,
      taxRateBp: 0,
      tax: 0,
      gross: 5_000
    })
  })

  it('rounds tax to the whole paisa — there is no such coin as 0.83 paisa', () => {
    // 17% of Rs 9.99 = 169.83 paisa -> 170 paisa
    const line = computeLineTax(999, GST_17, 'exclusive')
    expect(line.tax).toBe(170)
    expect(line.gross).toBe(1169)
  })

  it('powers the product form: type either price, the other fills in', () => {
    expect(priceInclusiveFromExclusive(10_000, GST_17)).toBe(11_700)
    expect(priceExclusiveFromInclusive(11_700, GST_17)).toBe(10_000)
  })

  it('lets one cart mix inclusive and exclusive products', () => {
    // A bakery item priced Rs 50 on the shelf (tax included) and a phone priced Rs 1000 + tax.
    const bakery = computeLineTax(5_000, GST_17, 'inclusive')
    const phone = computeLineTax(100_000, GST_17, 'exclusive')

    const cartTax = bakery.tax + phone.tax
    const cartGross = bakery.gross + phone.gross
    const cartNet = bakery.net + phone.net

    expect(bakery.gross).toBe(5_000) // shelf price is what the customer pays
    expect(phone.gross).toBe(117_000) // tax added on top
    expect(cartNet + cartTax).toBe(cartGross) // the receipt still adds up
  })

  it('THROWS on a float amount or a nonsense rate', () => {
    expect(() => computeLineTax(10.5, GST_17, 'exclusive')).toThrow(/integer minor units/)
    expect(() => computeLineTax(1000, -5, 'exclusive')).toThrow(/basis points/)
  })
})
