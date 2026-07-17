import { describe, it, expect } from 'vitest'
import { IsoDate, formatDate, formatDateTime } from './dates'
import { DateRangeInput } from './reports'
import { CreatePurchaseInput } from './purchases'
import { CreateExpenseInput } from './expenses'

/**
 * DATES — the two bugs this module exists to kill, both of which shipped silently for months.
 *
 *   1. A DATE THAT DOES NOT EXIST was accepted, and JS rolled it into the next month.
 *   2. A PRINTED DATE asked the MACHINE what country it was in, instead of the shop.
 *
 * Neither throws. Neither shows up in a test that asks the machine the same question the code does.
 * That is exactly why they lasted, and why these assertions name real strings.
 */

// ═════════════════════════════════════════════════════════════════════════════
// 1. A day that does not exist
// ═════════════════════════════════════════════════════════════════════════════

describe('IsoDate', () => {
  it('accepts a real day', () => {
    for (const day of ['2026-07-22', '2026-02-28', '2024-02-29', '2026-12-31', '2026-01-01']) {
      expect(IsoDate.safeParse(day).success, `${day} is a real day`).toBe(true)
    }
  })

  /**
   * THE BUG. `new Date('2026-02-30')` does not throw — it QUIETLY BECOMES March 2. A regex-only guard
   * passes it, so a February tax return silently contained a March date, and nobody found out from the
   * app. The round-trip check is what catches it.
   */
  it('REFUSES a day that does not exist — the one that silently rolls into next month', () => {
    for (const fake of ['2026-02-30', '2026-02-31', '2026-04-31', '2026-06-31', '2026-13-01', '2026-00-10', '2026-01-32']) {
      const parsed = IsoDate.safeParse(fake)
      expect(parsed.success, `${fake} is NOT a real day and must be refused`).toBe(false)
    }
  })

  it('knows a leap year from a common one — 2026 has no 29th of February', () => {
    expect(IsoDate.safeParse('2024-02-29').success).toBe(true) // a leap year
    expect(IsoDate.safeParse('2026-02-29').success).toBe(false) // not one
    expect(IsoDate.safeParse('2000-02-29').success).toBe(true) // divisible by 400 — a leap year
    expect(IsoDate.safeParse('1900-02-29').success).toBe(false) // divisible by 100, not 400 — not one
  })

  it('still refuses the wrong SHAPE, in language a shopkeeper reads', () => {
    for (const bad of ['22/07/2026', '2026-7-22', 'yesterday', '', '2026-07-22T10:00:00Z']) {
      expect(IsoDate.safeParse(bad).success, `"${bad}" is not an ISO day`).toBe(false)
    }
    const parsed = IsoDate.safeParse('not a date')
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/date/i)
  })

  /**
   * THE POINT OF ONE DEFINITION. The guard lived in `expenses.ts` alone; the same regex had been copied
   * WITHOUT it into seven other schemas, so a report, a purchase and a sale all accepted 2026-02-30.
   * These assert the guard AT THE SCHEMAS THAT USE IT — a future copy-paste that reintroduces a bare
   * regex fails here, not in a shop's tax return.
   */
  it('guards every schema that takes a date — not just the one the audit happened to look at', () => {
    expect(
      DateRangeInput.safeParse({ from: '2026-02-01', to: '2026-02-30' }).success,
      'a REPORT accepted a date that does not exist'
    ).toBe(false)

    expect(
      CreateExpenseInput.safeParse({
        categoryLookupId: 1,
        amount: 100,
        methodLookupId: 1,
        at: '2026-02-30'
      }).success,
      'an EXPENSE accepted a date that does not exist'
    ).toBe(false)

    expect(
      CreatePurchaseInput.safeParse({
        supplierId: 1,
        at: '2026-02-30',
        lines: [{ productId: 1, qtyM: 1000, unitCost: 10_000 }]
      }).success,
      'a PURCHASE accepted a date that does not exist'
    ).toBe(false)

    // ...and the same schemas take a real day happily.
    expect(DateRangeInput.safeParse({ from: '2026-02-01', to: '2026-02-28' }).success).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The shop's country writes the date — not the machine's Windows locale
// ═════════════════════════════════════════════════════════════════════════════

describe('formatDate', () => {
  /**
   * THE BUG. Every printed date was `toLocaleString()` with no locale — "whatever this PC is set to". A
   * Pakistani shop on a US Windows image printed 7/22/2026 on its own customers' receipts, while
   * `shop.country` sat in Settings promising "Sets the default tax rate and the date format".
   */
  it('writes day-first for a Pakistani shop, and month-first for an American one', () => {
    const day = '2026-07-22T15:45:00'
    expect(formatDate(day, 'PK')).toBe('22/07/2026')
    expect(formatDate(day, 'US')).toBe('07/22/2026')
  })

  it('writes day-first for every country the app offers except the US', () => {
    const day = new Date(2026, 6, 22)
    for (const country of ['PK', 'AE', 'SA', 'IN', 'GB']) {
      expect(formatDate(day, country), `${country} writes day-first`).toBe('22/07/2026')
    }
    expect(formatDate(day, 'US')).toBe('07/22/2026')
  })

  it('defaults to day-first — a shop that never opened Settings still reads its own receipts', () => {
    const day = new Date(2026, 6, 22)
    for (const missing of [null, undefined, '', 'ZZ']) {
      expect(formatDate(day, missing)).toBe('22/07/2026')
    }
  })

  it('is case-insensitive about the country code — "pk" is Pakistan', () => {
    expect(formatDate(new Date(2026, 6, 22), 'pk')).toBe('22/07/2026')
    expect(formatDate(new Date(2026, 6, 22), 'us')).toBe('07/22/2026')
  })

  it('pads to two digits, so the column does not jitter down a receipt', () => {
    expect(formatDate(new Date(2026, 0, 5), 'PK')).toBe('05/01/2026')
  })

  it('returns an empty string for a date it cannot read — never "Invalid Date" on a customer receipt', () => {
    expect(formatDate('not a date', 'PK')).toBe('')
  })
})

describe('formatDateTime', () => {
  it('prints a 12-hour clock a cashier can match against a shift', () => {
    expect(formatDateTime('2026-07-22T15:45:00', 'PK')).toBe('22/07/2026 3:45 pm')
    expect(formatDateTime('2026-07-22T09:05:00', 'PK')).toBe('22/07/2026 9:05 am')
  })

  it('gets the two times a 12-hour clock always gets wrong', () => {
    expect(formatDateTime('2026-07-22T00:30:00', 'PK'), 'half past midnight is 12:30 am').toBe(
      '22/07/2026 12:30 am'
    )
    expect(formatDateTime('2026-07-22T12:30:00', 'PK'), 'half past noon is 12:30 pm').toBe(
      '22/07/2026 12:30 pm'
    )
  })

  it("follows the shop's country too", () => {
    expect(formatDateTime('2026-07-22T15:45:00', 'US')).toBe('07/22/2026 3:45 pm')
  })
})
