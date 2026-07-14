import type { DB } from '../db'
import type { Lookup } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'

/**
 * LOOKUPS — the source of EVERY dropdown in the app. (CLAUDE.md §4)
 *
 * If you are ever about to type an array of strings into a <Select>, stop: it belongs here. The shop
 * owner adds their own payment methods, their own reason codes, their own categories, from
 * Settings → Manage Lists, without us shipping a new build.
 *
 * SYSTEM ROWS: some codes are load-bearing — the ledger posts differently for `cash` than for
 * `credit`. Those are marked is_system. The owner may RENAME them ("Cash" → "Naqad") and may
 * DEACTIVATE them, but may not DELETE them, because the code behind them would lose its footing.
 */

export type LookupList =
  | 'payment_method'
  | 'department'
  | 'category'
  | 'sub_category'
  | 'brand'
  | 'location'
  | 'favourite_group'
  | 'uom'
  | 'void_reason'
  | 'refund_reason'
  | 'discount_reason'
  | 'adjustment_reason'
  | 'expense_category'
  | 'customer_type'
  | 'supplier_type'

type LookupRow = {
  id: number
  list_key: string
  code: string
  label: string
  sort_order: number
  is_active: number
  is_system: number
}

function toLookup(row: LookupRow): Lookup {
  return {
    id: row.id,
    listKey: row.list_key,
    code: row.code,
    label: row.label,
    sortOrder: row.sort_order,
    isActive: Boolean(row.is_active),
    isSystem: Boolean(row.is_system)
  }
}

export function list(db: DB, listKey: LookupList, includeInactive = false): Lookup[] {
  const rows = db
    .prepare(
      `SELECT * FROM lookups
       WHERE list_key = ? ${includeInactive ? '' : 'AND is_active = 1'}
       ORDER BY sort_order, label`
    )
    .all(listKey) as LookupRow[]

  return rows.map(toLookup)
}

/** The inline "+ add new" behind every select. */
export function add(
  db: DB,
  input: { listKey: LookupList; label: string; code?: string; sortOrder?: number },
  now = new Date()
): Lookup {
  const label = input.label.trim()
  if (!label) {
    throw new AppError(ErrorCode.VALIDATION, 'Please enter a name.', 'empty lookup label')
  }

  const code = (input.code ?? label).trim().toLowerCase().replace(/\s+/g, '_')

  const existing = db
    .prepare('SELECT * FROM lookups WHERE list_key = ? AND code = ?')
    .get(input.listKey, code) as LookupRow | undefined

  if (existing) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${label}" is already on this list.`,
      `duplicate ${input.listKey}/${code}`
    )
  }

  const info = db
    .prepare(
      `INSERT INTO lookups (list_key, code, label, sort_order, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
    )
    .run(
      input.listKey,
      code,
      label,
      input.sortOrder ?? 100,
      now.toISOString(),
      now.toISOString()
    )

  return toLookup(
    db.prepare('SELECT * FROM lookups WHERE id = ?').get(Number(info.lastInsertRowid)) as LookupRow
  )
}

/** Rename or reorder. The CODE is never editable — code is what the rest of the app refers to. */
export function update(
  db: DB,
  id: number,
  changes: { label?: string; sortOrder?: number; isActive?: boolean },
  now = new Date()
): Lookup {
  const row = db.prepare('SELECT * FROM lookups WHERE id = ?').get(id) as LookupRow | undefined
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'That list item no longer exists.', `id=${id}`)

  // Note we send ONLY the fields the form actually edited — we never write back a whole object and
  // wipe columns the form never loaded (trap #18).
  db.prepare(
    `UPDATE lookups SET
       label = COALESCE(@label, label),
       sort_order = COALESCE(@sortOrder, sort_order),
       is_active = COALESCE(@isActive, is_active),
       updated_at = @now
     WHERE id = @id`
  ).run({
    id,
    label: changes.label?.trim() ?? null,
    sortOrder: changes.sortOrder ?? null,
    isActive: changes.isActive === undefined ? null : changes.isActive ? 1 : 0,
    now: now.toISOString()
  })

  return toLookup(db.prepare('SELECT * FROM lookups WHERE id = ?').get(id) as LookupRow)
}

/**
 * Remove a list item. A SYSTEM row can never be deleted — the ledger depends on it. And any row can
 * only be deactivated, never truly deleted, because a sale from last year may point at it and a
 * report from last year must still be able to name it.
 */
export function deactivate(db: DB, id: number, now = new Date()): void {
  const row = db.prepare('SELECT * FROM lookups WHERE id = ?').get(id) as LookupRow | undefined
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'That list item no longer exists.', `id=${id}`)

  if (row.is_system) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      `"${row.label}" is built in and cannot be removed. You can rename it instead.`,
      `attempt to remove system lookup ${row.list_key}/${row.code}`
    )
  }

  db.prepare('UPDATE lookups SET is_active = 0, updated_at = ? WHERE id = ?').run(
    now.toISOString(),
    id
  )
}
