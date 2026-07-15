import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { PagedResult } from '@shared/catalog'
import {
  SupplierGetInput,
  SupplierInput,
  SupplierListInput,
  UpdateSupplierInput,
  type Supplier
} from '@shared/suppliers'
import * as audit from './audit'

/**
 * SUPPLIERS — who the shop buys from, and who it owes money to. The mirror of `customers.ts`.
 *
 * THE SUPPLIER RECORD. Name, phone, address, type — the party a goods-received note is raised against
 * and a running payable is kept with. The LEDGER itself — the running statement and the payments that
 * bring what the shop owes back down — lives next door in `supplier-ledger.ts`.
 *
 * THE THING THAT IS NOT HERE, AND NEVER WILL BE: A BALANCE.
 *
 * What the shop owes a supplier is DERIVED — opening payable, plus each purchase's unpaid portion, less
 * the payments made against them — exactly as stock is the sum of its movements. There is no `balance`
 * column, no `setBalance()`, and no field on the form to type one into. A typed balance is a balance
 * that can disagree with the bills behind it, and then the shop pays a supplier money the ledger says
 * it does not owe.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import. The IPC layer
 * zod-validates, checks the permission in MAIN, and wraps the answer in a Result.
 */

// ── Rows ─────────────────────────────────────────────────────────────────────

type SupplierRow = {
  id: number
  name: string
  phone: string | null
  address: string | null
  type_lookup_id: number | null
  is_active: number
  created_at: string
  updated_at: string
}

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    typeLookupId: row.type_lookup_id,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Add a supplier.
 *
 * NAMES ARE NOT UNIQUE, deliberately — the same reasoning as customers. Two distributors can carry the
 * same trading name, and refusing the second would force the owner to invent a fake one for a real
 * business. The phone number is what tells them apart, and the list searches on it.
 */
export function create(db: DB, actor: User, raw: unknown, now = new Date()): Supplier {
  const input = parseOrThrow(SupplierInput, raw, 'supplier.create')
  const at = now.toISOString()

  if (input.typeLookupId != null) assertSupplierType(db, input.typeLookupId)

  const id = guard(
    () =>
      Number(
        db
          .prepare(
            `INSERT INTO suppliers (name, phone, address, type_lookup_id, is_active, created_at, updated_at)
             VALUES (@name, @phone, @address, @typeLookupId, 1, @at, @at)`
          )
          .run({
            name: input.name,
            phone: input.phone ?? null,
            address: input.address ?? null,
            typeLookupId: input.typeLookupId ?? null,
            at
          }).lastInsertRowid
      ),
    'supplier.create'
  )

  audit.record(
    db,
    actor,
    {
      action: 'supplier.create',
      entity: 'supplier',
      entityId: id,
      after: { name: input.name, phone: input.phone ?? null }
    },
    now
  )

  return getById(db, id)
}

// ── Update — ONLY the fields the form actually sent ───────────────────────────

/** Editable field -> its column. The whitelist IS the contract; nothing outside it can be written. */
const UPDATABLE: Record<string, string> = {
  name: 'name',
  phone: 'phone',
  address: 'address',
  typeLookupId: 'type_lookup_id',
  isActive: 'is_active'
  // NO BALANCE. See the header — what a supplier is owed is derived from the ledger. Not an oversight.
}

/**
 * Save an edit.
 *
 * THIS WRITES ONLY THE KEYS THAT ARE ACTUALLY PRESENT ON `raw`. (CLAUDE.md trap #18.)
 *
 *   key absent  ->  the form never loaded this field. LEAVE IT ALONE.
 *   key = null  ->  the user cleared it. Write NULL.
 *
 * Post the whole object back instead and the "quick edit the phone number" dialog — which never loaded
 * the address or the type — silently wipes both.
 */
export function update(db: DB, actor: User, raw: unknown, now = new Date()): Supplier {
  const input = parseOrThrow(UpdateSupplierInput, raw, 'supplier.update')
  const before = getById(db, input.id)

  // `in`, not a truthiness test: `false` and `null` are real, intentional values a truthiness test
  // would throw away.
  const touched = Object.keys(UPDATABLE).filter((key) => key in input)
  if (touched.length === 0) return before

  if ('typeLookupId' in input && input.typeLookupId != null) {
    assertSupplierType(db, input.typeLookupId)
  }

  const sets = touched.map((key) => `${UPDATABLE[key]} = @${key}`)
  const params: Record<string, unknown> = { id: input.id, at: now.toISOString() }

  for (const key of touched) {
    const value = (input as Record<string, unknown>)[key]
    params[key] = typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null)
  }

  guard(
    () =>
      db
        .prepare(`UPDATE suppliers SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`)
        .run(params),
    'supplier.update'
  )

  const after = getById(db, input.id)

  audit.record(
    db,
    actor,
    {
      action: 'supplier.update',
      entity: 'supplier',
      entityId: input.id,
      // Only what actually changed — an audit row nobody can read is an audit row nobody reads.
      before: pick(before, touched),
      after: pick(after, touched)
    },
    now
  )

  return after
}

/**
 * Retire a supplier. They are NEVER deleted.
 *
 * Last year's purchase and this supplier's opening payable point at this row, and the supplier ledger
 * must still be able to say whose debt it was. A deleted supplier turns every historical line that
 * referenced them into a hole.
 */
export function deactivate(db: DB, actor: User, id: number, now = new Date()): Supplier {
  return update(db, actor, { id, isActive: false }, now)
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function getById(db: DB, rawId: unknown): Supplier {
  const { id } = parseOrThrow(
    SupplierGetInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'supplier.get'
  )

  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as SupplierRow | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That supplier could not be found. They may have been removed.',
      `supplier id=${id} does not exist`
    )
  }
  return toSupplier(row)
}

/**
 * THE SUPPLIER LIST. Paginated and indexed — assume 100k rows, not 10. (CLAUDE.md §4)
 *
 * Searches NAME and PHONE, because two suppliers can share a name and the phone number is what tells
 * them apart. Both columns are indexed (migration 0003).
 */
export function list(db: DB, raw: unknown = {}): PagedResult<Supplier> {
  const input = parseOrThrow(SupplierListInput, raw, 'supplier.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (!input.includeInactive) where.push('is_active = 1')

  if (input.search) {
    // ESCAPE '\' is not optional: without it the backslashes escapeLike() adds are just characters.
    where.push(`(name LIKE @like ESCAPE '\\' OR phone LIKE @like ESCAPE '\\')`)
    params['like'] = `%${escapeLike(input.search)}%`
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db.prepare(`SELECT COUNT(*) FROM suppliers ${whereSql}`).pluck().get(params) as number

  const rows = db
    .prepare(
      `SELECT * FROM suppliers ${whereSql}
       ORDER BY name, id
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as SupplierRow[]

  return { total, page, pageSize, rows: rows.map(toSupplier) }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The supplier type must be a real, CURRENT entry on the owner's own `supplier_type` list — not a
 * number the renderer made up, and not one the owner has since retired. (CLAUDE.md §4: no hardcoded
 * dropdown options, ever; and the renderer is not a security boundary.)
 */
function assertSupplierType(db: DB, lookupId: number): void {
  const found = db
    .prepare(`SELECT 1 FROM lookups WHERE id = ? AND list_key = 'supplier_type' AND is_active = 1`)
    .pluck()
    .get(lookupId)

  if (found == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose a supplier type from the list.',
      `lookup id=${lookupId} is not an active supplier_type`
    )
  }
}

function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = (source as Record<string, unknown>)[key]
  return out
}

/** `%` and `_` are wildcards in LIKE. Somebody searching for "50%" means the characters. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today and a LAN server will call it tomorrow. The zod
 * messages are already written in language a cashier reads.
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
 * SQLite says "CHECK constraint failed". A cashier must never see that. This turns what the database
 * says into what a person needs to hear, and keeps the real text for the log.
 */
function guard<T>(run: () => T, context: string): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof AppError) throw error

    const code = (error as { code?: string }).code ?? ''
    const technical = `${context}: ${error instanceof Error ? error.message : String(error)}`

    if (code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'The supplier type chosen no longer exists. Please pick it again.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That supplier could not be saved. Please check the details and try again.',
        technical
      )
    }

    throw new AppError(
      ErrorCode.DB,
      'Something went wrong saving that supplier. Please try again.',
      technical
    )
  }
}
