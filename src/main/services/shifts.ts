import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { ACC } from '../db/chart-of-accounts'
import {
  CashMovementInput,
  CASH_MOVEMENT_REF_TYPE,
  CloseShiftInput,
  GetShiftInput,
  ListShiftsInput,
  OpenShiftInput,
  type CashMovement,
  type CashMovementType,
  type PagedResult,
  type Shift,
  type ShiftDetail,
  type ShiftListItem,
  type TenderBreakdown,
  type ZReport
} from '@shared/shifts'
import * as audit from './audit'
import * as ledger from './ledger'
import { accountForPaymentMethod } from './sales'

/**
 * THE SHIFT / CASH-DRAWER SERVICE. Who opened the till, what passed through it, and what it should hold
 * at close. (Migration 0012.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. ONE SHIFT OPEN AT A TIME.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * One shop, one drawer, so one shift is open at any moment. `openShift` refuses to open a second while
 * one is live; `closeShift` and `recordCashMovement` refuse when none is. The single synchronous main
 * process cannot interleave two opens (migration 0012's header), so the guard is a plain SELECT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. THE RECONCILIATION IS DERIVED, AND FROZEN AT CLOSE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * `expected_cash` is what the drawer SHOULD hold, computed from the documents that touched it:
 *
 *     opening_float
 *       + cash SALES rung on this shift        (sale_payments whose method maps to ACC.CASH, LESS the
 *                                               change handed back — the drawer keeps tendered − change)
 *       + cash UDHAAR repaid on this shift      (customer_payments in cash)
 *       + pay-ins                               (cash put INTO the drawer)
 *       − cash REFUNDS paid out on this shift   (returns settled 'refund' in cash)
 *       − pay-outs                              (cash taken OUT for a bill/expense)
 *       − drops                                 (cash moved to the safe / bank)
 *
 * `variance = counted_cash − expected_cash` (positive = OVER, negative = SHORT). It is RECORDED, NOT
 * posted to the ledger: an over/short is a miscount to investigate, and silently adjusting GL Cash on
 * every close would hide the very theft or error the count exists to catch. The books stay at what the
 * sales, refunds and movements actually posted; the count sits beside them. (Migration 0012's header.)
 *
 * `zReport` computes the SAME reconciliation live, so a closed shift's Z-report recomputes to its frozen
 * `expected_cash` by construction, and an open shift shows a running "so far".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. TRANSPORT-AGNOSTIC (CLAUDE.md §3).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Plain args in, plain data out. No Result envelope, no `electron` import. The IPC layer zod-validates
 * again at its boundary, enforces the `shift.manage` / `shift.view` permissions, checks the
 * read-only/expired-licence block with assertWritable, and wraps the answer — exactly as it does for the
 * sale handlers. A cashier may open/close a shift and record a drawer movement: running the till is a
 * cashier's job, and the audit log plus the Z-report variance are the control, not a block. A no-sale
 * and a pay-out are theft vectors, so they are heavily audited — but a cashier may still do them, which
 * is real shop workflow.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Small shared helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today, a LAN server will call it tomorrow. The zod messages
 * are already written in language a cashier reads.
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

/** The frozen full name of a user, for the Z-report. NULL if the user was since deleted. */
function userName(db: DB, id: number): string | null {
  return (
    (db.prepare('SELECT full_name FROM users WHERE id = ?').pluck().get(id) as string | undefined) ??
    null
  )
}

// ── Row → domain ─────────────────────────────────────────────────────────────

type ShiftRow = {
  id: number
  opened_at: string
  opened_by: number
  opening_float: number
  closed_at: string | null
  closed_by: number | null
  counted_cash: number | null
  expected_cash: number | null
  variance: number | null
  note: string | null
  created_at: string
}

function toShift(row: ShiftRow): Shift {
  return {
    id: row.id,
    openedAt: row.opened_at,
    openedByUserId: row.opened_by,
    openingFloat: row.opening_float,
    closedAt: row.closed_at,
    closedByUserId: row.closed_by,
    countedCash: row.counted_cash,
    expectedCash: row.expected_cash,
    variance: row.variance,
    note: row.note,
    createdAt: row.created_at,
    // DERIVED, never a stored column: the shift is open exactly while it has no close time.
    status: row.closed_at == null ? 'open' : 'closed'
  }
}

type CashMovementRow = {
  id: number
  shift_id: number
  at: string
  type: CashMovementType
  amount: number
  reason_code: string | null
  note: string | null
  user_id: number
  journal_id: number | null
  created_at: string
}

/**
 * The human label for a cash-movement reason, from the list that MATCHES the movement type: a no_sale
 * reason lives in no_sale_reason, a pay_out reason in pay_out_reason. A pay_in / drop reason is free text
 * with no list, so it shows as typed. Falls back to the raw code if the owner has since renamed or
 * removed the lookup, so an old movement never renders blank.
 */
function cashReasonLabel(db: DB, type: CashMovementType, code: string | null): string | null {
  if (code == null) return null
  const listKey = type === 'no_sale' ? 'no_sale_reason' : type === 'pay_out' ? 'pay_out_reason' : null
  if (listKey == null) return code
  const label = db
    .prepare('SELECT label FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as string | undefined
  return label ?? code
}

function toCashMovement(db: DB, row: CashMovementRow): CashMovement {
  return {
    id: row.id,
    shiftId: row.shift_id,
    at: row.at,
    type: row.type,
    amount: row.amount,
    reasonCode: row.reason_code,
    reasonLabel: cashReasonLabel(db, row.type, row.reason_code),
    note: row.note,
    userId: row.user_id,
    journalId: row.journal_id,
    createdAt: row.created_at
  }
}

function loadShift(db: DB, id: number): Shift {
  const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as ShiftRow | undefined
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That shift could not be found.', `shift id=${id} does not exist`)
  }
  return toShift(row)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE OPEN SHIFT
// ═════════════════════════════════════════════════════════════════════════════

/** The one shift with `closed_at IS NULL`, or null. Backed by a partial index (migration 0012). */
export function currentOpenShift(db: DB): Shift | null {
  const row = db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL').get() as ShiftRow | undefined
  return row ? toShift(row) : null
}

/**
 * OPEN A SHIFT with a starting float. Refused while one is already open — one drawer, one session.
 * Records who opened it and when, and audits `shift.open`. Posts NO journal: the float is cash already
 * in the till, not a fresh accounting event.
 */
export function openShift(db: DB, actor: User, rawInput: unknown, now = new Date()): Shift {
  const input = parseOrThrow(OpenShiftInput, rawInput, 'shift.open')

  // Opening a shift writes into a period, so a locked month refuses it (like a sale). Up front, so the
  // cashier gets a sentence rather than a rolled-back transaction.
  ledger.assertPeriodOpen(db, now.getFullYear(), now.getMonth() + 1)

  const existing = currentOpenShift(db)
  if (existing != null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A shift is already open. Close it before opening another.',
      `refusing to open a second shift while shift ${existing.id} is still open`
    )
  }

  const run = db.transaction((): number => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO shifts (opened_at, opened_by, opening_float, note, created_at)
           VALUES (@openedAt, @openedBy, @openingFloat, @note, @createdAt)`
        )
        .run({
          openedAt: now.toISOString(),
          openedBy: actor.id,
          openingFloat: input.openingFloat,
          note: input.note ?? null,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    audit.record(
      db,
      actor,
      { action: 'shift.open', entity: 'shift', entityId: id, after: { openingFloat: input.openingFloat } },
      now
    )

    return id
  })

  return loadShift(db, run())
}

// ═════════════════════════════════════════════════════════════════════════════
// CLOSE THE SHIFT — count the drawer, freeze the reconciliation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * CLOSE THE OPEN SHIFT. The cashier hands main the physically counted cash; main computes the expected
 * cash (see RECONCILIATION) and freezes counted / expected / variance onto the row TOGETHER — the DB
 * CHECK forbids a half-closed shift. Over/short is RECORDED, never posted (a miscount must not adjust GL
 * Cash). Audits `shift.close` with expected / counted / variance, and returns the frozen Z-report.
 */
export function closeShift(
  db: DB,
  actor: User,
  rawInput: unknown,
  now = new Date()
): { shift: Shift; zReport: ZReport } {
  const input = parseOrThrow(CloseShiftInput, rawInput, 'shift.close')

  ledger.assertPeriodOpen(db, now.getFullYear(), now.getMonth() + 1)

  const open = currentOpenShift(db)
  if (open == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'There is no open shift to close.',
      'closeShift called with no shift open'
    )
  }

  const recon = computeReconciliation(db, open)
  const countedCash = input.countedCash
  const expectedCash = recon.expectedCash
  const variance = countedCash - expectedCash // the DB CHECK re-asserts variance = counted − expected

  db.transaction((): void => {
    db.prepare(
      `UPDATE shifts
          SET closed_at = @closedAt, closed_by = @closedBy,
              counted_cash = @countedCash, expected_cash = @expectedCash, variance = @variance,
              note = COALESCE(@note, note)
        WHERE id = @id`
    ).run({
      closedAt: now.toISOString(),
      closedBy: actor.id,
      countedCash,
      expectedCash,
      variance,
      note: input.note ?? null,
      id: open.id
    })

    audit.record(
      db,
      actor,
      {
        action: 'shift.close',
        entity: 'shift',
        entityId: open.id,
        after: { expectedCash, countedCash, variance }
      },
      now
    )
  })()

  return { shift: loadShift(db, open.id), zReport: zReport(db, open.id) }
}

// ═════════════════════════════════════════════════════════════════════════════
// CASH MOVEMENTS — drawer events that are NOT sales
// ═════════════════════════════════════════════════════════════════════════════

/**
 * RECORD A DRAWER MOVEMENT. Requires an OPEN shift. In ONE transaction, or none of it:
 *
 *   1. the movement row is written;
 *   2. its balanced journal posts (NONE for a no-sale, which moves no money):
 *        pay_in  → DR Cash             CR Owner Equity      (an owner tops up the float)
 *        pay_out → DR General Expenses CR Cash              (cash out for a bill/errand)
 *        drop    → DR Bank             CR Cash              (cash relocated to the safe/bank)
 *   3. the journal id is linked back onto the row (NULL for a no-sale);
 *   4. `cash.movement` is audited, carrying the type and the reason.
 *
 * A no-sale and a pay-out each REQUIRE a live reason code from the owner's own list — they are the two
 * theft vectors here. A pay-in and a drop are self-explanatory, so a reason is optional.
 */
export function recordCashMovement(
  db: DB,
  actor: User,
  rawInput: unknown,
  now = new Date()
): CashMovement {
  const input = parseOrThrow(CashMovementInput, rawInput, 'cash.movement')

  ledger.assertPeriodOpen(db, now.getFullYear(), now.getMonth() + 1)

  const open = currentOpenShift(db)
  if (open == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Open a shift before recording a drawer movement.',
      `recordCashMovement(${input.type}) called with no shift open`
    )
  }

  // WHY — a live code on the owner's OWN list, for the two theft-vector movements. The zod schema has
  // already proven a code is present for these; this proves it is a real, active one.
  let reasonCode: string | null = null
  if (input.type === 'no_sale') {
    reasonCode = requireLookupByCode(
      db,
      'no_sale_reason',
      input.reasonCode as string,
      'Please choose a reason for opening the drawer.'
    ).code
  } else if (input.type === 'pay_out') {
    reasonCode = requireLookupByCode(
      db,
      'pay_out_reason',
      input.reasonCode as string,
      'Please choose a reason for taking cash out.'
    ).code
  } else {
    // pay_in / drop — a reason is optional and free-form colour; there is no list to police it against.
    reasonCode = input.reasonCode ?? null
  }

  const run = db.transaction((): number => {
    const movementId = Number(
      db
        .prepare(
          `INSERT INTO cash_movements
             (shift_id, at, type, amount, reason_code, note, user_id, journal_id, created_at)
           VALUES
             (@shiftId, @at, @type, @amount, @reasonCode, @note, @userId, NULL, @createdAt)`
        )
        .run({
          shiftId: open.id,
          at: now.toISOString(),
          type: input.type,
          amount: input.amount,
          reasonCode,
          note: input.note ?? null,
          userId: actor.id,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    // The journal (none for a no-sale). journal_id is NULL for the instant between the row landing and
    // the journal being attached — both happen inside this one transaction, so a committed movement
    // always carries its journal (or NULL, deliberately, for a no-sale).
    const journalId = postCashMovementJournal(db, {
      type: input.type,
      movementId,
      amount: input.amount,
      userId: actor.id,
      now
    })
    if (journalId != null) {
      db.prepare('UPDATE cash_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
    }

    // WHO did WHAT, and WHY (CLAUDE.md §4). The action carries the movement type and the reason.
    audit.record(
      db,
      actor,
      {
        action: 'cash.movement',
        entity: 'cash_movement',
        entityId: movementId,
        ...(reasonCode != null ? { reasonCode } : {}),
        ...(input.note != null ? { reasonText: input.note } : {}),
        after: { type: input.type, amount: input.amount, shiftId: open.id }
      },
      now
    )

    return movementId
  })

  return getCashMovement(db, run())
}

/**
 * POST A CASH MOVEMENT'S JOURNAL. Two equal legs, so it balances by construction. A no-sale moves no
 * money and posts nothing — returns null, and the movement row's journal_id stays NULL (migration 0012).
 */
function postCashMovementJournal(
  db: DB,
  args: { type: CashMovementType; movementId: number; amount: number; userId: number; now: Date }
): number | null {
  let lines: ledger.JournalLineInput[]
  let memo: string

  switch (args.type) {
    case 'no_sale':
      return null // the drawer opened; no money moved
    case 'pay_in':
      lines = [
        { account: ACC.CASH, debit: args.amount },
        { account: ACC.OWNER_EQUITY, credit: args.amount }
      ]
      memo = 'Cash pay-in'
      break
    case 'pay_out':
      lines = [
        { account: ACC.EXPENSE_GENERAL, debit: args.amount },
        { account: ACC.CASH, credit: args.amount }
      ]
      memo = 'Cash pay-out'
      break
    case 'drop':
      lines = [
        { account: ACC.BANK, debit: args.amount },
        { account: ACC.CASH, credit: args.amount }
      ]
      memo = 'Cash drop to safe/bank'
      break
  }

  return ledger.post(db, {
    at: args.now,
    refType: CASH_MOVEMENT_REF_TYPE,
    refId: args.movementId,
    memo,
    userId: args.userId,
    lines
  })
}

/** One drawer movement — the row, hydrated. */
export function getCashMovement(db: DB, id: number): CashMovement {
  const row = db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(id) as
    | CashMovementRow
    | undefined
  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That drawer movement could not be found.',
      `cash_movements id=${id} does not exist`
    )
  }
  return toCashMovement(db, row)
}

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILIATION — derived, one function used by close AND by the Z-report
// ═════════════════════════════════════════════════════════════════════════════

type Reconciliation = {
  openingFloat: number
  cashSales: number
  cashUdhaar: number
  payIns: number
  cashRefunds: number
  payOuts: number
  drops: number
  expectedCash: number
}

/**
 * The lookups('payment_method') ids whose method maps to ACC.CASH — reusing the SAME mapping a sale
 * uses (`sales.accountForPaymentMethod`), so this cannot disagree with the ledger about what "cash" is.
 * Not gated on is_active: a shift may have taken cash through a method the owner has since retired, and
 * that cash was still cash. Normally this is exactly the one 'cash' method.
 */
function cashMethodIds(db: DB): number[] {
  const rows = db
    .prepare("SELECT id, code FROM lookups WHERE list_key = 'payment_method'")
    .all() as Array<{ id: number; code: string }>
  return rows.filter((row) => accountForPaymentMethod(row.code) === ACC.CASH).map((row) => row.id)
}

/** SUM(amount) of the shift's cash movements of one type. */
function sumMovements(db: DB, shiftId: number, type: CashMovementType): number {
  return db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE shift_id = ? AND type = ?')
    .pluck()
    .get(shiftId, type) as number
}

/** Build a `col IN (?, ?, …)` fragment; an empty id list yields a fragment that matches nothing. */
function inClause(ids: number[]): string {
  return ids.length > 0 ? ids.map(() => '?').join(', ') : 'NULL'
}

function computeReconciliation(db: DB, shift: { id: number; openingFloat: number }): Reconciliation {
  const cashIds = cashMethodIds(db)

  // Cash TAKEN IN on the shift's completed sales, through a cash-mapped tender.
  const cashTendered = db
    .prepare(
      `SELECT COALESCE(SUM(sp.amount), 0)
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
        WHERE s.shift_id = ? AND s.status = 'completed'
          AND sp.method_lookup_id IN (${inClause(cashIds)})`
    )
    .pluck()
    .get(shift.id, ...cashIds) as number

  // Change is handed back in cash, so the drawer keeps tendered − change. change_due is only ever > 0
  // when cash was tendered (sales.complete enforces it), so all of it is attributable to cash.
  const changeGiven = db
    .prepare("SELECT COALESCE(SUM(change_due), 0) FROM sales WHERE shift_id = ? AND status = 'completed'")
    .pluck()
    .get(shift.id) as number

  const cashSales = cashTendered - changeGiven

  const cashUdhaar = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0)
         FROM customer_payments
        WHERE shift_id = ? AND method_lookup_id IN (${inClause(cashIds)})`
    )
    .pluck()
    .get(shift.id, ...cashIds) as number

  const cashRefunds = db
    .prepare(
      `SELECT COALESCE(SUM(grand_total), 0)
         FROM returns
        WHERE shift_id = ? AND settlement = 'refund'
          AND refund_method_lookup_id IN (${inClause(cashIds)})`
    )
    .pluck()
    .get(shift.id, ...cashIds) as number

  const payIns = sumMovements(db, shift.id, 'pay_in')
  const payOuts = sumMovements(db, shift.id, 'pay_out')
  const drops = sumMovements(db, shift.id, 'drop')

  const expectedCash =
    shift.openingFloat + cashSales + cashUdhaar + payIns - cashRefunds - payOuts - drops

  return { openingFloat: shift.openingFloat, cashSales, cashUdhaar, payIns, cashRefunds, payOuts, drops, expectedCash }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE Z-REPORT — computed from the shift's own rows
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE Z-REPORT. Live "so far" for an open shift; the same figures, recomputed, for a closed one (they
 * equal the frozen `expected_cash` by construction). Everything is totalled from the shift's OWN rows,
 * so a Z-report reads the same a year later — like a sale line, it is history, not a live view.
 */
export function zReport(db: DB, shiftId: number): ZReport {
  const shift = loadShift(db, shiftId)

  // ── Sales rung on this shift ──────────────────────────────────────────────
  const salesAgg = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(grand_total), 0)  AS grossTotal,
              COALESCE(SUM(tax_total), 0)    AS totalTax,
              COALESCE(SUM(cart_discount), 0) AS cartDiscount,
              COALESCE(SUM(change_due), 0)   AS change
         FROM sales WHERE shift_id = ? AND status = 'completed'`
    )
    .get(shiftId) as {
    count: number
    grossTotal: number
    totalTax: number
    cartDiscount: number
    change: number
  }

  // Line discounts live on the lines; add them to the header cart discounts for the "discount" total.
  const lineDiscount = db
    .prepare(
      `SELECT COALESCE(SUM(sl.line_discount), 0)
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE s.shift_id = ? AND s.status = 'completed'`
    )
    .pluck()
    .get(shiftId) as number

  const salesByTender = tenderBreakdown(
    db,
    `SELECT sp.method_lookup_id AS methodId, l.label AS label, COALESCE(SUM(sp.amount), 0) AS amount
       FROM sale_payments sp
       JOIN sales s   ON s.id = sp.sale_id
       JOIN lookups l ON l.id = sp.method_lookup_id
      WHERE s.shift_id = ? AND s.status = 'completed'
      GROUP BY sp.method_lookup_id, l.label
      ORDER BY sp.method_lookup_id`,
    shiftId,
    // Change is handed back in cash — net it out of the cash bucket so the breakdown sums to grossTotal
    // (what settled the sales), not to what was tendered (which includes the change given back).
    salesAgg.change
  )

  // ── Refunds paid out through a tender on this shift ───────────────────────
  const refundAgg = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(grand_total), 0) AS total
         FROM returns WHERE shift_id = ? AND settlement = 'refund'`
    )
    .get(shiftId) as { count: number; total: number }

  const refundByTender = tenderBreakdown(
    db,
    `SELECT r.refund_method_lookup_id AS methodId, l.label AS label,
            COALESCE(SUM(r.grand_total), 0) AS amount
       FROM returns r JOIN lookups l ON l.id = r.refund_method_lookup_id
      WHERE r.shift_id = ? AND r.settlement = 'refund'
      GROUP BY r.refund_method_lookup_id, l.label
      ORDER BY r.refund_method_lookup_id`,
    shiftId,
    0
  )

  // ── Voids: sales rung on this shift that were later cancelled ─────────────
  const voidCount = db
    .prepare("SELECT COUNT(*) FROM sales WHERE shift_id = ? AND status = 'voided'")
    .pluck()
    .get(shiftId) as number

  // ── Cash movements ────────────────────────────────────────────────────────
  const noSaleCount = db
    .prepare("SELECT COUNT(*) FROM cash_movements WHERE shift_id = ? AND type = 'no_sale'")
    .pluck()
    .get(shiftId) as number

  const recon = computeReconciliation(db, shift)

  return {
    shift: {
      id: shift.id,
      openedByName: userName(db, shift.openedByUserId),
      openedAt: shift.openedAt,
      closedByName: shift.closedByUserId != null ? userName(db, shift.closedByUserId) : null,
      closedAt: shift.closedAt,
      note: shift.note,
      status: shift.status
    },
    sales: {
      count: salesAgg.count,
      grossTotal: salesAgg.grossTotal,
      totalDiscount: salesAgg.cartDiscount + lineDiscount,
      totalTax: salesAgg.totalTax,
      byTender: salesByTender
    },
    refunds: {
      count: refundAgg.count,
      total: refundAgg.total,
      byTender: refundByTender
    },
    voids: { count: voidCount },
    cashMovements: {
      noSaleCount,
      payInTotal: recon.payIns,
      payOutTotal: recon.payOuts,
      dropTotal: recon.drops
    },
    reconciliation: {
      ...recon,
      // Frozen on the row at close; NULL while the shift is open.
      countedCash: shift.countedCash,
      variance: shift.variance
    }
  }
}

/**
 * Run a grouped `(methodId, label, amount)` query and turn it into a tender breakdown, optionally
 * netting `changeToNet` out of the cash-mapped buckets. Change comes out of cash only and never exceeds
 * the cash tendered on the shift (per sale, sales.complete caps change at cash tendered), so draining it
 * from the cash rows leaves every amount >= 0 and makes the breakdown sum to the money that settled.
 */
function tenderBreakdown(
  db: DB,
  sql: string,
  shiftId: number,
  changeToNet: number
): TenderBreakdown[] {
  const rows = db.prepare(sql).all(shiftId) as Array<{
    methodId: number
    label: string
    amount: number
  }>

  const cashIds = new Set(cashMethodIds(db))
  let changeRemaining = changeToNet

  const breakdown: TenderBreakdown[] = []
  for (const row of rows) {
    let amount = row.amount
    if (changeRemaining > 0 && cashIds.has(row.methodId)) {
      const take = Math.min(changeRemaining, amount)
      amount -= take
      changeRemaining -= take
    }
    if (amount !== 0) breakdown.push({ methodLookupId: row.methodId, label: row.label, amount })
  }
  return breakdown
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — the list and one shift in full
// ═════════════════════════════════════════════════════════════════════════════

/** THE SHIFTS LIST — paginated and indexed, newest first. Assume a shift a day for years (CLAUDE.md §4). */
export function listShifts(db: DB, rawInput: unknown = {}): PagedResult<ShiftListItem> {
  const input = parseOrThrow(ListShiftsInput, rawInput, 'shift.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const total = db.prepare('SELECT COUNT(*) FROM shifts').pluck().get() as number

  const rows = db
    .prepare(
      `SELECT sh.id, sh.opened_at, sh.opening_float, sh.closed_at,
              sh.expected_cash, sh.counted_cash, sh.variance,
              uo.full_name AS opened_by_name,
              uc.full_name AS closed_by_name
         FROM shifts sh
         LEFT JOIN users uo ON uo.id = sh.opened_by
         LEFT JOIN users uc ON uc.id = sh.closed_by
        ORDER BY sh.opened_at DESC, sh.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    id: number
    opened_at: string
    opening_float: number
    closed_at: string | null
    expected_cash: number | null
    counted_cash: number | null
    variance: number | null
    opened_by_name: string | null
    closed_by_name: string | null
  }>

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      openedAt: row.opened_at,
      openedByName: row.opened_by_name ?? null,
      closedAt: row.closed_at,
      closedByName: row.closed_by_name ?? null,
      openingFloat: row.opening_float,
      expectedCash: row.expected_cash,
      countedCash: row.counted_cash,
      variance: row.variance,
      status: row.closed_at == null ? 'open' : 'closed'
    }))
  }
}

/** ONE SHIFT with its cash movements and its Z-report — the shift detail screen. */
export function getShift(db: DB, rawId: unknown): ShiftDetail {
  const { id } = parseOrThrow(
    GetShiftInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'shift.get'
  )

  const shift = loadShift(db, id)

  const cashMovements = (
    db.prepare('SELECT * FROM cash_movements WHERE shift_id = ? ORDER BY at, id').all(id) as
      CashMovementRow[]
  ).map((row) => toCashMovement(db, row))

  return {
    ...shift,
    openedByName: userName(db, shift.openedByUserId),
    closedByName: shift.closedByUserId != null ? userName(db, shift.closedByUserId) : null,
    cashMovements,
    zReport: zReport(db, id)
  }
}
