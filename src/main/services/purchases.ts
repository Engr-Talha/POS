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
  type PurchasePayment,
  type PurchaseStatus,
  VoidPurchaseInput
} from '@shared/purchases'
import { roleCan } from '@shared/rbac'
import * as settings from './settings'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import { formatQty } from '@shared/qty'
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

/**
 * What caused the CONTRA movements and journal when a purchase is cancelled. DISTINCT from 'purchase',
 * deliberately: a report that sums purchases must not count a reversal as another delivery, and the
 * owner must be able to see that a correction happened rather than find a mysterious negative receipt.
 */
export const PURCHASE_VOID_REF_TYPE = 'purchase_void'

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
// CORRECTING A PURCHASE — reverse, then re-enter
// ═════════════════════════════════════════════════════════════════════════════

/** The owner's own list of settings, with the registry default behind it. (Mirrors sales.ts.) */
function setting<T>(db: DB, key: string): T {
  return settings.get<T>(db, key, REGISTRY_DEFAULTS[key] as T)
}

/** A real, CURRENT entry on the owner's own list — never a hardcoded option (CLAUDE.md §4). */
function requireLookupByCode(
  db: DB,
  listKey: string,
  code: string,
  userMessage: string
): { id: number; code: string; label: string } {
  const row = db
    .prepare('SELECT id, code, label FROM lookups WHERE list_key = ? AND code = ? AND is_active = 1')
    .get(listKey, code) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      userMessage,
      `unknown or inactive ${listKey} code "${code}"`
    )
  }
  return row
}

/**
 * CANCEL A WRONGLY-KEYED PURCHASE. The shopkeeper's "Correct this invoice", first half.
 *
 * THE CLIENT ASKED TO EDIT A PURCHASE. THIS REVERSES IT INSTEAD, AND THAT IS DELIBERATE.
 *
 * A purchase has already put stock on the shelf and money in the books. Editing it in place would
 * rewrite months the owner has already read: last month's stock value and last month's profit would BOTH
 * silently change after they were reported. And the weighted-average cost is a running blend of every
 * movement IN ORDER — rewrite one cost in the middle of that chain and every sale costed off it is
 * quietly wrong, on invoices already handed to customers. So:
 *
 *   THE WRONG INVOICE IS REVERSED WITH A CONTRA. THE CORRECTED ONE IS ENTERED FRESH. NOTHING IS ERASED.
 *
 * The UI presents both halves as ONE button, so it FEELS like editing to the shopkeeper. Underneath, the
 * books can still explain themselves: what was received, that it was cancelled, why, and by whom.
 *
 * This is `sales.voidSale` pointing the other way, and it solves the same four hard parts identically:
 *
 *   · THE STOCK COMES OFF AT THE COST IT CAME ON AT — the ORIGINAL movement's own frozen `unit_cost`,
 *     never today's weighted average. Buy 10 @ 60 then 10 @ 80 and the average is 70; reversing the
 *     first at 70 would take 700 off Inventory for goods that cost 600, and GL Inventory and the stock
 *     valuation would part company on the spot. Reversing at the frozen 60 keeps them equal to the paisa.
 *   · THE JOURNAL IS CONTRA-POSTED BY MIRRORING THE ORIGINAL'S OWN LINES — reversing what was actually
 *     POSTED, not what today's pricing code would post. It balances because the original balanced, and
 *     it stays right even if this file changes next year.
 *   · THE DOCUMENT IS MARKED, NEVER DELETED. It keeps its id and every line. `ON DELETE CASCADE` on
 *     purchase_lines is exactly why deleting would be a catastrophe: the GRN would vanish while its
 *     stock movements and journal remained, and nothing would explain them.
 *   · A REASON CODE from the owner's own lookups list, plus an audit row with a NAME on it.
 *
 * `void` is a reserved word in JavaScript. Hence `voidPurchase`.
 */
export function voidPurchase(db: DB, actor: User, raw: unknown, now = new Date()): PurchaseDetail {
  const input = parseOrThrow(VoidPurchaseInput, raw, 'purchase.void')

  // RBAC IN MAIN. The UI is not a security boundary (CLAUDE.md §4) — hiding the button is a courtesy.
  if (!roleCan(actor.role, 'purchase.void')) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Correcting a purchase invoice needs a manager. Please ask one to do it.',
      `purchase.void needs manager; actor=${actor.role}`
    )
  }

  const purchase = getPurchase(db, input.id)

  // ── Already cancelled: refuse. Voiding twice would reverse the stock and the journal a SECOND time —
  //    inventory would go down by the value of goods that were only ever received once. ──
  if (purchase.status === 'voided') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${describe(purchase)} has already been cancelled.`,
      `purchase ${input.id} is already voided`
    )
  }

  // ── GOODS ALREADY SENT BACK TO THE SUPPLIER: refuse. ──────────────────────
  // A void reverses the WHOLE bill. A purchase return has ALREADY reversed part of it — its own negative
  // movements and its own journal. Voiding on top would take the returned goods off the shelf a second
  // time (phantom negative stock) and credit the supplier twice. The two documents are mutually
  // exclusive, exactly as voidSale refuses a sale with returns against it.
  const returnCount = db
    .prepare('SELECT COUNT(*) FROM purchase_returns WHERE purchase_id = ?')
    .pluck()
    .get(input.id) as number
  if (returnCount > 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${describe(purchase)} has goods already returned to the supplier against it, so it cannot be cancelled. Please deal with those returns first.`,
      `purchase ${input.id} has ${returnCount} supplier return(s); refusing to void to avoid double reversal`
    )
  }

  // ── ALREADY PAID: refuse, and say what to do instead. ─────────────────────
  //
  // THE DECISION (documented because it is a judgement call, not a rule the schema forced):
  //
  // `paid_total` is money that PHYSICALLY LEFT the drawer or the bank at receipt time. A contra can
  // reverse a BOOK entry; it cannot walk to the distributor and bring cash back. Contra-posting the
  // original journal would DEBIT Cash for the amount paid — the books would say the money is back in the
  // till, and the shop would be short by exactly that much at the next count, with a green trial balance
  // hiding it. (The trial balance would still balance. It always does. That is why it is not the only
  // test that matters here.)
  //
  // Nor can we quietly leave the tender leg out of the contra: then the journal would not balance, and
  // ledger.post would rightly refuse it.
  //
  // So a paid purchase is refused, and pointed at the instrument that ALREADY handles money coming back:
  // a purchase RETURN settled as 'refund', which records the real tender the supplier actually refunds
  // through. An UNPAID purchase — the overwhelmingly common case, and the one the client hit, keying a
  // delivery that goes on the account — reverses cleanly, because the only money involved is a Payable
  // that no one has settled yet.
  if (purchase.paidTotal > 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${describe(purchase)} has already been paid, so it cannot simply be cancelled — the money has left the shop. Please record a return to the supplier instead, so the refund is recorded against a real payment method.`,
      `purchase ${input.id} has paid_total=${purchase.paidTotal}; refusing to void (a contra cannot un-spend real money)`
    )
  }

  // ── A LOCKED MONTH refuses it. ─────────────────────────────────────────────
  // ledger.post enforces this anyway, but it is checked UP FRONT so the manager gets a sentence rather
  // than a rolled-back transaction — and so a zero-value receipt (a free sample, which posts no journal
  // at all) is covered too. The message is already a friendly one; it is re-thrown untouched.
  ledger.assertPeriodOpen(db, now.getFullYear(), now.getMonth() + 1)

  // ── WHY, from the owner's OWN void_reason list — the same list a sale void uses. ──
  const reason = requireLookupByCode(
    db,
    'void_reason',
    input.reasonCode,
    'Please choose a reason for cancelling this purchase.'
  )

  // ── THE STOCK HAS SINCE BEEN SOLD. ─────────────────────────────────────────
  //
  // THE DECISION: allow, warn, or block — following the shop's OWN `selling.negativeStock` setting,
  // because being inconsistent with it would be its own bug. If the owner has decided the shelf may go
  // negative at the till (the default, 'warn' — a stock count is usually just out of date), it makes no
  // sense to hold a keying correction to a stricter standard than a sale. And REFUSING outright would be
  // actively harmful: a wrongly-keyed purchase that has since been partly sold is EXACTLY the case the
  // client needs fixed, and the alternative — leaving 100 units on the books when 10 arrived — is a
  // bigger lie than a temporarily negative shelf. The correcting invoice, entered moments later, puts
  // the right quantity back.
  const movements = db
    .prepare(
      `SELECT id, product_id, batch_id, qty_m, unit_cost
         FROM stock_movements
        WHERE ref_type = ? AND ref_id = ? AND type = 'purchase' AND qty_m > 0`
    )
    .all(PURCHASE_REF_TYPE, String(input.id)) as Array<{
    id: number
    product_id: number
    batch_id: number | null
    qty_m: number
    unit_cost: number
  }>

  assertReversalStockPolicy(db, movements, input.acceptNegativeStock === true)

  const run = db.transaction((): void => {
    // ── The stock comes back OFF the shelf, at the cost it came ON at ────────
    //
    // The ORIGINAL movement's frozen unit_cost, reused. Taking it off at TODAY'S weighted average would
    // remove a value the shop never paid, and GL Inventory would drift from the stock valuation
    // permanently. Onto the SAME batch it arrived on, so a batch-tracked product's FEFO picture is
    // reversed as precisely as it was created.
    for (const movement of movements) {
      stock.record(db, {
        productId: movement.product_id,
        type: 'purchase',
        qtyM: -movement.qty_m, // the mirror image: what came in goes back out
        unitCost: movement.unit_cost, // AT THE COST IT CAME IN AT
        batchId: movement.batch_id,
        refType: PURCHASE_REF_TYPE,
        refId: input.id,
        note: `Cancelled: ${describe(purchase)}`,
        userId: actor.id,
        at: now
      })
    }

    // ── The CONTRA journal. The original is NEVER touched. ──────────────────
    //
    // Built by MIRRORING the original journal's own lines, so it reverses what was actually POSTED —
    // not what the code above would post today. Every debit becomes a credit and every credit a debit,
    // so it balances because the original balanced. DR Payable here is what takes the bill back off the
    // supplier's account; supplier-ledger.balance() excludes a voided purchase to match, and a test
    // asserts the two still agree.
    const original = db
      .prepare(
        `SELECT l.debit AS debit, l.credit AS credit, a.code AS code
           FROM journals j
           JOIN journal_lines l ON l.journal_id = j.id
           JOIN accounts a      ON a.id = l.account_id
          WHERE j.ref_type = ? AND j.ref_id = ?
          ORDER BY l.id`
      )
      .all(PURCHASE_REF_TYPE, String(input.id)) as Array<{
      debit: number
      credit: number
      code: string
    }>

    if (original.length > 0) {
      ledger.post(db, {
        at: now,
        refType: PURCHASE_VOID_REF_TYPE,
        refId: input.id,
        memo: `Cancelled: ${describe(purchase)} (${reason.label})`,
        userId: actor.id,
        lines: original.map((line) =>
          line.debit > 0
            ? { account: line.code, credit: line.debit }
            : { account: line.code, debit: line.credit }
        )
      })
    }

    // ── The purchase is marked cancelled. IT KEEPS ITS NUMBER AND ITS LINES. ──
    // Never deleted: purchase_lines cascades on delete, so deleting the header would erase every line
    // while its stock movements and its journal remained — figures in the books with nothing left to
    // explain them. A migration-0020 trigger enforces that these four columns move together.
    db.prepare(
      `UPDATE purchases
          SET status = 'voided', void_reason_code = ?, voided_by = ?, voided_at = ?
        WHERE id = ?`
    ).run(reason.code, actor.id, now.toISOString(), input.id)

    // ── WHO cancelled it, WHY, and what it was worth. (CLAUDE.md §4) ────────
    audit.record(
      db,
      actor,
      {
        action: 'purchase.void',
        entity: 'purchase',
        entityId: input.id,
        reasonCode: reason.code,
        ...(input.reasonText != null ? { reasonText: input.reasonText } : {}),
        before: {
          status: 'completed',
          supplierId: purchase.supplierId,
          supplierInvoiceNo: purchase.supplierInvoiceNo,
          grandTotal: purchase.grandTotal,
          paidTotal: purchase.paidTotal
        },
        after: { status: 'voided', supplierInvoiceNo: purchase.supplierInvoiceNo }
      },
      now
    )
  })

  run()
  return getPurchase(db, input.id)
}

/** How a purchase names itself in a sentence a shopkeeper reads. */
function describe(purchase: Purchase): string {
  return purchase.supplierInvoiceNo
    ? `Purchase ${purchase.supplierInvoiceNo}`
    : `Purchase #${purchase.id}`
}

/**
 * REVERSING STOCK THAT HAS SINCE BEEN SOLD. Consistent with `selling.negativeStock` — see the long note
 * at the call site for why this follows the shop's own setting rather than inventing a stricter one.
 *
 *   'block' refused, in plain language.
 *   'warn'  refused UNTIL the manager confirms (`acceptNegativeStock`), then allowed. Enforced HERE, in
 *           MAIN — a warning the renderer could simply not show is not a warning.
 *   'allow' nothing is asked.
 */
function assertReversalStockPolicy(
  db: DB,
  movements: Array<{ product_id: number; qty_m: number }>,
  accepted: boolean
): void {
  // What the reversal would leave on the shelf, per product — several lines may share one product.
  const wanted = new Map<number, number>()
  for (const movement of movements) {
    wanted.set(movement.product_id, (wanted.get(movement.product_id) ?? 0) + movement.qty_m)
  }

  const shortages: string[] = []
  for (const [productId, qtyM] of wanted) {
    const onHandM = stock.onHand(db, productId)
    if (onHandM < qtyM) {
      const name = db.prepare('SELECT name FROM products WHERE id = ?').pluck().get(productId) as
        | string
        | undefined
      shortages.push(
        `${name ?? `product #${productId}`} (${formatQty(onHandM)} in stock, cancelling ${formatQty(qtyM)})`
      )
    }
  }
  if (shortages.length === 0) return

  const detail = shortages.join(', ')
  const policy = setting<string>(db, 'selling.negativeStock')

  if (policy === 'block') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Some of this delivery has already been sold, so cancelling it would leave less than zero in stock: ${detail}. Please adjust the stock first, or record a return to the supplier instead.`,
      `purchase void would drive stock negative, blocked by selling.negativeStock=block: ${detail}`
    )
  }

  if (policy === 'warn' && !accepted) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Some of this delivery has already been sold, so cancelling it will leave less than zero in stock for now: ${detail}. That is usually fine — entering the corrected invoice will put it right. Confirm to continue.`,
      `purchase void negative-stock warning not yet accepted: ${detail}`
    )
  }
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
              p.status,
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
    status: PurchaseStatus
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
      status: row.status,
      supplierName: row.supplier_name,
      userName: row.user_name,
      lineCount: row.line_count,
      // A CANCELLED bill owes nothing. Its contra already took the payable back off the supplier's
      // account, so showing the original remainder here would have the list contradict both the
      // supplier ledger and the books.
      payableRemaining: row.status === 'voided' ? 0 : row.grand_total - row.paid_total
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
  status: PurchaseStatus
  void_reason_code: string | null
  voided_by: number | null
  voided_at: string | null
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
    status: row.status,
    voidReasonCode: row.void_reason_code,
    voidedBy: row.voided_by,
    voidedAt: row.voided_at,
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
