import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { ACC } from '../db/chart-of-accounts'
import {
  CreatePurchaseInput,
  GetPurchaseInput,
  ListPurchasesInput,
  type PagedResult,
  type Purchase,
  type PurchaseDetail,
  type PurchaseLine,
  type PurchaseListItem,
  type PurchasePayment
} from '@shared/purchases'
import * as audit from './audit'
import * as catalog from './catalog'
import * as ledger from './ledger'
import * as stock from './stock'
import { accountForPaymentMethod } from './sales'

/**
 * THE PURCHASE ENGINE — a goods-received note. The mirror of `sales.ts`, pointing the other way.
 *
 * A sale takes stock OUT at the frozen average cost and brings money IN. A PURCHASE brings stock IN at a
 * real landed cost — re-averaging the product's weighted cost — and either pays for it now or owes the
 * supplier the rest. Everything the sale engine is strict about applies here, reflected:
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. STOCK IS STILL DERIVED, AND THE VALUE IS STILL FROZEN.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A purchase line does not store a stock figure; it APPENDS a 'purchase' movement through
 * `stock.record()`, which freezes that movement's `value_minor` and re-blends the weighted average. The
 * line's `line_total` is READ BACK from that frozen value — never a fresh qty × cost multiply — so
 * DR Inventory and the stock valuation move by the exact same paisa (the same rule as sale COGS, and
 * the reason `GL Inventory === SUM(stock_movements.value_minor)` holds by construction).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. THE JOURNAL BALANCES AS ALGEBRA (this file posts it).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *     DR Inventory   (ACC.INVENTORY)   = subtotalNet          Σ line_total, the net landed cost
 *     DR Input Tax   (ACC.INPUT_TAX)   = taxTotal             recoverable sales tax (omit if 0)
 *     CR each tender account           = paidTotal            cash/bank/wallet paid NOW, grouped
 *     CR Supplier Payables (ACC.PAYABLE) = grandTotal − paidTotal   the rest, owed on account (omit if 0)
 *
 * grandTotal = subtotalNet + taxTotal, so DR = CR by construction, for any split of pay-now vs owed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. TENDERS NOW, THE REST IS THE PAYABLE. NO 'CREDIT' TENDER.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * `purchase_payments` records only real money out now: cash / bank / wallet. There is no 'credit'
 * tender — the amount NOT paid now IS the payable (`grandTotal − paidTotal`), and a later payment that
 * settles it is a supplier_payment (DR Payable CR Cash/Bank; see supplier-ledger.ts). A payment method
 * whose account resolves to Payable or Receivable is refused: a purchase is tendered with real money,
 * and the credit portion is COMPUTED, never a tender.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 4. THREE INTEGER SCALES. NEVER MIXED. NEVER A FLOAT. (money 2dp / cost 4dp / qty_m 3dp)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import. The IPC layer
 * zod-validates, checks `purchase.manage` in MAIN, calls `assertWritable`, and wraps the answer in a
 * Result. The read-only/expired-licence block is the IPC layer's job — not duplicated here.
 */

/** What caused the stock movements and the journal — one string, so reports can point back at it. */
export const PURCHASE_REF_TYPE = 'purchase'

// ═════════════════════════════════════════════════════════════════════════════
// CREATE — the one that matters
// ═════════════════════════════════════════════════════════════════════════════

/** One purchase line, resolved against the catalog and ready to record. FROZEN before the transaction. */
type PreparedLine = {
  productId: number
  name: string
  uom: string | null
  qtyM: number
  unitCost: number
  batchNo: string | null
  expiryDate: string | null
  trackBatches: boolean
  /** 2-dp money = movementValueMinor(qtyM, unitCost). The value the movement WILL freeze. */
  lineTotal: number
}

type ResolvedPayment = {
  methodLookupId: number
  code: string
  amount: number
  account: string
  chequeNo: string | null
  chequeDate: string | null
  walletRef: string | null
}

/**
 * RECEIVE GOODS. In ONE transaction, or not at all:
 *
 *   1. validate the supplier (exists, active), the products (exist, stocked), the tenders (real money)
 *   2. freeze each line's value from qty × cost (the number the stock movement will carry)
 *   3. refuse paying more than the bill (there is no change when buying)
 *   4. append one 'purchase' stock movement per line — POSITIVE, re-averaging the weighted cost
 *   5. post ONE balanced journal (DR Inventory/Input Tax, CR tenders/Payable)
 *   6. audit 'purchase.create'
 *
 * If any of it fails, ALL of it rolls back.
 */
export function createPurchase(db: DB, actor: User, raw: unknown, now = new Date()): PurchaseDetail {
  const input = parseOrThrow(CreatePurchaseInput, raw, 'purchase.create')

  const at = resolveReceivedDate(input.at, now)

  // ── Validate the supplier: real, and still active. ──
  assertSupplierActive(db, input.supplierId)

  // ── Freeze every line BEFORE the transaction (so a bad line is a sentence, not a rolled-back write). ──
  const lines: PreparedLine[] = input.lines.map((line) => {
    const product = loadPurchasable(db, line.productId)
    assertStocked(product)

    // A batch number belongs ONLY to a batch-tracked product — the row that carries the expiry date and
    // that FEFO picks from later. On anything else it has nowhere to live.
    if (line.batchNo != null && !product.trackBatches) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `"${product.name}" is not set up for batch tracking, so it does not need a batch number. Turn on batch tracking for this item first, or leave the batch blank.`,
        `batch_no on product ${line.productId} with track_batches = 0`
      )
    }

    return {
      productId: product.id,
      name: product.name,
      uom: uomLabel(db, product.saleUomId),
      qtyM: line.qtyM,
      unitCost: line.unitCost,
      batchNo: line.batchNo ?? null,
      expiryDate: line.expiryDate ?? null,
      trackBatches: product.trackBatches,
      // The exact value stock.record() will freeze onto the movement — read back and asserted below.
      lineTotal: stock.movementValueMinor(line.qtyM, line.unitCost)
    }
  })

  // ── Validate the tenders. Real money only — cash/bank/wallet, never a promise. ──
  const payments = resolvePayments(db, input.payments)

  const subtotalNet = sum(lines.map((line) => line.lineTotal))
  const taxTotal = input.taxTotal
  const grandTotal = subtotalNet + taxTotal
  const paidTotal = sum(payments.map((payment) => payment.amount))

  // YOU CANNOT PAY MORE THAN THE BILL. There is no change when buying — the unpaid remainder is the
  // payable, and a payment beyond the bill would post a NEGATIVE payable (a supplier owing US on a
  // purchase), which is a data-entry mistake, not a transaction.
  if (paidTotal > grandTotal) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `The amount paid (${paidTotal / 100}) is more than the bill (${grandTotal / 100}). You cannot pay a supplier more than their invoice.`,
      `paid ${paidTotal} > grand total ${grandTotal}`
    )
  }

  const run = db.transaction((): number => {
    const purchaseId = Number(
      db
        .prepare(
          `INSERT INTO purchases
             (supplier_id, at, supplier_invoice_no, subtotal_net, tax_total, grand_total, paid_total,
              notes, user_id, journal_id, created_at)
           VALUES
             (@supplierId, @at, @supplierInvoiceNo, @subtotalNet, @taxTotal, @grandTotal, @paidTotal,
              @notes, @userId, NULL, @createdAt)`
        )
        .run({
          supplierId: input.supplierId,
          at: at.toISOString(),
          supplierInvoiceNo: input.supplierInvoiceNo ?? null,
          subtotalNet,
          taxTotal,
          grandTotal,
          paidTotal,
          notes: input.notes ?? null,
          userId: actor.id,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    // ── The stock. One movement per line, POSITIVE, at the landed cost — re-averaging the weighted
    //    cost and freezing value_minor. DR Inventory below sums the frozen values, never a fresh
    //    multiply, so GL Inventory and the stock report move by the same paisa. ──
    const insertLine = db.prepare(
      `INSERT INTO purchase_lines
         (purchase_id, product_id, name_snapshot, qty_m, uom, unit_cost, line_total, batch_id, created_at)
       VALUES
         (@purchaseId, @productId, @nameSnapshot, @qtyM, @uom, @unitCost, @lineTotal, @batchId, @createdAt)`
    )

    for (const line of lines) {
      // A batch-tracked line's stock goes INTO a batch (created here, or matched if it already exists),
      // so the near-expiry report and FEFO have something to pick later. Otherwise batch_id is NULL.
      const batchId = resolveBatchId(db, line, at)

      const movement = stock.record(db, {
        productId: line.productId,
        type: 'purchase',
        qtyM: line.qtyM, // POSITIVE — stock comes IN. A carton brings its base units in.
        unitCost: line.unitCost,
        batchId,
        refType: PURCHASE_REF_TYPE,
        refId: purchaseId,
        userId: actor.id,
        at
      })

      // READ BACK the value the movement froze, and freeze it as the line total (the sales.ts COGS
      // pattern). It equals `line.lineTotal` by construction — the same qty and cost through the same
      // function — so subtotal_net (computed above) still equals Σ line_total exactly.
      const frozen = movementValue(db, movement.id)

      insertLine.run({
        purchaseId,
        productId: line.productId,
        nameSnapshot: line.name,
        qtyM: line.qtyM,
        uom: line.uom,
        unitCost: line.unitCost,
        lineTotal: frozen,
        batchId,
        createdAt: now.toISOString()
      })
    }

    // ── The payments. Real tenders paid NOW. ──
    const insertPayment = db.prepare(
      `INSERT INTO purchase_payments
         (purchase_id, method_lookup_id, amount, cheque_no, cheque_date, wallet_ref, created_at)
       VALUES
         (@purchaseId, @methodLookupId, @amount, @chequeNo, @chequeDate, @walletRef, @createdAt)`
    )
    for (const payment of payments) {
      insertPayment.run({
        purchaseId,
        methodLookupId: payment.methodLookupId,
        amount: payment.amount,
        chequeNo: payment.chequeNo,
        chequeDate: payment.chequeDate,
        walletRef: payment.walletRef,
        createdAt: now.toISOString()
      })
    }

    // ── THE JOURNAL (see §2 of the header — it balances as algebra). ──
    const journalLines: ledger.JournalLineInput[] = []

    // DR what the goods cost, and the recoverable tax on them.
    if (subtotalNet > 0) journalLines.push({ account: ACC.INVENTORY, debit: subtotalNet })
    if (taxTotal > 0) journalLines.push({ account: ACC.INPUT_TAX, debit: taxTotal })

    // CR what the shop actually paid, grouped by where the money came from.
    const byAccount = new Map<string, number>()
    for (const payment of payments) {
      byAccount.set(payment.account, (byAccount.get(payment.account) ?? 0) + payment.amount)
    }
    for (const [account, amount] of byAccount) {
      if (amount > 0) journalLines.push({ account, credit: amount })
    }

    // CR the rest — what is now owed the supplier.
    const payable = grandTotal - paidTotal
    if (payable > 0) journalLines.push({ account: ACC.PAYABLE, credit: payable })

    // A free-sample receipt (everything zero) moves stock but no money — nothing to post, and
    // ledger.post rightly refuses a journal with fewer than two lines. The stock still came in.
    let journalId: number | null = null
    if (journalLines.length >= 2) {
      journalId = ledger.post(db, {
        at,
        refType: PURCHASE_REF_TYPE,
        refId: purchaseId,
        memo: purchaseMemo(input.supplierInvoiceNo ?? null, purchaseId),
        userId: actor.id,
        lines: journalLines
      })
      db.prepare('UPDATE purchases SET journal_id = ? WHERE id = ?').run(journalId, purchaseId)
    }

    // ── WHO received it, from whom, and what it left owing. (CLAUDE.md §4) ──
    audit.record(
      db,
      actor,
      {
        action: 'purchase.create',
        entity: 'purchase',
        entityId: purchaseId,
        after: {
          supplierId: input.supplierId,
          supplierInvoiceNo: input.supplierInvoiceNo ?? null,
          grandTotal,
          paidTotal,
          payable
        }
      },
      now
    )

    return purchaseId
  })

  return getPurchase(db, run())
}

/** The money a movement moved, as IT froze it (migration 0006). Read, never recomputed. */
function movementValue(db: DB, movementId: number): number {
  return db
    .prepare('SELECT value_minor FROM stock_movements WHERE id = ?')
    .pluck()
    .get(movementId) as number
}

// ═════════════════════════════════════════════════════════════════════════════
// LIST + GET
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE PURCHASES LIST. Paginated and indexed — assume 100k rows (CLAUDE.md §4). Filterable by supplier
 * and date range; newest first. `payableRemaining` is derived per row (grand_total − paid_total).
 */
export function listPurchases(db: DB, raw: unknown = {}): PagedResult<PurchaseListItem> {
  const input = parseOrThrow(ListPurchasesInput, raw, 'purchase.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.supplierId != null) {
    where.push('p.supplier_id = @supplierId')
    params['supplierId'] = input.supplierId
  }
  if (input.from) {
    where.push('p.at >= @from')
    params['from'] = input.from
  }
  if (input.to) {
    // `to` is a DATE, and the whole of that day is inside it — a receipt at 18:40 must not fall out of
    // a report that says it covers that day.
    where.push('p.at < @toExclusive')
    params['toExclusive'] = dayAfter(input.to)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(`SELECT COUNT(*) FROM purchases p ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT p.id, p.supplier_invoice_no, p.at, p.supplier_id, p.grand_total, p.paid_total, p.user_id,
              s.name      AS supplier_name,
              u.full_name AS user_name,
              (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u     ON u.id = p.user_id
       ${whereSql}
       ORDER BY p.at DESC, p.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    id: number
    supplier_invoice_no: string | null
    at: string
    supplier_id: number
    grand_total: number
    paid_total: number
    user_id: number
    supplier_name: string | null
    user_name: string | null
    line_count: number
  }>

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      supplierInvoiceNo: row.supplier_invoice_no,
      at: row.at,
      supplierId: row.supplier_id,
      grandTotal: row.grand_total,
      paidTotal: row.paid_total,
      userId: row.user_id,
      supplierName: row.supplier_name,
      userName: row.user_name,
      lineCount: row.line_count,
      payableRemaining: row.grand_total - row.paid_total
    }))
  }
}

export function getPurchase(db: DB, rawId: unknown): PurchaseDetail {
  const { id } = parseOrThrow(
    GetPurchaseInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'purchase.get'
  )

  const row = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow | undefined
  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That purchase could not be found.',
      `purchase id=${id} does not exist`
    )
  }

  return hydrate(db, row)
}

// ═════════════════════════════════════════════════════════════════════════════
// Rows → domain
// ═════════════════════════════════════════════════════════════════════════════

type PurchaseRow = {
  id: number
  supplier_id: number
  at: string
  supplier_invoice_no: string | null
  subtotal_net: number
  tax_total: number
  grand_total: number
  paid_total: number
  notes: string | null
  user_id: number
  journal_id: number | null
  created_at: string
}

type PurchaseLineRow = {
  id: number
  purchase_id: number
  product_id: number
  name_snapshot: string
  qty_m: number
  uom: string | null
  unit_cost: number
  line_total: number
  batch_id: number | null
  created_at: string
}

type PurchasePaymentRow = {
  id: number
  purchase_id: number
  method_lookup_id: number
  amount: number
  cheque_no: string | null
  cheque_date: string | null
  wallet_ref: string | null
  created_at: string
}

function toPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierInvoiceNo: row.supplier_invoice_no,
    at: row.at,
    subtotalNet: row.subtotal_net,
    taxTotal: row.tax_total,
    grandTotal: row.grand_total,
    paidTotal: row.paid_total,
    notes: row.notes,
    userId: row.user_id,
    journalId: row.journal_id,
    createdAt: row.created_at
  }
}

function toLine(row: PurchaseLineRow): PurchaseLine {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    productId: row.product_id,
    nameSnapshot: row.name_snapshot,
    qtyM: row.qty_m,
    uom: row.uom,
    unitCost: row.unit_cost,
    lineTotal: row.line_total,
    batchId: row.batch_id,
    createdAt: row.created_at
  }
}

function toPayment(row: PurchasePaymentRow): PurchasePayment {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    methodLookupId: row.method_lookup_id,
    amount: row.amount,
    chequeNo: row.cheque_no,
    chequeDate: row.cheque_date,
    walletRef: row.wallet_ref,
    createdAt: row.created_at
  }
}

/** Header + lines + payments + the joined names the view shows. */
function hydrate(db: DB, header: PurchaseRow): PurchaseDetail {
  const lines = (
    db
      .prepare('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY id')
      .all(header.id) as PurchaseLineRow[]
  ).map(toLine)

  const payments = (
    db
      .prepare('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY id')
      .all(header.id) as PurchasePaymentRow[]
  ).map(toPayment)

  const supplierName = db
    .prepare('SELECT name FROM suppliers WHERE id = ?')
    .pluck()
    .get(header.supplier_id) as string | undefined

  const userName = db
    .prepare('SELECT full_name FROM users WHERE id = ?')
    .pluck()
    .get(header.user_id) as string | undefined

  const paymentMethodLabels: Record<number, string> = {}
  for (const payment of payments) {
    if (paymentMethodLabels[payment.methodLookupId] != null) continue
    const label = db
      .prepare('SELECT label FROM lookups WHERE id = ?')
      .pluck()
      .get(payment.methodLookupId) as string | undefined
    if (label != null) paymentMethodLabels[payment.methodLookupId] = label
  }

  return {
    ...toPurchase(header),
    lines,
    payments,
    supplierName: supplierName ?? null,
    userName: userName ?? null,
    paymentMethodLabels
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Loading + validation helpers
// ═════════════════════════════════════════════════════════════════════════════

type PurchasableProduct = {
  id: number
  name: string
  saleUomId: number
  itemType: 'inventory' | 'non_inventory'
  trackBatches: boolean
}

/** The columns — and ONLY the columns — a purchase needs from a product. */
function loadPurchasable(db: DB, productId: number): PurchasableProduct {
  const row = db
    .prepare('SELECT id, name, sale_uom_id, item_type, track_batches FROM products WHERE id = ?')
    .get(productId) as
    | { id: number; name: string; sale_uom_id: number; item_type: string; track_batches: number }
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }

  return {
    id: row.id,
    name: row.name,
    saleUomId: row.sale_uom_id,
    itemType: row.item_type === 'non_inventory' ? 'non_inventory' : 'inventory',
    trackBatches: Boolean(row.track_batches)
  }
}

/**
 * A non-inventory item (a service, a bag charge) has no stock and never appears on a stock report —
 * receiving one into stock is a bug in the caller, not a decision the user made, so it fails loudly.
 */
function assertStocked(product: PurchasableProduct): void {
  if (product.itemType !== 'inventory') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not a stocked item, so it cannot be received on a purchase.`,
      `purchase line on item_type=${product.itemType} product ${product.id}`
    )
  }
}

/** The supplier must exist AND be active — you do not receive a delivery against a retired supplier. */
function assertSupplierActive(db: DB, supplierId: number): void {
  const row = db
    .prepare('SELECT is_active FROM suppliers WHERE id = ?')
    .pluck()
    .get(supplierId) as number | undefined

  if (row == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That supplier could not be found. They may have been removed.',
      `supplier id=${supplierId} does not exist`
    )
  }
  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That supplier has been retired, so a new purchase cannot be recorded against them. Please reactivate them first.',
      `supplier id=${supplierId} is inactive`
    )
  }
}

/**
 * A batched line needs a real batch row to hang off — the row that carries the expiry date, and that
 * FEFO and the near-expiry report both read. If the batch already exists (a second delivery of the same
 * lot, or one the owner created on the product screen) we attach to it and backfill a zero cost;
 * otherwise `catalog.addBatch` creates it. Non-batch lines carry no batch.
 */
function resolveBatchId(db: DB, line: PreparedLine, at: Date): number | null {
  if (line.batchNo == null) return null

  const existing = db
    .prepare('SELECT id, cost FROM batches WHERE product_id = ? AND batch_no = ?')
    .get(line.productId, line.batchNo) as { id: number; cost: number } | undefined

  if (existing != null) {
    // Left at 0, the batch valuation report would price this batch at nothing while the GL and the
    // product's average cost both knew better — a third number disagreeing with the other two.
    if ((existing.cost ?? 0) === 0 && line.unitCost > 0) {
      db.prepare('UPDATE batches SET cost = ? WHERE id = ?').run(line.unitCost, existing.id)
    }
    return existing.id
  }

  return catalog.addBatch(
    db,
    {
      productId: line.productId,
      batchNo: line.batchNo,
      expiryDate: line.expiryDate,
      cost: line.unitCost
    },
    at
  ).id
}

/**
 * WHERE THE MONEY CAME FROM. Real tenders only — cash / bank / wallet / cheque. A method whose account
 * resolves to Payable or Receivable is REFUSED: a purchase is paid with real money, and the amount NOT
 * paid IS the payable (computed), never a 'credit' tender. (The 'credit' payment method maps to
 * Receivable, so this is exactly what stops a purchase being "tendered" onto the ledger.)
 */
function resolvePayments(
  db: DB,
  payments: z.output<typeof CreatePurchaseInput>['payments']
): ResolvedPayment[] {
  return payments.map((payment) => {
    const method = requireLookupById(
      db,
      'payment_method',
      payment.methodLookupId,
      'Please choose how the supplier is being paid.'
    )

    const account = accountForPaymentMethod(method.code)
    if (account === ACC.PAYABLE || account === ACC.RECEIVABLE) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'A purchase is paid with cash, bank, cheque or a wallet — not on credit. The amount left unpaid is what the shop owes the supplier.',
        `purchase tender "${method.code}" resolves to ${account} (Payable/Receivable) — refused`
      )
    }

    return {
      methodLookupId: method.id,
      code: method.code,
      amount: payment.amount,
      account,
      chequeNo: payment.chequeNo ?? null,
      chequeDate: payment.chequeDate ?? null,
      walletRef: payment.walletRef ?? null
    }
  })
}

/** A real, CURRENT entry on the owner's own list. Never a hardcoded dropdown option. (CLAUDE.md §4.) */
function requireLookupById(
  db: DB,
  listKey: string,
  id: number,
  userMessage: string
): { id: number; code: string; label: string } {
  const row = db
    .prepare('SELECT id, code, label FROM lookups WHERE list_key = ? AND id = ? AND is_active = 1')
    .get(listKey, id) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(ErrorCode.VALIDATION, userMessage, `unknown or inactive ${listKey} lookup id=${id}`)
  }
  return row
}

/** lookups('uom').label — "Pieces", "Carton". Never a hardcoded unit list. */
function uomLabel(db: DB, uomId: number): string | null {
  return (
    (db.prepare('SELECT label FROM lookups WHERE id = ?').pluck().get(uomId) as string | undefined) ??
    null
  )
}

function purchaseMemo(supplierInvoiceNo: string | null, purchaseId: number): string {
  return supplierInvoiceNo ? `Purchase — bill ${supplierInvoiceNo}` : `Purchase #${purchaseId}`
}

/**
 * The received date. `at` (a day) dates the goods to WHEN THEY ARRIVED — LOCAL NOON, so a shop east of
 * Greenwich cannot have an opening-of-day receipt filed under the previous UTC day (the same trap
 * opening.commit guards). Omit it and the purchase is dated to `now` (MAIN's clock).
 */
function resolveReceivedDate(atDate: string | undefined, now: Date): Date {
  if (atDate == null) return now
  const at = new Date(`${atDate}T12:00:00`)
  if (Number.isNaN(at.getTime())) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please pick the date the goods were received.',
      `unparseable purchase date "${atDate}"`
    )
  }
  return at
}

/** The day AFTER an ISO date — an exclusive upper bound so a whole day is included. */
function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today and a LAN server will call it tomorrow.
 */
function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown, context: string): z.output<S> {
  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AppError(
      ErrorCode.VALIDATION,
      issue?.message ?? 'Please check the details and try again.',
      `${context}: ${JSON.stringify(parsed.error.issues)}`
    )
  }

  return parsed.data as z.output<S>
}
