import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as promotions from './promotions'
import { extendPrice } from '@shared/pricing'
import { ONE_UNIT } from '@shared/qty'
import { dayIndexOf, maskRunsOn, type PromotableLine } from '@shared/promotions'
import { PERMISSIONS } from '@shared/rbac'
import type { User } from '@shared/types'

/**
 * THE PROMOTIONS SERVICE + THE RULES ENGINE. (Migration 0018, whose header is the spec.)
 *
 * WHAT THESE TESTS ARE FOR. A promotion is a LINE DISCOUNT — it invents no new money — so the thing
 * that can go wrong is not "does the journal balance" (there is no journal here); it is the ARITHMETIC
 * and the GATING. Every test below is one way the shop loses money or one way an offer fires when it
 * should not:
 *
 *   · a float creeping into a discount                    (every kind, on integers only)
 *   · buy-2-get-1 giving 1.67 free instead of 1           (partial groups)
 *   · a discount going negative, or exceeding the line    (a price rise nobody authorised)
 *   · an offer firing outside its window or on Thursday   (the Monday-first mask)
 *   · an offer with no rules discounting the whole shop   (the expensive typo 0018 exists to prevent)
 *   · two offers stacking on one tin                      (selling at a loss, with balanced books)
 *
 * THE STANDING ASSERTION (`holds`), run after every engine scenario: EVERY discount is a non-negative
 * INTEGER that never exceeds the line it came off. That is the invariant the whole feature rests on —
 * once a discount is inside the line, sales.ts trusts it absolutely.
 */

const RS_100 = 10_000
const RS_10 = 1_000
const GST = 1_700

let t: TestDb
/** A REAL user row — the audit log's user_id is a foreign key, and every write here is audited. */
let owner: User

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'The Owner')
})

afterEach(() => {
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertion
// ═════════════════════════════════════════════════════════════════════════════

/**
 * EVERY discount the engine hands back is a non-negative INTEGER, never more than the line's own price.
 * Run after every scenario: sales.ts puts these numbers straight into `line_discount` and never
 * questions them, so a float or a negative here becomes a corrupt sale downstream.
 */
function holds(lines: readonly PromotableLine[], results: promotions.LinePromotionResult[]): void {
  expect(results, 'the engine must answer once per line, in order').toHaveLength(lines.length)

  results.forEach((result, index) => {
    if (result == null) return
    const line = lines[index]!

    expect(Number.isInteger(result.discountMinor), `discount is not an integer: ${result.discountMinor}`).toBe(true)
    expect(result.discountMinor, 'a discount can never be negative').toBeGreaterThanOrEqual(0)
    expect(result.discountMinor, 'a discount can never exceed the line').toBeLessThanOrEqual(line.lineAmount)
    expect(result.promotionName.length, 'the frozen name must not be empty').toBeGreaterThan(0)
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

function makeUser(role: User['role'], username: string, fullName: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, pin_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', NULL, 1, ?, ?)`
      )
      .run(username, fullName, role, now, now).lastInsertRowid
  )
  return { id, username, fullName, role, hasPin: false, isActive: true }
}

function lookupId(listKey: string, code: string): number {
  const id = t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number | undefined

  if (id == null) throw new Error(`test fixture: no lookup ${listKey}/${code}`)
  return id
}

/** A lookup on one of the owner's own lists — for the category/brand/department rule scopes. */
function makeLookup(listKey: string, code: string, label = code): number {
  const existing = t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number | undefined
  if (existing != null) return existing

  return Number(
    t.db
      .prepare(
        `INSERT INTO lookups (list_key, code, label, sort_order, is_active, is_system, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 0, @now, @now)`.replace(/@now/g, `'${new Date().toISOString()}'`)
      )
      .run(listKey, code, label).lastInsertRowid
  )
}

function makeProduct(
  options: {
    name?: string
    retailPrice?: number
    categoryId?: number | null
    brandId?: number | null
    departmentId?: number | null
    isWeighted?: boolean
  } = {}
): number {
  const now = new Date().toISOString()

  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            department_id, category_id, brand_id, is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, 0, @retailPrice, 0, @taxRateBp,
                 'exclusive', 0, 'inventory', @isWeighted, 0, 0,
                 @departmentId, @categoryId, @brandId, 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        name: options.name ?? 'Test Item',
        uomId: lookupId('uom', 'pcs'),
        retailPrice: options.retailPrice ?? RS_100,
        taxRateBp: GST,
        isWeighted: options.isWeighted ? 1 : 0,
        departmentId: options.departmentId ?? null,
        categoryId: options.categoryId ?? null,
        brandId: options.brandId ?? null,
        now
      }).lastInsertRowid
  )
}

/** A cart line as MAIN would hand it to the engine — its price already resolved from the catalog. */
function line(productId: number | null, qtyM: number, unitPrice: number): PromotableLine {
  return { productId, qtyM, unitPrice, lineAmount: extendPrice(unitPrice, qtyM) }
}

/** An offer, plus the rules that make it apply to something. */
function makeOffer(
  input: Record<string, unknown>,
  rules: Array<{ scope: string; targetId?: number | null }>
): number {
  const promotion = promotions.createPromotion(t.db, owner, input)

  if (rules.length > 0) {
    promotions.setRules(t.db, owner, { promotionId: promotion.id, rules })
  }
  return promotion.id
}

// Real, known weekdays — checked against the calendar, not assumed.
const A_SUNDAY = new Date(2026, 6, 12, 10, 0, 0) // 12 July 2026 IS a Sunday
const A_MONDAY = new Date(2026, 6, 13, 10, 0, 0) // 13 July 2026 IS a Monday
const A_SATURDAY = new Date(2026, 6, 11, 10, 0, 0) // 11 July 2026 IS a Saturday

// ═════════════════════════════════════════════════════════════════════════════
// THE DAY MAPPING — the one that silently fires a weekend offer on Thursday
// ═════════════════════════════════════════════════════════════════════════════

describe('the days mask is MONDAY-FIRST, and JS getDay() is not', () => {
  it('the fixture dates really are the weekdays this file claims', () => {
    // If this fails, every days_mask test below is testing the wrong day and proving nothing.
    expect(A_SUNDAY.getDay(), '12 July 2026 must be a Sunday').toBe(0)
    expect(A_MONDAY.getDay(), '13 July 2026 must be a Monday').toBe(1)
    expect(A_SATURDAY.getDay(), '11 July 2026 must be a Saturday').toBe(6)
  })

  it('maps getDay() onto the Monday-first index', () => {
    expect(dayIndexOf(A_MONDAY), 'Monday is index 0').toBe(0)
    expect(dayIndexOf(A_SATURDAY), 'Saturday is index 5').toBe(5)
    expect(dayIndexOf(A_SUNDAY), 'Sunday is index 6 — NOT 0').toBe(6)
  })

  it("a weekend mask '0000011' runs on Saturday and Sunday, and NOT on Monday", () => {
    // The off-by-one this guards: read with getDay() directly, '0000011' would fire Thu/Fri.
    expect(maskRunsOn('0000011', A_SATURDAY)).toBe(true)
    expect(maskRunsOn('0000011', A_SUNDAY)).toBe(true)
    expect(maskRunsOn('0000011', A_MONDAY)).toBe(false)

    const thursday = new Date(2026, 6, 9, 10, 0, 0)
    expect(thursday.getDay(), '9 July 2026 must be a Thursday').toBe(4)
    expect(maskRunsOn('0000011', thursday), 'a WEEKEND offer must never fire on a Thursday').toBe(false)
  })

  it('a null mask runs every day', () => {
    expect(maskRunsOn(null, A_MONDAY)).toBe(true)
    expect(maskRunsOn(null, A_SUNDAY)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CREATING — the kind/knob pairing SQLite cannot express
// ═════════════════════════════════════════════════════════════════════════════

describe('createPromotion — a half-described offer never reaches the till', () => {
  it('creates a percent_off offer and stores the percentage in basis points', () => {
    const promotion = promotions.createPromotion(t.db, owner, {
      name: '10% off tea',
      kind: 'percent_off',
      percentBp: 1_000
    })

    expect(promotion.percentBp).toBe(1_000)
    expect(promotion.isActive, 'a new offer is ON').toBe(true)
    expect(promotion.priority, 'defaults to the table default').toBe(100)
    expect(promotion.rules, 'a new offer applies to NOTHING until rules are set').toEqual([])
  })

  it('REFUSES percent_off with no percentage', () => {
    expectUserMessage(
      () => promotions.createPromotion(t.db, owner, { name: 'Broken', kind: 'percent_off' }),
      /needs a percentage/i
    )
  })

  it('REFUSES a knob that does not belong to the kind — the offer would have two readings', () => {
    // "10% off" or "Rs 50 off"? Whichever the engine picked, the owner set the other one.
    expectUserMessage(
      () =>
        promotions.createPromotion(t.db, owner, {
          name: 'Ambiguous',
          kind: 'percent_off',
          percentBp: 1_000,
          amountMinor: 5_000
        }),
      /does not use an amount/i
    )
  })

  it('REFUSES amount_off with no amount, and buy_x_get_y missing either half', () => {
    expectUserMessage(
      () => promotions.createPromotion(t.db, owner, { name: 'x', kind: 'amount_off' }),
      /needs an amount/i
    )
    expectUserMessage(
      () =>
        promotions.createPromotion(t.db, owner, { name: 'x', kind: 'buy_x_get_y', buyQtyM: 2_000 }),
      /needs how many are free/i
    )
    expectUserMessage(
      () => promotions.createPromotion(t.db, owner, { name: 'x', kind: 'fixed_price' }),
      /needs an amount/i
    )
  })

  it('REFUSES an offer that ends before it starts', () => {
    expectUserMessage(
      () =>
        promotions.createPromotion(t.db, owner, {
          name: 'Backwards',
          kind: 'percent_off',
          percentBp: 1_000,
          startsOn: '2026-07-10',
          endsOn: '2026-07-01'
        }),
      /cannot end before it starts/i
    )
  })

  it('REFUSES a calendar-invalid date — 2026-02-30 would silently roll to March 2', () => {
    expectUserMessage(
      () =>
        promotions.createPromotion(t.db, owner, {
          name: 'Impossible',
          kind: 'percent_off',
          percentBp: 1_000,
          startsOn: '2026-02-30'
        }),
      /not a real calendar date/i
    )
  })

  it('REFUSES a percentage over 100%, and one of zero', () => {
    expectUserMessage(
      () =>
        promotions.createPromotion(t.db, owner, { name: 'x', kind: 'percent_off', percentBp: 10_001 }),
      /more than 100%/i
    )
    expectUserMessage(
      () => promotions.createPromotion(t.db, owner, { name: 'x', kind: 'percent_off', percentBp: 0 }),
      /greater than zero/i
    )
  })

  it('audits the creation — an offer is a standing decision to sell below the shelf price', () => {
    promotions.createPromotion(t.db, owner, { name: 'Audited', kind: 'percent_off', percentBp: 1_000 })

    const row = t.db
      .prepare("SELECT user_name, user_role, action FROM audit_log WHERE action = 'promotion.create'")
      .get() as { user_name: string; user_role: string } | undefined

    expect(row?.user_name).toBe('The Owner')
    expect(row?.user_role).toBe('owner')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// EDITING and SWITCHING OFF
// ═════════════════════════════════════════════════════════════════════════════

describe('updatePromotion / deactivatePromotion', () => {
  it('an edit that does not mention priority KEEPS the one it had', () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'Tea',
      kind: 'percent_off',
      percentBp: 1_000,
      priority: 5
    })

    const updated = promotions.updatePromotion(t.db, owner, {
      id: created.id,
      name: 'Tea (better)',
      kind: 'percent_off',
      percentBp: 2_000
    })

    expect(updated.priority, 'an omitted priority must not silently reshuffle which offer wins').toBe(5)
    expect(updated.percentBp).toBe(2_000)
  })

  it('switches an offer OFF rather than deleting it — last March must still explain itself', () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'Old offer',
      kind: 'percent_off',
      percentBp: 1_000
    })

    const off = promotions.deactivatePromotion(t.db, owner, { id: created.id })

    expect(off.isActive).toBe(false)
    expect(
      t.db.prepare('SELECT COUNT(*) FROM promotions WHERE id = ?').pluck().get(created.id),
      'the row must still be there'
    ).toBe(1)
  })

  it('audits an edit with BOTH before and after — "who changed 10% to 40%" is the whole question', () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'Tea',
      kind: 'percent_off',
      percentBp: 1_000
    })

    promotions.updatePromotion(t.db, owner, {
      id: created.id,
      name: 'Tea',
      kind: 'percent_off',
      percentBp: 4_000
    })

    const row = t.db
      .prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'promotion.update'")
      .get() as { before_json: string; after_json: string }

    expect(JSON.parse(row.before_json).percentBp).toBe(1_000)
    expect(JSON.parse(row.after_json).percentBp).toBe(4_000)
  })

  it('deactivating an already-off offer writes no second audit row', () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'x',
      kind: 'percent_off',
      percentBp: 1_000
    })

    promotions.deactivatePromotion(t.db, owner, { id: created.id })
    promotions.deactivatePromotion(t.db, owner, { id: created.id })

    const count = t.db
      .prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'promotion.deactivate'")
      .pluck()
      .get()

    expect(count, 'nothing changed the second time — an audit of non-events is one nobody reads').toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RULES
// ═════════════════════════════════════════════════════════════════════════════

describe('setRules — what an offer applies to', () => {
  it('replaces the whole set, and an empty set means it applies to NOTHING', () => {
    const productId = makeProduct()
    const created = promotions.createPromotion(t.db, owner, {
      name: 'x',
      kind: 'percent_off',
      percentBp: 1_000
    })

    promotions.setRules(t.db, owner, {
      promotionId: created.id,
      rules: [{ scope: 'product', targetId: productId }]
    })
    expect(promotions.listRules(t.db, { promotionId: created.id })).toHaveLength(1)

    promotions.setRules(t.db, owner, { promotionId: created.id, rules: [] })
    expect(
      promotions.listRules(t.db, { promotionId: created.id }),
      'clearing the rules stops the offer dead — it must not fall back to shop-wide'
    ).toHaveLength(0)
  })

  it('REFUSES a rule pointing at a product that does not exist', () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'x',
      kind: 'percent_off',
      percentBp: 1_000
    })

    expectUserMessage(
      () =>
        promotions.setRules(t.db, owner, {
          promotionId: created.id,
          rules: [{ scope: 'product', targetId: 99_999 }]
        }),
      /could not be found/i
    )
  })

  it('REFUSES a lookup id borrowed from the wrong list', () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'x',
      kind: 'percent_off',
      percentBp: 1_000
    })

    // A payment method's id, used as a category. It would match nothing, forever, with no error.
    const wrongList = lookupId('payment_method', 'cash')

    expectUserMessage(
      () =>
        promotions.setRules(t.db, owner, {
          promotionId: created.id,
          rules: [{ scope: 'category', targetId: wrongList }]
        }),
      /could not be found/i
    )
  })

  it("REFUSES 'all' with a target, and a group scope with none", () => {
    const created = promotions.createPromotion(t.db, owner, {
      name: 'x',
      kind: 'percent_off',
      percentBp: 1_000
    })

    expectUserMessage(
      () =>
        promotions.setRules(t.db, owner, {
          promotionId: created.id,
          rules: [{ scope: 'all', targetId: 1 }]
        }),
      /cannot also name one item/i
    )
    expectUserMessage(
      () =>
        promotions.setRules(t.db, owner, {
          promotionId: created.id,
          rules: [{ scope: 'category' }]
        }),
      /choose which item or group/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// activeFor — the window and the weekday
// ═════════════════════════════════════════════════════════════════════════════

describe('activeFor — which offers are live on a date', () => {
  it('an offer outside its date window is NOT live', () => {
    const productId = makeProduct()
    makeOffer(
      {
        name: 'July sale',
        kind: 'percent_off',
        percentBp: 1_000,
        startsOn: '2026-07-01',
        endsOn: '2026-07-31'
      },
      [{ scope: 'product', targetId: productId }]
    )

    expect(promotions.activeFor(t.db, new Date(2026, 5, 30)), 'the day BEFORE it starts').toHaveLength(0)
    expect(promotions.activeFor(t.db, new Date(2026, 7, 1)), 'the day AFTER it ends').toHaveLength(0)
    expect(promotions.activeFor(t.db, new Date(2026, 6, 15)), 'inside').toHaveLength(1)
  })

  it('the window is INCLUSIVE at both ends — an offer "until the 14th" runs all of the 14th', () => {
    const productId = makeProduct()
    makeOffer(
      {
        name: 'Ends the 14th',
        kind: 'percent_off',
        percentBp: 1_000,
        startsOn: '2026-07-10',
        endsOn: '2026-07-14'
      },
      [{ scope: 'product', targetId: productId }]
    )

    expect(promotions.activeFor(t.db, new Date(2026, 6, 10, 23, 59)), 'the first day').toHaveLength(1)
    expect(promotions.activeFor(t.db, new Date(2026, 6, 14, 23, 59)), 'the last day, late').toHaveLength(1)
  })

  it('an INACTIVE offer is never live', () => {
    const productId = makeProduct()
    const id = makeOffer({ name: 'Off', kind: 'percent_off', percentBp: 1_000 }, [
      { scope: 'product', targetId: productId }
    ])

    expect(promotions.activeFor(t.db, A_MONDAY)).toHaveLength(1)

    promotions.deactivatePromotion(t.db, owner, { id })
    expect(promotions.activeFor(t.db, A_MONDAY), 'switched off is switched off').toHaveLength(0)
  })

  it('orders by priority then id — the order the engine takes the first match in', () => {
    const productId = makeProduct()
    makeOffer({ name: 'Third', kind: 'percent_off', percentBp: 1_000, priority: 50 }, [
      { scope: 'product', targetId: productId }
    ])
    makeOffer({ name: 'First', kind: 'percent_off', percentBp: 1_000, priority: 1 }, [
      { scope: 'product', targetId: productId }
    ])
    makeOffer({ name: 'Second', kind: 'percent_off', percentBp: 1_000, priority: 10 }, [
      { scope: 'product', targetId: productId }
    ])

    expect(promotions.activeFor(t.db, A_MONDAY).map((p) => p.name)).toEqual([
      'First',
      'Second',
      'Third'
    ])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE ENGINE — the arithmetic, on integers only
// ═════════════════════════════════════════════════════════════════════════════

describe('applyTo — percent_off', () => {
  it('takes the percentage off the line’s own extended price', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: '10% off', kind: 'percent_off', percentBp: 1_000 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 3 * ONE_UNIT, RS_100)] // Rs 300
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, '10% of Rs 300 = Rs 30').toBe(3_000)
    expect(results[0]?.promotionName).toBe('10% off')
    holds(lines, results)
  })

  it('percentBp = 10000 is a GIVEAWAY — the whole line off, never a negative price', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Free tin', kind: 'percent_off', percentBp: 10_000 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 2 * ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    // The line rings at its NORMAL price with a 100% discount — that is what "free" IS (0018's header).
    expect(results[0]?.discountMinor, '100% off Rs 200 is Rs 200 off, leaving zero').toBe(20_000)
    expect(lines[0]!.lineAmount - results[0]!.discountMinor, 'the customer pays exactly nothing').toBe(0)
    holds(lines, results)
  })

  it('rounds a fractional paisa ONCE, half up — 10% of Rs 9.99 is 99.9 paisa, and there is no such coin', () => {
    const productId = makeProduct({ retailPrice: 999 })
    makeOffer({ name: '10% off', kind: 'percent_off', percentBp: 1_000 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, 999)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, '99.9 rounds to 100 paisa').toBe(100)
    holds(lines, results)
  })
})

describe('applyTo — amount_off', () => {
  it('takes the amount off EACH UNIT — a 1.5 kg line at Rs 10/unit off is Rs 15', () => {
    const productId = makeProduct({ retailPrice: RS_100, isWeighted: true })
    makeOffer({ name: 'Rs 10 off per kg', kind: 'amount_off', amountMinor: RS_10 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 1_500, RS_100)] // 1.5 kg
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, 'Rs 10 × 1.5 = Rs 15').toBe(1_500)
    holds(lines, results)
  })

  it('a 3-dp weighed quantity stays exact — no float anywhere', () => {
    const productId = makeProduct({ retailPrice: 32_000, isWeighted: true })
    makeOffer({ name: 'Rs 10 off per kg', kind: 'amount_off', amountMinor: RS_10 }, [
      { scope: 'product', targetId: productId }
    ])

    // 1.234 kg at Rs 320/kg — the weighed case shared/pricing.ts is written around.
    const lines = [line(productId, 1_234, 32_000)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(lines[0]!.lineAmount, 'Rs 394.88').toBe(39_488)
    expect(results[0]?.discountMinor, 'Rs 10 × 1.234 = Rs 12.34').toBe(1_234)
    holds(lines, results)
  })

  it('an amount_off BIGGER than the line is capped at the line — never negative', () => {
    const productId = makeProduct({ retailPrice: RS_10 })
    makeOffer({ name: 'Rs 100 off', kind: 'amount_off', amountMinor: RS_100 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, RS_10)] // a Rs 10 line, Rs 100 off
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, 'capped at the line — the till never pays the customer').toBe(RS_10)
    holds(lines, results)
  })
})

describe('applyTo — fixed_price', () => {
  it('the unit sells at the fixed price; the discount is the difference', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Rs 80 each', kind: 'fixed_price', amountMinor: 8_000 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 3 * ONE_UNIT, RS_100)] // Rs 300 -> Rs 240
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, 'Rs 300 − Rs 240 = Rs 60 off').toBe(6_000)
    holds(lines, results)
  })

  it('a fixed price ABOVE the shelf price discounts ZERO — an offer is never a surcharge', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Rs 150 each', kind: 'fixed_price', amountMinor: 15_000 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 2 * ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, 'it must NOT charge more').toBe(0)
    holds(lines, results)
  })
})

describe('applyTo — buy_x_get_y', () => {
  /** Buy 2 get 1 free on `units` whole units of a Rs 100 item. */
  function buy2get1(units: number): promotions.LinePromotionResult[] {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Buy 2 get 1', kind: 'buy_x_get_y', buyQtyM: 2 * ONE_UNIT, getQtyM: ONE_UNIT }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, units * ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)
    holds(lines, results)
    return results
  }

  it('5 units gives exactly ONE free — not 1.67', () => {
    // floor(5000 / 3000) = 1 group. The 2 left over have not earned a second free one.
    expect(buy2get1(5)[0]?.discountMinor, 'ONE free tin, Rs 100').toBe(RS_100)
  })

  it('3 units gives one free', () => {
    expect(buy2get1(3)[0]?.discountMinor).toBe(RS_100)
  })

  it('2 units gives NONE — the group is not complete', () => {
    expect(buy2get1(2)[0]?.discountMinor, 'buying 2 does not earn the third yet').toBe(0)
  })

  it('6 units gives exactly TWO free', () => {
    expect(buy2get1(6)[0]?.discountMinor).toBe(2 * RS_100)
  })

  it('a weighed offer works by the same integer arithmetic — buy 1kg get 500g', () => {
    const productId = makeProduct({ retailPrice: 20_000, isWeighted: true }) // Rs 200/kg
    makeOffer({ name: 'Buy 1kg get 500g', kind: 'buy_x_get_y', buyQtyM: 1_000, getQtyM: 500 }, [
      { scope: 'product', targetId: productId }
    ])

    // 3.2 kg: floor(3200 / 1500) = 2 groups -> 1.0 kg free -> Rs 200 off.
    const lines = [line(productId, 3_200, 20_000)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, '2 groups × 500g = 1kg free at Rs 200/kg').toBe(20_000)
    holds(lines, results)
  })

  it('the free units never exceed the line, even on a lopsided offer', () => {
    // Buy 1 get 3 free — a nonsense offer, but the table permits it and it must not go negative.
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Buy 1 get 3', kind: 'buy_x_get_y', buyQtyM: ONE_UNIT, getQtyM: 3 * ONE_UNIT }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 8 * ONE_UNIT, RS_100)] // floor(8/4) = 2 groups -> 6 free
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor).toBe(6 * RS_100)
    holds(lines, results)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE GATING — every way an offer must NOT fire
// ═════════════════════════════════════════════════════════════════════════════

describe('applyTo — an offer must not fire when it should not', () => {
  it('a promotion with NO RULES fires on NOTHING — the expensive typo 0018 exists to prevent', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    promotions.createPromotion(t.db, owner, {
      name: 'Forgot the rules',
      kind: 'percent_off',
      percentBp: 5_000
    })

    const lines = [line(productId, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0], 'it must NOT have applied shop-wide').toBeNull()
    holds(lines, results)
  })

  it('an INACTIVE offer never fires', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    const id = makeOffer({ name: 'Old', kind: 'percent_off', percentBp: 5_000 }, [
      { scope: 'product', targetId: productId }
    ])

    promotions.deactivatePromotion(t.db, owner, { id })

    const lines = [line(productId, ONE_UNIT, RS_100)]
    expect(promotions.applyTo(t.db, lines, A_MONDAY)[0]).toBeNull()
  })

  it('an offer outside its date window does NOT fire', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer(
      { name: 'July only', kind: 'percent_off', percentBp: 5_000, startsOn: '2026-07-01', endsOn: '2026-07-31' },
      [{ scope: 'product', targetId: productId }]
    )

    const lines = [line(productId, ONE_UNIT, RS_100)]

    expect(promotions.applyTo(t.db, lines, new Date(2026, 7, 5))[0], 'August').toBeNull()
    expect(promotions.applyTo(t.db, lines, new Date(2026, 6, 5))[0], 'July').not.toBeNull()
  })

  it('a SUNDAY offer fires on a real Sunday and NOT on a real Monday', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    // Monday-first mask: index 6 is Sunday.
    makeOffer({ name: 'Sunday special', kind: 'percent_off', percentBp: 2_000, daysMask: '0000001' }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, RS_100)]

    expect(promotions.applyTo(t.db, lines, A_SUNDAY)[0]?.discountMinor, 'Sunday: 20% off').toBe(2_000)
    expect(promotions.applyTo(t.db, lines, A_MONDAY)[0], 'Monday: nothing').toBeNull()
    expect(promotions.applyTo(t.db, lines, A_SATURDAY)[0], 'Saturday: nothing').toBeNull()
  })

  it('a MONDAY offer fires on a real Monday and NOT on a real Sunday', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Monday special', kind: 'percent_off', percentBp: 2_000, daysMask: '1000000' }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, RS_100)]

    expect(promotions.applyTo(t.db, lines, A_MONDAY)[0]?.discountMinor, 'Monday: 20% off').toBe(2_000)
    expect(promotions.applyTo(t.db, lines, A_SUNDAY)[0], 'Sunday: nothing').toBeNull()
  })

  it('an OPEN ITEM can never match — there is no catalog row to test a rule against', () => {
    makeProduct({ retailPrice: RS_100 })
    promotions.createPromotion(t.db, owner, { name: 'Shop-wide', kind: 'percent_off', percentBp: 1_000 })
    const created = promotions.listPromotions(t.db, {}).rows[0]!
    promotions.setRules(t.db, owner, { promotionId: created.id, rules: [{ scope: 'all' }] })

    const lines = [line(null, ONE_UNIT, 50_000)] // "Misc — Rs 500", typed by the cashier
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0], "a shop-wide offer means every STOCKED item, not the cashier's open item").toBeNull()
    holds(lines, results)
  })

  it('an offer on another product does not touch this one', () => {
    const tea = makeProduct({ name: 'Tea', retailPrice: RS_100 })
    const soap = makeProduct({ name: 'Soap', retailPrice: RS_100 })
    makeOffer({ name: 'Tea offer', kind: 'percent_off', percentBp: 5_000 }, [
      { scope: 'product', targetId: tea }
    ])

    const lines = [line(tea, ONE_UNIT, RS_100), line(soap, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor).toBe(5_000)
    expect(results[1], 'soap is not on offer').toBeNull()
    holds(lines, results)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ONE PROMOTION PER LINE — stacking is how a shop sells at a loss
// ═════════════════════════════════════════════════════════════════════════════

describe('applyTo — only ONE promotion ever discounts a line', () => {
  it('two matching offers: only the LOWER priority one applies', () => {
    const productId = makeProduct({ retailPrice: RS_100 })

    makeOffer({ name: 'Big offer', kind: 'percent_off', percentBp: 5_000, priority: 90 }, [
      { scope: 'product', targetId: productId }
    ])
    makeOffer({ name: 'Small offer', kind: 'percent_off', percentBp: 1_000, priority: 10 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    // LOWER priority wins — even though it is the SMALLER discount. Priority is the owner's order,
    // not "whichever is biggest".
    expect(results[0]?.promotionName).toBe('Small offer')
    expect(results[0]?.discountMinor, 'only 10% — NOT 10% then 50% stacked').toBe(1_000)
    holds(lines, results)
  })

  it('a tie on priority breaks by id — the older offer wins, and it is stable', () => {
    const productId = makeProduct({ retailPrice: RS_100 })

    makeOffer({ name: 'Older', kind: 'percent_off', percentBp: 1_000, priority: 50 }, [
      { scope: 'product', targetId: productId }
    ])
    makeOffer({ name: 'Newer', kind: 'percent_off', percentBp: 5_000, priority: 50 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, RS_100)]

    expect(promotions.applyTo(t.db, lines, A_MONDAY)[0]?.promotionName).toBe('Older')
    expect(promotions.applyTo(t.db, lines, A_MONDAY)[0]?.promotionName, 'same answer every time').toBe(
      'Older'
    )
  })

  it('a matched offer that gives nothing still CLAIMS the line — a second offer must not sneak in', () => {
    const productId = makeProduct({ retailPrice: RS_100 })

    // A fixed price ABOVE the shelf price: it matches, and gives 0.
    makeOffer({ name: 'Rs 150 each', kind: 'fixed_price', amountMinor: 15_000, priority: 10 }, [
      { scope: 'product', targetId: productId }
    ])
    makeOffer({ name: 'Half price', kind: 'percent_off', percentBp: 5_000, priority: 20 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.promotionName, 'the first match takes the line').toBe('Rs 150 each')
    expect(results[0]?.discountMinor).toBe(0)
    holds(lines, results)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE GROUP SCOPES
// ═════════════════════════════════════════════════════════════════════════════

describe('applyTo — the group scopes match on the product’s own lookups', () => {
  it('a category offer hits everything in the category and nothing outside it', () => {
    const beverages = makeLookup('category', 'beverages', 'Beverages')
    const cleaning = makeLookup('category', 'cleaning', 'Cleaning')

    const tea = makeProduct({ name: 'Tea', retailPrice: RS_100, categoryId: beverages })
    const coffee = makeProduct({ name: 'Coffee', retailPrice: RS_100, categoryId: beverages })
    const soap = makeProduct({ name: 'Soap', retailPrice: RS_100, categoryId: cleaning })
    const uncategorised = makeProduct({ name: 'Odds', retailPrice: RS_100 })

    makeOffer({ name: '10% off drinks', kind: 'percent_off', percentBp: 1_000 }, [
      { scope: 'category', targetId: beverages }
    ])

    const lines = [
      line(tea, ONE_UNIT, RS_100),
      line(coffee, ONE_UNIT, RS_100),
      line(soap, ONE_UNIT, RS_100),
      line(uncategorised, ONE_UNIT, RS_100)
    ]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor).toBe(1_000)
    expect(results[1]?.discountMinor).toBe(1_000)
    expect(results[2], 'cleaning is not on offer').toBeNull()
    expect(results[3], 'a product with NO category must not match a category rule').toBeNull()
    holds(lines, results)
  })

  it("an 'all' rule is a shop-wide sale — every stocked item", () => {
    const tea = makeProduct({ name: 'Tea', retailPrice: RS_100 })
    const soap = makeProduct({ name: 'Soap', retailPrice: RS_100 })

    makeOffer({ name: 'Everything 5% off', kind: 'percent_off', percentBp: 500 }, [{ scope: 'all' }])

    const lines = [line(tea, ONE_UNIT, RS_100), line(soap, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor).toBe(500)
    expect(results[1]?.discountMinor).toBe(500)
    holds(lines, results)
  })

  it('the rules of ONE offer are an OR — "tea OR anything in Cleaning"', () => {
    const cleaning = makeLookup('category', 'cleaning', 'Cleaning')
    const tea = makeProduct({ name: 'Tea', retailPrice: RS_100 })
    const soap = makeProduct({ name: 'Soap', retailPrice: RS_100, categoryId: cleaning })
    const other = makeProduct({ name: 'Other', retailPrice: RS_100 })

    makeOffer({ name: 'Mixed offer', kind: 'percent_off', percentBp: 1_000 }, [
      { scope: 'product', targetId: tea },
      { scope: 'category', targetId: cleaning }
    ])

    const lines = [line(tea, ONE_UNIT, RS_100), line(soap, ONE_UNIT, RS_100), line(other, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.discountMinor, 'matched by the product rule').toBe(1_000)
    expect(results[1]?.discountMinor, 'matched by the category rule').toBe(1_000)
    expect(results[2]).toBeNull()
    holds(lines, results)
  })

  it('a brand offer and a department offer match their own columns', () => {
    const brand = makeLookup('brand', 'tapal', 'Tapal')
    const department = makeLookup('department', 'grocery', 'Grocery')

    const branded = makeProduct({ name: 'Tapal Tea', retailPrice: RS_100, brandId: brand })
    const departmental = makeProduct({ name: 'Rice', retailPrice: RS_100, departmentId: department })

    makeOffer({ name: 'Brand offer', kind: 'percent_off', percentBp: 1_000, priority: 1 }, [
      { scope: 'brand', targetId: brand }
    ])
    makeOffer({ name: 'Department offer', kind: 'percent_off', percentBp: 2_000, priority: 2 }, [
      { scope: 'department', targetId: department }
    ])

    const lines = [line(branded, ONE_UNIT, RS_100), line(departmental, ONE_UNIT, RS_100)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(results[0]?.promotionName).toBe('Brand offer')
    expect(results[1]?.promotionName).toBe('Department offer')
    holds(lines, results)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// APPORTIONMENT — sum-of-rounded is not round-of-sum
// ═════════════════════════════════════════════════════════════════════════════

describe('the discount sums back EXACTLY — no sum-of-rounded drift', () => {
  it('a buy_x_get_y discount is exactly what the free units are charged at', () => {
    // The identity that matters: the discount must equal the extended price of the free quantity,
    // computed by the SAME function that extended the line. If the engine computed the free units'
    // price a different way, a 3-dp quantity would drift a paisa and the line would not go to zero.
    const productId = makeProduct({ retailPrice: 33_333 })
    makeOffer({ name: 'Buy 2 get 1', kind: 'buy_x_get_y', buyQtyM: 2 * ONE_UNIT, getQtyM: ONE_UNIT }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 9 * ONE_UNIT, 33_333)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    // 3 groups -> 3 free units.
    expect(results[0]?.discountMinor).toBe(extendPrice(33_333, 3 * ONE_UNIT))
    // And the customer pays for exactly the 6 they bought — no paisa lost or invented.
    expect(lines[0]!.lineAmount - results[0]!.discountMinor).toBe(extendPrice(33_333, 6 * ONE_UNIT))
    holds(lines, results)
  })

  it('a 100% offer takes the line to EXACTLY zero on an awkward weighed price', () => {
    const productId = makeProduct({ retailPrice: 33_333, isWeighted: true })
    makeOffer({ name: 'Free', kind: 'percent_off', percentBp: 10_000 }, [
      { scope: 'product', targetId: productId }
    ])

    const lines = [line(productId, 1_234, 33_333)]
    const results = promotions.applyTo(t.db, lines, A_MONDAY)

    expect(
      lines[0]!.lineAmount - results[0]!.discountMinor,
      'a giveaway must leave EXACTLY zero, not one paisa'
    ).toBe(0)
    holds(lines, results)
  })

  it('every discount over a thousand random lines is an integer inside [0, lineAmount]', () => {
    // The property, not the example: this is the one place a rupee could quietly go missing on every
    // discounted sale in the shop's history.
    const productId = makeProduct({ retailPrice: RS_100 })
    makeOffer({ name: 'Buy 2 get 1', kind: 'buy_x_get_y', buyQtyM: 2 * ONE_UNIT, getQtyM: ONE_UNIT }, [
      { scope: 'product', targetId: productId }
    ])

    const lines: PromotableLine[] = []
    for (let i = 0; i < 1_000; i++) {
      const qtyM = 1 + Math.floor(Math.random() * 20_000) // 0.001 to 20 units
      const unitPrice = 1 + Math.floor(Math.random() * 100_000)
      lines.push(line(productId, qtyM, unitPrice))
    }

    holds(lines, promotions.applyTo(t.db, lines, A_MONDAY))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// LISTING and RBAC
// ═════════════════════════════════════════════════════════════════════════════

describe('listPromotions', () => {
  it('paginates, and filters to the live ones', () => {
    for (let i = 0; i < 5; i++) {
      promotions.createPromotion(t.db, owner, {
        name: `Offer ${i}`,
        kind: 'percent_off',
        percentBp: 1_000,
        priority: i
      })
    }

    const first = promotions.listPromotions(t.db, { page: 1, pageSize: 2 })
    expect(first.total).toBe(5)
    expect(first.rows).toHaveLength(2)
    expect(first.rows.map((r) => r.name), 'ordered the way the engine resolves them').toEqual([
      'Offer 0',
      'Offer 1'
    ])

    promotions.deactivatePromotion(t.db, owner, { id: first.rows[0]!.id })

    expect(promotions.listPromotions(t.db, { isActive: true }).total).toBe(4)
    expect(promotions.listPromotions(t.db, { isActive: false }).total).toBe(1)
  })

  it('searches by name', () => {
    promotions.createPromotion(t.db, owner, { name: 'Sunday tea', kind: 'percent_off', percentBp: 1_000 })
    promotions.createPromotion(t.db, owner, { name: 'Soap deal', kind: 'percent_off', percentBp: 1_000 })

    expect(promotions.listPromotions(t.db, { search: 'tea' }).total).toBe(1)
  })
})

describe('RBAC', () => {
  it('running an offer is a MANAGER’s call; reading them is a cashier’s', () => {
    expect(PERMISSIONS['promotion.manage']).toBe('manager')
    expect(PERMISSIONS['promotion.view']).toBe('cashier')
  })
})

describe('getPromotion', () => {
  it('a missing offer fails with a message a shopkeeper reads, not a stack trace', () => {
    expectUserMessage(() => promotions.getPromotion(t.db, { id: 99_999 }), /could not be found/i)
  })
})
