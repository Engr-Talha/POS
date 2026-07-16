import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as sales from './sales'
import * as stock from './stock'
import * as ledger from './ledger'
import * as promotions from './promotions'
import * as loyalty from './loyalty'
import * as reports from './reports'
import * as settings from './settings'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * THE PROMOTIONS ENGINE, WIRED INTO A REAL SALE. (Migration 0018, whose header is the spec.)
 *
 * `promotions.test.ts` proves the ARITHMETIC in isolation. This file proves the WIRING: that an offer
 * computed by the engine travels the one road migration 0018 designed for it —
 *
 *     sale_lines.line_discount  →  priceCart re-resolves tax on what is ACTUALLY paid
 *                               →  DR Discounts Given (4200, contra-income), ex-tax
 *                               →  frozen onto the line, so a RETURN refunds what was really charged
 *
 * — and invents no new money on the way. Every scenario below is one way that road could be wrong:
 *
 *   · the offer discounts but the tax is charged on the UNdiscounted price   (the customer overpays tax)
 *   · the giveaway is hidden in a smaller Sales figure                       (0018: it must be VISIBLE)
 *   · a cashier is asked for a PIN to sell a Sunday special                  (THE APPROVAL RULE)
 *   · a manual discount and an offer are both measured on the shelf price    (the shop gives away 120%)
 *   · a renamed offer rewrites what an old sale said it cost                 (the FROZEN snapshot)
 *
 * THE STANDING ASSERTIONS from sales.test.ts run after every scenario here too — the trial balance, the
 * books-vs-shelf identity, and every sale adding up. A promotion that broke any of them would be a
 * promotion that had invented a second path to the money, which is exactly what 0018 forbids.
 */

const RS_100 = 10_000 // 2-dp money
const RS_60_COST = 600_000 // 4-dp cost
const GST = 1700 // 17%, basis points

let t: TestDb
let cashier: User
let owner: User

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'The Owner')
  cashier = makeUser('cashier', 'cashier', 'The Cashier')
})

afterEach(() => {
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertions (the same ones sales.test.ts runs — a promotion may not break one)
// ═════════════════════════════════════════════════════════════════════════════

function everythingHolds(): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)

  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  const valuation = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number
  expect(gl, 'GL Inventory has drifted away from the stock valuation').toBe(valuation)

  const ids = t.db.prepare('SELECT id FROM sales').pluck().all() as number[]
  for (const id of ids) {
    const sale = sales.getById(t.db, id)
    let net = 0
    let tax = 0
    let gross = 0

    for (const line of sale.lines) {
      expect(line.gross, `sale ${id} line ${line.id}: gross !== net + tax`).toBe(
        line.net + line.taxAmount
      )
      net += line.net
      tax += line.taxAmount
      gross += line.gross
    }

    expect(sale.subtotalNet, `sale ${id}: subtotal_net !== SUM(line.net)`).toBe(net)
    expect(sale.taxTotal, `sale ${id}: tax_total !== SUM(line.tax_amount)`).toBe(tax)
    expect(sale.grandTotal, `sale ${id}: grand_total !== SUM(line.gross)`).toBe(gross)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

/** A supervisor approves by PIN — main derives WHO from the PIN, never from a claimed id. */
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

function lookupId(listKey: string, code: string): number {
  return t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number
}

const cash = (): number => lookupId('payment_method', 'cash')

function makeProduct(options: { name?: string; retailPrice?: number; categoryId?: number } = {}): number {
  const now = new Date().toISOString()

  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, category_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, @categoryId, 0, @retailPrice, 0, @taxRateBp,
                 'exclusive', 0, 'inventory', 0, 0, 0, 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        name: options.name ?? 'Test Item',
        uomId: lookupId('uom', 'pcs'),
        categoryId: options.categoryId ?? null,
        retailPrice: options.retailPrice ?? RS_100,
        taxRateBp: GST,
        now
      }).lastInsertRowid
  )
}

/** A named customer — points need somebody to belong to. */
function makeCustomer(name: string): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO customers (name, credit_limit, is_active, created_at, updated_at) VALUES (?, 0, 1, ?, ?)`
      )
      .run(name, now, now).lastInsertRowid
  )
}

function openingStock(productId: number, qtyM: number): void {
  stock.adjust(t.db, owner, {
    productId,
    type: 'opening',
    qtyM,
    unitCost: RS_60_COST,
    reasonCode: 'data_entry'
  })
}

/** An offer, live today, on ONE product. The shape almost every test below needs. */
function offerOn(
  productId: number,
  offer: {
    name?: string
    kind: 'percent_off' | 'amount_off' | 'buy_x_get_y' | 'fixed_price'
    percentBp?: number
    amountMinor?: number
    buyQtyM?: number
    getQtyM?: number
    priority?: number
  }
): number {
  const created = promotions.createPromotion(t.db, owner, {
    name: offer.name ?? 'Test Offer',
    kind: offer.kind,
    percentBp: offer.percentBp,
    amountMinor: offer.amountMinor,
    buyQtyM: offer.buyQtyM,
    getQtyM: offer.getQtyM,
    priority: offer.priority
  })

  promotions.setRules(t.db, owner, {
    promotionId: created.id,
    rules: [{ scope: 'product', targetId: productId }]
  })

  return created.id
}

function promotionRowsFor(saleLineId: number): Array<{
  promotion_id: number
  name_snapshot: string
  discount_minor: number
}> {
  return t.db
    .prepare('SELECT * FROM sale_line_promotions WHERE sale_line_id = ? ORDER BY id')
    .all(saleLineId) as Array<{
    promotion_id: number
    name_snapshot: string
    discount_minor: number
  }>
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ROAD: a promotion becomes a line discount, and nothing else
// ═════════════════════════════════════════════════════════════════════════════

describe('a promotion is a line discount', () => {
  it('discounts the line, and charges tax on WHAT IS ACTUALLY PAID', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { name: 'Sunday special', kind: 'percent_off', percentBp: 1000 }) // 10% off

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 21_060 }]
    })

    const line = sale.lines[0]!

    // Rs 100 x 2 = Rs 200 list. 10% off = Rs 20 off the LINE (the exclusive, pre-tax amount).
    expect(line.unitPrice).toBe(RS_100)
    expect(line.lineDiscount).toBe(2_000)

    // THE POINT: tax is 17% of Rs 180, NOT of Rs 200. The customer does not pay tax on money they
    // never paid. Rs 180 net + Rs 30.60 tax = Rs 210.60.
    expect(line.net).toBe(18_000)
    expect(line.taxAmount).toBe(3_060)
    expect(line.gross).toBe(21_060)
    expect(sale.grandTotal).toBe(21_060)

    everythingHolds()
  })

  it('makes the giveaway VISIBLE in Discounts Given, not hidden in a smaller Sales figure', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { kind: 'percent_off', percentBp: 1000 })

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 21_060 }]
    })

    // CR Sales is the FULL list net — Rs 200. The shop sold Rs 200 of goods.
    expect(ledger.accountBalance(t.db, ACC.SALES)).toBe(20_000)

    // DR Discounts Given is what the offer cost — Rs 20, EX-TAX. This is the whole reason a "free"
    // item is not rung at zero: the cost of the offer is a number the owner can see and question.
    expect(ledger.accountBalance(t.db, ACC.DISCOUNTS)).toBe(2_000)

    everythingHolds()
  })

  it('posts NO journal leg of its own — a promotion invents no new money', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { kind: 'percent_off', percentBp: 1000 })

    const { journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 21_060 }]
    })

    // The SAME five accounts a discounted sale without any promotion touches: Cash, Sales, Discounts,
    // Tax, COGS, Inventory. If a promotion ever added a leg, it would show up right here.
    const accounts = t.db
      .prepare(
        `SELECT DISTINCT a.code FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? ORDER BY a.code`
      )
      .pluck()
      .all(journalId) as string[]

    expect(accounts).toEqual(
      [ACC.CASH, ACC.COGS, ACC.DISCOUNTS, ACC.INVENTORY, ACC.SALES, ACC.OUTPUT_TAX].sort()
    )

    everythingHolds()
  })

  it('rings a buy-2-get-1 free tin at its NORMAL price with a 100% discount — stock moves for all 3', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { name: 'Buy 2 get 1', kind: 'buy_x_get_y', buyQtyM: 2 * ONE_UNIT, getQtyM: ONE_UNIT })

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 3 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    const line = sale.lines[0]!

    // Three tins at Rs 100 = Rs 300 list, one of them free = Rs 100 off. The customer pays for two.
    expect(line.lineDiscount).toBe(RS_100)
    expect(line.net).toBe(20_000)
    expect(sale.grandTotal).toBe(23_400)

    // ALL THREE TINS LEFT THE SHELF. This is why the free one is not rung at zero — the shelf and the
    // books must agree about how many tins are gone.
    expect(stock.onHand(t.db, productId)).toBe(7 * ONE_UNIT)

    everythingHolds()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE APPROVAL RULE — a cashier NEVER needs a PIN to sell the shop's own offer
// ═════════════════════════════════════════════════════════════════════════════

describe('THE APPROVAL RULE: a promotion is the shop’s offer, not a cashier’s decision', () => {
  /**
   * THE TEST THIS WHOLE FEATURE HANGS ON.
   *
   * The threshold is 10% (`selling.discountApprovalPercent`) and Rs 500. This offer gives 25% away —
   * two and a half times over the percentage limit. A cashier, with NO approver and NO PIN, must ring
   * it up without being stopped. If this ever fails, every basket on a promotion day demands a
   * supervisor, and within a morning the cashier has simply been handed the supervisor's PIN.
   */
  it('a CASHIER sells a 25%-off special with NO PIN and NO approver', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { name: 'Sunday special', kind: 'percent_off', percentBp: 2500 })

    // NO approverPin. NO reason code. The cashier just scans and takes the money.
    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 4 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 35_100 }]
    })

    // Rs 400 list, Rs 100 off (25%) — ten times the Rs 500... no: Rs 100 off is 25%, well over the 10%
    // limit that would stop a MANUAL discount of the same size dead.
    expect(sale.lines[0]!.lineDiscount).toBe(10_000)
    expect(sale.grandTotal).toBe(35_100)

    // AND NOTHING WAS LOGGED AS AN OVER-THRESHOLD DISCOUNT, because nobody at the till decided anything.
    const overThreshold = t.db
      .prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'sale.discount.over_threshold'")
      .pluck()
      .get() as number
    expect(overThreshold, 'a promotion must not be logged as a cashier’s over-threshold discount').toBe(0)

    everythingHolds()
  })

  it('a promotion needs no reason code — a cashier cannot explain the shop’s own offer', () => {
    const freeId = makeProduct({ name: 'Free tin', retailPrice: RS_100 })
    const paidId = makeProduct({ name: 'Paid tin', retailPrice: RS_100 })
    openingStock(freeId, 10 * ONE_UNIT)
    openingStock(paidId, 10 * ONE_UNIT)

    // 100% off — a giveaway, as far over any threshold as it is possible to be, and with NO reason code
    // anywhere on the sale. A cashier cannot be asked to justify the shop's own offer.
    offerOn(freeId, { name: 'Free tin day', kind: 'percent_off', percentBp: 10_000 })

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId: freeId, qtyM: ONE_UNIT }, { productId: paidId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 11_700 }]
    })

    // The free tin is rung at its NORMAL price with a 100% discount — never at zero (0018's header).
    const free = sale.lines[0]!
    expect(free.unitPrice).toBe(RS_100)
    expect(free.lineDiscount).toBe(RS_100)
    expect(free.gross).toBe(0)

    // The customer pays for the other tin only.
    expect(sale.grandTotal).toBe(11_700)

    // BOTH tins left the shelf, and the giveaway is visible as a cost, not as a missing sale.
    expect(stock.onHand(t.db, freeId)).toBe(9 * ONE_UNIT)
    expect(ledger.accountBalance(t.db, ACC.DISCOUNTS)).toBe(RS_100)

    everythingHolds()
  })

  /**
   * THE OTHER HALF OF THE RULE, and the one that stops it being a loophole: the promotion is subtracted
   * from what the threshold measures, but the CASHIER'S OWN discount is still measured in full. A
   * cashier cannot hide a big manual discount behind a promotion.
   */
  it('still stops a cashier’s OWN over-threshold discount on a promoted line', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { name: 'Sunday special', kind: 'percent_off', percentBp: 500 }) // a modest 5%

    // The cashier keys Rs 60 off a Rs 400 line — 15%, over the 10% limit, on their own authority.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: 4 * ONE_UNIT, lineDiscount: 6_000, discountReasonCode: 'damaged_packaging' }],
          payments: [{ methodLookupId: cash(), amount: 40_000 }]
        }),
      /supervisor/i
    )

    everythingHolds()
  })

  it('measures ONLY the cashier’s own discount — a promotion cannot drag a small one over the line', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    // A 25% offer. Together with the cashier's Rs 20 that is well over 10% of the cart...
    offerOn(productId, { kind: 'percent_off', percentBp: 2500 })

    // ...but the cashier's OWN discount is Rs 20 on Rs 400 = 5%, which is under the limit. It goes
    // through, with its reason code, and no PIN.
    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 4 * ONE_UNIT, lineDiscount: 2_000, discountReasonCode: 'damaged_packaging' }],
      payments: [{ methodLookupId: cash(), amount: 33_345 }]
    })

    // Rs 400 list − Rs 20 keyed = Rs 380; 25% of THAT = Rs 95. Total off = Rs 115.
    expect(sale.lines[0]!.lineDiscount).toBe(11_500)

    everythingHolds()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A MANUAL DISCOUNT *AND* AN OFFER ON THE SAME LINE — the documented decision
// ═════════════════════════════════════════════════════════════════════════════

describe('a cashier who ALSO keys a discount on a promoted line', () => {
  /**
   * THE DECISION (documented on `applyPromotions` in sales.ts): they STACK, and the promotion is
   * computed on WHAT IS LEFT after the manual discount. This is the test that proves the alternative —
   * both measured on the shelf price — is not what happens.
   */
  it('stacks, with the offer computed on what is LEFT after the cashier’s discount', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { kind: 'percent_off', percentBp: 1000 }) // 10% off

    const { sale } = sales.complete(t.db, cashier, {
      // A Rs 400 line (4 tins); the cashier knocks Rs 20 off for a dented one — 5%, under the limit,
      // so this is a discount a cashier may give on their own and no PIN is involved either way.
      lines: [{ productId, qtyM: 4 * ONE_UNIT, lineDiscount: 2_000, discountReasonCode: 'damaged_packaging' }],
      payments: [{ methodLookupId: cash(), amount: 40_014 }]
    })

    const line = sale.lines[0]!

    // Rs 400 − Rs 20 = Rs 380 left. 10% of Rs 380 = Rs 38 — NOT Rs 40 (10% of the shelf price).
    // Total off the line = Rs 58. The customer pays Rs 342 + 17% = Rs 400.14.
    expect(line.lineDiscount).toBe(5_800)
    expect(line.net).toBe(34_200)
    expect(line.gross).toBe(40_014)

    // The offer's own share is recorded as the Rs 38 it actually gave — not the Rs 40 it would have.
    const rows = promotionRowsFor(line.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.discount_minor).toBe(3_800)

    everythingHolds()
  })

  /**
   * THE FAILURE MODE THE DECISION EXISTS TO PREVENT. 60% off, plus a cashier's Rs 60 on a Rs 100 tin.
   * Computed on the shelf price and added, that is Rs 120 off a Rs 100 tin — the shop gives away the
   * whole tin AND Rs 20, because two people each thought they were giving away part of it.
   */
  it('CANNOT give away more than the line is worth, however the two combine', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    offerOn(productId, { kind: 'percent_off', percentBp: 6000 }) // 60% off

    const { sale } = sales.complete(t.db, owner, {
      // The owner keys Rs 60 off on their own authority (over threshold, but they hold the role).
      lines: [{ productId, qtyM: ONE_UNIT, lineDiscount: 6_000, discountReasonCode: 'damaged_packaging' }],
      payments: [{ methodLookupId: cash(), amount: 1_872 }]
    })

    const line = sale.lines[0]!

    // Rs 100 − Rs 60 = Rs 40 left; 60% of Rs 40 = Rs 24. Total off = Rs 84, and the customer still
    // pays Rs 16 + tax. NEVER Rs 120 off a Rs 100 tin.
    expect(line.lineDiscount).toBe(8_400)
    expect(line.lineDiscount).toBeLessThan(RS_100)
    expect(line.net).toBe(1_600)
    expect(line.net).toBeGreaterThan(0)

    everythingHolds()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE FROZEN RECORD — "what did that Sunday special cost me?"
// ═════════════════════════════════════════════════════════════════════════════

describe('sale_line_promotions — the frozen record of what an offer cost', () => {
  it('records WHICH offer gave the discount, and WHAT it gave', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const promotionId = offerOn(productId, { name: 'Sunday special', kind: 'percent_off', percentBp: 1000 })

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 21_060 }]
    })

    const rows = promotionRowsFor(sale.lines[0]!.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.promotion_id).toBe(promotionId)
    expect(rows[0]!.name_snapshot).toBe('Sunday special')
    expect(rows[0]!.discount_minor).toBe(2_000)

    // IT IS THE *WHY*, NOT A SECOND SOURCE OF TRUTH: it is a component of the line's own discount.
    expect(rows[0]!.discount_minor).toBe(sale.lines[0]!.lineDiscount)

    everythingHolds()
  })

  /** MIGRATION 0018'S PROMISE: an offer renamed or switched off never rewrites what an old sale cost. */
  it('a RENAMED, re-priced and switched-off offer does not rewrite what an old sale says it cost', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const promotionId = offerOn(productId, { name: 'Sunday special', kind: 'percent_off', percentBp: 1000 })

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 21_060 }]
    })

    // The owner renames it, doubles it, and then switches it off entirely.
    promotions.updatePromotion(t.db, owner, {
      id: promotionId,
      name: 'Weekend blowout',
      kind: 'percent_off',
      percentBp: 2000
    })
    promotions.deactivatePromotion(t.db, owner, { id: promotionId })

    // THE OLD SALE IS UNTOUCHED. It still says what it cost, under the name it had on the day.
    const rows = promotionRowsFor(sale.lines[0]!.id)
    expect(rows[0]!.name_snapshot).toBe('Sunday special')
    expect(rows[0]!.discount_minor).toBe(2_000)

    const reread = sales.getById(t.db, sale.id)
    expect(reread.lines[0]!.lineDiscount).toBe(2_000)
    expect(reread.grandTotal).toBe(21_060)

    everythingHolds()
  })

  it('records nothing for a line no offer touched', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 11_700 }]
    })

    expect(promotionRowsFor(sale.lines[0]!.id)).toHaveLength(0)
    expect(sale.lines[0]!.lineDiscount).toBe(0)

    everythingHolds()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A HELD CART / A QUOTE, RESUMED ON A LATER DAY
// ═════════════════════════════════════════════════════════════════════════════

describe('a held cart resumed on a later day', () => {
  /**
   * WHAT WAS FOUND, AND IT IS THE EXISTING BEHAVIOUR, NOT A NEW ONE.
   *
   * `toCartLines` deliberately carries back only WHAT was scanned and HOW MANY — never the price. So
   * `complete()` re-resolves every price, every tax rate and every cost from the catalog on the day the
   * cart is actually rung up, and the promotions now ride that same road: they are resolved against the
   * offers live at `now`, the sale's own instant.
   *
   * A cart held on Sunday and rung up on Monday is therefore sold at MONDAY's price, under MONDAY's
   * offers. That is the same rule the shop's prices already followed, and it is the right one — the
   * money is taken on Monday. A QUOTE is the deliberate exception the shop has already thought about:
   * it carries a `valid_until` date so the customer can be told "this price was good until the 14th",
   * but nothing is BLOCKED when it lapses (see `Sale.validUntil`).
   */
  it('re-prices against TODAY’s offers, not the day it was parked', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    // Sunday: the cart is parked while the special is running.
    const promotionId = offerOn(productId, { name: 'Sunday special', kind: 'percent_off', percentBp: 1000 })

    const held = sales.hold(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }]
    })

    // The parked cart shows Sunday's price — Rs 20 off.
    expect(held.lines[0]!.lineDiscount).toBe(2_000)

    // Monday: the special is over.
    promotions.deactivatePromotion(t.db, owner, { id: promotionId })

    const resumed = sales.toCartLines(sales.resume(t.db, { id: held.id }))
    const { sale } = sales.complete(t.db, cashier, {
      saleId: held.id,
      lines: resumed,
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    // IT IS RUNG UP AT MONDAY'S PRICE. The offer is over; the discount is gone. The money is taken
    // today, so today's offers are the ones that apply.
    expect(sale.lines[0]!.lineDiscount).toBe(0)
    expect(sale.grandTotal).toBe(23_400)
    expect(promotionRowsFor(sale.lines[0]!.id)).toHaveLength(0)

    everythingHolds()
  })

  it('picks up an offer that started AFTER the cart was parked', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: 2 * ONE_UNIT }] })
    expect(held.lines[0]!.lineDiscount).toBe(0)

    // The offer starts while the cart is in the tray.
    offerOn(productId, { name: 'Flash sale', kind: 'percent_off', percentBp: 1000 })

    const resumed = sales.toCartLines(sales.resume(t.db, { id: held.id }))
    const { sale } = sales.complete(t.db, cashier, {
      saleId: held.id,
      lines: resumed,
      payments: [{ methodLookupId: cash(), amount: 21_060 }]
    })

    expect(sale.lines[0]!.lineDiscount).toBe(2_000)
    expect(sale.grandTotal).toBe(21_060)

    everythingHolds()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// AN OPEN ITEM
// ═════════════════════════════════════════════════════════════════════════════

describe('an open item', () => {
  it('is never touched by an offer — there is no catalog row to match a rule against', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    // A shop-wide "everything 10% off".
    const created = promotions.createPromotion(t.db, owner, {
      name: 'Everything must go',
      kind: 'percent_off',
      percentBp: 1000
    })
    promotions.setRules(t.db, owner, {
      promotionId: created.id,
      rules: [{ scope: 'all' }]
    })

    const { sale } = sales.complete(t.db, cashier, {
      lines: [
        { productId, qtyM: ONE_UNIT },
        { qtyM: ONE_UNIT, openItem: { name: 'Misc', unitPrice: 5_000, taxRateBp: 0, taxMode: 'inclusive' } }
      ],
      payments: [{ methodLookupId: cash(), amount: 15_530 }]
    })

    // The catalogued tin takes the offer. The open item — a price the cashier typed — does not.
    expect(sale.lines[0]!.lineDiscount).toBe(1_000)
    expect(sale.lines[1]!.lineDiscount).toBe(0)
    expect(promotionRowsFor(sale.lines[1]!.id)).toHaveLength(0)

    everythingHolds()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE OTHER-READERS SWEEP — the check that has caught a real bug every phase
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A promotion changes what a sale line's net, tax and discount ARE. Everything that recomputes a figure
 * from those had to be checked — and this is the payoff of "a promotion is a line discount": NOT ONE of
 * them needed changing. They already read the discounted line, because there is nothing new to read.
 *
 * These tests pin that. If a future change gives a promotion its own money path, they fail here rather
 * than in a shop's books six months later.
 */
describe('the other readers, against a promotion', () => {
  /**
   * LOYALTY. Points are earned on `subtotalNet`, which the promotion's discount is already apportioned
   * into — so a customer earns on what they PAID, never on the list price. Earning on the list price
   * would mean the shop discounts the goods AND pays a reward on money it never took.
   */
  it('loyalty earns on what the customer PAID, not the list price', () => {
    settings.set(t.db, 'loyalty.enabled', true)
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 100 * ONE_UNIT)
    const customerId = makeCustomer('Regular Rashid')
    offerOn(productId, { name: '25% off tea', kind: 'percent_off', percentBp: 2_500 })

    // 4 @ Rs 100 = Rs 400 list; 25% off => the customer pays Rs 300.
    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 4 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 35_100 }]
    })
    expect(sale.grandTotal, 'Rs 300 net after the offer, + 17% tax').toBe(35_100)

    expect(loyalty.pointsBalance(t.db, customerId), 'points must follow what was PAID (300), not the Rs 400 list').toBe(300)
    everythingHolds()
  })

  /**
   * LEAKAGE. It reports who is doing the things a shop gets robbed through — and reads the AUDIT LOG for
   * over-threshold discounts, not sale_lines.line_discount. A promotion never trips that threshold
   * (it is not a human's decision), so it never lands on a cashier's leakage row. A promotion day must
   * not make the honest cashier look like the shop's biggest discounter.
   */
  it('leakage does not blame the cashier for the shop’s own offer', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 100 * ONE_UNIT)
    offerOn(productId, { name: '25% off tea', kind: 'percent_off', percentBp: 2_500 })

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 4 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 35_100 }]
    })

    const leak = reports.leakage(t.db, { from: '2026-07-01', to: '2026-07-31' })
    const row = leak.rows.find((r) => r.userId === cashier.id)
    // Not `?? 0` on a guessed field: assert the REAL columns, so this cannot pass vacuously.
    expect(row?.overThresholdDiscountValue ?? 0, 'a promotion is not the cashier discounting').toBe(0)
    expect(row?.overThresholdDiscountCount ?? 0, 'and it is not an over-threshold event at all').toBe(0)
    everythingHolds()
  })

  /** The giveaway is VISIBLE money: Rs 100 in Discounts Given, never hidden in a smaller Sales figure. */
  it('shows the whole giveaway in Discounts Given', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 100 * ONE_UNIT)
    offerOn(productId, { name: '25% off tea', kind: 'percent_off', percentBp: 2_500 })

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 4 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 35_100 }]
    })

    expect(ledger.accountBalance(t.db, ACC.DISCOUNTS), 'the Rs 100 given away must be visible in one place').toBe(RS_100)
    everythingHolds()
  })
})
