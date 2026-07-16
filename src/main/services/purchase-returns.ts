import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { ACC } from '../db/chart-of-accounts'
import { formatQty } from '@shared/qty'
import {
  CreatePurchaseReturnInput,
  GetPurchaseReturnInput,
  ListPurchaseReturnsInput,
  PURCHASE_RETURN_REF_TYPE,
  type PagedResult,
  type PurchaseReturn,
  type PurchaseReturnDetail,
  type PurchaseReturnLine,
  type PurchaseReturnListItem,
  type PurchaseReturnSettlement,
  type ReturnablePurchase,
  type ReturnablePurchaseLine
} from '@shared/purchase-returns'
import type { PurchaseDetail, PurchaseLine } from '@shared/purchases'
import * as audit from './audit'
import * as ledger from './ledger'
import * as purchases from './purchases'
import * as stock from './stock'
import { accountForPaymentMethod } from './sales'

/**
 * THE RETURNS-TO-SUPPLIER ENGINE. Goods going BACK to where they came from, and the money that follows.
 * (Migration 0016.)
 *
 * This is `services/returns.ts` reflected: the customer-return engine takes stock IN and pays money OUT;
 * this one sends stock BACK OUT and either lowers what the shop OWES or brings a refund IN. It obeys
 * exactly the same disciplines, and deliberately mirrors that file where it can.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. GOODS LEAVE AT THE COST THEY CAME IN AT. THIS IS THE WHOLE POINT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Each line copies the ORIGINAL purchase line's FROZEN 4-dp `unit_cost` and records a NEGATIVE
 * 'purchase_return' movement at that cost, onto the batch the goods arrived on.
 *
 *     Buy 10 @ Rs 60, then 10 @ Rs 80  → the weighted average is Rs 70.
 *     Send one of the FIRST tins back  → Inventory falls by Rs 60, NOT Rs 70.
 *
 * Returning at today's average would credit the supplier for a cost they never charged, and leave the
 * remaining 19 tins carrying a value the shelf never had. `stock.record` freezes each movement's
 * `value_minor`, and `line_total` is READ BACK from it — never a fresh qty × cost multiply — so CR
 * Inventory and the stock valuation move by the SAME paisa (migration 0006), and
 * `GL Inventory === SUM(stock_movements.value_minor)` still holds by construction.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. INPUT TAX GOES BACK PRO-RATA, WITH REMAINDER ON THE LAST RETURN.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * If the purchase reclaimed input tax, sending goods back hands that tax back with them. There is no
 * per-line tax on a purchase — the bill carries ONE frozen `tax_total` — so the tax is apportioned by
 * VALUE RETURNED out of that pool, by CUMULATIVE DIFFERENCING (the same shape returns.ts uses per line):
 *
 *     this return's tax = tax_total × (value returned so far, incl. this) / subtotal_net
 *                       − the tax every prior return of this purchase already took
 *
 * The final return — the one that takes the purchase to fully returned — takes the EXACT REMAINDER, so
 * a purchase sent back in pieces sums back to its `tax_total` to the paisa, with no sum-of-rounded
 * drift. The leg is omitted when there was no tax.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. THE JOURNAL BALANCES AS ALGEBRA (see `postReturnJournal`).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *     CR Inventory (ACC.INVENTORY) = subtotalNet        the goods leave, at their frozen cost
 *     CR Input Tax (ACC.INPUT_TAX) = taxTotal           the reclaimed tax handed back (omit if 0)
 *     DR <settlement>              = grandTotal         = subtotalNet + taxTotal                   ∎
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 4. THE SUPPLIER BALANCE STAYS TIED TO THE GL.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A 'supplier_credit' return DEBITS Payables, so it lowers what the shop owes. `supplier-ledger.balance`
 * subtracts exactly this set, and the statement shows it as a credit line — or the ledger screen would
 * chase a distributor for money the GL says is no longer owed (CLAUDE.md trap #17; the same bug the
 * customer-returns audit found, not repeated here). A 'refund' return never touches Payables and never
 * appears there.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 5. NEVER MORE THAN CAME IN. ONE TRANSACTION. AUDITED.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no Result envelope and no `electron`
 * import. The IPC layer zod-validates, checks `purchaseReturn.manage` in MAIN, calls `assertWritable`,
 * and wraps the answer.
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
 * Split a frozen money figure (`total`, earned over `whole`) pro-rata to `part`, rounded half-up to the
 * paisa. BigInt for the multiply — the same guard `extendPrice`/`movementValueCost`/`returns.proRata`
 * use, so a huge bill cannot silently overflow a float's exact-integer range. All arguments are >= 0 and
 * `whole > 0` (the caller checks; a zero-value purchase has no tax to apportion anyway).
 */
function proRata(total: number, part: number, whole: number): number {
  if (whole <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Something went wrong reading that purchase. Please try again.',
      `proRata got whole=${whole} (must be > 0)`
    )
  }

  const num = BigInt(total) * BigInt(part)
  const den = BigInt(whole)
  const value = (num * 2n + den) / (den * 2n) // floor(num/den + 1/2) — round half up

  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That amount is too large to record. Please split it into smaller returns.',
      `proRata result ${value} exceeds safe integer range (total=${total} part=${part} whole=${whole})`
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

/** The money a stock movement froze (migration 0006). Read, never recomputed — as purchases.ts does. */
function movementValueMinor(db: DB, movementId: number): number {
  return db.prepare('SELECT value_minor FROM stock_movements WHERE id = ?').pluck().get(movementId) as number
}

// ═════════════════════════════════════════════════════════════════════════════
// CREATE A RETURN TO SUPPLIER — the one that matters
// ═════════════════════════════════════════════════════════════════════════════

/** One return line, resolved against the purchase and FROZEN, ready to drive the stock + the journal. */
type FrozenReturnLine = {
  purchaseLine: PurchaseLine
  qtyM: number
}

type ResolvedSettlement = {
  kind: PurchaseReturnSettlement
  /** The account the grand total is DEBITED to. */
  account: string
  refundMethodLookupId: number | null
}

/**
 * SEND GOODS BACK TO A SUPPLIER. In ONE transaction, or not at all:
 *
 *   1. the original purchase is loaded (it carries the supplier, the frozen costs and the tax pool);
 *   2. the return is given a live reason code from the owner's own list;
 *   3. WHERE the credit settles is resolved (off the bill, or back through a real tender);
 *   4. each line is checked against what REMAINS returnable across ALL prior returns of that line;
 *   5. each line records a NEGATIVE 'purchase_return' movement at the PURCHASE LINE'S FROZEN COST, onto
 *      the batch it arrived on, and its `line_total` is READ BACK from that movement's frozen value;
 *   6. the input tax is apportioned pro-rata, remainder-on-last;
 *   7. the balanced journal posts (it throws if it does not balance);
 *   8. one audit row records WHO, WHY, and against WHICH purchase.
 */
export function createPurchaseReturn(
  db: DB,
  actor: User,
  rawInput: unknown,
  now = new Date()
): PurchaseReturnDetail {
  const input = parseOrThrow(CreatePurchaseReturnInput, rawInput, 'purchase.return.create')

  // ── The original purchase: it must be REAL. It carries the supplier, the frozen costs, and the tax. ──
  const purchase = purchases.getPurchase(db, input.purchaseId)

  // ── WHY — a live code on the owner's own purchase_return_reason list (CLAUDE.md §4) ────────────────
  const reason = requireLookupByCode(
    db,
    'purchase_return_reason',
    input.reasonCode,
    'Please choose a reason for sending these goods back.'
  )

  // ── WHERE the credit settles ───────────────────────────────────────────────────────────────────────
  const settlement = resolveSettlement(db, input)

  // A locked month refuses a return, just as it refuses a purchase — a return writes into a period.
  // Checked up front so the manager gets a sentence, not a rolled-back transaction. (stock.record and
  // ledger.post below check it again; harmless, and it also covers a zero-value return that posts
  // neither a movement nor a journal.)
  ledger.assertPeriodOpen(db, now.getFullYear(), now.getMonth() + 1)

  const purchaseLineById = new Map(purchase.lines.map((line) => [line.id, line]))

  const run = db.transaction((): number => {
    // ── Freeze every line against what REMAINS returnable ────────────────────────────────────────────
    const priorQtyOf = db.prepare(
      'SELECT COALESCE(SUM(qty_m), 0) FROM purchase_return_lines WHERE purchase_line_id = ?'
    )

    const seen = new Set<number>()
    const frozen: FrozenReturnLine[] = []

    for (const lineInput of input.lines) {
      if (seen.has(lineInput.purchaseLineId)) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'That item is listed more than once. Please combine it into a single line.',
          `purchase_line ${lineInput.purchaseLineId} appears twice in one return`
        )
      }
      seen.add(lineInput.purchaseLineId)

      const purchaseLine = purchaseLineById.get(lineInput.purchaseLineId)
      if (!purchaseLine) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'One of those items is not on this purchase. Please look the bill up again.',
          `purchase_line ${lineInput.purchaseLineId} does not belong to purchase ${purchase.id}`
        )
      }

      // NEVER MORE THAN CAME IN — summed across every return of this line, this return's earlier lines
      // included (they are already written by the time a later line reads this).
      const alreadyReturnedQtyM = priorQtyOf.pluck().get(lineInput.purchaseLineId) as number
      const returnableQtyM = purchaseLine.qtyM - alreadyReturnedQtyM

      if (lineInput.qtyM > returnableQtyM) {
        throw new AppError(
          ErrorCode.VALIDATION,
          returnableQtyM <= 0
            ? `All of "${purchaseLine.nameSnapshot}" has already been sent back.`
            : `You can send back at most ${formatQty(returnableQtyM)} of "${purchaseLine.nameSnapshot}" — ${formatQty(alreadyReturnedQtyM)} of ${formatQty(purchaseLine.qtyM)} has already gone back.`,
          `return qty ${lineInput.qtyM} exceeds returnable ${returnableQtyM} for purchase_line ${purchaseLine.id} (received ${purchaseLine.qtyM}, prior ${alreadyReturnedQtyM})`
        )
      }

      frozen.push({ purchaseLine, qtyM: lineInput.qtyM })
    }

    // ── The header. Totals are filled in once the movements have frozen their own values, so
    //    subtotal_net is Σ line_total by construction rather than by a parallel multiply. ────────────
    const returnId = Number(
      db
        .prepare(
          `INSERT INTO purchase_returns
             (purchase_id, at, user_id, reason_code, reason_text, settlement, refund_method_lookup_id,
              subtotal_net, tax_total, grand_total, notes, journal_id, created_at)
           VALUES
             (@purchaseId, @at, @userId, @reasonCode, @reasonText, @settlement, @refundMethodLookupId,
              0, 0, 0, @notes, NULL, @createdAt)`
        )
        .run({
          purchaseId: purchase.id,
          at: now.toISOString(),
          userId: actor.id,
          reasonCode: reason.code,
          reasonText: input.reasonText ?? null,
          settlement: settlement.kind,
          refundMethodLookupId: settlement.refundMethodLookupId,
          notes: input.notes ?? null,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    // ── The lines, and the stock that goes back with them ────────────────────────────────────────────
    const insertLine = db.prepare(
      `INSERT INTO purchase_return_lines
         (purchase_return_id, purchase_line_id, product_id, name_snapshot, qty_m, uom, unit_cost,
          line_total, batch_id, created_at)
       VALUES
         (@purchaseReturnId, @purchaseLineId, @productId, @nameSnapshot, @qtyM, @uom, @unitCost,
          @lineTotal, @batchId, @createdAt)`
    )

    // The stock movements' OWN frozen values, summed for the inventory leg — never a fresh multiply, so
    // GL Inventory and the stock valuation move by the SAME paisa (migration 0006).
    let subtotalNet = 0

    for (const line of frozen) {
      const { purchaseLine } = line

      // NEGATIVE qty — the goods LEAVE — at the cost they CAME IN AT (the purchase line's frozen 4-dp
      // unit_cost, NOT today's re-averaged figure), and out of the batch they arrived on so FEFO and
      // the near-expiry report stay honest. A decrease never moves the weighted average (stock.ts), so
      // what remains on the shelf keeps costing exactly what it cost.
      const movement = stock.record(db, {
        productId: purchaseLine.productId,
        type: 'purchase_return',
        qtyM: -line.qtyM,
        unitCost: purchaseLine.unitCost,
        batchId: purchaseLine.batchId,
        refType: PURCHASE_RETURN_REF_TYPE,
        refId: returnId,
        userId: actor.id,
        at: now
      })

      // READ BACK what the movement froze. It is signed (negative — stock left); the line and the
      // journal carry the MAGNITUDE, because a journal never posts a negative amount — you credit the
      // other side instead, which is exactly what CR Inventory does below.
      const lineTotal = Math.abs(movementValueMinor(db, movement.id))
      subtotalNet += lineTotal

      insertLine.run({
        purchaseReturnId: returnId,
        purchaseLineId: purchaseLine.id,
        productId: purchaseLine.productId,
        nameSnapshot: purchaseLine.nameSnapshot,
        qtyM: line.qtyM,
        uom: purchaseLine.uom,
        unitCost: purchaseLine.unitCost,
        lineTotal,
        batchId: purchaseLine.batchId,
        createdAt: now.toISOString()
      })
    }

    // ── The input tax handed back, pro-rata with remainder-on-last (see §2 of the header) ────────────
    const taxTotal = apportionInputTax(db, purchase, returnId, subtotalNet)
    const grandTotal = subtotalNet + taxTotal

    db.prepare(
      'UPDATE purchase_returns SET subtotal_net = ?, tax_total = ?, grand_total = ? WHERE id = ?'
    ).run(subtotalNet, taxTotal, grandTotal, returnId)

    // ── The journal, posted once, in this same transaction ───────────────────────────────────────────
    const journalId = postReturnJournal(db, {
      returnId,
      supplierInvoiceNo: purchase.supplierInvoiceNo,
      supplierName: purchase.supplierName ?? null,
      reasonLabel: reason.label,
      settlementAccount: settlement.account,
      subtotalNet,
      taxTotal,
      grandTotal,
      userId: actor.id,
      now
    })

    if (journalId != null) {
      db.prepare('UPDATE purchase_returns SET journal_id = ? WHERE id = ?').run(journalId, returnId)
    }

    // ── WHO did WHAT, WHY, and against WHICH purchase (CLAUDE.md §4) ─────────────────────────────────
    audit.record(
      db,
      actor,
      {
        action: 'purchase.return',
        entity: 'purchase_return',
        entityId: returnId,
        reasonCode: reason.code,
        ...(input.reasonText != null ? { reasonText: input.reasonText } : {}),
        before: {
          purchaseId: purchase.id,
          supplierId: purchase.supplierId,
          supplierInvoiceNo: purchase.supplierInvoiceNo,
          purchaseGrandTotal: purchase.grandTotal
        },
        after: {
          returnId,
          settlement: settlement.kind,
          subtotalNet,
          taxTotal,
          grandTotal,
          lineCount: frozen.length
        }
      },
      now
    )

    return returnId
  })

  return getPurchaseReturn(db, run())
}

// ── The input tax handed back ────────────────────────────────────────────────

/**
 * THE INPUT TAX THIS RETURN HANDS BACK, apportioned by VALUE RETURNED out of the purchase's own frozen
 * `tax_total`, by CUMULATIVE DIFFERENCING — the shape `returns.ts` uses per line, applied here to the
 * bill, because a purchase carries ONE tax figure rather than a tax per line.
 *
 *     cumulative tax due for (everything returned so far, INCLUDING this return)
 *   − the tax every PRIOR return of this purchase already took
 *   = this return's share
 *
 * WHY CUMULATIVE, and not simply `tax_total × mine / subtotal`: rounding each return on its own lets the
 * parts drift from the whole (sum-of-rounded ≠ round-of-sum), and a purchase sent back in three goes
 * would leave a paisa of reclaimed tax stranded on Input Tax forever, with the trial balance still green.
 * Differencing against what the DB actually recorded means the FINAL return — the one that takes the
 * purchase to fully returned — takes the EXACT REMAINDER, whatever the earlier ones did.
 *
 * `max(0, …)`: a partial can never book more than the cumulative due, and the final remainder is always
 * >= 0 because prior returns can never exceed the purchase (the qty guard proves it line by line).
 *
 * VALUE, WITH QUANTITY AS THE FALLBACK. Value is the right ruler when a bill's lines carry different
 * costs — quantity ratios and value ratios genuinely diverge there, and value is what the tax was charged
 * on. But a bill CAN carry tax on goods of no value: free promotional stock with GST still on the invoice
 * (`unitCost` may be 0, and `taxTotal` is its own field on the bill, not derived from the lines). Value
 * cannot divide that, so quantity does. Bailing out instead — as this once did — meant sending EVERY unit
 * back handed back NO tax: the shop kept owing for goods it no longer had, and the reclaimed tax sat on
 * the GL forever with the trial balance still green.
 *
 * MUST be called INSIDE the transaction and AFTER this return's lines are written — `returnedSoFar` is
 * read from the table and is expected to include them.
 */
function apportionInputTax(
  db: DB,
  purchase: PurchaseDetail,
  returnId: number,
  thisReturnNet: number
): number {
  // No tax was reclaimed on the bill, so there is none to hand back.
  if (purchase.taxTotal <= 0) return 0

  const sums = db
    .prepare(
      `SELECT COALESCE(SUM(pr.subtotal_net), 0) AS net,
              COALESCE(SUM(pr.tax_total), 0)    AS tax
         FROM purchase_returns pr
        WHERE pr.purchase_id = ? AND pr.id <> ?`
    )
    .get(purchase.id, returnId) as { net: number; tax: number }

  // The pool this return's share is measured against: the bill's value, or — when the goods are free —
  // the bill's quantity. Same cumulative-differencing shape either way.
  const { pool, returnedSoFar } =
    purchase.subtotalNet > 0
      ? { pool: purchase.subtotalNet, returnedSoFar: sums.net + thisReturnNet }
      : { pool: receivedQtyM(db, purchase.id), returnedSoFar: returnedQtyM(db, purchase.id) }

  // A bill with neither value nor quantity has nothing to apportion against — it cannot happen (a line's
  // qty_m is CHECKed > 0), but division must never be the thing that proves it.
  if (pool <= 0) return 0

  // The final return — this takes the bill to fully returned — gets the exact remainder, so the parts sum
  // back to tax_total to the paisa. Anything less is apportioned and differenced.
  const cumulativeTax =
    returnedSoFar >= pool ? purchase.taxTotal : proRata(purchase.taxTotal, returnedSoFar, pool)

  return Math.max(0, cumulativeTax - sums.tax)
}

/** Σ qty_m received on a bill — the quantity pool for a zero-value bill's tax. */
function receivedQtyM(db: DB, purchaseId: number): number {
  return db
    .prepare('SELECT COALESCE(SUM(qty_m), 0) FROM purchase_lines WHERE purchase_id = ?')
    .pluck()
    .get(purchaseId) as number
}

/**
 * Σ qty_m sent back on a bill, INCLUDING this return's own lines — they are already written when
 * `apportionInputTax` runs, which is what makes the cumulative differencing read true.
 */
function returnedQtyM(db: DB, purchaseId: number): number {
  return db
    .prepare(
      `SELECT COALESCE(SUM(prl.qty_m), 0)
         FROM purchase_return_lines prl
         JOIN purchase_returns pr ON pr.id = prl.purchase_return_id
        WHERE pr.purchase_id = ?`
    )
    .pluck()
    .get(purchaseId) as number
}

// ── Settlement — where the credit lands ──────────────────────────────────────

/**
 * WHERE THE CREDIT LANDS, and which companion column the return carries. The service fixes that column
 * by settlement so a stray field from the renderer can never reach the DB's settlement CHECK.
 *
 *   'supplier_credit' → DR Accounts Payable. The common case: the credit comes off what the shop owes,
 *                       and the supplier ledger subtracts exactly this set (see supplier-ledger.ts).
 *   'refund'          → DR the account the tender maps to, resolved through the SAME payment-method →
 *                       account mapping a sale, a purchase and a supplier payment use. One mapping,
 *                       reused, so a JazzCash refund lands where a JazzCash anything lands.
 */
function resolveSettlement(
  db: DB,
  input: z.output<typeof CreatePurchaseReturnInput>
): ResolvedSettlement {
  if (input.settlement === 'supplier_credit') {
    return { kind: 'supplier_credit', account: ACC.PAYABLE, refundMethodLookupId: null }
  }

  // Required by the schema, re-asserted here so the technical log is precise if it is ever absent.
  if (input.refundMethodLookupId == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose how the supplier paid the refund.',
      'refund settlement with no refundMethodLookupId'
    )
  }

  const method = requireLookupById(
    db,
    'payment_method',
    input.refundMethodLookupId,
    'Please choose how the supplier paid the refund, from the list.'
  )

  const account = accountForPaymentMethod(method.code)

  // A REFUND COMES BACK AS REAL MONEY — cash, the bank, a wallet. A tender resolving to Payable or
  // Receivable is not money: the 'credit' method maps to Receivable, and DR Receivable here would book
  // the distributor as a DEBTOR of the shop — a receivable with nobody behind it that no per-customer
  // sum can ever reconcile. Taking the credit off the bill is a settlement of its OWN
  // ('supplier_credit'), which the supplier ledger and balance() track. So it is refused, and the
  // manager is pointed at the right button. (Mirrors returns.ts refusing a refund onto Receivable.)
  if (account === ACC.PAYABLE || account === ACC.RECEIVABLE) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A refund comes back as cash, to the bank, or to a wallet — not on credit. To take this off what the shop owes the supplier, choose "Credit against the supplier account" instead.',
      `refund tender "${method.code}" resolves to ${account} (Payable/Receivable) — use settlement supplier_credit`
    )
  }

  return { kind: 'refund', account, refundMethodLookupId: method.id }
}

// ── The journal ──────────────────────────────────────────────────────────────

/**
 * POST THE RETURN'S JOURNAL. It balances as ALGEBRA, not as arithmetic that happens to work out:
 *
 *     CR  Inventory                    subtotalNet     the goods leave, at their frozen cost
 *     CR  Input Tax                    taxTotal        the reclaimed tax handed back
 *     DR  Payable / Cash / Bank        grandTotal      (= subtotalNet + taxTotal)
 *
 *     grandTotal = subtotalNet + taxTotal   ⟹   DR = CR                                          ∎
 *
 * A leg is emitted only when its amount is > 0 — the posting engine rejects a zero line, and a bill with
 * no reclaimed tax legitimately has no Input Tax leg. A return whose money is entirely zero (free samples
 * going back) posts no journal at all: there is nothing to record, and the header's `journal_id` stays
 * NULL, exactly as `stock.adjust` leaves it for a zero-value movement. The stock still went back.
 * Returns nothing to post → null; otherwise the new journal id.
 */
function postReturnJournal(
  db: DB,
  args: {
    returnId: number
    supplierInvoiceNo: string | null
    supplierName: string | null
    reasonLabel: string
    settlementAccount: string
    subtotalNet: number
    taxTotal: number
    grandTotal: number
    userId: number
    now: Date
  }
): number | null {
  const lines: ledger.JournalLineInput[] = []

  if (args.subtotalNet > 0) lines.push({ account: ACC.INVENTORY, credit: args.subtotalNet })
  if (args.taxTotal > 0) lines.push({ account: ACC.INPUT_TAX, credit: args.taxTotal })
  if (args.grandTotal > 0) lines.push({ account: args.settlementAccount, debit: args.grandTotal })

  // Nothing moved money — a zero-value return (free samples going back). No journal is a record of that.
  if (lines.length < 2) return null

  const against = args.supplierInvoiceNo
    ? `bill ${args.supplierInvoiceNo}`
    : `purchase return #${args.returnId}`
  const to = args.supplierName ? ` to ${args.supplierName}` : ''

  return ledger.post(db, {
    at: args.now,
    refType: PURCHASE_RETURN_REF_TYPE,
    refId: args.returnId,
    memo: `Return${to} — ${against} (${args.reasonLabel})`,
    userId: args.userId,
    lines
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — what can still go back
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE RETURN-TO-SUPPLIER SCREEN'S FIRST MOVE: look a purchase up and show, per line, what was received,
 * what has already gone back, and what remains returnable — plus the FROZEN unit cost the goods will
 * leave at, so the UI can show what the credit is worth before anything is committed.
 */
export function returnablePurchaseLines(db: DB, purchaseId: number): ReturnablePurchase {
  const purchase = purchases.getPurchase(db, purchaseId)

  // One indexed lookup per line (idx_purchase_return_lines_line), not a scan.
  const priorOf = db.prepare(
    'SELECT COALESCE(SUM(qty_m), 0) FROM purchase_return_lines WHERE purchase_line_id = ?'
  )

  const lines: ReturnablePurchaseLine[] = purchase.lines.map((line) => {
    const alreadyReturnedQtyM = priorOf.pluck().get(line.id) as number
    return {
      purchaseLineId: line.id,
      productId: line.productId,
      nameSnapshot: line.nameSnapshot,
      uom: line.uom,
      receivedQtyM: line.qtyM,
      alreadyReturnedQtyM,
      returnableQtyM: line.qtyM - alreadyReturnedQtyM,
      unitCost: line.unitCost,
      lineTotal: line.lineTotal,
      batchId: line.batchId
    }
  })

  return {
    purchaseId: purchase.id,
    supplierId: purchase.supplierId,
    supplierName: purchase.supplierName ?? null,
    supplierInvoiceNo: purchase.supplierInvoiceNo,
    at: purchase.at,
    taxTotal: purchase.taxTotal,
    lines
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — a single return, and the list
// ═════════════════════════════════════════════════════════════════════════════

type PurchaseReturnRow = {
  id: number
  purchase_id: number
  at: string
  user_id: number
  reason_code: string
  reason_text: string | null
  settlement: PurchaseReturnSettlement
  refund_method_lookup_id: number | null
  subtotal_net: number
  tax_total: number
  grand_total: number
  notes: string | null
  journal_id: number | null
  created_at: string
}

function toPurchaseReturn(row: PurchaseReturnRow): PurchaseReturn {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    at: row.at,
    userId: row.user_id,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    settlement: row.settlement,
    refundMethodLookupId: row.refund_method_lookup_id,
    subtotalNet: row.subtotal_net,
    taxTotal: row.tax_total,
    grandTotal: row.grand_total,
    notes: row.notes,
    journalId: row.journal_id,
    createdAt: row.created_at
  }
}

type PurchaseReturnLineRow = {
  id: number
  purchase_return_id: number
  purchase_line_id: number
  product_id: number
  name_snapshot: string
  qty_m: number
  uom: string | null
  unit_cost: number
  line_total: number
  batch_id: number | null
  created_at: string
}

function toPurchaseReturnLine(row: PurchaseReturnLineRow): PurchaseReturnLine {
  return {
    id: row.id,
    purchaseReturnId: row.purchase_return_id,
    purchaseLineId: row.purchase_line_id,
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

/** One return, with its lines and the joined labels — the detail screen and the debit note. */
export function getPurchaseReturn(db: DB, rawId: unknown): PurchaseReturnDetail {
  const { id } = parseOrThrow(
    GetPurchaseReturnInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'purchase.return.get'
  )

  const row = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(id) as
    | PurchaseReturnRow
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That return could not be found.',
      `purchase_return id=${id} does not exist`
    )
  }

  const lines = (
    db
      .prepare('SELECT * FROM purchase_return_lines WHERE purchase_return_id = ? ORDER BY id')
      .all(id) as PurchaseReturnLineRow[]
  ).map(toPurchaseReturnLine)

  const purchase = db
    .prepare('SELECT supplier_id, supplier_invoice_no FROM purchases WHERE id = ?')
    .get(row.purchase_id) as { supplier_id: number; supplier_invoice_no: string | null } | undefined

  return {
    ...toPurchaseReturn(row),
    lines,
    supplierId: purchase?.supplier_id ?? null,
    supplierName:
      purchase != null
        ? ((db.prepare('SELECT name FROM suppliers WHERE id = ?').pluck().get(purchase.supplier_id) as
            | string
            | undefined) ?? null)
        : null,
    purchaseInvoiceNo: purchase?.supplier_invoice_no ?? null,
    userName:
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
 * THE RETURNS-TO-SUPPLIER LIST — paginated and indexed, always. Assume years of trading (CLAUDE.md §4).
 * Deliberately narrow: it does not load every return's lines to show a page.
 */
export function listPurchaseReturns(db: DB, raw: unknown = {}): PagedResult<PurchaseReturnListItem> {
  const input = parseOrThrow(ListPurchaseReturnsInput, raw, 'purchase.return.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.purchaseId != null) {
    where.push('r.purchase_id = @purchaseId')
    params['purchaseId'] = input.purchaseId
  }
  if (input.supplierId != null) {
    // The supplier is the PURCHASE's supplier — a return is never re-pointed at another one (0016).
    where.push('p.supplier_id = @supplierId')
    params['supplierId'] = input.supplierId
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

  const total = db
    .prepare(
      `SELECT COUNT(*) FROM purchase_returns r
         LEFT JOIN purchases p ON p.id = r.purchase_id
         ${whereSql}`
    )
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT r.id, r.purchase_id, r.at, r.settlement, r.grand_total, r.reason_code, r.user_id,
              p.supplier_id         AS supplier_id,
              p.supplier_invoice_no AS supplier_invoice_no,
              s.name                AS supplier_name,
              u.full_name           AS user_name,
              (SELECT COUNT(*) FROM purchase_return_lines l WHERE l.purchase_return_id = r.id) AS line_count
         FROM purchase_returns r
         LEFT JOIN purchases p ON p.id = r.purchase_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN users u     ON u.id = r.user_id
         ${whereSql}
         ORDER BY r.at DESC, r.id DESC
         LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    id: number
    purchase_id: number
    at: string
    settlement: PurchaseReturnSettlement
    grand_total: number
    reason_code: string
    user_id: number
    supplier_id: number | null
    supplier_invoice_no: string | null
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
      purchaseId: row.purchase_id,
      at: row.at,
      settlement: row.settlement,
      grandTotal: row.grand_total,
      reasonCode: row.reason_code,
      userId: row.user_id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      purchaseInvoiceNo: row.supplier_invoice_no,
      userName: row.user_name,
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
