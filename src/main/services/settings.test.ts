import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as settings from './settings'
import { SETTINGS, SETTINGS_BY_KEY, ALL_DEFAULTS } from '@shared/settings-registry'

/**
 * THE SETTINGS REGISTRY.
 *
 * The owner's standing rule: if a number could differ between two shops, it is a setting, not a
 * constant. These tests defend the two things that make that safe — that the registry is the single
 * source of truth, and that MAIN validates every write (the renderer is not a security boundary).
 */

let t: TestDb
beforeEach(() => (t = makeTestDb({ withSeed: true })))
afterEach(() => t.cleanup())

describe('the registry is the single source of truth', () => {
  it('seeds every declared setting with its declared default', () => {
    for (const def of SETTINGS) {
      expect(settings.get(t.db, def.key, '__missing__')).toEqual(def.default)
    }
  })

  it('has no duplicate keys, and every setting has a label and a group', () => {
    const keys = SETTINGS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)

    for (const def of SETTINGS) {
      expect(def.label, `${def.key} has no label`).toBeTruthy()
      expect(def.group, `${def.key} has no group`).toBeTruthy()
      if (def.type === 'select') {
        expect(def.options?.length, `${def.key} is a select with no options`).toBeGreaterThan(0)
      }
    }
  })

  it('DEFAULT_SETTINGS is DERIVED from the registry — there is no second list to fall out of step', () => {
    expect(settings.DEFAULT_SETTINGS).toBe(ALL_DEFAULTS)
  })

  it('carries the knobs the owner asked for, rather than hard-coding them', () => {
    // Spot-check the ones that were literals in the code before, and that a shop will really want to
    // change: the discount that needs a supervisor, what happens on negative stock, expiry warnings.
    expect(SETTINGS_BY_KEY['selling.discountApprovalPercent']).toBeTruthy()
    expect(SETTINGS_BY_KEY['selling.negativeStock']?.default).toBe('warn')
    expect(SETTINGS_BY_KEY['stock.nearExpiryDays']?.default).toBe(30)
    expect(SETTINGS_BY_KEY['drawer.kickCode']).toBeTruthy()
    expect(SETTINGS_BY_KEY['scanner.minLength']).toBeTruthy()
    expect(SETTINGS_BY_KEY['loyalty.pointsPerCurrencyUnit']).toBeTruthy()
  })

  it('does NOT let a shop switch off the things that make the books correct', () => {
    // Money is 2dp, cost is 4dp, quantity is thousandths, stock is derived, journals balance. Those
    // are invariants, not preferences. A settings key for any of them would be a switch labelled
    // "turn correctness off", and one slow afternoon somebody would flip it.
    const forbidden = /decimal|rounding|derive|balance|integer|float/i
    for (const def of SETTINGS) {
      expect(def.key, `${def.key} looks like it makes an invariant configurable`).not.toMatch(forbidden)
    }
  })
})

describe('MAIN validates every write — the renderer is not a security boundary', () => {
  it('refuses a value of the wrong type, in plain language', () => {
    expectUserMessage(() => settings.set(t.db, 'tax.defaultRateBp', 'banana'), /whole number/i)
    expectUserMessage(() => settings.set(t.db, 'tax.enabled', 'yes'), /on or off/i)
    expectUserMessage(() => settings.set(t.db, 'shop.name', 42), /must be text/i)
  })

  it('refuses a value outside its declared range', () => {
    // A negative discount threshold would make EVERY sale need a supervisor. A 500% tax rate would
    // be worse. Neither is reachable from the UI — which is exactly why it is checked here instead.
    expectUserMessage(() => settings.set(t.db, 'selling.discountApprovalPercent', -1), /cannot be less/i)
    expectUserMessage(() => settings.set(t.db, 'tax.defaultRateBp', 50_000), /cannot be more/i)
  })

  it('refuses a float where an integer is required', () => {
    // 17.5% must arrive as 1750 basis points, not 17.5. A float here is how a rate quietly becomes
    // 16.999999999999998%.
    expectUserMessage(() => settings.set(t.db, 'tax.defaultRateBp', 17.5), /whole number/i)
  })

  it('refuses an option that is not on the list', () => {
    expectUserMessage(() => settings.set(t.db, 'selling.negativeStock', 'explode'), /choose one/i)
  })

  it('refuses a setting that does not exist at all', () => {
    expectUserMessage(() => settings.set(t.db, 'nonsense.key', 1), /does not exist/i)
  })

  it('accepts a good value and stores it as the integer it is', () => {
    settings.set(t.db, 'tax.defaultRateBp', 1750) // 17.5%
    expect(settings.get(t.db, 'tax.defaultRateBp', 0)).toBe(1750)

    settings.set(t.db, 'selling.negativeStock', 'block')
    expect(settings.get(t.db, 'selling.negativeStock', '')).toBe('block')

    settings.set(t.db, 'currency.symbol', '₨')
    expect(settings.get(t.db, 'currency.symbol', '')).toBe('₨')
  })

  it('still allows the runtime state the APP sets (a remembered folder is not a knob)', () => {
    expect(() => settings.set(t.db, 'backup.directory', '/Users/x/Documents')).not.toThrow()
    expect(() => settings.set(t.db, 'backup.lastRunAt', new Date().toISOString())).not.toThrow()
  })
})
