import { describe, it, expect } from 'vitest'
import { parseQty, formatQty, purchaseToSaleUnits, ONE_UNIT } from './qty'

describe('quantity — integer thousandths', () => {
  it('parses countable and weighed quantities', () => {
    expect(parseQty('1')).toBe(1000)
    expect(parseQty('3')).toBe(3000)
    expect(parseQty('1.234')).toBe(1234) // 1.234 kg
    expect(parseQty('0.5')).toBe(500) // half a kg
    expect(parseQty('0.005')).toBe(5) // 5 grams
  })

  it('rejects junk and more precision than a retail scale gives', () => {
    expect(parseQty('')).toBeNull()
    expect(parseQty('two')).toBeNull()
    expect(parseQty('1.2345')).toBeNull() // scales weigh in grams; a 4th decimal is a typo
  })

  it('formats without trailing zeros so a cashier sees "2", not "2.000"', () => {
    expect(formatQty(2000)).toBe('2')
    expect(formatQty(1234)).toBe('1.234')
    expect(formatQty(500)).toBe('0.5')
    expect(formatQty(0)).toBe('0')
  })

  it('THROWS if a float ever reaches the quantity layer', () => {
    expect(() => formatQty(1.5)).toThrow(/integer thousandths/)
  })

  it('converts purchase units to sale units — buy a carton, sell pieces', () => {
    // 1 carton = 24 pieces. Receiving 1 carton puts 24 sellable pieces into stock.
    expect(purchaseToSaleUnits(ONE_UNIT, 24)).toBe(24_000)
    expect(formatQty(purchaseToSaleUnits(ONE_UNIT, 24))).toBe('24')
    // 5 cartons of 12
    expect(formatQty(purchaseToSaleUnits(parseQty('5') as number, 12))).toBe('60')
  })
})
