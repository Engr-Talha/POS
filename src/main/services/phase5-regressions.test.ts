import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import { hashSecret } from '../security/password'
import * as sales from './sales'
import * as products from './products'
import * as stock from './stock'
import * as settings from './settings'
import * as auth from './auth'
import type { User } from '@shared/types'

/**
 * REGRESSIONS from the Phase 5 adversarial audit. Four of the fifteen findings were CRITICAL. These
 * cover the two that could stop the shop trading or let a cashier rob it.
 */

let t: TestDb
let owner: User
let cashier: User
let supervisor: User
let pid: number

const SUPER_PIN = '778294'

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })

  const uomId = t.db.prepare("SELECT id FROM lookups WHERE list_key='uom' AND code='pcs'").pluck().get() as number

  const supId = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, pin_hash, is_active, created_at, updated_at)
         VALUES ('super', 'Rashid Supervisor', 'supervisor', 'x', ?, 1, 'x', 'x')`
      )
      .run(hashSecret(SUPER_PIN)).lastInsertRowid
  )
  supervisor = auth.getById(t.db, supId)

  const cashId = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES ('cash', 'Bilal Cashier', 'cashier', 'x', 1, 'x', 'x')`
      )
      .run().lastInsertRowid
  )
  cashier = auth.getById(t.db, cashId)

  const p = products.create(t.db, owner, {
    sku: 'TV', name: 'Television', saleUomId: uomId,
    retailPrice: 2_000_000, wholesalePrice: 1_800_000, taxRateBp: 0,
    priceEntryMode: 'exclusive', itemType: 'inventory'
  } as never) as { product: { id: number } }
  pid = p.product.id
  stock.adjust(t.db, owner, {
    productId: pid, type: 'opening', qtyM: 100_000, unitCost: 15_000_000, reasonCode: 'stock_take'
  } as never)
})

afterEach(() => t.cleanup())

function cash(): number {
  return t.db.prepare("SELECT id FROM lookups WHERE list_key='payment_method' AND code='cash'").pluck().get() as number
}

describe('CRITICAL: the year boundary bricked the till', () => {
  /**
   * With `resetYearly` on and the year NOT in the number, 1 January re-issued INV-000001 on top of
   * last year's, hit `sales.invoice_no UNIQUE`, rolled the sale back — taking the counter bump with
   * it — and failed identically forever. The shop could not sell on New Year's Day, or ever again.
   */
  it('a shop that restarts numbering each year keeps selling across the boundary', () => {
    settings.set(t.db, 'invoice.resetYearly', true)
    // Deliberately try to hide the year — the OLD brick. Coupling now forces it back in.
    settings.set(t.db, 'invoice.includeYear', false)

    // The invoice year is the day the sale is rung up (the `now` argument), which is exactly right.
    const sell = (when: string) =>
      sales.complete(
        t.db,
        owner,
        {
          lines: [{ productId: pid, qtyM: 1_000 }],
          payments: [{ methodLookupId: cash(), amount: 2_000_000 }]
        } as never,
        new Date(when)
      ) as unknown as { sale: { invoiceNo: string } }

    const dec = sell('2026-12-31T10:00:00')
    const jan = sell('2027-01-01T10:00:00') // the sale that used to brick the till
    const jan2 = sell('2027-01-01T11:00:00')

    // Every number is DISTINCT, and the till never stopped.
    const numbers = new Set([dec.sale.invoiceNo, jan.sale.invoiceNo, jan2.sale.invoiceNo])
    expect(numbers.size).toBe(3)
    // The year is present because the sequence resets — that is what keeps them unique.
    expect(jan.sale.invoiceNo).toMatch(/2027/)
    expect(jan.sale.invoiceNo).not.toBe(dec.sale.invoiceNo)
  })

  it('toggling “restart each year” does not brick the next sale', () => {
    const sell = () =>
      sales.complete(t.db, owner, {
        lines: [{ productId: pid, qtyM: 1_000 }],
        payments: [{ methodLookupId: cash(), amount: 2_000_000 }]
      } as never) as unknown as { sale: { invoiceNo: string } }

    const a = sell()
    settings.set(t.db, 'invoice.resetYearly', true) // owner ticks the box mid-life
    const b = sell()
    settings.set(t.db, 'invoice.resetYearly', false) // and unticks it
    const c = sell()

    // No collision, no brick — three distinct numbers through both toggles.
    expect(new Set([a.sale.invoiceNo, b.sale.invoiceNo, c.sale.invoiceNo]).size).toBe(3)
  })
})

describe('CRITICAL: supervisor approval was unauthenticated', () => {
  /**
   * `approvedByUserId` was an unverified integer from the renderer. A cashier passed the owner's id
   * (usually 1), self-approved a Rs 1 television, and the audit log named a supervisor who was never
   * at the till. The approver is now proven by PIN, in main, or there is no approver.
   */
  it('a huge discount CANNOT be self-approved with a claimed id — only a real PIN works', () => {
    // 60% off — over both default thresholds. No approver.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId: pid, qtyM: 1_000 }],
          cartDiscount: 1_200_000, // Rs 12,000 off Rs 20,000
          cartDiscountReasonCode: 'regular_customer',
          payments: [{ methodLookupId: cash(), amount: 800_000 }]
        } as never),
      /supervisor|approve/i
    )

    // The wrong PIN is no better than none.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId: pid, qtyM: 1_000 }],
          cartDiscount: 1_200_000,
          cartDiscountReasonCode: 'regular_customer',
          approverPin: '000000',
          payments: [{ methodLookupId: cash(), amount: 800_000 }]
        } as never),
      /PIN was not recognised/i
    )

    // The supervisor's REAL PIN goes through — and the audit names the real approver.
    const r = sales.complete(t.db, cashier, {
      lines: [{ productId: pid, qtyM: 1_000 }],
      cartDiscount: 1_200_000,
      cartDiscountReasonCode: 'regular_customer',
      approverPin: SUPER_PIN,
      payments: [{ methodLookupId: cash(), amount: 800_000 }]
    } as never) as unknown as { sale: { grandTotal: number } }

    expect(r.sale.grandTotal).toBe(800_000) // Rs 8,000 after the Rs 12,000 discount

    const audit = t.db
      .prepare("SELECT user_name, approved_by_name FROM audit_log WHERE action = 'sale.discount.over_threshold' ORDER BY id DESC LIMIT 1")
      .get() as { user_name: string; approved_by_name: string } | undefined
    expect(audit?.user_name).toBe('Bilal Cashier') // who rang it up
    expect(audit?.approved_by_name).toBe('Rashid Supervisor') // who actually approved, proven by PIN
  })

  it('a price override — selling a Rs 20,000 TV for Rs 1 — needs a real supervisor PIN', () => {
    // Without approval: refused.
    expect(
      (
        // The service returns/throws NEEDS_APPROVAL; assert it does not silently go through.
        (() => {
          try {
            sales.complete(t.db, cashier, {
              lines: [{ productId: pid, qtyM: 1_000, priceOverride: 100 }], // Rs 1.00
              payments: [{ methodLookupId: cash(), amount: 100 }]
            } as never)
            return 'COMPLETED'
          } catch {
            return 'REFUSED'
          }
        })()
      )
    ).toBe('REFUSED')

    // With the real PIN: allowed (this is a legitimate manager decision), and it is on the record.
    const r = sales.complete(t.db, cashier, {
      lines: [{ productId: pid, qtyM: 1_000, priceOverride: 100 }],
      approverPin: SUPER_PIN,
      payments: [{ methodLookupId: cash(), amount: 100 }]
    } as never) as unknown as { sale: { grandTotal: number } }
    expect(r.sale.grandTotal).toBe(100)
  })
})
