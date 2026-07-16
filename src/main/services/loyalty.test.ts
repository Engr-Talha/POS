import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as loyalty from './loyalty'
import * as ledger from './ledger'
import * as settings from './settings'
import { ACC } from '../db/chart-of-accounts'
import type { User } from '@shared/types'

/**
 * THE LOYALTY SERVICE — what the shop owes its regulars, booked as a LIABILITY the moment it is promised.
 * (Migration 0017, whose header is the spec.)
 *
 * TWO STANDING ASSERTIONS RUN AFTER EVERY SCENARIO (see `holds`):
 *
 *   1. THE TRIAL BALANCE BALANCES.                          (CLAUDE.md §4 — the engine's standing test)
 *   2. Σ(every customer's points × the rate they were BOOKED at) === GL ACC.LOYALTY.
 *
 * The second is the one that makes the first mean something here. A trial balance balances just as
 * happily when loyalty posts nothing at all, or posts to the wrong account — what it cannot survive is
 * the points and the ledger disagreeing about what the shop owes.
 *
 * Note what assertion 2 uses: the FROZEN value on each movement, NOT today's setting. Σ(points × TODAY's
 * rate) is what the customer is offered, not what the books hold, and after a rate change the two
 * legitimately differ — that is decision 3 in the service header, and it is tested head-on below.
 */

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertions
// ═════════════════════════════════════════════════════════════════════════════

function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

/**
 * What the BOOKS carry for every unspent point, derived the same way the service releases it: FIFO over
 * each customer's own movements at their FROZEN rates. This is the mirror of `bookedValueOfOldestPoints`
 * — deliberately written a second time, from the movements alone, so it would catch that function
 * getting it wrong rather than agreeing with it.
 */
function bookedLiability(t: TestDb): number {
  const customers = t.db
    .prepare('SELECT DISTINCT customer_id AS id FROM loyalty_movements')
    .all() as Array<{ id: number }>

  let total = 0

  for (const customer of customers) {
    const rows = t.db
      .prepare(
        `SELECT points, value_minor AS valueMinor FROM loyalty_movements
          WHERE customer_id = ? ORDER BY at ASC, id ASC`
      )
      .all(customer.id) as Array<{ points: number; valueMinor: number }>

    const layers: Array<{ points: number; valueMinor: number }> = []
    let consumed = 0

    for (const row of rows) {
      if (row.points > 0) layers.push({ points: row.points, valueMinor: row.valueMinor })
      else consumed += -row.points
    }

    for (const layer of layers) {
      if (consumed <= 0) break
      const take = Math.min(consumed, layer.points)
      const takeValue =
        take >= layer.points ? layer.valueMinor : Math.floor((layer.valueMinor * take) / layer.points)
      layer.points -= take
      layer.valueMinor -= takeValue
      consumed -= take
    }

    for (const layer of layers) total += layer.valueMinor
  }

  return total
}

/**
 * THE INVARIANT THAT MATTERS: what the points say the shop owes === what the ledger says it owes.
 * ACC.LOYALTY is a liability, so `accountBalance` returns it credit-natured — positive means "owed".
 */
function assertPointsMatchLedger(t: TestDb): void {
  const gl = ledger.accountBalance(t.db, ACC.LOYALTY)
  expect(bookedLiability(t), 'POINTS AND THE GENERAL LEDGER DISAGREE ABOUT WHAT THE SHOP OWES').toBe(gl)
}

function holds(t: TestDb): void {
  assertBooksBalance(t)
  assertPointsMatchLedger(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures — mirrors the sibling service tests so the files read the same way
// ═════════════════════════════════════════════════════════════════════════════

/** A fixed instant so date-range assertions are timezone-independent. */
const NOW = new Date('2026-07-15T10:00:00.000Z')

/** A movement dated to `iso` at a fixed UTC instant — deterministic across machines. */
const at = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`)

let t: TestDb
let owner: User
let cashier: User
let alice: number

function pinOf(username: string): string {
  let hash = 0
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) % 900000
  return String(100000 + hash)
}

function makeUser(role: User['role'], username: string, fullName: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, pin_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`
      )
      .run(username, fullName, role, hashSecret(pinOf(username)), now, now).lastInsertRowid
  )
  return { id, username, fullName, role, hasPin: true, isActive: true }
}

function makeCustomer(name: string): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)`
      )
      .run(name, now, now).lastInsertRowid
  )
}

/** Loyalty ON, at the registry defaults: 1 pt per rupee, Rs 1.00 a point, 100 points before spending. */
function enableLoyalty(overrides: Record<string, unknown> = {}): void {
  settings.set(t.db, 'loyalty.enabled', true)
  for (const [key, value] of Object.entries(overrides)) settings.set(t.db, key, value)
}

/** Points earned, without needing a real sale — this service is tested on its own. */
function earn(customerId: number, netAmount: number, saleId = 1, now = NOW) {
  return loyalty.earnForSale(t.db, cashier, { customerId, saleId, netAmount }, now)
}

const glLoyalty = (): number => ledger.accountBalance(t.db, ACC.LOYALTY)
const glExpense = (): number => ledger.accountBalance(t.db, ACC.LOYALTY_EXPENSE)

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'The Owner')
  cashier = makeUser('cashier', 'cashier', 'A Cashier')
  alice = makeCustomer('Alice')
})

afterEach(() => t.cleanup())

// ═════════════════════════════════════════════════════════════════════════════
// EARNING — the liability is booked AT EARN TIME, or the P&L is a lie
// ═════════════════════════════════════════════════════════════════════════════

describe('earning points', () => {
  it('books the liability AT EARN TIME — not at redemption', () => {
    enableLoyalty()

    // Rs 500.00 net → 500 points → Rs 500.00 owed.
    const movement = earn(alice, 50000)

    expect(movement?.points).toBe(500)
    expect(movement?.valueMinor).toBe(50000)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(500)

    // THE POINT OF THE WHOLE DESIGN: the promise is on the books already, before anyone redeems.
    // DR Loyalty Expense / CR Loyalty Liability — the cost is recognised in the P&L of the month the
    // points were given, not the month they happen to be spent.
    expect(glLoyalty()).toBe(50000)
    expect(glExpense()).toBe(50000)

    holds(t)
  })

  it('earns nothing for a WALK-IN — there is no customer to owe it to', () => {
    enableLoyalty()

    // A walk-in has no customer id at all, so the sale simply never calls this service. What must not
    // happen is a liability owed to a customer who does not exist — nobody could ever claim it, and
    // nobody could ever settle it (migration 0017).
    expectUserMessage(
      () => earn(9999, 50000),
      /customer could not be found/i
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM loyalty_movements').pluck().get()).toBe(0)
    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  it('posts NOTHING ANYWHERE when loyalty is switched off', () => {
    // The default. The shop has not turned points on, so a sale makes no promise.
    const movement = earn(alice, 50000)

    expect(movement).toBeNull()
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    // Not a movement, not a journal, not a paisa of liability. A null is the honest answer, not a failure.
    expect(t.db.prepare('SELECT COUNT(*) FROM loyalty_movements').pluck().get()).toBe(0)
    expect(t.db.prepare("SELECT COUNT(*) FROM journals WHERE ref_type = 'loyalty'").pluck().get()).toBe(0)
    expect(glLoyalty()).toBe(0)
    expect(glExpense()).toBe(0)
    holds(t)
  })

  it('FLOORS to whole points — a fraction of a promise is never made', () => {
    enableLoyalty()

    // Rs 149.99 at 1 pt/rupee = 149.99 points → 149. Never 150: rounding up would invent liability the
    // sale did not earn.
    const movement = earn(alice, 14999)

    expect(movement?.points).toBe(149)
    expect(movement?.valueMinor).toBe(14900)
    expect(glLoyalty()).toBe(14900)
    holds(t)
  })

  it('earns NOTHING on a spend too small to make one whole point', () => {
    enableLoyalty() // 1 pt per rupee

    // Rs 0.99 at 1 pt/rupee = 0.99 points → 0. A movement that moves nothing is not an event
    // (0017: CHECK points <> 0), so nothing is written and nothing is posted. A null, not a crash.
    expect(earn(alice, 99)).toBeNull()
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM loyalty_movements').pluck().get()).toBe(0)

    // ...and a sale of nothing earns nothing, rather than dividing its way to a NaN.
    expect(earn(alice, 0)).toBeNull()

    holds(t)
  })

  it('earns nothing when the owner sets the points rate to zero — the scheme is on, but gives nothing', () => {
    // The registry enforces WHOLE numbers for `loyalty.pointsPerCurrencyUnit` (settings-registry.ts:
    // "Integers only, everywhere"), so 0 is the only way to run the scheme without giving points.
    enableLoyalty({ 'loyalty.pointsPerCurrencyUnit': 0 })

    expect(earn(alice, 100000)).toBeNull()
    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  it('a whole-number rate multiplies, and still floors', () => {
    enableLoyalty({ 'loyalty.pointsPerCurrencyUnit': 3 }) // 3 points a rupee

    // Rs 10.50 → 10.5 rupees × 3 = 31.5 points → 31. The floor bites on the RESULT, not on the rupees:
    // flooring the rupees first would give 30 and quietly short the customer a point and a half.
    expect(earn(alice, 1050)?.points).toBe(31)
    holds(t)
  })

  it('values points at the CURRENT rate and freezes it onto the movement', () => {
    enableLoyalty({ 'loyalty.redeemValueMinor': 250 }) // Rs 2.50 a point

    const movement = earn(alice, 10000) // Rs 100 → 100 points
    expect(movement?.points).toBe(100)
    expect(movement?.valueMinor).toBe(25000) // 100 × Rs 2.50
    expect(glLoyalty()).toBe(25000)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// READING — the balance is DERIVED, never stored
// ═════════════════════════════════════════════════════════════════════════════

describe('reading a balance', () => {
  it('derives the balance from the movements, and values it at TODAY rate', () => {
    enableLoyalty()
    earn(alice, 30000) // 300 pt
    earn(alice, 20000, 2) // 200 pt

    expect(loyalty.pointsBalance(t.db, alice)).toBe(500)
    expect(loyalty.pointsValue(t.db, alice)).toBe(50000) // 500 × Rs 1.00

    // There is no customers.points column and there never will be (CLAUDE.md §4). Proof: the balance is
    // SUM(movements) and nothing else — delete the movements and the balance is gone with them.
    const columns = t.db.prepare('PRAGMA table_info(customers)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain('points')

    holds(t)
  })

  it('a customer with no movements has no points', () => {
    enableLoyalty()
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    expect(loyalty.pointsValue(t.db, alice)).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REDEEMING — a TENDER, settling the liability by the paisa it was booked at
// ═════════════════════════════════════════════════════════════════════════════

describe('redeeming points', () => {
  it('settles the liability by the SAME PAISA it was booked at, and leaves it at zero', () => {
    enableLoyalty()
    earn(alice, 50000) // 500 pt, Rs 500 booked
    expect(glLoyalty()).toBe(50000)

    const redemption = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 500 })

    // The sale tenders MAIN's figure — never one the renderer worked out.
    expect(redemption.valueMinor).toBe(50000)
    expect(redemption.points).toBe(-500)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)

    // The legs the SALE will post. The redemption itself posts NO journal: the DR to the liability is
    // the sale's tender leg, and it belongs in the sale's own balanced journal (exactly like cash).
    const lines = loyalty.journalLines(redemption)
    expect(lines).toEqual([{ account: ACC.LOYALTY, debit: 50000 }])

    // Post them the way sales.complete will — against the revenue this tender paid for — and the
    // liability lands EXACTLY on zero. Booked at Rs 500, settled for Rs 500.
    ledger.post(t.db, {
      at: NOW,
      refType: 'sale',
      refId: 2,
      memo: 'sale paid with points',
      lines: [...lines, { account: ACC.SALES, credit: 50000 }]
    })

    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  it('refuses MORE points than the customer has', () => {
    enableLoyalty()
    earn(alice, 30000) // 300 pt

    expectUserMessage(
      () => loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 301 }),
      /only has 300 points/i
    )

    // Refused means nothing happened: the points are untouched and no movement was written.
    expect(loyalty.pointsBalance(t.db, alice)).toBe(300)
    expect(t.db.prepare("SELECT COUNT(*) FROM loyalty_movements WHERE type = 'redeem'").pluck().get()).toBe(0)
    holds(t)
  })

  it('refuses BELOW loyalty.minPointsToRedeem — the floor is a setting, not a literal', () => {
    enableLoyalty({ 'loyalty.minPointsToRedeem': 100 })
    earn(alice, 9900) // 99 pt — earned, but not yet spendable

    expectUserMessage(
      () => loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 99 }),
      /100 at a time or more/i
    )
    expect(loyalty.pointsBalance(t.db, alice)).toBe(99)

    // ...and the floor MOVES when the owner moves it. Same points, same call, now allowed — proof the
    // rule is the setting and not a constant compiled into the service.
    settings.set(t.db, 'loyalty.minPointsToRedeem', 50)
    const redemption = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 99 })
    expect(redemption.valueMinor).toBe(9900)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)

    ledger.post(t.db, {
      at: NOW,
      refType: 'sale',
      refId: 2,
      memo: 'sale paid with points',
      lines: [...loyalty.journalLines(redemption), { account: ACC.SALES, credit: 9900 }]
    })
    holds(t)
  })

  it('refuses when loyalty is switched OFF, even to a customer holding points', () => {
    // Points earned while it was on...
    enableLoyalty()
    earn(alice, 50000)

    // ...and the owner switches it off. The points remain (their data is never taken away), but they
    // cannot be spent while the scheme is off.
    settings.set(t.db, 'loyalty.enabled', false)

    expectUserMessage(
      () => loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 500 }),
      /switched off/i
    )
    expect(loyalty.pointsBalance(t.db, alice)).toBe(500)
    holds(t)
  })

  it('refuses a non-positive number of points', () => {
    enableLoyalty()
    earn(alice, 50000)

    expectUserMessage(
      () => loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 0 }),
      /greater than zero/i
    )
    expectUserMessage(
      () => loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: -100 }),
      /greater than zero/i
    )
    // A fractional point is not a point.
    expectUserMessage(
      () => loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 10.5 }),
      /whole number/i
    )

    expect(loyalty.pointsBalance(t.db, alice)).toBe(500)
    holds(t)
  })

  it('a PARTIAL redemption leaves exactly the unspent points on the books', () => {
    enableLoyalty()
    earn(alice, 50000) // 500 pt, Rs 500

    const redemption = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 200 })
    ledger.post(t.db, {
      at: NOW,
      refType: 'sale',
      refId: 2,
      memo: 'sale paid with points',
      lines: [...loyalty.journalLines(redemption), { account: ACC.SALES, credit: 20000 }]
    })

    expect(loyalty.pointsBalance(t.db, alice)).toBe(300)
    expect(glLoyalty()).toBe(30000) // Rs 300 still owed
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RATE CHANGE — the one that breaks a naive implementation
// ═════════════════════════════════════════════════════════════════════════════

describe('changing loyalty.redeemValueMinor after points were earned', () => {
  it('does NOT rewrite the frozen history', () => {
    enableLoyalty({ 'loyalty.redeemValueMinor': 100 }) // Rs 1.00 a point
    const earned = earn(alice, 10000) // 100 pt, booked at Rs 100

    expect(earned?.valueMinor).toBe(10000)
    expect(glLoyalty()).toBe(10000)

    // The owner doubles what a point is worth.
    settings.set(t.db, 'loyalty.redeemValueMinor', 200) // Rs 2.00 a point

    // THE OLD MOVEMENT IS UNTOUCHED. Its value_minor is what the books said the shop owed that day, and
    // no setting reaches back and rewrites history (migration 0017).
    const row = t.db
      .prepare('SELECT value_minor AS valueMinor FROM loyalty_movements WHERE id = ?')
      .get(earned!.id) as { valueMinor: number }
    expect(row.valueMinor).toBe(10000)

    // The LEDGER is untouched too — changing a setting is not a business event and posts nothing.
    expect(glLoyalty()).toBe(10000)

    // But what the customer is OFFERED today has doubled: the balance is worth the CURRENT rate.
    expect(loyalty.pointsValue(t.db, alice)).toBe(20000)

    holds(t)
  })

  it('redeeming at a HIGHER rate: the customer gets today rate, the extra is a NEW expense, and the books stay balanced', () => {
    enableLoyalty({ 'loyalty.redeemValueMinor': 100 })
    earn(alice, 10000) // 100 pt, booked at Rs 100

    const expenseAtEarn = glExpense()
    expect(expenseAtEarn).toBe(10000)

    settings.set(t.db, 'loyalty.redeemValueMinor', 200) // the owner doubles it

    const redemption = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 100 })

    // THE DECISION (service header, decision 3): the customer gets TODAY's promise — Rs 200 of goods.
    expect(redemption.valueMinor).toBe(20000)
    // ...but the liability only ever carried Rs 100, so that is all there is to release.
    expect(redemption.bookedMinor).toBe(10000)
    // The other Rs 100 is what the owner's rate rise costs, incurred NOW — a fresh expense, not a
    // settlement of something the books already recorded.
    expect(redemption.rateDelta).toBe(10000)

    const lines = loyalty.journalLines(redemption)
    expect(lines).toEqual([
      { account: ACC.LOYALTY, debit: 10000 }, // release exactly what was booked
      { account: ACC.LOYALTY_EXPENSE, debit: 10000 } // the rate rise, expensed today
    ])

    // The sale tenders Rs 200 of goods against those two legs — and it balances.
    ledger.post(t.db, {
      at: NOW,
      refType: 'sale',
      refId: 2,
      memo: 'sale paid with points',
      lines: [...lines, { account: ACC.SALES, credit: 20000 }]
    })

    // THE LIABILITY LANDS ON ZERO — not negative, which is what settling Rs 200 against a Rs 100
    // liability would have done, and which would have broken the points-vs-ledger invariant for good.
    expect(glLoyalty()).toBe(0)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    // The cost of the rate change lands in the P&L of the month the owner changed it: Rs 100 + Rs 100.
    expect(glExpense()).toBe(20000)

    holds(t)
  })

  it('redeeming at a LOWER rate: the surplus is a promise released, and the books stay balanced', () => {
    enableLoyalty({ 'loyalty.redeemValueMinor': 200 }) // Rs 2.00 a point
    earn(alice, 10000) // 100 pt, booked at Rs 200
    expect(glLoyalty()).toBe(20000)

    settings.set(t.db, 'loyalty.redeemValueMinor', 100) // the owner halves it

    const redemption = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 2, points: 100 })

    expect(redemption.valueMinor).toBe(10000) // the customer gets today's rate: Rs 100
    expect(redemption.bookedMinor).toBe(20000) // the books held Rs 200
    expect(redemption.rateDelta).toBe(-10000) // Rs 100 the shop no longer has to hand over

    const lines = loyalty.journalLines(redemption)
    expect(lines).toEqual([
      { account: ACC.LOYALTY, debit: 20000 }, // release everything that was booked
      { account: ACC.LOYALTY_EXPENSE, credit: 10000 } // ...and give the surplus back to the P&L
    ])

    ledger.post(t.db, {
      at: NOW,
      refType: 'sale',
      refId: 2,
      memo: 'sale paid with points',
      lines: [...lines, { account: ACC.SALES, credit: 10000 }]
    })

    expect(glLoyalty()).toBe(0) // exactly zero again
    expect(glExpense()).toBe(10000) // Rs 200 charged, Rs 100 released — net cost Rs 100
    holds(t)
  })

  it('releases points FIFO at the rate EACH was booked at, so a partial redemption never over-releases', () => {
    // Two earns at two different rates — the case that makes an average wrong.
    enableLoyalty({ 'loyalty.redeemValueMinor': 100 })
    earn(alice, 10000, 1, at('2026-07-01')) // 100 pt @ Rs 1.00 = Rs 100

    settings.set(t.db, 'loyalty.redeemValueMinor', 300)
    earn(alice, 10000, 2, at('2026-07-02')) // 100 pt @ Rs 3.00 = Rs 300

    expect(glLoyalty()).toBe(40000) // Rs 400 owed in total
    expect(loyalty.pointsBalance(t.db, alice)).toBe(200)

    // Redeem 100 — the OLDEST 100, which the books carry at Rs 100, not at the Rs 300 of the newer batch
    // and not at an averaged Rs 200.
    const first = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 3, points: 100 })
    expect(first.bookedMinor).toBe(10000)
    ledger.post(t.db, {
      at: NOW, refType: 'sale', refId: 3, memo: 'points',
      lines: [...loyalty.journalLines(first), { account: ACC.SALES, credit: first.valueMinor }]
    })

    expect(glLoyalty()).toBe(30000) // exactly the newer batch's Rs 300 remains
    holds(t)

    // Redeem the rest — the Rs 300 batch — and the liability lands on zero. If the first redemption had
    // over-released, this one could not.
    const second = loyalty.redeemForSale(t.db, cashier, { customerId: alice, saleId: 4, points: 100 })
    expect(second.bookedMinor).toBe(30000)
    ledger.post(t.db, {
      at: NOW, refType: 'sale', refId: 4, memo: 'points',
      lines: [...loyalty.journalLines(second), { account: ACC.SALES, credit: second.valueMinor }]
    })

    expect(glLoyalty()).toBe(0)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// EXPIRING — a promise released
// ═════════════════════════════════════════════════════════════════════════════

describe('expiring points', () => {
  it('RELEASES the liability and credits the expense back', () => {
    enableLoyalty()
    earn(alice, 50000) // 500 pt, Rs 500
    expect(glExpense()).toBe(50000)

    const movement = loyalty.expirePoints(t.db, owner, { customerId: alice, points: 500 }, NOW)

    expect(movement.points).toBe(-500)
    expect(movement.valueMinor).toBe(50000)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)

    // DR the liability, CR the expense: the shop is off the hook, and the cost it charged itself when it
    // made the promise is given back to the P&L.
    expect(glLoyalty()).toBe(0)
    expect(glExpense()).toBe(0)
    holds(t)
  })

  it('is AUDITED — points taken off a customer is evidence', () => {
    enableLoyalty()
    earn(alice, 50000)
    loyalty.expirePoints(t.db, owner, { customerId: alice, points: 500 }, NOW)

    const entry = t.db
      .prepare("SELECT user_name, user_role, action, entity_id FROM audit_log WHERE action = 'loyalty.expire'")
      .get() as { user_name: string; user_role: string; action: string; entity_id: string }

    // WHO did WHAT and WHEN — with the role copied in at the time (CLAUDE.md §4).
    expect(entry.user_name).toBe('The Owner')
    expect(entry.user_role).toBe('owner')
    expect(entry.entity_id).toBe(String(alice))
    holds(t)
  })

  it('has NO minimum — points age out below the redeem floor too', () => {
    enableLoyalty({ 'loyalty.minPointsToRedeem': 100 })
    earn(alice, 5000) // 50 pt — below the floor, so they can never be spent...

    // ...but they can still expire. Otherwise a customer with 99 points is owed them forever and the
    // liability never leaves the books. (Decision 4.)
    loyalty.expirePoints(t.db, owner, { customerId: alice, points: 50 }, NOW)

    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  it('refuses to expire more points than the customer has', () => {
    enableLoyalty()
    earn(alice, 10000) // 100 pt

    expectUserMessage(
      () => loyalty.expirePoints(t.db, owner, { customerId: alice, points: 101 }, NOW),
      /only has 100 points/i
    )
    expect(loyalty.pointsBalance(t.db, alice)).toBe(100)
    holds(t)
  })

  it('releases at the rate the points were BOOKED at, not today rate', () => {
    enableLoyalty({ 'loyalty.redeemValueMinor': 100 })
    earn(alice, 10000) // 100 pt, booked at Rs 100

    settings.set(t.db, 'loyalty.redeemValueMinor', 500) // the owner raises it, then they expire

    loyalty.expirePoints(t.db, owner, { customerId: alice, points: 100 }, NOW)

    // Rs 100 was booked, so Rs 100 is released — expiring at today's Rs 500 would have driven the
    // liability to MINUS Rs 400 and left the books lying about what the shop owes.
    expect(glLoyalty()).toBe(0)
    expect(glExpense()).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ADJUSTING — the owner's correction. Needs a LIVE reason, always audited.
// ═════════════════════════════════════════════════════════════════════════════

describe('adjusting points by hand', () => {
  it('GIVING points books a new promise at today rate', () => {
    enableLoyalty()

    const movement = loyalty.adjustPoints(
      t.db,
      owner,
      { customerId: alice, points: 250, reasonCode: 'data_entry', reasonText: 'Missed on a receipt' },
      NOW
    )

    expect(movement.points).toBe(250)
    expect(movement.valueMinor).toBe(25000)
    expect(movement.reasonCode).toBe('data_entry')
    expect(loyalty.pointsBalance(t.db, alice)).toBe(250)

    // A new promise: DR the expense, CR the liability — the same journal an earn posts.
    expect(glLoyalty()).toBe(25000)
    expect(glExpense()).toBe(25000)
    holds(t)
  })

  it('TAKING points back releases exactly what the books hold', () => {
    enableLoyalty()
    earn(alice, 30000) // 300 pt, Rs 300

    const movement = loyalty.adjustPoints(
      t.db,
      owner,
      { customerId: alice, points: -100, reasonCode: 'data_entry' },
      NOW
    )

    expect(movement.points).toBe(-100)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(200)
    expect(glLoyalty()).toBe(20000)
    holds(t)
  })

  it('REQUIRES a reason validated against the LIVE lookups list', () => {
    enableLoyalty()

    // Not on the list at all.
    expectUserMessage(
      () => loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 100, reasonCode: 'because_i_said_so' }, NOW),
      /choose a reason/i
    )

    // Missing entirely.
    expectUserMessage(
      () => loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 100, reasonCode: '' }, NOW),
      /choose a reason/i
    )

    // On a DIFFERENT list — a valid code, but not an adjustment reason. The list_key filter is what
    // catches this.
    expectUserMessage(
      () => loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 100, reasonCode: 'cash' }, NOW),
      /choose a reason/i
    )

    // RETIRED — it was a real reason once, but the owner has since removed it from the list. "Live"
    // means live: a code that is no longer offered cannot be used.
    t.db.prepare("UPDATE lookups SET is_active = 0 WHERE list_key = 'adjustment_reason' AND code = 'theft'").run()
    expectUserMessage(
      () => loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 100, reasonCode: 'theft' }, NOW),
      /choose a reason/i
    )

    // Nothing was written by any of those.
    expect(t.db.prepare('SELECT COUNT(*) FROM loyalty_movements').pluck().get()).toBe(0)
    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    holds(t)
  })

  it('is AUDITED with the reason, the balance before and the balance after', () => {
    enableLoyalty()
    earn(alice, 10000) // 100 pt

    loyalty.adjustPoints(
      t.db,
      owner,
      { customerId: alice, points: 50, reasonCode: 'data_entry', reasonText: 'Goodwill' },
      NOW
    )

    const entry = t.db
      .prepare(
        `SELECT user_name, user_role, reason_code, reason_text, before_json, after_json
           FROM audit_log WHERE action = 'loyalty.adjust'`
      )
      .get() as Record<string, string>

    expect(entry['user_name']).toBe('The Owner')
    expect(entry['user_role']).toBe('owner')
    expect(entry['reason_code']).toBe('data_entry')
    expect(entry['reason_text']).toBe('Goodwill')
    expect(JSON.parse(entry['before_json']!)).toMatchObject({ points: 100 })
    expect(JSON.parse(entry['after_json']!)).toMatchObject({ points: 50, balanceAfter: 150 })
    holds(t)
  })

  it('refuses to take a balance NEGATIVE — the shop cannot owe less than nothing', () => {
    enableLoyalty()
    earn(alice, 10000) // 100 pt

    expectUserMessage(
      () => loyalty.adjustPoints(t.db, owner, { customerId: alice, points: -101, reasonCode: 'data_entry' }, NOW),
      /only has 100 points/i
    )
    expect(loyalty.pointsBalance(t.db, alice)).toBe(100)
    holds(t)
  })

  it('refuses a ZERO adjustment — a movement that moves nothing is not an event', () => {
    enableLoyalty()
    expectUserMessage(
      () => loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 0, reasonCode: 'data_entry' }, NOW),
      /other than zero/i
    )
    holds(t)
  })

  it('works while loyalty is switched OFF — a correction is not a new promise the scheme makes', () => {
    // Deliberate: the scheme being off must not trap a liability the shop already owes. An owner who
    // switches points off still has to be able to correct what is on the books.
    enableLoyalty()
    earn(alice, 10000)
    settings.set(t.db, 'loyalty.enabled', false)

    loyalty.adjustPoints(t.db, owner, { customerId: alice, points: -100, reasonCode: 'data_entry' }, NOW)

    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    expect(glLoyalty()).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HISTORY — paginated, filtered, and honest about dates
// ═════════════════════════════════════════════════════════════════════════════

describe('the points history', () => {
  it('paginates, newest first', () => {
    enableLoyalty()
    for (let day = 1; day <= 5; day += 1) {
      earn(alice, 10000, day, at(`2026-07-0${day}`))
    }

    const page1 = loyalty.history(t.db, { customerId: alice, page: 1, pageSize: 2 })
    expect(page1.total).toBe(5)
    expect(page1.rows).toHaveLength(2)
    expect(page1.rows[0]!.at).toContain('2026-07-05') // newest first
    expect(page1.rows[1]!.at).toContain('2026-07-04')

    const page3 = loyalty.history(t.db, { customerId: alice, page: 3, pageSize: 2 })
    expect(page3.rows).toHaveLength(1)
    expect(page3.rows[0]!.at).toContain('2026-07-01')
    holds(t)
  })

  it('is ONE customer statement — never another customer points', () => {
    enableLoyalty()
    const bob = makeCustomer('Bob')
    earn(alice, 10000, 1)
    earn(bob, 20000, 2)

    const aliceHistory = loyalty.history(t.db, { customerId: alice })
    expect(aliceHistory.total).toBe(1)
    expect(aliceHistory.rows[0]!.points).toBe(100)
    expect(aliceHistory.rows.every((row) => row.customerId === alice)).toBe(true)
    holds(t)
  })

  it('includes the WHOLE of the `to` day', () => {
    enableLoyalty()
    earn(alice, 10000, 1, new Date('2026-07-02T18:40:00.000Z')) // late in the day

    // A statement that says it covers the 2nd must contain what happened at 18:40 on the 2nd.
    const history = loyalty.history(t.db, { customerId: alice, from: '2026-07-01', to: '2026-07-02' })
    expect(history.total).toBe(1)
    holds(t)
  })

  it('REJECTS a calendar-invalid date rather than silently rolling it into the wrong month', () => {
    enableLoyalty()

    // 2026 is not a leap year. JS would roll 2026-02-30 to March 2 and quietly report the wrong days.
    expectUserMessage(
      () => loyalty.history(t.db, { customerId: alice, from: '2026-02-30' }),
      /not a real calendar date/i
    )
    expectUserMessage(
      () => loyalty.history(t.db, { customerId: alice, to: '2026-13-01' }),
      /not a real calendar date/i
    )
    expectUserMessage(
      () => loyalty.history(t.db, { customerId: alice, from: 'last tuesday' }),
      /pick a date/i
    )
    holds(t)
  })

  it('hydrates the reason LABEL and the user name for the screen', () => {
    enableLoyalty()
    loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 100, reasonCode: 'data_entry' }, NOW)

    const row = loyalty.history(t.db, { customerId: alice }).rows[0]!
    expect(row.userName).toBe('The Owner')
    expect(row.reasonLabel).toBe('Data entry correction')
    expect(row.type).toBe('adjust')
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE WHOLE LIFECYCLE — every path, one customer, and the invariant survives
// ═════════════════════════════════════════════════════════════════════════════

describe('the invariant across a full life', () => {
  it('holds through earn → partial redeem → adjust → expire, across a rate change', () => {
    enableLoyalty({ 'loyalty.minPointsToRedeem': 50 })

    earn(alice, 40000, 1, at('2026-07-01')) // +400 pt @ Rs 1.00 → Rs 400
    holds(t)

    const redemption = loyalty.redeemForSale(
      t.db, cashier, { customerId: alice, saleId: 2, points: 150 }, at('2026-07-02')
    )
    ledger.post(t.db, {
      at: at('2026-07-02'), refType: 'sale', refId: 2, memo: 'points',
      lines: [...loyalty.journalLines(redemption), { account: ACC.SALES, credit: redemption.valueMinor }]
    })
    holds(t) // 250 pt left, Rs 250 owed

    settings.set(t.db, 'loyalty.redeemValueMinor', 150) // the owner raises the rate mid-life
    holds(t) // a setting change posts nothing

    loyalty.adjustPoints(
      t.db, owner, { customerId: alice, points: 100, reasonCode: 'data_entry' }, at('2026-07-03')
    )
    holds(t) // +100 pt @ the new Rs 1.50 → Rs 150 more owed

    loyalty.expirePoints(t.db, owner, { customerId: alice, points: 50 }, at('2026-07-04'))
    holds(t)

    expect(loyalty.pointsBalance(t.db, alice)).toBe(300)

    // Now spend the lot. The liability must land EXACTLY on zero — no stranded paisa, no negative.
    const final = loyalty.redeemForSale(
      t.db, cashier, { customerId: alice, saleId: 5, points: 300 }, at('2026-07-05')
    )
    ledger.post(t.db, {
      at: at('2026-07-05'), refType: 'sale', refId: 5, memo: 'points',
      lines: [...loyalty.journalLines(final), { account: ACC.SALES, credit: final.valueMinor }]
    })

    expect(loyalty.pointsBalance(t.db, alice)).toBe(0)
    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  it('every committed movement carries its journal', () => {
    enableLoyalty()
    earn(alice, 10000)
    loyalty.expirePoints(t.db, owner, { customerId: alice, points: 50 }, NOW)
    loyalty.adjustPoints(t.db, owner, { customerId: alice, points: 25, reasonCode: 'data_entry' }, NOW)

    // A committed movement always has one (migration 0017) — except a redemption, whose journal is the
    // SALE's and is attached by the caller inside the sale's transaction.
    const orphans = t.db
      .prepare("SELECT COUNT(*) FROM loyalty_movements WHERE journal_id IS NULL AND type <> 'redeem'")
      .pluck()
      .get()
    expect(orphans).toBe(0)
    holds(t)
  })
})
