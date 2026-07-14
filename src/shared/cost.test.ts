import { describe, it, expect } from 'vitest'
import { parseCost, formatCost, costPerUnit, costToPriceMinor } from './cost'

describe('cost — integer ten-thousandths, 4 decimal places', () => {
  it('parses cost to 4 dp', () => {
    expect(parseCost('2185')).toBe(21_850_000)
    expect(parseCost('2185.0000')).toBe(21_850_000)
    expect(parseCost('91.0417')).toBe(910_417)
    expect(parseCost('2,185.50')).toBe(21_855_000)
  })

  it('rejects more than 4 decimals and junk', () => {
    expect(parseCost('91.04175')).toBeNull()
    expect(parseCost('abc')).toBeNull()
    expect(parseCost('')).toBeNull()
  })

  it('formats always at 4 dp — precision is the whole point of this type', () => {
    expect(formatCost(21_850_000)).toBe('2,185.0000')
    expect(formatCost(910_417, { symbol: 'Rs' })).toBe('Rs 91.0417')
    expect(formatCost(21_850_000, { grouping: false })).toBe('2185.0000')
  })

  it('THROWS if a float reaches the cost layer', () => {
    expect(() => formatCost(91.04)).toThrow(/integer ten-thousandths/)
  })

  it('splits a carton cost across its pieces without losing the fraction', () => {
    // Rs 2185 carton of 24 = Rs 91.0417/piece. THIS is why cost is 4 dp: at 2 dp it would be
    // 91.04, losing 0.0017 a piece, and a year of COGS would quietly drift.
    const perPiece = costPerUnit(21_850_000, 24)
    expect(formatCost(perPiece)).toBe('91.0417')
  })

  it('converts a 4-dp cost to a 2-dp price when it becomes customer-facing', () => {
    expect(costToPriceMinor(910_417)).toBe(9104) // Rs 91.0417 cost -> Rs 91.04 as money
    expect(costToPriceMinor(21_850_000)).toBe(218_500) // Rs 2185.0000 -> Rs 2185.00
  })
})
