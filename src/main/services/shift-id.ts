import type { DB } from '../db'

/**
 * THE OPEN SHIFT'S ID — for the three documents whose cash lands in a drawer (sales, returns,
 * customer payments) to STAMP onto themselves as they are written, so a Z-report totals exactly its
 * own shift rather than guessing by a time window. (Migration 0012.)
 *
 * This is a LEAF: it imports ONLY the DB type, and NOTHING from any other service. That is the whole
 * point of it. `sales.ts`, `returns.ts` and `customer-ledger.ts` all call it, and `shifts.ts` imports
 * `sales.ts` (for the payment-method → account mapping the reconciliation needs). If this lookup lived
 * in `shifts.ts`, then `sales.ts` importing it would close a module-load import cycle
 * (sales → shifts → sales), and one of the two modules would see the other half-initialised. A leaf
 * with no service imports cannot form that cycle.
 *
 * NULL when no shift is open. A sale, return or payment made while the shop is not running a shift
 * simply has no shift — true, the till was not on a shift — and it must still succeed exactly as
 * before. The column is nullable for precisely this (migration 0012, forward-only).
 *
 * One shift is open at a time (the service refuses to open a second), so this returns 0 or 1 row.
 */
export function openShiftId(db: DB): number | null {
  const id = db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL').pluck().get() as
    | number
    | undefined
  return id ?? null
}
