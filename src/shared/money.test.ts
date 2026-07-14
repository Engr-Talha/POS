import { describe, it, expect } from 'vitest'
import { parseMoney, formatMoney, splitMoney } from './money'

describe('money — integer minor units, never floats', () => {
  it('parses plain and grouped input into minor units', () => {
    expect(parseMoney('1234.50')).toBe(123450)
    expect(parseMoney('1,234.50')).toBe(123450)
    expect(parseMoney('0.05')).toBe(5)
    expect(parseMoney('12')).toBe(1200)
    expect(parseMoney('  7.9 ')).toBe(790)
    expect(parseMoney('-3.25')).toBe(-325)
  })

  it('rejects anything that is not a clean 2-decimal amount', () => {
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('abc')).toBeNull()
    expect(parseMoney('1.2.3')).toBeNull()
    // A 3rd decimal is REJECTED, not silently rounded. There is no rounding in this app, and
    // quietly dropping a digit the user typed would be a lie about their money.
    expect(parseMoney('1.005')).toBeNull()
  })

  it('formats minor units for display', () => {
    expect(formatMoney(123450)).toBe('1,234.50')
    expect(formatMoney(123450, { symbol: 'Rs' })).toBe('Rs 1,234.50')
    expect(formatMoney(5)).toBe('0.05')
    expect(formatMoney(0)).toBe('0.00')
    expect(formatMoney(-325, { symbol: 'Rs' })).toBe('-Rs 3.25')
    expect(formatMoney(123450, { grouping: false })).toBe('1234.50')
  })

  it('THROWS if a float ever reaches the money layer', () => {
    // This is the bug that quietly costs a shop money. Make it loud, never round it away.
    expect(() => formatMoney(10.5)).toThrow(/integer minor units/)
  })

  it('survives a round trip', () => {
    for (const input of ['0.01', '9.99', '1234.56', '100000.00']) {
      const minor = parseMoney(input)
      expect(minor).not.toBeNull()
      expect(formatMoney(minor as number, { grouping: false })).toBe(input)
    }
  })

  it('does not drift when summing many amounts (the float bug this design prevents)', () => {
    // 0.1 + 0.2 !== 0.3 in floats. In minor units it is exact, a thousand times over.
    const tenPaisa = parseMoney('0.10') as number
    let total = 0
    for (let i = 0; i < 1000; i++) total += tenPaisa
    expect(total).toBe(10000)
    expect(formatMoney(total, { grouping: false })).toBe('100.00')
  })

  it('splits into whole and fraction for receipt layouts', () => {
    expect(splitMoney(123450)).toEqual({ whole: 1234, fraction: 50 })
    expect(splitMoney(7)).toEqual({ whole: 0, fraction: 7 })
  })
})
