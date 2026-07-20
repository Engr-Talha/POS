import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as purchases from './purchases'
import * as suppliers from './suppliers'
import * as supplierLedger from './supplier-ledger'
import * as stock from './stock'
import * as ledger from './ledger'
import * as settings from './settings'
import * as purchaseReturns from './purchase-returns'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * PURCHASES — the buying engine, the mirror of the sale engine. A purchase brings stock IN at a real
 * landed cost, re-averages the weighted cost, and either pays for it now or owes the supplier the rest.
 *
 * THREE STANDING ASSERTIONS RUN AFTER EVERY SCENARIO, and they are the whole point:
 *
 *   1. THE TRIAL BALANCE BALANCES.                                (CLAUDE.md §4 — the standing test)
 *   2. GL INVENTORY === SUM(stock_movements.value_minor). DR Inventory sums the movements' OWN frozen
 *      values (never a fresh qty × cost), so the books and the stock valuation move by the same paisa.
 *   3. GL ACCOUNTS PAYABLE === the summed supplier balances. Every purchase's unpaid portion posts CR
 *      Payable; `balance()` is derived from exactly those rows. The ledger screen and the books can
 *      never disagree.
 */

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertions
// ═════════════════════════════════════════════════════════════════════════════

function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

/** The books' Inventory account equals the sum of every stock movement's OWN frozen value. */
function assertInventoryReconciles(t: TestDb): void {
  const summed = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number
  expect(
    ledger.accountBalance(t.db, ACC.INVENTORY),
    'GL Inventory has drifted from SUM(stock_movements.value_minor)'
  ).toBe(summed)
}

/** The sum of what the shop owes every supplier equals the one Accounts Payable account. */
function assertPayablesReconcile(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM suppliers').pluck().all() as number[]
  const summed = ids.reduce((total, id) => total + supplierLedger.balance(t.db, id), 0)
  expect(
    ledger.accountBalance(t.db, ACC.PAYABLE),
    'GL Accounts Payable has drifted from the summed supplier balances'
  ).toBe(summed)
}

function everythingHolds(t: TestDb): void {
  assertBooksBalance(t)
  assertInventoryReconciles(t)
  assertPayablesReconcile(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

let t: TestDb
let manager: User

/** 2-dp money minor units from rupees. Rs 60 -> 6000. */
const rs = (rupees: number): number => rupees * 100
/** 4-dp cost units from rupees. Rs 60 -> 600000. A DIFFERENT scale, 100× money. */
const cost = (rupees: number): number => rupees * 10_000

function makeUser(role: User['role'], username: string, fullName: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', 1, ?, ?)`
      )
      .run(username, fullName, role, now, now).lastInsertRowid
  )
  return { id, username, fullName, role, hasPin: false, isActive: true }
}

function lookupId(listKey: string, code: string): number {
  return t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number
}

const cash = (): number => lookupId('payment_method', 'cash')
const bank = (): number => lookupId('payment_method', 'bank')
const credit = (): number => lookupId('payment_method', 'credit')

function makeProduct(opts: { trackBatches?: boolean; itemType?: string } = {}): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, 'Item', @uomId, 0, 10000, 0, 0, 'exclusive', 1, @itemType, 0, @trackBatches, 0,
                 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        uomId: lookupId('uom', 'pcs'),
        itemType: opts.itemType ?? 'inventory',
        trackBatches: opts.trackBatches ? 1 : 0,
        now
      }).lastInsertRowid
  )
}

function makeSupplier(name: string): number {
  return suppliers.create(t.db, manager, { name }).id
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  manager = makeUser('manager', 'meena', 'Meena Manager')
})

afterEach(() => {
  everythingHolds(t)
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// A cash purchase: DR Inventory, CR Cash — stock up, cost re-averaged
// ═════════════════════════════════════════════════════════════════════════════

describe('a cash purchase', () => {
  it('DR Inventory / CR Cash; stock rises; the weighted cost is set to the landed cost', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      supplierInvoiceNo: 'INV-9001',
      lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(60) }], // 10 @ Rs 60
      payments: [{ methodLookupId: cash(), amount: rs(600) }]
    })

    // The header froze the totals. Nothing owed — it was paid in full.
    expect(purchase.subtotalNet).toBe(rs(600))
    expect(purchase.grandTotal).toBe(rs(600))
    expect(purchase.paidTotal).toBe(rs(600))
    expect(purchase.journalId).not.toBeNull()

    // The line's total EQUALS the frozen value of the stock movement it created (never a re-multiply).
    expect(purchase.lines).toHaveLength(1)
    expect(purchase.lines[0]!.lineTotal).toBe(rs(600))
    expect(purchase.lines[0]!.unitCost).toBe(cost(60))
    expect(purchase.lines[0]!.batchId).toBeNull()

    // Stock is DERIVED — it rose by exactly what came in.
    expect(stock.onHand(t.db, productId)).toBe(10 * ONE_UNIT)
    // The weighted cost was set to the landed cost (nothing was on the shelf to blend with).
    expect(stock.averageCost(t.db, productId)).toBe(cost(60))

    // The journal: DR Inventory 600, CR Cash 600.
    const journal = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit, l.credit AS credit
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? ORDER BY a.code`
      )
      .all(purchase.journalId) as Array<{ code: string; debit: number; credit: number }>
    expect(journal).toEqual([
      { code: ACC.CASH, debit: 0, credit: rs(600) },
      { code: ACC.INVENTORY, debit: rs(600), credit: 0 }
    ])

    // Nothing is owed to the supplier.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A fully-credit purchase: CR Payable — the supplier balance rises
// ═════════════════════════════════════════════════════════════════════════════

describe('a fully-credit purchase', () => {
  it('posts the whole bill to Payable and raises what the shop owes', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [{ productId, qtyM: 5 * ONE_UNIT, unitCost: cost(80) }], // Rs 400, nothing paid
      payments: []
    })

    expect(purchase.grandTotal).toBe(rs(400))
    expect(purchase.paidTotal).toBe(0)

    // The whole bill is owed.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(400))
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(rs(400))

    // DR Inventory 400, CR Payable 400 — no tender line at all.
    const journal = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit, l.credit AS credit
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? ORDER BY a.code`
      )
      .all(purchase.journalId) as Array<{ code: string; debit: number; credit: number }>
    expect(journal).toEqual([
      { code: ACC.INVENTORY, debit: rs(400), credit: 0 },
      { code: ACC.PAYABLE, debit: 0, credit: rs(400) }
    ])

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A split purchase: part cash, part owed
// ═════════════════════════════════════════════════════════════════════════════

describe('a split purchase', () => {
  it('part cash now, the rest owed — CR Cash AND CR Payable', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(50) }], // Rs 500
      payments: [{ methodLookupId: cash(), amount: rs(200) }] // Rs 200 down
    })

    expect(purchase.grandTotal).toBe(rs(500))
    expect(purchase.paidTotal).toBe(rs(200))
    // Rs 300 owed.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(300))

    const journal = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit, l.credit AS credit
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? ORDER BY a.code`
      )
      .all(purchase.journalId) as Array<{ code: string; debit: number; credit: number }>
    expect(journal).toEqual([
      { code: ACC.CASH, debit: 0, credit: rs(200) },
      { code: ACC.INVENTORY, debit: rs(500), credit: 0 },
      { code: ACC.PAYABLE, debit: 0, credit: rs(300) }
    ])

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Input tax: DR Input Tax; the cost that re-averages stays NET of it
// ═════════════════════════════════════════════════════════════════════════════

describe('a purchase with input tax', () => {
  it('debits Input Tax, and the weighted cost stays net of the tax', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(100) }], // Rs 1000 net
      taxTotal: rs(170), // Rs 170 recoverable input tax
      payments: [{ methodLookupId: cash(), amount: rs(1170) }]
    })

    expect(purchase.subtotalNet).toBe(rs(1000))
    expect(purchase.taxTotal).toBe(rs(170))
    expect(purchase.grandTotal).toBe(rs(1170))

    // The recoverable tax landed in the Input Tax asset...
    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(rs(170))
    // ...and the weighted cost is NET of it — Rs 100, not Rs 117.
    expect(stock.averageCost(t.db, productId)).toBe(cost(100))
    // Inventory reconciles to the NET stock value, tax excluded.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(1000))

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A batch-tracked purchase creates a batch, and FEFO can see it
// ═════════════════════════════════════════════════════════════════════════════

describe('a batch-tracked purchase', () => {
  it('creates the batch, records the stock against it, and FEFO can see it', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct({ trackBatches: true })

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [
        {
          productId,
          qtyM: 10 * ONE_UNIT,
          unitCost: cost(50),
          batchNo: 'B-2026-01',
          expiryDate: '2027-01-01'
        }
      ],
      payments: [{ methodLookupId: cash(), amount: rs(500) }]
    })

    // The line carries the batch it created.
    const batchId = purchase.lines[0]!.batchId
    expect(batchId).not.toBeNull()

    // The batch exists, with the expiry the purchase gave it and the stock it received. `onHandByBatch`
    // is the very function FEFO picks from (sales.pickBatchFefo), soonest-expiry first — so if it can be
    // seen here, FEFO can see it.
    const perBatch = stock.onHandByBatch(t.db, productId)
    expect(perBatch).toHaveLength(1)
    expect(perBatch[0]!.batchId).toBe(batchId)
    expect(perBatch[0]!.batchNo).toBe('B-2026-01')
    expect(perBatch[0]!.expiryDate).toBe('2027-01-01')
    expect(perBatch[0]!.onHandM).toBe(10 * ONE_UNIT)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Re-averaging: buy 10 @ Rs 60, then 10 @ Rs 80 -> average Rs 70
// ═════════════════════════════════════════════════════════════════════════════

describe('weighted-average cost', () => {
  it('buy 10 @ Rs 60, then 10 @ Rs 80 -> the average is Rs 70', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    purchases.createPurchase(
      t.db,
      manager,
      {
        supplierId,
        lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(60) }],
        payments: [{ methodLookupId: cash(), amount: rs(600) }]
      },
      new Date('2026-05-01T10:00:00')
    )
    purchases.createPurchase(
      t.db,
      manager,
      {
        supplierId,
        lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(80) }],
        payments: [{ methodLookupId: cash(), amount: rs(800) }]
      },
      new Date('2026-05-02T10:00:00')
    )

    // (10 × 60 + 10 × 80) / 20 = 70.
    expect(stock.averageCost(t.db, productId)).toBe(cost(70))
    expect(stock.onHand(t.db, productId)).toBe(20 * ONE_UNIT)

    // The rebuild-from-movements audit agrees with the cached average — nothing skipped the blend.
    expect(stock.recomputeAverageCost(t.db, productId)).toBe(cost(70))

    // Stock value = 600 + 800 = 1,400, and GL Inventory agrees to the paisa.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(1400))

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Guards
// ═════════════════════════════════════════════════════════════════════════════

describe('guards', () => {
  it('cannot pay MORE than the bill — there is no change when buying', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    expectUserMessage(
      () =>
        purchases.createPurchase(t.db, manager, {
          supplierId,
          lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(50) }], // Rs 50 bill
          payments: [{ methodLookupId: cash(), amount: rs(100) }] // Rs 100 tendered
        }),
      /more than the bill/i
    )

    // Nothing was written — the shelf is still empty and the books are still bare.
    expect(stock.onHand(t.db, productId)).toBe(0)
  })

  it('cannot tender a purchase onto Payable/Receivable (the "credit" method is refused)', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    // 'credit' resolves to Receivable — a purchase is paid with real money, and the unpaid remainder IS
    // the payable, computed. Tendering onto credit is refused.
    expectUserMessage(
      () =>
        purchases.createPurchase(t.db, manager, {
          supplierId,
          lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(50) }],
          payments: [{ methodLookupId: credit(), amount: rs(50) }]
        }),
      /not on credit|cash, bank/i
    )

    expect(stock.onHand(t.db, productId)).toBe(0)
  })

  it('refuses a purchase against a supplier that does not exist', () => {
    const productId = makeProduct()
    expectUserMessage(
      () =>
        purchases.createPurchase(t.db, manager, {
          supplierId: 9999,
          lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(50) }],
          payments: []
        }),
      /supplier could not be found/i
    )
  })

  it('refuses a purchase against a RETIRED supplier', () => {
    const supplierId = makeSupplier('Acme')
    suppliers.deactivate(t.db, manager, supplierId)
    const productId = makeProduct()

    expectUserMessage(
      () =>
        purchases.createPurchase(t.db, manager, {
          supplierId,
          lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(50) }],
          payments: []
        }),
      /retired/i
    )
  })

  it('refuses receiving a NON-INVENTORY item — a service has no shelf', () => {
    const supplierId = makeSupplier('Acme')
    const serviceId = makeProduct({ itemType: 'non_inventory' })

    expectUserMessage(
      () =>
        purchases.createPurchase(t.db, manager, {
          supplierId,
          lines: [{ productId: serviceId, qtyM: 1 * ONE_UNIT, unitCost: cost(50) }],
          payments: []
        }),
      /not a stocked item/i
    )
  })

  it('refuses a batch number on an item that is not batch-tracked', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct() // not track_batches

    expectUserMessage(
      () =>
        purchases.createPurchase(t.db, manager, {
          supplierId,
          lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(50), batchNo: 'B-1' }],
          payments: []
        }),
      /not set up for batch tracking/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// list + get
// ═════════════════════════════════════════════════════════════════════════════

describe('listPurchases + getPurchase', () => {
  it('lists newest-first, paginates, filters by supplier, and carries the payable remaining', () => {
    const acme = makeSupplier('Acme')
    const other = makeSupplier('Beta')
    const productId = makeProduct()

    // Two bills for Acme, one paid, one on account; one for Beta.
    purchases.createPurchase(
      t.db,
      manager,
      {
        supplierId: acme,
        lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(100) }],
        payments: [{ methodLookupId: cash(), amount: rs(100) }]
      },
      new Date('2026-05-01T10:00:00')
    )
    purchases.createPurchase(
      t.db,
      manager,
      {
        supplierId: acme,
        lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(200) }],
        payments: []
      },
      new Date('2026-05-02T10:00:00')
    )
    purchases.createPurchase(
      t.db,
      manager,
      {
        supplierId: other,
        lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(50) }],
        payments: [{ methodLookupId: bank(), amount: rs(20) }]
      },
      new Date('2026-05-03T10:00:00')
    )

    const all = purchases.listPurchases(t.db)
    expect(all.total).toBe(3)
    // Newest first.
    expect(all.rows[0]!.supplierName).toBe('Beta')

    // Filtered to one supplier.
    const acmeOnly = purchases.listPurchases(t.db, { supplierId: acme })
    expect(acmeOnly.total).toBe(2)
    // The second Acme bill was fully on account — Rs 200 still owed.
    const onAccount = acmeOnly.rows.find((row) => row.payableRemaining === rs(200))
    expect(onAccount).toBeDefined()

    // A page past the end is empty — never an unbounded read.
    expect(purchases.listPurchases(t.db, { page: 99, pageSize: 10 }).rows).toEqual([])

    // getPurchase hydrates the header + lines + payments + the joined names.
    const detail = purchases.getPurchase(t.db, all.rows[0]!.id)
    expect(detail.supplierName).toBe('Beta')
    expect(detail.userName).toBe('Meena Manager')
    expect(detail.lines).toHaveLength(1)
    expect(detail.payments).toHaveLength(1)
    expect(detail.paymentMethodLabels?.[bank()]).toBe('Bank Transfer')

    everythingHolds(t)
  })

  it('an unknown purchase says so plainly', () => {
    expectUserMessage(() => purchases.getPurchase(t.db, 9999), /purchase could not be found/i)
  })

  // Buying audit: the list's date filters used to skip validation — a malformed `to` threw a RangeError
  // and a malformed `from` silently returned an empty page. Now the ISO shape is checked at the boundary.
  it('rejects a malformed date filter with a friendly message, not a crash or a silent empty page', () => {
    expectUserMessage(() => purchases.listPurchases(t.db, { to: 'garbage' }), /pick a date/i)
    expectUserMessage(() => purchases.listPurchases(t.db, { from: '31-12-2026' }), /pick a date/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CORRECTING A PURCHASE INVOICE — reverse + re-enter, never edit in place
// ═════════════════════════════════════════════════════════════════════════════
//
// The client keyed a delivery wrong and could not fix it. A purchase has already moved stock and money,
// so it is REVERSED with a contra and a corrected one is entered — never edited, which would silently
// rewrite months the owner has already read.
//
// The three standing assertions in afterEach() run after EVERY test below, which is the point: the trial
// balance must still balance, GL Inventory must still equal SUM(stock_movements.value_minor), and the
// summed supplier balances must still equal GL Payable — after a void, and after a refused void.

describe('cancelling a purchase', () => {
  /** Receive `qty` @ `unitCostRs`, fully on account (nothing paid) — the case a void is designed for. */
  function receiveOnAccount(
    supplierId: number,
    productId: number,
    qty: number,
    unitCostRs: number,
    invoiceNo: string | null = null
  ): ReturnType<typeof purchases.createPurchase> {
    return purchases.createPurchase(t.db, manager, {
      supplierId,
      supplierInvoiceNo: invoiceNo,
      lines: [{ productId, qtyM: qty * ONE_UNIT, unitCost: cost(unitCostRs) }],
      payments: []
    })
  }

  // ── THE ONE THAT MATTERS ──────────────────────────────────────────────────
  it('reverses the stock at the ORIGINAL FROZEN cost, not at today’s weighted average', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    // Buy 10 @ Rs 60, then 10 @ Rs 80. The weighted average is now Rs 70.
    const first = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-1')
    receiveOnAccount(supplierId, productId, 10, 80, 'BILL-2')

    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(1400)) // 600 + 800
    expect(stock.onHand(t.db, productId)).toBe(20 * ONE_UNIT)

    purchases.voidPurchase(t.db, manager, { id: first.id, reasonCode: 'keyed_wrong' })

    // EXACTLY 600 comes off — what that delivery cost — NOT 700, which is what 10 @ today's average
    // would have removed. Reversing at the average would take out money the shop never paid, and GL
    // Inventory and the stock valuation would part company permanently.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(800))
    expect(stock.onHand(t.db, productId)).toBe(10 * ONE_UNIT)

    everythingHolds(t)
  })

  it('takes the bill back off the supplier’s account, and off their statement', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()

    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)

    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-7')
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(600))
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(rs(600))

    purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' })

    // Back exactly where it started — on BOTH sides. The contra DEBITED Payable; balance() excludes a
    // voided purchase to match. If only one of those had been done, this pair would disagree while the
    // trial balance stayed green (CLAUDE.md trap #17).
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(0)

    // And it is no longer a charge the owner sees when they open the supplier's statement.
    const statement = supplierLedger.ledger(t.db, { supplierId })
    expect(statement.rows.filter((row) => row.kind === 'purchase')).toHaveLength(0)
    expect(statement.balance).toBe(0)

    everythingHolds(t)
  })

  it('keeps the document, its number and all its lines — nothing is ever deleted', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-42')

    const voided = purchases.voidPurchase(t.db, manager, {
      id: purchase.id,
      reasonCode: 'keyed_wrong',
      reasonText: 'Keyed 10 when 100 arrived'
    })

    expect(voided.status).toBe('voided')
    expect(voided.voidReasonCode).toBe('keyed_wrong')
    expect(voided.voidedBy).toBe(manager.id)
    expect(voided.voidedAt).not.toBeNull()

    // It KEEPS its number, its totals and its lines. purchase_lines cascades on delete, so deleting the
    // header would erase every line while its movements and journal remained — figures with nothing left
    // to explain them.
    expect(voided.supplierInvoiceNo).toBe('BILL-42')
    expect(voided.grandTotal).toBe(rs(600))
    expect(voided.lines).toHaveLength(1)

    // The ORIGINAL journal is untouched. The reversal is a SEPARATE, contra journal.
    const journals = t.db
      .prepare('SELECT ref_type FROM journals WHERE ref_id = ? ORDER BY id')
      .pluck()
      .all(String(purchase.id)) as string[]
    expect(journals).toEqual(['purchase', 'purchase_void'])

    everythingHolds(t)
  })

  it('refuses to cancel the same purchase twice', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-3')

    purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' })

    // A second void would reverse the stock and the journal AGAIN — inventory would fall by the value of
    // goods that were only ever received once.
    expectUserMessage(
      () => purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' }),
      /already been cancelled/i
    )

    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(0)
    expect(stock.onHand(t.db, productId)).toBe(0)

    everythingHolds(t)
  })

  it('refuses a purchase that already has goods returned to the supplier', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-4')

    purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    // The return has ALREADY reversed part of this bill. A void reverses the WHOLE of it, so together
    // they would take the returned goods off twice and credit the supplier twice.
    expectUserMessage(
      () => purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' }),
      /already returned to the supplier/i
    )

    expect(purchases.getPurchase(t.db, purchase.id).status).toBe('completed')
    everythingHolds(t)
  })

  it('refuses a purchase that has already been paid, and says what to do instead', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      supplierInvoiceNo: 'BILL-5',
      lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(60) }],
      payments: [{ methodLookupId: cash(), amount: rs(600) }]
    })

    // A contra can reverse a BOOK entry; it cannot walk to the distributor and bring the cash back.
    // Contra-posting would DEBIT Cash — the books would claim the money is back in the till, and the
    // shop would be short by exactly that much at the next count, with the trial balance still green.
    expectUserMessage(
      () => purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' }),
      /already been paid/i
    )

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(rs(-600))
    expect(purchases.getPurchase(t.db, purchase.id).status).toBe('completed')
    everythingHolds(t)
  })

  it('refuses a locked month with a sentence, not a stack trace', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-6')

    const now = new Date()
    ledger.lockPeriod(t.db, now.getFullYear(), now.getMonth() + 1, manager.id)

    expectUserMessage(
      () => purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' }),
      /has been closed.*unlock/is
    )

    expect(purchases.getPurchase(t.db, purchase.id).status).toBe('completed')
    everythingHolds(t)
  })

  it('records WHO cancelled it and WHY — an audit row', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-8')

    purchases.voidPurchase(t.db, manager, {
      id: purchase.id,
      reasonCode: 'duplicate_entry',
      reasonText: 'Same delivery entered twice'
    })

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, entity_id, reason_code, reason_text
           FROM audit_log WHERE action = 'purchase.void'`
      )
      .get() as Record<string, string | number>

    expect(row['user_id']).toBe(manager.id)
    expect(row['user_name']).toBe('Meena Manager')
    expect(row['user_role']).toBe('manager')
    expect(row['entity']).toBe('purchase')
    expect(row['entity_id']).toBe(String(purchase.id))
    expect(row['reason_code']).toBe('duplicate_entry')
    expect(row['reason_text']).toBe('Same delivery entered twice')

    everythingHolds(t)
  })

  it('demands a reason from the owner’s own list — never a hardcoded one', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-9')

    expectUserMessage(
      () => purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'made_up_code' }),
      /choose a reason/i
    )

    expect(purchases.getPurchase(t.db, purchase.id).status).toBe('completed')
    everythingHolds(t)
  })

  it('refuses a cashier — the check is in MAIN, not the hidden button', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-10')
    const cashier = makeUser('cashier', 'kamal', 'Kamal Cashier')

    expectUserMessage(
      () => purchases.voidPurchase(t.db, cashier, { id: purchase.id, reasonCode: 'keyed_wrong' }),
      /needs a manager/i
    )

    expect(purchases.getPurchase(t.db, purchase.id).status).toBe('completed')
    everythingHolds(t)
  })

  // ── The stock has since been SOLD ────────────────────────────────────────
  it('follows the shop’s own negative-stock setting when the goods are already sold', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()
    const purchase = receiveOnAccount(supplierId, productId, 10, 60, 'BILL-11')

    // 8 of the 10 have left the shelf. Reversing all 10 would leave −8.
    stock.adjust(t.db, manager, {
      productId,
      qtyM: -8 * ONE_UNIT,
      reasonCode: 'damage'
    })
    expect(stock.onHand(t.db, productId)).toBe(2 * ONE_UNIT)

    // Default is 'warn': refused until the manager confirms — enforced in MAIN, because a warning the
    // renderer could simply not show is not a warning.
    expectUserMessage(
      () => purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' }),
      /already been sold.*Confirm to continue/is
    )

    // 'block' means blocked, and confirming cannot rescue it.
    settings.set(t.db, 'selling.negativeStock', 'block')
    expectUserMessage(
      () =>
        purchases.voidPurchase(t.db, manager, {
          id: purchase.id,
          reasonCode: 'keyed_wrong',
          acceptNegativeStock: true
        }),
      /less than zero in stock/i
    )

    // Back to 'warn', confirmed: it goes through, and the shelf legitimately goes negative until the
    // corrected invoice is entered. Refusing outright would leave 10 on the books when 1 arrived — a
    // bigger lie than a temporarily negative shelf.
    settings.set(t.db, 'selling.negativeStock', 'warn')
    purchases.voidPurchase(t.db, manager, {
      id: purchase.id,
      reasonCode: 'keyed_wrong',
      acceptNegativeStock: true
    })

    expect(stock.onHand(t.db, productId)).toBe(-8 * ONE_UNIT)
    everythingHolds(t)
  })

  it('reverses a free-sample receipt, which posted no journal at all', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    // Everything zero: stock moves, but there is nothing to post — ledger.post rightly refuses a
    // one-line journal. The void must cope with an original that has no journal to mirror.
    const purchase = receiveOnAccount(supplierId, productId, 10, 0, 'FREE-1')
    expect(purchase.journalId).toBeNull()
    expect(stock.onHand(t.db, productId)).toBe(10 * ONE_UNIT)

    purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' })

    expect(stock.onHand(t.db, productId)).toBe(0)
    expect(purchases.getPurchase(t.db, purchase.id).status).toBe('voided')
    everythingHolds(t)
  })

  it('reverses every line of a multi-line bill, each at its own frozen cost', () => {
    const supplierId = makeSupplier('Acme')
    const productA = makeProduct()
    const productB = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      supplierInvoiceNo: 'BILL-12',
      lines: [
        { productId: productA, qtyM: 10 * ONE_UNIT, unitCost: cost(60) }, // Rs 600
        { productId: productB, qtyM: 5 * ONE_UNIT, unitCost: cost(20) } // Rs 100
      ],
      payments: []
    })
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(700))

    purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'wrong_supplier' })

    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(0)
    expect(stock.onHand(t.db, productA)).toBe(0)
    expect(stock.onHand(t.db, productB)).toBe(0)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)
    everythingHolds(t)
  })

  it('reverses the recoverable input tax too, not just the goods', () => {
    const supplierId = makeSupplier('Acme')
    const productId = makeProduct()

    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      supplierInvoiceNo: 'BILL-13',
      taxTotal: rs(102), // 17% input tax on Rs 600
      lines: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: cost(60) }],
      payments: []
    })

    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(rs(102))
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(702))

    // The contra mirrors the ORIGINAL journal's own lines, so the tax leg reverses with everything else
    // — no special case, and it would still be right if the tax rules changed next year.
    purchases.voidPurchase(t.db, manager, { id: purchase.id, reasonCode: 'keyed_wrong' })

    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(0)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)
    everythingHolds(t)
  })

  // ── The whole point, end to end ──────────────────────────────────────────
  it('the shopkeeper’s correction: cancel the wrong bill, enter the right one', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()

    // Keyed 100 @ Rs 60 when 10 arrived. Rs 6,000 of stock the shop never received.
    const wrong = receiveOnAccount(supplierId, productId, 100, 60, 'BILL-77')
    expect(stock.onHand(t.db, productId)).toBe(100 * ONE_UNIT)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(6000))

    purchases.voidPurchase(t.db, manager, {
      id: wrong.id,
      reasonCode: 'keyed_wrong',
      reasonText: 'Keyed 100, only 10 arrived'
    })
    receiveOnAccount(supplierId, productId, 10, 60, 'BILL-77')

    // The shelf and the bill are both right, and BOTH documents survive to explain how.
    expect(stock.onHand(t.db, productId)).toBe(10 * ONE_UNIT)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(600))
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(600))

    const all = purchases.listPurchases(t.db)
    expect(all.total).toBe(2)
    expect(all.rows.filter((row) => row.status === 'voided')).toHaveLength(1)

    everythingHolds(t)
  })
})
