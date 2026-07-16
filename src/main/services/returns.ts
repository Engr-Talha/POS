import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { roleCan } from '@shared/rbac'
import { ACC } from '../db/chart-of-accounts'
import { formatQty } from '@shared/qty'
import {
  CreateReturnInput,
  GetReturnInput,
  ListReturnsInput,
  RETURN_REF_TYPE,
  type PagedResult,
  type Return,
  type ReturnDetail,
  type ReturnLine,
  type ReturnListItem,
  type ReturnableLine,
  type ReturnableSale,
  type Settlement
} from '@shared/returns'
import type { SaleDetail, SaleLine } from '@shared/sales'
import { SALE_REF_TYPE } from '@shared/sales'
import * as audit from './audit'
import * as auth from './auth'
import * as ledger from './ledger'
import * as loyalty from './loyalty'
import * as sales from './sales'
import * as stock from './stock'
import { openShiftId } from './shift-id'

/**
 * THE RETURNS ENGINE. Goods coming BACK, and the money that goes back with them. (Migration 0011.)
 *
 * This is the shop's money going the other way, so it obeys exactly the disciplines the SALE engine
 * does — and it deliberately mirrors `services/sales.ts` line for line where it can:
 *
 *   • FREEZE, NEVER RECOMPUTE. A return line copies the ORIGINAL sale line's frozen net / tax / gross /
 *     unit_cost, scaled to the quantity coming back. Return three tins in August that were sold in
 *     March and the refund is what was charged in March and the stock comes back at what it cost in
 *     March — so GL Inventory and the stock report move by the SAME paisa (migration 0006, extended to
 *     returns). Nothing is ever re-read from today's price, tax rate or average cost.
 *
 *   • WHAT THE CUSTOMER ACTUALLY PAID IS ALREADY ON THE SALE LINE. The sale service apportions a cart
 *     discount INTO the lines and re-resolves each line's tax on what the customer then pays for it
 *     (sales.ts §2, `priceCart` pass 2). So `sale_lines.net` / `.tax_amount` are ALREADY net of the
 *     cart discount — they ARE what the customer paid for the line. A return therefore scales those
 *     frozen figures directly; "unwinding" the cart discount a second time here would refund too
 *     little. (Proven by the cart-discount test: a full return of a discounted sale refunds its whole
 *     grand total, to the paisa.)
 *
 *   • REMAINDER ON THE LAST RETURN. A line returned in several goes must sum back to the sale line
 *     EXACTLY — no sum-of-rounded drift. Each return freezes the DIFFERENCE between the cumulative
 *     amount due for (already-returned + this) units and what was already returned; the final return,
 *     which takes the line to fully-returned, gets the exact remainder. Cumulative differencing also
 *     makes every partial non-negative, which the naïve per-return round does not guarantee.
 *
 *   • THE JOURNAL BALANCES AS ALGEBRA (see `postReturnJournal`), and it posts the stock movements' OWN
 *     frozen values — never a fresh multiply.
 *
 *   • SUPERVISOR-APPROVED, REASON-CODED, AUDITED — exactly like `sales.voidSale`.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no Result envelope and no
 * `electron` import. The IPC layer zod-validates, checks read-only/licence, and wraps the answer.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Small shared helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate at the SERVICE boundary, not only at the IPC one — the services layer is the real boundary
 * (CLAUDE.md §3). vitest calls it directly today; a LAN server will call it tomorrow.
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

/**
 * Split a frozen money figure (`total`, at the sold quantity) pro-rata to `qtyM` of `soldQtyM`, rounded
 * half-up to the paisa. BigInt for the multiply — the same guard `extendPrice`/`movementValueCost` use,
 * so a huge line cannot silently overflow a float's exact-integer range. All arguments are >= 0 and
 * `soldQtyM > 0` (a sale line always sold something).
 */
function proRata(total: number, qtyM: number, soldQtyM: number): number {
  if (soldQtyM <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Something went wrong reading that sale line. Please try again.',
      `proRata got soldQtyM=${soldQtyM} (must be > 0)`
    )
  }
  const num = BigInt(total) * BigInt(qtyM)
  const den = BigInt(soldQtyM)
  const value = (num * 2n + den) / (den * 2n) // floor(num/den + 1/2) — round half up
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That amount is too large to record. Please split it into smaller returns.',
      `proRata result ${value} exceeds safe integer range (total=${total} qtyM=${qtyM} soldQtyM=${soldQtyM})`
    )
  }
  return result
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
    throw new AppError(ErrorCode.VALIDATION, userMessage, `unknown or inactive ${listKey} code "${code}"`)
  }
  return row
}

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

/** Is this catalogue product a stocked item? Only an inventory item can be — or should be — restocked. */
function isInventoryProduct(db: DB, productId: number): boolean {
  const itemType = db.prepare('SELECT item_type FROM products WHERE id = ?').pluck().get(productId) as
    | string
    | undefined
  return itemType === 'inventory'
}

/** The money a stock movement froze (migration 0006). Read, never recomputed — like sales.ts does. */
function movementValueMinor(db: DB, movementId: number): number {
  return db.prepare('SELECT value_minor FROM stock_movements WHERE id = ?').pluck().get(movementId) as number
}

/**
 * Split a restock across the batches the SALE actually drew this product from, so a returned unit goes
 * back onto the SAME batch it left — FEFO and expiry stay honest even when one sale line was filled from
 * several batches. Putting the whole return back on the sale line's single frozen batch (which the
 * receipt records, but which is only ONE of the batches a big line may have consumed) over-credits that
 * batch and starves the others, so the near-expiry report and per-batch on-hand quietly drift.
 *
 * The sale recorded one negative 'sale' movement per batch (allocateFefo, sales.ts). We take the return
 * back in that same order, capped per batch by (sold − already returned by ANY return of this sale, this
 * one's earlier lines included), so a partial return refills the earliest batch first and can never put
 * more onto a batch than came off it. Any remainder that cannot be attributed — a negative-stock sale
 * that recorded no batch, or data written before this code — falls to the sale line's frozen batch, so
 * nothing is ever dropped. The money is unaffected either way: value_minor is frozen from unit_cost.
 */
function allocateRestockBatches(
  db: DB,
  saleId: number,
  productId: number,
  qtyToRestock: number,
  fallbackBatchId: number | null
): Array<{ batchId: number | null; qtyM: number }> {
  const sold = db
    .prepare(
      `SELECT batch_id AS batchId, -SUM(qty_m) AS qty
         FROM stock_movements
        WHERE ref_type = ? AND ref_id = ? AND product_id = ? AND type = 'sale'
        GROUP BY batch_id
        HAVING qty > 0
        ORDER BY MIN(id)`
    )
    .all(SALE_REF_TYPE, String(saleId), productId) as Array<{ batchId: number | null; qty: number }>

  // How much every prior return of THIS sale (including this return's already-written earlier lines) has
  // already put back on each batch — so we cap against what is still OUT, never re-crediting a batch.
  const prior = db
    .prepare(
      `SELECT sm.batch_id AS batchId, SUM(sm.qty_m) AS qty
         FROM stock_movements sm
         JOIN returns r ON r.id = CAST(sm.ref_id AS INTEGER)
        WHERE sm.ref_type = ? AND sm.type = 'sale_return' AND sm.product_id = ? AND r.sale_id = ?
        GROUP BY sm.batch_id`
    )
    .all(RETURN_REF_TYPE, productId, saleId) as Array<{ batchId: number | null; qty: number }>
  const priorByBatch = new Map<number | null, number>()
  for (const row of prior) priorByBatch.set(row.batchId, row.qty)

  const allocations: Array<{ batchId: number | null; qtyM: number }> = []
  let remaining = qtyToRestock
  for (const batch of sold) {
    if (remaining <= 0) break
    const stillOut = batch.qty - (priorByBatch.get(batch.batchId) ?? 0)
    if (stillOut <= 0) continue
    const take = Math.min(remaining, stillOut)
    allocations.push({ batchId: batch.batchId, qtyM: take })
    remaining -= take
  }
  if (remaining > 0) allocations.push({ batchId: fallbackBatchId, qtyM: remaining })
  return allocations
}

// ═════════════════════════════════════════════════════════════════════════════
// Who may do this — mirror sales.voidSale exactly
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A RETURN/REFUND IS A SUPERVISOR ACTION (rbac `sale.refund`), enforced HERE in MAIN — hiding a button
 * is a courtesy, not a control (CLAUDE.md §4).
 *
 * If the person at the till already holds the role, they authorise their own. Otherwise a supervisor's
 * PIN is entered and resolves to a REAL user IN MAIN (`auth.verifyPin`) — never an id the renderer
 * claims, or a cashier passes the owner's id (usually 1) and refunds a television to themselves. The
 * authoriser's role is snapshotted onto the return, exactly as the audit log snapshots names and roles.
 */
function resolveAuthoriser(db: DB, actor: User, approverPin: string | null | undefined): User {
  if (roleCan(actor.role, 'sale.refund')) return actor

  // The claimed actor cannot do this alone. A supervisor's PIN must approve it. verifyPin throws a
  // friendly "PIN not recognised" if it matches nobody — so a missing or wrong PIN lands there.
  const approver = approverPin ? auth.verifyPin(db, approverPin) : null

  if (approver == null || !roleCan(approver.role, 'sale.refund')) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Processing a return needs a supervisor. Please ask one to enter their PIN to approve it.',
      `sale.refund needs supervisor; actor=${actor.role}, approver=${approver?.role ?? 'none'}`
    )
  }
  return approver
}

// ═════════════════════════════════════════════════════════════════════════════
// CREATE A RETURN — the one that matters
// ═════════════════════════════════════════════════════════════════════════════

/** One return line, fully resolved and FROZEN, ready to insert and to drive the stock + journal legs. */
type FrozenReturnLine = {
  saleLine: SaleLine
  qtyM: number
  net: number
  taxAmount: number
  gross: number
  /** The EFFECTIVE restock flag — 1 only when a stock movement will actually be written. */
  restocked: boolean
}

/**
 * PROCESS A RETURN. In ONE transaction, or not at all:
 *
 *   1. the original sale is loaded and proven to be COMPLETED (never a held/quote/voided sale);
 *   2. the return is authorised (Supervisor, or a supervisor's PIN) and given a live reason code;
 *   3. each line is checked against what REMAINS returnable, and its refund is FROZEN from the sale
 *      line, scaled and remainder-on-last so partial returns sum back to the line exactly;
 *   4. restocked lines append a POSITIVE 'sale_return' movement at the line's frozen cost;
 *   5. the balanced journal posts (it throws if it does not balance);
 *   6. one audit row records WHO, WHY and against WHICH sale.
 */
export function createReturn(db: DB, actor: User, rawInput: unknown, now = new Date()): ReturnDetail {
  const input = parseOrThrow(CreateReturnInput, rawInput, 'return.create')

  // ── The original sale: it must be REAL and COMPLETE ──────────────────────
  const sale = sales.getById(db, input.saleId)
  if (sale.status !== 'completed') {
    throw new AppError(
      ErrorCode.VALIDATION,
      sale.status === 'voided'
        ? `Invoice ${sale.invoiceNo} was cancelled, so there is nothing to return against it.`
        : 'Only a completed sale can be returned. A parked cart is simply discarded.',
      `return against sale ${input.saleId} with status "${sale.status}"`
    )
  }

  // ── WHO authorises it — resolved in main, never claimed ──────────────────
  const authoriser = resolveAuthoriser(db, actor, input.approverPin)

  // ── WHY — a live code on the owner's own refund_reason list ───────────────
  const reason = requireLookupByCode(
    db,
    'refund_reason',
    input.reasonCode,
    'Please choose a reason for this return.'
  )

  // ── WHERE the money settles ──────────────────────────────────────────────
  const settlement = resolveSettlement(db, sale, input)

  // A locked month refuses a return, just as it refuses a sale — a return writes into a period. Checked
  // up front so the cashier gets a sentence, not a rolled-back transaction. (stock.record and
  // ledger.post below check it again; harmless, and it also covers a zero-value return that posts
  // neither a movement nor a journal.)
  ledger.assertPeriodOpen(db, now.getFullYear(), now.getMonth() + 1)

  const saleLineById = new Map(sale.lines.map((line) => [line.id, line]))

  const run = db.transaction((): number => {
    // ── Freeze every line against what REMAINS returnable ──────────────────
    const priorOf = db.prepare(
      `SELECT COALESCE(SUM(qty_m), 0)     AS q,
              COALESCE(SUM(net), 0)        AS n,
              COALESCE(SUM(tax_amount), 0) AS t
         FROM return_lines WHERE sale_line_id = ?`
    )

    const seen = new Set<number>()
    const frozen: FrozenReturnLine[] = []

    for (const lineInput of input.lines) {
      if (seen.has(lineInput.saleLineId)) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'That item is listed more than once. Please combine it into a single line.',
          `sale_line ${lineInput.saleLineId} appears twice in one return`
        )
      }
      seen.add(lineInput.saleLineId)

      const saleLine = saleLineById.get(lineInput.saleLineId)
      if (!saleLine) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'One of those items is not on this sale. Please look the sale up again.',
          `sale_line ${lineInput.saleLineId} does not belong to sale ${sale.id}`
        )
      }

      const prior = priorOf.get(lineInput.saleLineId) as { q: number; n: number; t: number }
      const returnableQtyM = saleLine.qtyM - prior.q

      if (lineInput.qtyM > returnableQtyM) {
        throw new AppError(
          ErrorCode.VALIDATION,
          returnableQtyM <= 0
            ? `All of "${saleLine.nameSnapshot}" has already been returned.`
            : `You can return at most ${formatQty(returnableQtyM)} of "${saleLine.nameSnapshot}" — ${formatQty(prior.q)} of ${formatQty(saleLine.qtyM)} has already come back.`,
          `return qty ${lineInput.qtyM} exceeds returnable ${returnableQtyM} for sale_line ${saleLine.id} (sold ${saleLine.qtyM}, prior ${prior.q})`
        )
      }

      // REMAINDER ON THE LAST RETURN. The refund for this return is the cumulative amount due for
      // (prior + this) units MINUS what prior returns already booked. The final return — the one that
      // takes the line to fully returned — gets the exact remainder, so the parts sum back to the sale
      // line to the paisa. `prior.n`/`prior.t` are read from the DB, so the last return always trues up
      // no matter how the earlier ones rounded.
      const totalAfterQtyM = prior.q + lineInput.qtyM
      const isFinal = totalAfterQtyM === saleLine.qtyM

      const cumNet = isFinal ? saleLine.net : proRata(saleLine.net, totalAfterQtyM, saleLine.qtyM)
      const cumTax = isFinal ? saleLine.taxAmount : proRata(saleLine.taxAmount, totalAfterQtyM, saleLine.qtyM)

      // max(0, …): a partial can never book more than the cumulative due, and the final remainder is
      // always >= 0 because prior returns never exceed the line (the qty check above guarantees it).
      const net = Math.max(0, cumNet - prior.n)
      const taxAmount = Math.max(0, cumTax - prior.t)
      const gross = net + taxAmount // satisfies the line CHECK (gross = net + tax_amount)

      // RESTOCK only what there is a shelf to restock: a catalogue INVENTORY item, and only if the
      // cashier is putting it back (not writing it off as damaged). An open item and a non-inventory
      // service have no stock and never take a movement — so their effective restock flag is 0, which
      // keeps "restocked = 1 ⟺ a sale_return movement exists" honest.
      const canRestock =
        lineInput.restocked && saleLine.productId != null && isInventoryProduct(db, saleLine.productId)

      frozen.push({ saleLine, qtyM: lineInput.qtyM, net, taxAmount, gross, restocked: canRestock })
    }

    const subtotalNet = frozen.reduce((total, line) => total + line.net, 0)
    const taxTotal = frozen.reduce((total, line) => total + line.taxAmount, 0)
    const grandTotal = subtotalNet + taxTotal

    // ── Write the return header (journal_id filled in once posted) ──────────
    const returnId = Number(
      db
        .prepare(
          `INSERT INTO returns
             (sale_id, at, user_id, approved_by, approved_by_role, reason_code, reason_text,
              settlement, refund_method_lookup_id, exchange_group_id,
              subtotal_net, tax_total, grand_total, journal_id, shift_id, notes, created_at)
           VALUES
             (@saleId, @at, @userId, @approvedBy, @approvedByRole, @reasonCode, @reasonText,
              @settlement, @refundMethodLookupId, @exchangeGroupId,
              @subtotalNet, @taxTotal, @grandTotal, NULL, @shiftId, @notes, @createdAt)`
        )
        .run({
          saleId: sale.id,
          at: now.toISOString(),
          userId: actor.id,
          approvedBy: authoriser.id,
          approvedByRole: authoriser.role,
          reasonCode: reason.code,
          reasonText: input.reasonText ?? null,
          settlement: settlement.kind,
          refundMethodLookupId: settlement.refundMethodLookupId,
          exchangeGroupId: settlement.exchangeGroupId,
          subtotalNet,
          taxTotal,
          grandTotal,
          // The OPEN shift this refund belongs to, or NULL if the till is not on a shift (migration 0012).
          shiftId: openShiftId(db),
          notes: input.notes ?? null,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    // ── The lines, and the stock that comes back with them ─────────────────
    const insertLine = db.prepare(
      `INSERT INTO return_lines
         (return_id, sale_line_id, product_id, name_snapshot, qty_m, uom,
          net, tax_rate_bp, tax_amount, gross, unit_cost, restocked, batch_id, created_at)
       VALUES
         (@returnId, @saleLineId, @productId, @nameSnapshot, @qtyM, @uom,
          @net, @taxRateBp, @taxAmount, @gross, @unitCost, @restocked, @batchId, @createdAt)`
    )

    // The stock movements' OWN frozen values, summed for the inventory leg — never a fresh multiply, so
    // GL Inventory and the stock valuation move by the SAME paisa (migration 0006).
    let restockValueMinor = 0

    for (const line of frozen) {
      const { saleLine } = line

      insertLine.run({
        returnId,
        saleLineId: saleLine.id,
        productId: saleLine.productId,
        nameSnapshot: saleLine.nameSnapshot,
        qtyM: line.qtyM,
        uom: saleLine.uom,
        net: line.net,
        taxRateBp: saleLine.taxRateBp,
        taxAmount: line.taxAmount,
        gross: line.gross,
        // The 4-dp weighted-average cost frozen on the sale line — what these units cost the shop.
        unitCost: saleLine.unitCost,
        restocked: line.restocked ? 1 : 0,
        // Restock to the SAME batch it was sold from — FEFO and expiry stay honest.
        batchId: line.restocked ? saleLine.batchId : null,
        createdAt: now.toISOString()
      })

      if (line.restocked && saleLine.productId != null) {
        // POSITIVE qty — the goods come BACK — at the cost they LEFT at, onto the SAME batches the sale
        // drew from (a big line may have spanned several). stock.record freezes each movement's
        // value_minor and keeps the weighted average honest, exactly as voidSale does.
        const allocations = allocateRestockBatches(db, sale.id, saleLine.productId, line.qtyM, saleLine.batchId)
        for (const allocation of allocations) {
          const movement = stock.record(db, {
            productId: saleLine.productId,
            type: 'sale_return',
            qtyM: allocation.qtyM,
            unitCost: saleLine.unitCost,
            batchId: allocation.batchId,
            refType: RETURN_REF_TYPE,
            refId: returnId,
            userId: actor.id,
            at: now
          })
          restockValueMinor += movementValueMinor(db, movement.id)
        }
      }
    }

    // ── The journal, posted once, in this same transaction ─────────────────
    const journalId = postReturnJournal(db, {
      returnId,
      invoiceNo: sale.invoiceNo,
      reasonLabel: reason.label,
      settlementAccount: settlement.account,
      subtotalNet,
      taxTotal,
      grandTotal,
      restockValueMinor,
      userId: actor.id,
      now
    })

    if (journalId != null) {
      db.prepare('UPDATE returns SET journal_id = ? WHERE id = ?').run(journalId, returnId)
    }

    // ── The points for goods that came back ────────────────────────────────
    // In THIS transaction: a return and its points are one act. Without it a customer buys Rs 1000 of
    // goods, earns 1000 points, returns the lot for a full refund and KEEPS the points — free money, over
    // and over, with the trial balance green the whole time because the liability really is owed. It just
    // should never have been booked. (CLAUDE.md trap #17: the earn was right when the sale happened; this
    // is the path that keeps it right afterwards.) A no-op when the sale earned nothing — loyalty off, or
    // a walk-in. Proportional to the NET going back, which is the basis the points were earned on.
    loyalty.clawbackForReturn(
      db,
      actor,
      { saleId: sale.id, returnId, returnedNet: subtotalNet, saleNet: sale.subtotalNet },
      now
    )

    // ── WHO did WHAT, WHY, and against WHICH sale (CLAUDE.md §4) ────────────
    audit.record(
      db,
      actor,
      {
        action: 'sale.return',
        entity: 'return',
        entityId: returnId,
        reasonCode: reason.code,
        ...(input.reasonText != null ? { reasonText: input.reasonText } : {}),
        // The approver's name and role land beside the actor's — only when a SEPARATE supervisor
        // approved it, exactly as voidSale records it (a supervisor acting alone is already the actor).
        ...(authoriser.id !== actor.id ? { approvedBy: authoriser } : {}),
        before: { invoiceNo: sale.invoiceNo, saleGrandTotal: sale.grandTotal },
        after: {
          returnId,
          settlement: settlement.kind,
          grandTotal,
          lineCount: frozen.length,
          restocked: frozen.filter((line) => line.restocked).length
        }
      },
      now
    )

    return returnId
  })

  return getReturn(db, run())
}

// ── Settlement — where the refunded money goes ───────────────────────────────

type ResolvedSettlement = {
  kind: Settlement
  account: string
  refundMethodLookupId: number | null
  exchangeGroupId: number | null
}

/**
 * WHERE THE MONEY LANDS, and which companion columns the return carries. The service fixes those
 * columns by settlement so a stray field from the renderer can never reach the DB's settlement CHECK.
 *
 *   'refund'          → the account the tender maps to, resolved through the SAME payment-method →
 *                       account mapping a sale uses (sales.accountForPaymentMethod). One mapping, reused.
 *   'customer_credit' → Accounts Receivable (reduces the udhaar). Only valid if the sale had a customer.
 *   'exchange'        → a store-credit placeholder on Receivable for this phase; requires a customer and
 *                       an exchange group. The guided replacement-sale flow is deferred, by design.
 */
function resolveSettlement(
  db: DB,
  sale: SaleDetail,
  input: z.output<typeof CreateReturnInput>
): ResolvedSettlement {
  if (input.settlement === 'refund') {
    // Required by the schema, re-asserted here so the technical log is precise if it is ever absent.
    if (input.refundMethodLookupId == null) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Please choose how the refund is being paid.',
        'refund settlement with no refundMethodLookupId'
      )
    }
    const method = requireLookupById(
      db,
      'payment_method',
      input.refundMethodLookupId,
      'Please choose how the refund is being paid, from the list.'
    )
    const account = sales.accountForPaymentMethod(method.code)
    // A refund pays money OUT through a real tender — cash, bank, card, a wallet. The 'credit' (udhaar)
    // method is NOT money leaving the drawer: it maps to Accounts Receivable. Refunding ONTO it would
    // look like a refund while actually RAISING what the customer owes, and on a walk-in (no customer)
    // it parks a balance on Receivable with nobody behind it — an unattributable receivable no
    // per-customer sum can ever reconcile. Reducing what a customer owes is a settlement of its own
    // ('customer_credit'), which the ledger and outstandingCredit track. So a refund whose tender lands
    // on Receivable is refused, and the cashier is pointed at the right button. (Returns audit, HIGH.)
    if (account === ACC.RECEIVABLE) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'A refund is paid back as cash, to the bank, or to a wallet — not onto a customer’s udhaar. To lower what this customer owes, choose "Apply to customer account" instead.',
        `refund tender ${method.code} resolves to Receivable; use settlement customer_credit`
      )
    }
    return {
      kind: 'refund',
      account,
      refundMethodLookupId: method.id,
      exchangeGroupId: null
    }
  }

  if (input.settlement === 'customer_credit') {
    if (sale.customerId == null) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'This sale was not for a named customer, so it cannot be settled as store credit. Please refund it instead.',
        `customer_credit settlement on sale ${sale.id} which has no customer`
      )
    }
    return { kind: 'customer_credit', account: ACC.RECEIVABLE, refundMethodLookupId: null, exchangeGroupId: null }
  }

  // 'exchange' — minimal in this phase.
  if (sale.customerId == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A guided exchange is not available yet for a walk-in sale. Please refund it, or settle it as store credit for a named customer.',
      `exchange settlement on sale ${sale.id} which has no customer (guided exchange deferred)`
    )
  }
  if (input.exchangeGroupId == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'An exchange must be linked to its replacement sale.',
      'exchange settlement with no exchangeGroupId'
    )
  }
  return {
    kind: 'exchange',
    account: ACC.RECEIVABLE,
    refundMethodLookupId: null,
    exchangeGroupId: input.exchangeGroupId
  }
}

// ── The journal ──────────────────────────────────────────────────────────────

/**
 * POST THE RETURN'S JOURNAL. It balances as ALGEBRA, not as arithmetic that happens to work out:
 *
 *     DR  Sales Returns (contra-income)   subtotalNet
 *     DR  Output Tax                       taxTotal
 *     CR  Cash / Bank / Receivable         grandTotal   (= subtotalNet + taxTotal)
 *   and, only for the lines that went back on the shelf:
 *     DR  Inventory                        restockValue
 *     CR  COGS                             restockValue
 *
 *     (subtotalNet + taxTotal) + restockValue  =  grandTotal + restockValue                     ∎
 *
 * A leg is emitted only when its amount is > 0 — the posting engine rejects a zero line, and a
 * DAMAGED-only return (no restock) legitimately has no inventory/COGS leg. A return whose money is
 * entirely zero (a returned free sample, written off) posts no journal at all: there is nothing to
 * record, and the header's journal_id stays NULL, exactly as `stock.adjust` leaves it for a zero-value
 * movement. Returns nothing to post → null; otherwise the new journal id.
 */
function postReturnJournal(
  db: DB,
  args: {
    returnId: number
    invoiceNo: string | null
    reasonLabel: string
    settlementAccount: string
    subtotalNet: number
    taxTotal: number
    grandTotal: number
    restockValueMinor: number
    userId: number
    now: Date
  }
): number | null {
  const lines: ledger.JournalLineInput[] = []

  if (args.subtotalNet > 0) lines.push({ account: ACC.SALES_RETURNS, debit: args.subtotalNet })
  if (args.taxTotal > 0) lines.push({ account: ACC.OUTPUT_TAX, debit: args.taxTotal })
  if (args.grandTotal > 0) lines.push({ account: args.settlementAccount, credit: args.grandTotal })

  if (args.restockValueMinor > 0) {
    lines.push({ account: ACC.INVENTORY, debit: args.restockValueMinor })
    lines.push({ account: ACC.COGS, credit: args.restockValueMinor })
  }

  // Nothing moved money and nothing restocked — a zero-value return. No journal is a record of that.
  if (lines.length < 2) return null

  return ledger.post(db, {
    at: args.now,
    refType: RETURN_REF_TYPE,
    refId: args.returnId,
    memo: `Return: ${args.invoiceNo ?? `sale #${args.returnId}`} (${args.reasonLabel})`,
    userId: args.userId,
    lines
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — what can still be returned
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE RETURNS DESK'S FIRST MOVE: look a sale up (by id or by the number on the customer's receipt) and
 * show, per line, what was sold, what has already come back, and what remains returnable — plus the
 * frozen figures the picker needs to show what a refund is worth.
 */
export function returnableLines(db: DB, ref: number | string): ReturnableSale {
  const sale =
    typeof ref === 'number'
      ? sales.getById(db, ref)
      : sales.getByInvoiceNo(db, { invoiceNo: ref })

  const priorOf = db.prepare(
    'SELECT COALESCE(SUM(qty_m), 0) FROM return_lines WHERE sale_line_id = ?'
  )

  const lines: ReturnableLine[] = sale.lines.map((line) => {
    const alreadyReturnedQtyM = priorOf.pluck().get(line.id) as number
    return {
      saleLineId: line.id,
      productId: line.productId,
      isOpenItem: line.isOpenItem,
      nameSnapshot: line.nameSnapshot,
      uom: line.uom,
      soldQtyM: line.qtyM,
      alreadyReturnedQtyM,
      returnableQtyM: line.qtyM - alreadyReturnedQtyM,
      unitPrice: line.unitPrice,
      net: line.net,
      taxRateBp: line.taxRateBp,
      taxAmount: line.taxAmount,
      gross: line.gross,
      unitCost: line.unitCost,
      batchId: line.batchId
    }
  })

  return {
    saleId: sale.id,
    invoiceNo: sale.invoiceNo,
    status: sale.status,
    at: sale.at,
    customerId: sale.customerId,
    customerName: sale.customerName ?? null,
    lines
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — a single return, and the list
// ═════════════════════════════════════════════════════════════════════════════

type ReturnRow = {
  id: number
  sale_id: number
  at: string
  user_id: number
  approved_by: number
  approved_by_role: string
  reason_code: string
  reason_text: string | null
  settlement: Settlement
  refund_method_lookup_id: number | null
  exchange_group_id: number | null
  subtotal_net: number
  tax_total: number
  grand_total: number
  journal_id: number | null
  notes: string | null
  created_at: string
}

function toReturn(row: ReturnRow): Return {
  return {
    id: row.id,
    saleId: row.sale_id,
    at: row.at,
    userId: row.user_id,
    approvedByUserId: row.approved_by,
    approvedByRole: row.approved_by_role,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    settlement: row.settlement,
    refundMethodLookupId: row.refund_method_lookup_id,
    exchangeGroupId: row.exchange_group_id,
    subtotalNet: row.subtotal_net,
    taxTotal: row.tax_total,
    grandTotal: row.grand_total,
    journalId: row.journal_id,
    notes: row.notes,
    createdAt: row.created_at
  }
}

type ReturnLineRow = {
  id: number
  return_id: number
  sale_line_id: number
  product_id: number | null
  name_snapshot: string
  qty_m: number
  uom: string | null
  net: number
  tax_rate_bp: number
  tax_amount: number
  gross: number
  unit_cost: number
  restocked: number
  batch_id: number | null
  created_at: string
}

function toReturnLine(db: DB, row: ReturnLineRow): ReturnLine {
  return {
    id: row.id,
    returnId: row.return_id,
    saleLineId: row.sale_line_id,
    productId: row.product_id,
    nameSnapshot: row.name_snapshot,
    qtyM: row.qty_m,
    uom: row.uom,
    net: row.net,
    taxRateBp: row.tax_rate_bp,
    taxAmount: row.tax_amount,
    gross: row.gross,
    unitCost: row.unit_cost,
    restocked: Boolean(row.restocked),
    // Could this line ever go on a shelf? Only a catalogue inventory item. An open item and a
    // non-inventory service cannot, and so are "not stocked", never "damaged". (Returns audit.)
    stockable: row.product_id != null && isInventoryProduct(db, row.product_id),
    batchId: row.batch_id,
    createdAt: row.created_at
  }
}

/** One return, with its lines and a few joined labels — the return detail screen and the credit note. */
export function getReturn(db: DB, rawId: unknown): ReturnDetail {
  const { id } = parseOrThrow(
    GetReturnInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'return.get'
  )

  const row = db.prepare('SELECT * FROM returns WHERE id = ?').get(id) as ReturnRow | undefined
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That return could not be found.', `return id=${id} does not exist`)
  }

  const lines = (
    db.prepare('SELECT * FROM return_lines WHERE return_id = ? ORDER BY id').all(id) as ReturnLineRow[]
  ).map((line) => toReturnLine(db, line))

  const sale = db
    .prepare('SELECT invoice_no, customer_id FROM sales WHERE id = ?')
    .get(row.sale_id) as { invoice_no: string | null; customer_id: number | null } | undefined

  return {
    ...toReturn(row),
    lines,
    saleInvoiceNo: sale?.invoice_no ?? null,
    customerId: sale?.customer_id ?? null,
    cashierName:
      (db.prepare('SELECT full_name FROM users WHERE id = ?').pluck().get(row.user_id) as
        | string
        | undefined) ?? null,
    refundMethodLabel:
      row.refund_method_lookup_id != null
        ? ((db.prepare('SELECT label FROM lookups WHERE id = ?').pluck().get(row.refund_method_lookup_id) as
            | string
            | undefined) ?? null)
        : null
  }
}

/**
 * THE RETURNS LIST — paginated and indexed, always. Assume years of trading (CLAUDE.md §4).
 * Deliberately narrow: it does not load every return's lines to show a page.
 */
export function listReturns(db: DB, raw: unknown = {}): PagedResult<ReturnListItem> {
  const input = parseOrThrow(ListReturnsInput, raw, 'return.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.saleId != null) {
    where.push('r.sale_id = @saleId')
    params['saleId'] = input.saleId
  }
  if (input.from) {
    where.push('r.at >= @from')
    params['from'] = input.from
  }
  if (input.to) {
    // `to` is a DATE; the whole of that day is inside it — a return at 18:40 must not fall out of a
    // report that says it covers that day. ISO timestamps sort lexically, so a string compare works.
    where.push('r.at < @toExclusive')
    params['toExclusive'] = dayAfter(input.to)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db.prepare(`SELECT COUNT(*) FROM returns r ${whereSql}`).pluck().get(params) as number

  const rows = db
    .prepare(
      `SELECT r.id, r.sale_id, r.at, r.settlement, r.grand_total, r.reason_code, r.user_id,
              s.invoice_no AS invoice_no,
              (SELECT COUNT(*) FROM return_lines l WHERE l.return_id = r.id) AS line_count
         FROM returns r
         LEFT JOIN sales s ON s.id = r.sale_id
         ${whereSql}
         ORDER BY r.at DESC, r.id DESC
         LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    id: number
    sale_id: number
    at: string
    settlement: Settlement
    grand_total: number
    reason_code: string
    user_id: number
    invoice_no: string | null
    line_count: number
  }>

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      saleId: row.sale_id,
      at: row.at,
      settlement: row.settlement,
      grandTotal: row.grand_total,
      reasonCode: row.reason_code,
      userId: row.user_id,
      saleInvoiceNo: row.invoice_no,
      lineCount: row.line_count
    }))
  }
}

/** The day after an ISO date, so a `to` filter includes everything that happened on that day. */
function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString()
}
