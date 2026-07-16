import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as purchaseReturns from './purchase-returns'
import * as purchases from './purchases'
import * as suppliers from './suppliers'
import * as supplierLedger from './supplier-ledger'
import * as reports from './reports'
import * as stock from './stock'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * RETURNS TO SUPPLIER — goods going BACK, and the money that follows. (Migration 0016.)
 *
 * FIVE STANDING ASSERTIONS RUN AFTER EVERY SCENARIO, and they are the whole point:
 *
 *   1. THE TRIAL BALANCE BALANCES.                                (CLAUDE.md §4 — the standing test)
 *   2. GL INVENTORY === SUM(stock_movements.value_minor). CR Inventory sums the movements' OWN frozen
 *      values (never a fresh qty × cost), so the books and the stock valuation move by the same paisa.
 *   3. GL ACCOUNTS PAYABLE === the summed supplier balances. A 'supplier_credit' return DEBITS Payable,
 *      so `balance()` must subtract it — or the ledger screen chases a distributor for money the GL says
 *      is no longer owed, with the trial balance still green. (CLAUDE.md trap #17.)
 *   4. THE SUPPLIER AGING TOTAL === GL ACCOUNTS PAYABLE. The same question as (3), asked through the
 *      other screen that answers it. `supplierAging` shipped omitting 'supplier_credit' returns while
 *      `balance()` subtracted them: same trap, second path, and (3) alone did not catch it.
 *   5. EVERY PRODUCT'S CACHED AVERAGE COST === the average rebuilt from its movements alone.
 */

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The `asOf` the aging assertion reports at — far enough ahead that every scenario in this file falls
 * inside the window, so a missing figure is always a real omission and never a date-range artefact.
 */
const AGING_ASOF = '2099-01-01'

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

/**
 * THE SUPPLIER AGING REPORT TOTAL === GL Accounts Payable.
 *
 * The same reconciliation as assertPayablesReconcile, through the OTHER screen that answers "what does
 * the shop owe?". `balance()` and `supplierAging` are two independent sums over the same facts, and a
 * 'supplier_credit' return DEBITS Payable — so BOTH must subtract it. Fixing only `balance()` left the
 * aging report chasing a distributor for stock they had already taken back, with the trial balance and
 * every other assertion still green. That is CLAUDE.md trap #17 — a derived figure must be correct from
 * EVERY path — and it is why this assertion stands alongside the other four rather than in one test.
 *
 * `asOf` is deliberately far in the future: every return in this file is inside the window, so anything
 * the report drops is a genuine omission and never an out-of-range date.
 */
function assertSupplierAgingReconciles(t: TestDb): void {
  const aging = reports.supplierAging(t.db, { asOf: AGING_ASOF })
  expect(
    aging.totals.total,
    'the supplier aging total has drifted from GL Accounts Payable'
  ).toBe(ledger.accountBalance(t.db, ACC.PAYABLE))
}

/** The cached weighted average never lies — it equals the rebuild from the movements alone. */
function assertAveragesAreHonest(t: TestDb): void {
  const ids = t.db.prepare("SELECT id FROM products WHERE item_type = 'inventory'").pluck().all() as number[]
  for (const id of ids) {
    expect(
      stock.averageCost(t.db, id),
      `product ${id}: the cached average cost has drifted from its movements`
    ).toBe(stock.recomputeAverageCost(t.db, id))
  }
}

function everythingHolds(t: TestDb): void {
  assertBooksBalance(t)
  assertInventoryReconciles(t)
  assertPayablesReconcile(t)
  assertSupplierAgingReconciles(t)
  assertAveragesAreHonest(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

let t: TestDb
let manager: User

/** 2-dp money minor units from rupees. Rs 60 -> 6000. */
const rs = (rupees: number): number => Math.round(rupees * 100)
/**
 * 4-dp cost units from rupees. Rs 60 -> 600000. A DIFFERENT scale, 100× money.
 *
 * `Math.round` because the fixture itself must not hand a float to a service that only takes integers:
 * `91.0417 * 10_000` is 910417.0000000001 in IEEE-754, and zod rightly refuses it. Exactly the reason
 * this app never lets a float near the ledger — the test helper is held to the same rule.
 */
const cost = (rupees: number): number => Math.round(rupees * 10_000)

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
const creditMethod = (): number => lookupId('payment_method', 'credit')

function makeProduct(opts: { trackBatches?: boolean } = {}): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, 'Tin', @uomId, 0, 10000, 0, 0, 'exclusive', 1, 'inventory', 0, @trackBatches, 0,
                 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        uomId: lookupId('uom', 'pcs'),
        trackBatches: opts.trackBatches ? 1 : 0,
        now
      }).lastInsertRowid
  )
}

function makeSupplier(name: string): number {
  return suppliers.create(t.db, manager, { name }).id
}

/** Receive `qty` units at `unitCost` rupees, wholly ON ACCOUNT (nothing paid now). */
function receive(
  supplierId: number,
  productId: number,
  qty: number,
  unitCostRs: number,
  extra: { taxTotal?: number; batchNo?: string; invoiceNo?: string } = {}
): ReturnType<typeof purchases.createPurchase> {
  return purchases.createPurchase(t.db, manager, {
    supplierId,
    supplierInvoiceNo: extra.invoiceNo ?? null,
    taxTotal: extra.taxTotal ?? 0,
    lines: [
      {
        productId,
        qtyM: qty * ONE_UNIT,
        unitCost: cost(unitCostRs),
        ...(extra.batchNo != null ? { batchNo: extra.batchNo } : {})
      }
    ],
    payments: []
  })
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  manager = makeUser('manager', 'meena', 'Meena Manager')
})

afterEach(() => {
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SUPPLIER BALANCE MUST STAY TIED TO THE GL — trap #17
// ═════════════════════════════════════════════════════════════════════════════

describe('a supplier_credit return and the ledger', () => {
  it('lowers the derived supplier balance AND GL Payables by the same paisa', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60, { invoiceNo: 'BILL-1' })

    // Rs 600 of tins, all on account.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(600))
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(rs(600))

    // Two tins go back, taken off the bill.
    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    expect(ret.grandTotal).toBe(rs(120))

    // BOTH move, by the same paisa. This is the assertion the whole file exists for.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(480))
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(rs(480))

    everythingHolds(t)
  })

  it('shows the return on the supplier statement as a credit, and the running balance ends on balance()', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60, { invoiceNo: 'BILL-7' })

    purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 3 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'expired',
      reasonText: 'Short-dated on arrival'
    })

    const statement = supplierLedger.ledger(t.db, { supplierId })
    const returnRow = statement.rows.find((row) => row.kind === 'return')

    expect(returnRow, 'the return is missing from the supplier statement').toBeDefined()
    expect(returnRow!.payment).toBe(rs(180)) // it LOWERS what the shop owes
    expect(returnRow!.charge).toBe(0)
    expect(returnRow!.description).toContain('BILL-7')

    // The statement's last running balance IS balance(). If the union and balance() ever disagree about
    // which rows count, this is what catches it.
    const last = statement.rows[statement.rows.length - 1]!
    expect(last.balanceAfter).toBe(supplierLedger.balance(t.db, supplierId))
    expect(statement.balance).toBe(rs(420))

    everythingHolds(t)
  })

  it('a refund return brings money IN and does NOT touch Payables or the statement', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    const payableBefore = supplierLedger.balance(t.db, supplierId)
    const cashBefore = ledger.accountBalance(t.db, ACC.CASH)

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    expect(ret.grandTotal).toBe(rs(120))

    // Cash came IN...
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(cashBefore + rs(120))
    // ...and what the shop owes did NOT move. A refund is not a credit off the bill.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(payableBefore)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(payableBefore)

    // And it is nowhere on the statement — it never touched the supplier's account.
    const statement = supplierLedger.ledger(t.db, { supplierId })
    expect(statement.rows.some((row) => row.kind === 'return')).toBe(false)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GOODS LEAVE AT THE COST THEY CAME IN AT — the crux
// ═════════════════════════════════════════════════════════════════════════════

describe('the frozen cost', () => {
  it('sends goods back at the PURCHASE LINE cost, not today’s weighted average', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()

    // Buy 10 @ Rs 60, then 10 @ Rs 80. The weighted average is now Rs 70.
    const first = receive(supplierId, productId, 10, 60)
    receive(supplierId, productId, 10, 80)
    expect(stock.averageCost(t.db, productId)).toBe(cost(70))

    const inventoryBefore = ledger.accountBalance(t.db, ACC.INVENTORY)

    // Send ONE of the FIRST tins back. It cost Rs 60. It must leave at Rs 60 — NOT Rs 70.
    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: first.id,
      lines: [{ purchaseLineId: first.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    expect(ret.lines[0]!.unitCost, 'the line did not copy the purchase line’s frozen cost').toBe(cost(60))
    expect(ret.lines[0]!.lineTotal).toBe(rs(60))
    expect(ret.subtotalNet).toBe(rs(60))

    // Inventory fell by Rs 60, not Rs 70.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(inventoryBefore - rs(60))

    // AND the weighted average of what remains stays honest. 19 tins are left; the books carry
    // Rs 1400 − Rs 60 = Rs 1340 of them. A decrease never moves the average, so it is still Rs 70 —
    // which is exactly what the rebuild from the movements says.
    expect(stock.averageCost(t.db, productId)).toBe(cost(70))
    expect(stock.onHand(t.db, productId)).toBe(19 * ONE_UNIT)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(rs(1340))

    everythingHolds(t)
  })

  it('records a NEGATIVE movement whose frozen value IS the line total (never a fresh multiply)', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    // A cost that does not divide cleanly into paisa — where a fresh multiply would drift.
    const purchase = receive(supplierId, productId, 3, 91.0417)

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 3 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'quality'
    })

    const movement = t.db
      .prepare("SELECT * FROM stock_movements WHERE ref_type = 'purchase_return' AND ref_id = ?")
      .get(String(ret.id)) as { qty_m: number; unit_cost: number; value_minor: number; type: string }

    expect(movement.type).toBe('purchase_return')
    expect(movement.qty_m, 'stock must LEAVE — the movement is negative').toBe(-3 * ONE_UNIT)
    expect(movement.unit_cost).toBe(cost(91.0417))
    // The line carries the MAGNITUDE of what the movement froze. Same number, one rounding, both sides.
    expect(ret.lines[0]!.lineTotal).toBe(Math.abs(movement.value_minor))

    everythingHolds(t)
  })

  it('sends the goods back out of the batch they came in on', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct({ trackBatches: true })
    const purchase = receive(supplierId, productId, 10, 60, { batchNo: 'LOT-A' })
    const batchId = purchase.lines[0]!.batchId

    expect(batchId, 'the purchase should have created a batch').not.toBeNull()

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 4 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'expired'
    })

    expect(ret.lines[0]!.batchId).toBe(batchId)

    const movementBatch = t.db
      .prepare("SELECT batch_id FROM stock_movements WHERE ref_type = 'purchase_return' AND ref_id = ?")
      .pluck()
      .get(String(ret.id)) as number
    expect(movementBatch, 'the goods left a batch they never came in on').toBe(batchId)

    // The batch's own on-hand fell — FEFO and the near-expiry report stay honest.
    const batch = stock.onHandByBatch(t.db, productId).find((b) => b.batchId === batchId)!
    expect(batch.onHandM).toBe(6 * ONE_UNIT)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// INPUT TAX, PRO-RATA, REMAINDER ON THE LAST
// ═════════════════════════════════════════════════════════════════════════════

describe('input tax handed back', () => {
  it('is apportioned pro-rata by value returned', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    // Rs 1000 of goods + Rs 170 input tax (17%).
    const purchase = receive(supplierId, productId, 10, 100, { taxTotal: rs(170) })

    const inputTaxBefore = ledger.accountBalance(t.db, ACC.INPUT_TAX)
    expect(inputTaxBefore).toBe(rs(170))

    // Send 2 of 10 back — a fifth of the value, so a fifth of the tax.
    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    expect(ret.subtotalNet).toBe(rs(200))
    expect(ret.taxTotal).toBe(rs(34)) // 170 × 200/1000
    expect(ret.grandTotal).toBe(rs(234))

    // The reclaimed tax was handed back — Input Tax fell by exactly that.
    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(rs(136))
    // And the whole grand total came off the bill.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(1170) - rs(234))

    everythingHolds(t)
  })

  /**
   * REGRESSION — FREE STOCK CAN STILL CARRY TAX.
   *
   * A promotional bill: the goods are free, the GST is real and reclaimed. `taxTotal` is its own field on
   * the bill, not derived from the lines, and `unitCost` may legitimately be 0. Apportioning by VALUE
   * cannot divide a zero-value bill, and this used to bail out and hand back NOTHING: send every unit
   * back and the shop still owed the distributor for goods it no longer had, with the reclaimed tax
   * stranded on the GL forever — trial balance green throughout. Quantity is the ruler when value is 0.
   */
  it('hands the tax back on a ZERO-VALUE bill (free stock, GST still charged)', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    // 10 free tins, Rs 50 GST on the invoice, wholly on account.
    const purchase = receive(supplierId, productId, 10, 0, { taxTotal: rs(50) })
    expect(purchase.subtotalNet).toBe(0)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(rs(50)) // owes the tax

    // Send 4 of the 10 back: no value, but 40% of the goods — so 40% of the tax.
    const part = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 4 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })
    expect(part.subtotalNet).toBe(0)
    expect(part.taxTotal, 'a zero-value bill must apportion its tax BY QUANTITY').toBe(rs(20))
    expect(part.grandTotal).toBe(rs(20))
    everythingHolds(t)

    // The remaining 6 go back too. The bill is now fully returned: the tax must land EXACTLY back at 0,
    // and the shop must owe nothing for goods it no longer has.
    const rest = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 6 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })
    expect(rest.taxTotal).toBe(rs(30))

    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX), 'input tax stranded on a fully returned bill').toBe(0)
    expect(supplierLedger.balance(t.db, supplierId), 'still owes for goods sent back').toBe(0)
    everythingHolds(t)
  })

  /** The quantity path must difference like the value path: the LAST return takes the exact remainder. */
  it('a zero-value bill returned in indivisible pieces sums back to its tax EXACTLY', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    // 3 free tins, 1 paisa of tax — no whole-paisa third exists.
    const purchase = receive(supplierId, productId, 3, 0, { taxTotal: 1 })

    let handedBack = 0
    for (let i = 0; i < 3; i++) {
      handedBack += purchaseReturns.createPurchaseReturn(t.db, manager, {
        purchaseId: purchase.id,
        lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
        settlement: 'supplier_credit',
        reasonCode: 'damaged'
      }).taxTotal
    }

    expect(handedBack, 'the parts must sum back to the whole').toBe(1)
    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(0)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)
    everythingHolds(t)
  })

  it('omits the tax leg entirely when the purchase reclaimed no input tax', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60) // taxTotal 0

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    expect(ret.taxTotal).toBe(0)
    expect(ret.grandTotal).toBe(ret.subtotalNet)

    const legs = t.db
      .prepare(
        `SELECT a.code FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
          WHERE jl.journal_id = ?`
      )
      .pluck()
      .all(ret.journalId) as string[]
    expect(legs, 'a zero Input Tax leg must not be posted').not.toContain(ACC.INPUT_TAX)

    everythingHolds(t)
  })

  /**
   * THE ONE THAT CATCHES SUM-OF-ROUNDED DRIFT. A purchase returned in pieces must hand back EXACTLY the
   * tax it reclaimed — no more, no less. A tax total that does not divide evenly by the returned
   * quantities is the whole point: each part rounds, and only remainder-on-last trues it up.
   */
  it('a purchase returned in pieces sums back to its tax_total EXACTLY', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    // Rs 1000 of goods, and a tax total that resists thirds: Rs 100.01.
    const purchase = receive(supplierId, productId, 3, 100, { taxTotal: 10_001 })
    const lineId = purchase.lines[0]!.id

    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(10_001)

    const taxes: number[] = []
    for (let i = 0; i < 3; i++) {
      const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
        purchaseId: purchase.id,
        lines: [{ purchaseLineId: lineId, qtyM: 1 * ONE_UNIT }],
        settlement: 'supplier_credit',
        reasonCode: 'damaged'
      })
      taxes.push(ret.taxTotal)
      everythingHolds(t)
    }

    // The parts sum back to the whole, to the paisa. (3 × round(10001/3) would be 10,002 — a paisa of
    // reclaimed tax conjured from nothing, with the trial balance still green.)
    expect(taxes.reduce((a, b) => a + b, 0), 'the parts do not sum back to tax_total').toBe(10_001)
    // The final return took the exact remainder, whatever the earlier ones rounded to.
    expect(taxes[2]).toBe(10_001 - taxes[0]! - taxes[1]!)

    // Everything went back, so the whole bill is reversed: Input Tax is empty, and nothing is owed.
    expect(ledger.accountBalance(t.db, ACC.INPUT_TAX)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(0)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// NEVER MORE THAN CAME IN
// ═════════════════════════════════════════════════════════════════════════════

describe('the over-return guard', () => {
  it('refuses more than was received, in plain language naming what is left', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: purchase.id,
          lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 11 * ONE_UNIT }],
          settlement: 'supplier_credit',
          reasonCode: 'damaged'
        }),
      /at most 10/
    )

    everythingHolds(t)
  })

  it('counts EVERY prior return of the line, across several returns', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)
    const lineId = purchase.lines[0]!.id

    const send = (qty: number): unknown =>
      purchaseReturns.createPurchaseReturn(t.db, manager, {
        purchaseId: purchase.id,
        lines: [{ purchaseLineId: lineId, qtyM: qty * ONE_UNIT }],
        settlement: 'supplier_credit',
        reasonCode: 'damaged'
      })

    send(4)
    send(4)
    everythingHolds(t)

    // 8 of 10 have gone. Only 2 remain — a third return of 3 must be refused.
    expectUserMessage(() => send(3), /at most 2/)

    // ...and the 2 that DO remain still go back fine.
    send(2)
    expect(purchaseReturns.returnablePurchaseLines(t.db, purchase.id).lines[0]!.returnableQtyM).toBe(0)

    // Once it is fully returned, the message says so rather than offering "at most 0".
    expectUserMessage(() => send(1), /already been sent back/)

    // Everything went back: no stock, nothing owed.
    expect(stock.onHand(t.db, productId)).toBe(0)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)
    everythingHolds(t)
  })

  it('refuses the same purchase line listed twice in one return', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)
    const lineId = purchase.lines[0]!.id

    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: purchase.id,
          lines: [
            { purchaseLineId: lineId, qtyM: 3 * ONE_UNIT },
            { purchaseLineId: lineId, qtyM: 3 * ONE_UNIT }
          ],
          settlement: 'supplier_credit',
          reasonCode: 'damaged'
        }),
      /more than once/
    )

    everythingHolds(t)
  })

  it('refuses a line that belongs to a different purchase', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const mine = receive(supplierId, productId, 10, 60)
    const theirs = receive(supplierId, productId, 10, 80)

    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: mine.id,
          lines: [{ purchaseLineId: theirs.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
          settlement: 'supplier_credit',
          reasonCode: 'damaged'
        }),
      /not on this purchase/
    )

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SETTLEMENT
// ═════════════════════════════════════════════════════════════════════════════

describe('the settlement', () => {
  it('refuses a refund tender that resolves to Payable/Receivable', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    // The 'credit' method maps to Receivable. A refund onto it would book the distributor as a DEBTOR
    // of the shop — a receivable with nobody behind it. Taking it off the bill is its own settlement.
    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: purchase.id,
          lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: creditMethod(),
          reasonCode: 'damaged'
        }),
      /not on credit/
    )

    // Nothing was written — not the return, not the stock, not a journal.
    expect(t.db.prepare('SELECT COUNT(*) FROM purchase_returns').pluck().get()).toBe(0)
    expect(stock.onHand(t.db, productId)).toBe(10 * ONE_UNIT)
    everythingHolds(t)
  })

  it('a bank refund lands on Bank, through the same mapping every other tender uses', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    const bankBefore = ledger.accountBalance(t.db, ACC.BANK)

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 5 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: bank(),
      reasonCode: 'not_ordered'
    })

    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(bankBefore + rs(300))
    expect(ret.refundMethodLookupId).toBe(bank())
    expect(ret.refundMethodLabel).not.toBeNull()

    everythingHolds(t)
  })

  it('a supplier_credit return carries no refund method (the DB CHECK, honoured by the service)', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    // A stray refundMethodLookupId on a credit settlement must not reach the DB's CHECK — the service
    // fixes the companion column by settlement.
    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
      settlement: 'supplier_credit',
      refundMethodLookupId: cash(),
      reasonCode: 'damaged'
    })

    expect(ret.refundMethodLookupId).toBeNull()
    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE REASON, AND THE AUDIT
// ═════════════════════════════════════════════════════════════════════════════

describe('the reason code and the audit trail', () => {
  it('is validated against the LIVE lookups list, not a hardcoded one', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: purchase.id,
          lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
          settlement: 'supplier_credit',
          reasonCode: 'because-i-said-so'
        }),
      /choose a reason/
    )
  })

  it('refuses a reason the owner has since RETIRED', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    t.db
      .prepare("UPDATE lookups SET is_active = 0 WHERE list_key = 'purchase_return_reason' AND code = 'damaged'")
      .run()

    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: purchase.id,
          lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
          settlement: 'supplier_credit',
          reasonCode: 'damaged'
        }),
      /choose a reason/
    )
  })

  it('records WHO sent the goods back, WHY, and against WHICH purchase', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged',
      reasonText: 'Two tins dented'
    })

    const row = t.db
      .prepare("SELECT * FROM audit_log WHERE action = 'purchase.return'")
      .get() as Record<string, string>

    expect(row).toBeDefined()
    expect(row['user_name']).toBe('Meena Manager')
    expect(row['user_role']).toBe('manager') // the role is SNAPSHOTTED, never joined later
    expect(row['reason_code']).toBe('damaged')
    expect(row['reason_text']).toBe('Two tins dented')
    expect(row['entity_id']).toBe(String(ret.id))
    expect(JSON.parse(row['after_json']!)).toMatchObject({
      settlement: 'supplier_credit',
      grandTotal: rs(120)
    })
    expect(JSON.parse(row['before_json']!)).toMatchObject({ purchaseId: purchase.id, supplierId })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// READING
// ═════════════════════════════════════════════════════════════════════════════

describe('returnablePurchaseLines', () => {
  it('reports received, already-returned, returnable and the frozen cost, per line', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    const before = purchaseReturns.returnablePurchaseLines(t.db, purchase.id)
    expect(before.supplierId).toBe(supplierId)
    expect(before.lines[0]).toMatchObject({
      receivedQtyM: 10 * ONE_UNIT,
      alreadyReturnedQtyM: 0,
      returnableQtyM: 10 * ONE_UNIT,
      unitCost: cost(60),
      lineTotal: rs(600)
    })

    purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 3 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    const after = purchaseReturns.returnablePurchaseLines(t.db, purchase.id)
    expect(after.lines[0]).toMatchObject({
      receivedQtyM: 10 * ONE_UNIT,
      alreadyReturnedQtyM: 3 * ONE_UNIT,
      returnableQtyM: 7 * ONE_UNIT,
      unitCost: cost(60) // still the FROZEN cost — the UI must quote what the goods will leave at
    })

    everythingHolds(t)
  })

  it('throws a friendly NOT_FOUND for a purchase that does not exist', () => {
    expectUserMessage(() => purchaseReturns.returnablePurchaseLines(t.db, 9999), /could not be found/)
  })
})

describe('listPurchaseReturns', () => {
  it('paginates, and filters by purchase and by supplier', () => {
    const acme = makeSupplier('Acme Distributors')
    const bolt = makeSupplier('Bolt Traders')
    const productId = makeProduct()
    const acmePurchase = receive(acme, productId, 10, 60)
    const boltPurchase = receive(bolt, productId, 10, 60)

    const send = (purchase: { id: number; lines: Array<{ id: number }> }): void => {
      purchaseReturns.createPurchaseReturn(t.db, manager, {
        purchaseId: purchase.id,
        lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
        settlement: 'supplier_credit',
        reasonCode: 'damaged'
      })
    }

    send(acmePurchase)
    send(acmePurchase)
    send(boltPurchase)

    expect(purchaseReturns.listPurchaseReturns(t.db, {}).total).toBe(3)
    expect(purchaseReturns.listPurchaseReturns(t.db, { purchaseId: acmePurchase.id }).total).toBe(2)

    // The supplier filter joins THROUGH the purchase — the only thing that says whose goods these were.
    const boltPage = purchaseReturns.listPurchaseReturns(t.db, { supplierId: bolt })
    expect(boltPage.total).toBe(1)
    expect(boltPage.rows[0]!.supplierName).toBe('Bolt Traders')
    expect(boltPage.rows[0]!.lineCount).toBe(1)
    expect(boltPage.rows[0]!.userName).toBe('Meena Manager')

    const page = purchaseReturns.listPurchaseReturns(t.db, { page: 2, pageSize: 2 })
    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(3)

    everythingHolds(t)
  })

  it('includes a return made LATE on the `to` day (the whole day is inside the filter)', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    const lateEvening = new Date('2026-03-05T18:40:00.000Z')
    purchaseReturns.createPurchaseReturn(
      t.db,
      manager,
      {
        purchaseId: purchase.id,
        lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
        settlement: 'supplier_credit',
        reasonCode: 'damaged'
      },
      lateEvening
    )

    expect(
      purchaseReturns.listPurchaseReturns(t.db, { from: '2026-03-05', to: '2026-03-05' }).total,
      'a 18:40 return fell out of a report that says it covers that day'
    ).toBe(1)
  })

  /** The same fix expenses took: the shape alone lets 2026-02-30 through, and JS rolls it to March 2. */
  it('rejects a CALENDAR-INVALID date rather than silently reporting the wrong window', () => {
    expectUserMessage(
      () => purchaseReturns.listPurchaseReturns(t.db, { from: '2026-02-30' }),
      /not a real calendar date/
    )
    expectUserMessage(
      () => purchaseReturns.listPurchaseReturns(t.db, { to: '2026-13-01' }),
      /Please pick a date|not a real calendar date/
    )
    // ...and a real leap day still passes.
    expect(() => purchaseReturns.listPurchaseReturns(t.db, { from: '2028-02-29' })).not.toThrow()
  })
})

describe('getPurchaseReturn', () => {
  it('returns the header, its lines and the joined labels', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60, { invoiceNo: 'BILL-9' })

    const created = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'supplier_credit',
      reasonCode: 'damaged',
      notes: 'Collected by their driver'
    })

    const fetched = purchaseReturns.getPurchaseReturn(t.db, created.id)
    expect(fetched.supplierName).toBe('Acme Distributors')
    expect(fetched.purchaseInvoiceNo).toBe('BILL-9')
    expect(fetched.userName).toBe('Meena Manager')
    expect(fetched.notes).toBe('Collected by their driver')
    expect(fetched.lines).toHaveLength(1)
    expect(fetched.journalId).not.toBeNull()
    // grand_total = subtotal_net + tax_total, always (a DB CHECK, and the service's own arithmetic).
    expect(fetched.grandTotal).toBe(fetched.subtotalNet + fetched.taxTotal)
  })

  it('throws a friendly NOT_FOUND for a return that does not exist', () => {
    expectUserMessage(() => purchaseReturns.getPurchaseReturn(t.db, 9999), /could not be found/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ATOMICITY, AND THE PERIOD LOCK
// ═════════════════════════════════════════════════════════════════════════════

describe('one transaction', () => {
  it('writes nothing at all when a later line is refused', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productA = makeProduct()
    const productB = makeProduct()
    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [
        { productId: productA, qtyM: 10 * ONE_UNIT, unitCost: cost(60) },
        { productId: productB, qtyM: 10 * ONE_UNIT, unitCost: cost(80) }
      ],
      payments: []
    })

    const payableBefore = supplierLedger.balance(t.db, supplierId)

    // The first line is fine; the SECOND asks for more than came in. All of it must roll back.
    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(t.db, manager, {
          purchaseId: purchase.id,
          lines: [
            { purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT },
            { purchaseLineId: purchase.lines[1]!.id, qtyM: 99 * ONE_UNIT }
          ],
          settlement: 'supplier_credit',
          reasonCode: 'damaged'
        }),
      /at most 10/
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM purchase_returns').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM purchase_return_lines').pluck().get()).toBe(0)
    expect(
      t.db.prepare("SELECT COUNT(*) FROM stock_movements WHERE type = 'purchase_return'").pluck().get(),
      'the first line’s stock movement survived a rolled-back return'
    ).toBe(0)
    expect(stock.onHand(t.db, productA)).toBe(10 * ONE_UNIT)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(payableBefore)

    everythingHolds(t)
  })

  it('multi-line: the header totals are Σ line_total, and one journal covers the lot', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productA = makeProduct()
    const productB = makeProduct()
    const purchase = purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [
        { productId: productA, qtyM: 10 * ONE_UNIT, unitCost: cost(60) },
        { productId: productB, qtyM: 10 * ONE_UNIT, unitCost: cost(80) }
      ],
      payments: []
    })

    const ret = purchaseReturns.createPurchaseReturn(t.db, manager, {
      purchaseId: purchase.id,
      lines: [
        { purchaseLineId: purchase.lines[0]!.id, qtyM: 2 * ONE_UNIT }, // 2 × 60 = 120
        { purchaseLineId: purchase.lines[1]!.id, qtyM: 3 * ONE_UNIT } // 3 × 80 = 240
      ],
      settlement: 'supplier_credit',
      reasonCode: 'damaged'
    })

    expect(ret.subtotalNet).toBe(rs(360))
    expect(ret.subtotalNet).toBe(ret.lines.reduce((total, line) => total + line.lineTotal, 0))

    // ONE journal for the whole document, not one per line.
    const journals = t.db
      .prepare("SELECT COUNT(*) FROM journals WHERE ref_type = 'purchase_return' AND ref_id = ?")
      .pluck()
      .get(String(ret.id)) as number
    expect(journals).toBe(1)

    everythingHolds(t)
  })

  it('a LOCKED month refuses the return outright', () => {
    const supplierId = makeSupplier('Acme Distributors')
    const productId = makeProduct()
    const purchase = receive(supplierId, productId, 10, 60)

    const when = new Date('2026-03-05T10:00:00.000Z')
    ledger.lockPeriod(t.db, when.getFullYear(), when.getMonth() + 1, manager.id)

    expectUserMessage(
      () =>
        purchaseReturns.createPurchaseReturn(
          t.db,
          manager,
          {
            purchaseId: purchase.id,
            lines: [{ purchaseLineId: purchase.lines[0]!.id, qtyM: 1 * ONE_UNIT }],
            settlement: 'supplier_credit',
            reasonCode: 'damaged'
          },
          when
        ),
      /closed|locked/i
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM purchase_returns').pluck().get()).toBe(0)
    everythingHolds(t)
  })
})
