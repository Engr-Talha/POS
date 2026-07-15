import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { PagedResult } from '@shared/catalog'
import { CustomerGetInput, CustomerListInput } from '@shared/opening'
import {
  CreateCustomerInput,
  UpdateCustomerInput,
  type Customer,
  type CustomerPriceTier
} from '@shared/customers'
import * as audit from './audit'

/**
 * CUSTOMERS — who owes the shop money, and who the loyalty points belong to.
 *
 * THE CUSTOMER RECORD. Phase 7 (migration 0009) turned the minimal row into a real party the shop
 * keeps a running account with: on top of name/phone/address/type/credit-limit it now carries a
 * business name and tax number (for a proper sales-tax invoice), free-text notes, and a default price
 * tier. The udhaar LEDGER itself — the running statement and the repayments that bring the balance
 * down — lives next door in `customer-ledger.ts`; loyalty and per-customer pricing are still to come.
 *
 * THE THING THAT IS NOT HERE, AND NEVER WILL BE: A BALANCE.
 *
 * What a customer owes is DERIVED — it is the sum of their credit sales less their payments, exactly
 * as stock is the sum of the movements. There is no `balance` column, no `setBalance()`, and no field
 * on the form to type one into. A typed balance is a balance that can disagree with the invoices
 * behind it, and then the shop chases a customer for money the ledger says they do not owe.
 *
 * `credit_limit` IS stored, and it is a different thing entirely: how much udhaar this customer is
 * ALLOWED to run up. A limit, not a debt.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import. The IPC
 * layer zod-validates, checks the permission in MAIN, and wraps the answer in a Result.
 */

// ── Rows ─────────────────────────────────────────────────────────────────────

type CustomerRow = {
  id: number
  name: string
  phone: string | null
  address: string | null
  type_lookup_id: number | null
  credit_limit: number
  // ── Phase 7 (migration 0009). All nullable — a walk-in added before this build is simply NULL. ──
  business_name: string | null
  tax_number: string | null
  notes: string | null
  // The CHECK on this column (0009) guarantees it is 'retail', 'wholesale' or NULL — never anything else.
  price_tier: CustomerPriceTier | null
  is_active: number
  created_at: string
  updated_at: string
}

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    typeLookupId: row.type_lookup_id,
    creditLimit: row.credit_limit,
    businessName: row.business_name,
    taxNumber: row.tax_number,
    notes: row.notes,
    priceTier: row.price_tier,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Add a customer.
 *
 * NAMES ARE NOT UNIQUE, deliberately. In a Pakistani neighbourhood shop two customers really are both
 * called Muhammad Rashid, and refusing the second one would force the owner to invent a fake name for
 * a real person. The phone number is what tells them apart, and the list searches on it.
 */
export function create(db: DB, actor: User, raw: unknown, now = new Date()): Customer {
  const input = parseOrThrow(CreateCustomerInput, raw, 'customer.create')
  const at = now.toISOString()

  if (input.typeLookupId != null) assertCustomerType(db, input.typeLookupId)

  const id = guard(
    () =>
      Number(
        db
          .prepare(
            `INSERT INTO customers (name, phone, address, type_lookup_id, credit_limit,
                                    business_name, tax_number, notes, price_tier,
                                    is_active, created_at, updated_at)
             VALUES (@name, @phone, @address, @typeLookupId, @creditLimit,
                     @businessName, @taxNumber, @notes, @priceTier, 1, @at, @at)`
          )
          .run({
            name: input.name,
            phone: input.phone ?? null,
            address: input.address ?? null,
            typeLookupId: input.typeLookupId ?? null,
            creditLimit: input.creditLimit,
            businessName: input.businessName ?? null,
            taxNumber: input.taxNumber ?? null,
            notes: input.notes ?? null,
            priceTier: input.priceTier ?? null,
            at
          }).lastInsertRowid
      ),
    'customer.create'
  )

  audit.record(
    db,
    actor,
    {
      action: 'customer.create',
      entity: 'customer',
      entityId: id,
      after: { name: input.name, phone: input.phone ?? null, creditLimit: input.creditLimit }
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
  creditLimit: 'credit_limit',
  businessName: 'business_name',
  taxNumber: 'tax_number',
  notes: 'notes',
  priceTier: 'price_tier',
  isActive: 'is_active'
  // NO BALANCE. See the header — what a customer owes is derived from the ledger. Not an oversight.
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
 * the address or the credit limit — silently wipes both.
 */
export function update(db: DB, actor: User, raw: unknown, now = new Date()): Customer {
  const input = parseOrThrow(UpdateCustomerInput, raw, 'customer.update')
  const before = getById(db, input.id)

  // `in`, not a truthiness test: `false`, `0` and `null` are all real, intentional values that a
  // truthiness test would throw away — and `creditLimit: 0` is exactly how an owner cuts a customer off.
  const touched = Object.keys(UPDATABLE).filter((key) => key in input)
  if (touched.length === 0) return before

  if ('typeLookupId' in input && input.typeLookupId != null) {
    assertCustomerType(db, input.typeLookupId)
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
        .prepare(`UPDATE customers SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`)
        .run(params),
    'customer.update'
  )

  const after = getById(db, input.id)

  audit.record(
    db,
    actor,
    {
      action: 'customer.update',
      entity: 'customer',
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
 * Retire a customer. They are NEVER deleted.
 *
 * Last year's credit sale points at this row, and the udhaar ledger must still be able to say whose
 * debt it was. A deleted customer turns every historical line that referenced them into a hole.
 */
export function deactivate(db: DB, actor: User, id: number, now = new Date()): Customer {
  return update(db, actor, { id, isActive: false }, now)
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function getById(db: DB, rawId: unknown): Customer {
  const { id } = parseOrThrow(CustomerGetInput, typeof rawId === 'number' ? { id: rawId } : rawId, 'customer.get')

  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That customer could not be found. They may have been removed.',
      `customer id=${id} does not exist`
    )
  }
  return toCustomer(row)
}

/**
 * THE CUSTOMER LIST. Paginated and indexed — assume 100k rows, not 10. (CLAUDE.md §4)
 *
 * Searches NAME and PHONE, because two customers share a name and the phone number is what tells them
 * apart. Both columns are indexed (migration 0005).
 */
export function list(db: DB, raw: unknown = {}): PagedResult<Customer> {
  const input = parseOrThrow(CustomerListInput, raw, 'customer.list')

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

  const total = db.prepare(`SELECT COUNT(*) FROM customers ${whereSql}`).pluck().get(params) as number

  const rows = db
    .prepare(
      `SELECT * FROM customers ${whereSql}
       ORDER BY name, id
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as CustomerRow[]

  return { total, page, pageSize, rows: rows.map(toCustomer) }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The customer type must be a real, CURRENT entry on the owner's own `customer_type` list — not a
 * number the renderer made up, and not one the owner has since retired. (CLAUDE.md §4: no hardcoded
 * dropdown options, ever; and the renderer is not a security boundary.)
 */
function assertCustomerType(db: DB, lookupId: number): void {
  const found = db
    .prepare(
      `SELECT 1 FROM lookups WHERE id = ? AND list_key = 'customer_type' AND is_active = 1`
    )
    .pluck()
    .get(lookupId)

  if (found == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose a customer type from the list.',
      `lookup id=${lookupId} is not an active customer_type`
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
 * SQLite says "CHECK constraint failed: customers.credit_limit". A cashier must never see that. This
 * turns what the database says into what a person needs to hear, and keeps the real text for the log.
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
        'The customer type chosen no longer exists. Please pick it again.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That customer could not be saved. Please check the details and try again.',
        technical
      )
    }

    throw new AppError(
      ErrorCode.DB,
      'Something went wrong saving that customer. Please try again.',
      technical
    )
  }
}
