import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { costToPriceMinor } from '@shared/cost'
import type { PagedResult } from '@shared/catalog'
import {
  CommitOpeningInput,
  DeleteOpeningPayableInput,
  DeleteOpeningReceivableInput,
  DeleteOpeningStockLineInput,
  OpeningCashInput,
  OpeningPayableInput,
  OpeningReceivableInput,
  OpeningStockLineInput,
  OpeningStockListInput,
  OPENING_REF_TYPE,
  UpdateOpeningPayableInput,
  UpdateOpeningReceivableInput,
  UpdateOpeningStockLineInput,
  openingBalanceEquityMinor,
  type OpeningPayable,
  type OpeningReceivable,
  type OpeningSetup,
  type OpeningStockLine,
  type OpeningSummary
} from '@shared/opening'
import { ACC } from '../db/chart-of-accounts'
import * as audit from './audit'
import * as catalog from './catalog'
import * as ledger from './ledger'
import * as stock from './stock'

/**
 * THE OPENING SETUP — what the shop ALREADY HAS on the day it starts using this app.
 *
 * Without this, the books believe the shop began life with nothing. The first tin sold — a tin the
 * shop bought last year — shows a 100% profit, because as far as the ledger knows it cost nothing.
 * Every report is wrong from the first day. This is the service that makes the very first report tell
 * the truth.
 *
 * ── THE ACCOUNTING. Get this exactly right; everything else here is plumbing. ────────────────────
 *
 *      opening stock    ->  DR Inventory              CR Opening Balance Equity
 *      opening cash     ->  DR Cash in Hand           CR Opening Balance Equity
 *      opening bank     ->  DR Bank                   CR Opening Balance Equity
 *      customer udhaar  ->  DR Accounts Receivable    CR Opening Balance Equity
 *      supplier dues    ->  DR Opening Balance Equity CR Accounts Payable
 *
 * So Opening Balance Equity is credited with Inventory + Cash + Bank + Receivables − Payables: the
 * shop's day-one net worth. IF THE SHOP OWES MORE THAN IT OWNS, OBE LANDS ON THE DEBIT SIDE, and that
 * is CORRECT — a negative net worth, honestly stated. Nothing here tries to "fix" it.
 *
 * ── WHAT THIS SERVICE DOES NOT REINVENT ─────────────────────────────────────────────────────────
 *
 * `stock.adjust({ type: 'opening' })` ALREADY appends the stock movement, ALREADY posts
 * DR Inventory / CR Opening Balance Equity, and ALREADY seeds the weighted-average cost. Every
 * opening stock line goes through it. There is no second implementation of any of that in this file,
 * because two implementations of one rule is how a stock report and a ledger start disagreeing.
 *
 * ── TWO STATES, AND A DOOR THAT ONLY OPENS ONCE ─────────────────────────────────────────────────
 *
 *   DRAFT      the owner is typing. The opening_* tables are a WORKSHEET — nothing is in the books.
 *              They can come back to it over three evenings with a stock sheet in their hand.
 *
 *   COMMITTED  the journals and the stock movements are IN THE BOOKS, and the worksheet is frozen.
 *
 * A SECOND COMMIT WOULD NOT FAIL LOUDLY. It would succeed — posting the entire opening balance again:
 * double the stock, double the cash, double the equity, with the trial balance still balancing
 * perfectly, because two balanced journals balance. Nothing downstream would ever catch it. `status`
 * is the only thing standing between the shop and that, so it is checked first and it is checked
 * inside the transaction.
 *
 * ── THE FREEZE RULE (owner's decision) ──────────────────────────────────────────────────────────
 *
 * Opening balances are editable until the shop makes its FIRST REAL SALE OR PURCHASE. Then they
 * freeze — see `hasTraded()`. After that, a correction goes through a stock adjustment or a journal
 * correction, which leaves a name and a reason behind it. Silently rewriting an opening figure a month
 * later would retroactively change every profit report the owner has already looked at, and there
 * would be nothing anywhere to say that it had happened.
 *
 * ── SCALES — three of them, and they are NOT interchangeable ────────────────────────────────────
 *
 *      qty_m   thousandths      1 piece = 1000, 1.234 kg = 1234     shared/qty.ts
 *      cost    ten-thousandths  Rs 91.0417  =  910_417   (4 dp)     shared/cost.ts
 *      money   minor units      Rs 91.04    =    9_104   (2 dp)     shared/money.ts
 *
 * A quantity times a cost is neither of those until it is divided back down. That conversion happens
 * in exactly one place — `stock.movementValueCost()` — and crosses into money through
 * `costToPriceMinor()`. Nothing here is ever a float.
 */

// ═════════════════════════════════════════════════════════════════════════════
// THE FREEZE RULE
// ═════════════════════════════════════════════════════════════════════════════

/** Movements that mean the shop has done real business. An `opening` or an `adjustment` does not. */
const TRADING_MOVEMENTS = ['sale', 'purchase', 'sale_return', 'purchase_return'] as const

/** Journals that mean the same thing, for a sale of a non-stocked item that moves no stock at all. */
const TRADING_JOURNALS = ['sale', 'purchase'] as const

/**
 * HAS THE SHOP STARTED TRADING? The moment this turns true, the opening balances freeze.
 *
 * Two questions, because either one alone has a hole in it:
 *
 *   stock_movements   a sale or a purchase MOVED STOCK.
 *   journals          ...or it did not — a service, a bag charge, a non-inventory item still makes a
 *                     sale, and it posts a journal without touching a single stock movement.
 *
 * Checking only the movements would let a shop that has been selling haircuts for a month go back and
 * rewrite the cash it "started" with.
 */
export function hasTraded(db: DB): boolean {
  const movements = db
    .prepare(
      `SELECT 1 FROM stock_movements
        WHERE type IN (${TRADING_MOVEMENTS.map(() => '?').join(', ')})
        LIMIT 1`
    )
    .pluck()
    .get(...TRADING_MOVEMENTS)

  if (movements != null) return true

  const journals = db
    .prepare(
      `SELECT 1 FROM journals
        WHERE ref_type IN (${TRADING_JOURNALS.map(() => '?').join(', ')})
        LIMIT 1`
    )
    .pluck()
    .get(...TRADING_JOURNALS)

  return journals != null
}

/**
 * May the worksheet still be changed? Every draft-editing function in this file asks this FIRST, and
 * `commit()` asks it too — committing is not an exception to the freeze rule, it is the biggest write
 * of all. Posting a backdated opening balance behind a month of real sales would re-seed the average
 * cost of stock those sales were already costed against, and the profit reports the owner has been
 * reading would quietly change underneath them.
 */
function assertNotCommitted(db: DB): void {
  if (readSetup(db).status === 'committed') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'The opening balances have already been saved to the books, so they cannot be changed. To correct a figure, use a stock adjustment or ask the owner to post a correction — that way the change is recorded with a name and a reason against it.',
      'opening_setup.status = committed'
    )
  }
}

/** Editing the WORKSHEET. Frozen once the shop has traded — see the comment above. */
function assertEditable(db: DB): void {
  assertNotCommitted(db)

  if (hasTraded(db)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This shop has already made sales or purchases, so the opening balances are now locked. To correct a figure, use a stock adjustment — that keeps a record of what changed and who changed it.',
      'a sale or purchase already exists: the opening balances are frozen'
    )
  }
}

/**
 * COMMITTING a draft. Deliberately NOT gated on hasTraded().
 *
 * This used to share the guard above, and that was a trap with no way out: a cashier ringing up one
 * sale before the owner had finished pressing Commit would STRAND the shop's opening balances
 * forever. The cash in the till, the money in the bank, the udhaar customers owed and the dues owed
 * to suppliers could then never reach the books AT ALL — the shop would be permanently missing its
 * own starting position, and no screen in the app would let it in.
 *
 * Being unable to EDIT after trading is the safety. Being unable to COMMIT is just a locked door.
 *
 * The journals are dated to the go-live date, which is before those sales, and a backdated stock
 * movement makes stock.record() rebuild the weighted average from history — so the books land in the
 * right period and the averages come out right anyway.
 */
function assertCommittable(db: DB): void {
  assertNotCommitted(db)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SETUP ROW — one, ever
// ═════════════════════════════════════════════════════════════════════════════

type SetupRow = {
  id: number
  status: 'draft' | 'committed'
  go_live_date: string
  opening_cash: number
  opening_bank: number
  committed_at: string | null
  committed_by: number | null
}

/**
 * Read the setup. A shop that has never opened the wizard has NO ROW — and that is an empty draft,
 * not an error. Synthesized rather than inserted, because reading must never write: `getSummary()` has
 * to work under an expired licence, where the app is READ-ONLY (CLAUDE.md §6).
 */
function readSetup(db: DB, now = new Date()): OpeningSetup {
  const row = db.prepare('SELECT * FROM opening_setup WHERE id = 1').get() as SetupRow | undefined

  if (!row) {
    return {
      status: 'draft',
      goLiveDate: isoDate(now),
      openingCash: 0,
      openingBank: 0,
      committedAt: null,
      committedByUserId: null
    }
  }

  return {
    status: row.status,
    goLiveDate: row.go_live_date,
    openingCash: row.opening_cash,
    openingBank: row.opening_bank,
    committedAt: row.committed_at,
    committedByUserId: row.committed_by
  }
}

/** Create row 1 if the wizard has never been saved. Called by WRITES only. */
function ensureSetup(db: DB, now: Date): void {
  db.prepare(
    `INSERT INTO opening_setup (id, status, go_live_date, opening_cash, opening_bank, created_at, updated_at)
     VALUES (1, 'draft', @goLiveDate, 0, 0, @at, @at)
     ON CONFLICT (id) DO NOTHING`
  ).run({ goLiveDate: isoDate(now), at: now.toISOString() })
}

export function getSetup(db: DB): OpeningSetup {
  return readSetup(db)
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP: CASH IN THE TILL, MONEY IN THE BANK, AND THE GO-LIVE DATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Save the till, the bank, and the date the opening balances are AS AT.
 *
 * ONLY THE FIELDS ACTUALLY SENT ARE WRITTEN. (CLAUDE.md trap #18.) The wizard saves each step as the
 * owner finishes it, and a step that never loaded the bank balance must not post `openingBank: 0` back
 * and wipe it.
 */
export function setCashAndBank(db: DB, actor: User, raw: unknown, now = new Date()): OpeningSetup {
  const input = parseOrThrow(OpeningCashInput, raw, 'opening.setCashAndBank')

  const run = db.transaction((): OpeningSetup => {
    assertEditable(db)
    ensureSetup(db, now)

    const columns: Record<string, string> = {
      goLiveDate: 'go_live_date',
      openingCash: 'opening_cash',
      openingBank: 'opening_bank'
    }

    const touched = Object.keys(columns).filter((key) => key in input)
    const sets = touched.map((key) => `${columns[key]} = @${key}`)
    const params: Record<string, unknown> = { at: now.toISOString() }
    for (const key of touched) params[key] = (input as Record<string, unknown>)[key]

    guard(
      () =>
        db
          .prepare(`UPDATE opening_setup SET ${sets.join(', ')}, updated_at = @at WHERE id = 1`)
          .run(params),
      'opening.setCashAndBank'
    )

    return readSetup(db)
  })

  return run()
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP: THE STOCK SHEET
// ═════════════════════════════════════════════════════════════════════════════

type StockLineRow = {
  id: number
  product_id: number
  qty_m: number
  unit_cost: number
  batch_no: string | null
  expiry_date: string | null
  sku?: string
  name?: string
}

function toStockLine(row: StockLineRow): OpeningStockLine {
  const line: OpeningStockLine = {
    id: row.id,
    productId: row.product_id,
    qtyM: row.qty_m,
    unitCost: row.unit_cost,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    // qty x cost -> 2-dp money. EXACTLY the figure this line will debit Inventory with at commit,
    // rounded EXACTLY as stock.adjust() will round it. See lineValueMinor().
    lineValueMinor: lineValueMinor(row.qty_m, row.unit_cost)
  }
  if (row.sku != null) line.productSku = row.sku
  if (row.name != null) line.productName = row.name
  return line
}

/**
 * What ONE opening stock line is worth, in 2-dp money.
 *
 * THE ROUNDING HAPPENS PER LINE, and that is not a detail. `stock.adjust()` values each line on its
 * own and debits Inventory with that rounded figure. If the review screen instead summed the raw cost
 * values and rounded ONCE at the end, it could promise the owner a total that is a paisa away from
 * what the journal actually posts — a review screen that lies about the thing it exists to review.
 * One function, used by both the summary and (through stock.adjust) the posting. They cannot drift.
 */
function lineValueMinor(qtyM: number, unitCost: number): number {
  return costToPriceMinor(stock.movementValueCost(qtyM, unitCost))
}

/**
 * Add a line to the stock sheet. INSERT ONLY — editing goes through `updateStockLine()`, which is a
 * different schema and a different write, because on an EDIT an absent field means "leave it alone"
 * while on an ADD it means "there isn't one". Collapsing the two into one "save" is what made a
 * quantity correction quietly zero the cost. (CLAUDE.md trap #18.)
 *
 * BATCHES ARE OPTIONAL (owner's decision). One line per item; a batch number is only OFFERED for a
 * product flagged `track_batches`, and even then it is not forced. The owner is never made to invent a
 * batch number for a tin of beans.
 */
export function addStockLine(db: DB, actor: User, raw: unknown, now = new Date()): OpeningStockLine {
  const input = parseOrThrow(OpeningStockLineInput, raw, 'opening.addStockLine')

  const run = db.transaction((): OpeningStockLine => {
    assertEditable(db)
    ensureSetup(db, now)

    const batchNo = input.batchNo ?? null
    const expiryDate = input.expiryDate ?? null

    assertLineIsPossible(db, input.productId, batchNo, expiryDate)
    assertNoDuplicateLine(db, input.productId, batchNo, null)

    const at = now.toISOString()

    const id = guard(
      () =>
        Number(
          db
            .prepare(
              `INSERT INTO opening_stock_lines
                 (product_id, qty_m, unit_cost, batch_no, expiry_date, created_at, updated_at)
               VALUES (@productId, @qtyM, @unitCost, @batchNo, @expiryDate, @at, @at)`
            )
            .run({
              productId: input.productId,
              qtyM: input.qtyM,
              // .default(0) is CORRECT here and only here: a line added with no cost is a free sample.
              unitCost: input.unitCost,
              batchNo,
              expiryDate,
              at
            }).lastInsertRowid
        ),
      'opening.addStockLine'
    )

    return getStockLine(db, id)
  })

  return run()
}

/** Editable field -> its column. The whitelist IS the contract; nothing outside it can be written. */
const UPDATABLE_STOCK_LINE: Record<string, string> = {
  productId: 'product_id',
  qtyM: 'qty_m',
  unitCost: 'unit_cost',
  batchNo: 'batch_no',
  expiryDate: 'expiry_date'
}

/**
 * Edit a line already on the stock sheet.
 *
 * THIS WRITES ONLY THE KEYS THAT ARE ACTUALLY PRESENT ON THE INPUT. (CLAUDE.md trap #18, and
 * `UpdateOpeningStockLineInput` in shared/opening.ts, which is a different schema from the ADD for
 * exactly this reason.)
 *
 *   key absent  ->  the form never loaded this field. LEAVE THE COLUMN ALONE.
 *   key = null  ->  the user cleared it. Write NULL.
 *
 * Writing every column back instead meant a caller that corrected only the quantity silently reset
 * the cost to zero — and a zero cost seeds the product's weighted average at zero, which makes every
 * later sale of that item report a 100% profit. Regression-tested.
 *
 * The row is MERGED with what is already there before the batch rules are checked, because "is this
 * batch number allowed?" depends on the product — and on an edit the product may not have been sent.
 */
export function updateStockLine(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): OpeningStockLine {
  const input = parseOrThrow(UpdateOpeningStockLineInput, raw, 'opening.updateStockLine')

  const run = db.transaction((): OpeningStockLine => {
    assertEditable(db)

    const before = getStockLine(db, input.id)

    // Absent means "leave it alone" — so validate the row AS IT WILL BE, not as it was sent.
    const productId = 'productId' in input ? input.productId! : before.productId
    const batchNo = 'batchNo' in input ? (input.batchNo ?? null) : before.batchNo
    const expiryDate = 'expiryDate' in input ? (input.expiryDate ?? null) : before.expiryDate

    assertLineIsPossible(db, productId, batchNo, expiryDate)
    assertNoDuplicateLine(db, productId, batchNo, input.id)

    const touched = Object.keys(UPDATABLE_STOCK_LINE).filter((key) => key in input)
    if (touched.length === 0) return before

    const sets = touched.map((key) => `${UPDATABLE_STOCK_LINE[key]} = @${key}`)
    const params: Record<string, unknown> = { id: input.id, at: now.toISOString() }
    // `?? null`, not `||` — a unitCost of 0 is a real, deliberate value (a free sample).
    for (const key of touched) params[key] = (input as Record<string, unknown>)[key] ?? null

    guard(
      () =>
        db
          .prepare(
            `UPDATE opening_stock_lines SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`
          )
          .run(params),
      'opening.updateStockLine'
    )

    return getStockLine(db, input.id)
  })

  return run()
}

/** Take a line off the stock sheet. Nothing has been posted yet — this is a worksheet, not the books. */
export function removeStockLine(db: DB, actor: User, raw: unknown): void {
  const { id } = parseOrThrow(DeleteOpeningStockLineInput, coerceId(raw), 'opening.removeStockLine')

  db.transaction(() => {
    assertEditable(db)
    const changed = db.prepare('DELETE FROM opening_stock_lines WHERE id = ?').run(id).changes
    if (changed === 0) throw noSuchLine(id)
  })()
}

export function getStockLine(db: DB, id: number): OpeningStockLine {
  const row = db
    .prepare(
      `SELECT l.*, p.sku AS sku, p.name AS name
         FROM opening_stock_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.id = ?`
    )
    .get(id) as StockLineRow | undefined

  if (!row) throw noSuchLine(id)
  return toStockLine(row)
}

/** The stock sheet, paginated — a shop may open with thousands of lines. (CLAUDE.md §4) */
export function listStockLines(db: DB, raw: unknown = {}): PagedResult<OpeningStockLine> {
  const input = parseOrThrow(OpeningStockListInput, raw, 'opening.listStockLines')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.search) {
    where.push(`(p.sku LIKE @like ESCAPE '\\' OR p.name LIKE @like ESCAPE '\\')`)
    params['like'] = `%${escapeLike(input.search)}%`
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(
      `SELECT COUNT(*) FROM opening_stock_lines l JOIN products p ON p.id = l.product_id ${whereSql}`
    )
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT l.*, p.sku AS sku, p.name AS name
         FROM opening_stock_lines l
         JOIN products p ON p.id = l.product_id
         ${whereSql}
        ORDER BY p.name, l.id
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as StockLineRow[]

  return { total, page, pageSize, rows: rows.map(toStockLine) }
}

/**
 * Can this line exist AT ALL? Asked when the owner types it — not at commit time, three evenings
 * later, when they have long since forgotten which item it was.
 */
function assertLineIsPossible(
  db: DB,
  productId: number,
  batchNo: string | null,
  expiryDate: string | null
): void {
  const product = db
    .prepare('SELECT id, name, item_type, track_batches FROM products WHERE id = ?')
    .get(productId) as
    | { id: number; name: string; item_type: string; track_batches: number }
    | undefined

  if (!product) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }

  // A service or a bag charge has no stock and can never appear on a stock report. An opening quantity
  // of one would be a balance nobody will ever see and nobody can ever sell.
  if (product.item_type !== 'inventory') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not a stocked item, so it cannot have an opening quantity.`,
      `opening stock line on item_type=${product.item_type} product ${productId}`
    )
  }

  if (!product.track_batches && batchNo != null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not set up for batch tracking, so it does not need a batch number. Turn on batch tracking for this item first, or leave the batch blank.`,
      `batch_no on product ${productId} with track_batches = 0`
    )
  }

  // An expiry date has to belong to a BATCH — that is the row that carries it, and the near-expiry
  // report reads it from there. An expiry with no batch number has nowhere to live.
  if (expiryDate != null && batchNo == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Please enter a batch number for "${product.name}" as well as the expiry date.`,
      `expiry_date without batch_no on product ${productId}`
    )
  }
}

/**
 * THE DOUBLE-ENTRY MISTAKE THAT COSTS REAL MONEY, caught in plain language.
 *
 * The database refuses it too (migration 0005's partial unique index), but a cashier must never meet
 * "UNIQUE constraint failed: opening_stock_lines.product_id". The owner keys "Cooking Oil, 40" on
 * Monday, forgets, keys it again on Tuesday — and without this the shop opens with 80 litres it does
 * not have and a doubled Inventory debit that balances perfectly.
 */
function assertNoDuplicateLine(
  db: DB,
  productId: number,
  batchNo: string | null,
  selfId: number | null
): void {
  const existing = db
    .prepare(
      `SELECT l.id, p.name AS name
         FROM opening_stock_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.product_id = ?
          AND (l.batch_no IS ?)
          AND l.id IS NOT ?`
    )
    .get(productId, batchNo, selfId) as { id: number; name: string } | undefined

  if (!existing) return

  throw new AppError(
    ErrorCode.VALIDATION,
    batchNo == null
      ? `"${existing.name}" is already on the opening stock list. Change that line instead of adding it again.`
      : `Batch ${batchNo} of "${existing.name}" is already on the opening stock list. Change that line instead of adding it again.`,
    `duplicate opening stock line: product=${productId} batch_no=${batchNo ?? 'NULL'} clashes with line ${existing.id}`
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP: CUSTOMER UDHAAR (receivables) and SUPPLIER DUES (payables)
// ═════════════════════════════════════════════════════════════════════════════

type ReceivableRow = {
  id: number
  customer_id: number
  amount: number
  note: string | null
  customer_name?: string
}

type PayableRow = {
  id: number
  supplier_id: number
  amount: number
  note: string | null
  supplier_name?: string
}

function toReceivable(row: ReceivableRow): OpeningReceivable {
  const receivable: OpeningReceivable = {
    id: row.id,
    customerId: row.customer_id,
    amount: row.amount,
    note: row.note
  }
  if (row.customer_name != null) receivable.customerName = row.customer_name
  return receivable
}

function toPayable(row: PayableRow): OpeningPayable {
  const payable: OpeningPayable = {
    id: row.id,
    supplierId: row.supplier_id,
    amount: row.amount,
    note: row.note
  }
  if (row.supplier_name != null) payable.supplierName = row.supplier_name
  return payable
}

/**
 * What a customer already owes the shop. ONE ROW PER CUSTOMER — an opening figure is a balance
 * ("Rashid owes 12,400"), not the invoices behind it. Those invoices predate the app, and inventing
 * them would be inventing data.
 *
 * INSERT ONLY. Editing goes through `updateReceivable()`. (See addStockLine — same rule, trap #18.)
 */
export function addReceivable(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): OpeningReceivable {
  const input = parseOrThrow(OpeningReceivableInput, raw, 'opening.addReceivable')

  const run = db.transaction((): OpeningReceivable => {
    assertEditable(db)
    ensureSetup(db, now)

    assertCustomerExists(db, input.customerId)
    assertNoDuplicateParty(db, 'receivable', input.customerId, null)

    const id = guard(
      () =>
        Number(
          db
            .prepare(
              `INSERT INTO opening_receivables (customer_id, amount, note, created_at)
               VALUES (@customerId, @amount, @note, @at)`
            )
            .run({
              customerId: input.customerId,
              amount: input.amount,
              note: input.note ?? null,
              at: now.toISOString()
            }).lastInsertRowid
        ),
      'opening.addReceivable'
    )

    return getReceivable(db, id)
  })

  return run()
}

const UPDATABLE_RECEIVABLE: Record<string, string> = {
  customerId: 'customer_id',
  amount: 'amount',
  note: 'note'
}

/**
 * Edit an udhaar row. ONLY THE KEYS ACTUALLY SENT ARE WRITTEN (trap #18) — a dialog that corrects the
 * amount must not wipe the note saying which page of the old paper ledger the figure came off.
 */
export function updateReceivable(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): OpeningReceivable {
  const input = parseOrThrow(UpdateOpeningReceivableInput, raw, 'opening.updateReceivable')

  const run = db.transaction((): OpeningReceivable => {
    assertEditable(db)

    const before = getReceivable(db, input.id)
    const customerId = 'customerId' in input ? input.customerId! : before.customerId

    assertCustomerExists(db, customerId)
    assertNoDuplicateParty(db, 'receivable', customerId, input.id)

    const touched = Object.keys(UPDATABLE_RECEIVABLE).filter((key) => key in input)
    if (touched.length === 0) return before

    const sets = touched.map((key) => `${UPDATABLE_RECEIVABLE[key]} = @${key}`)
    const params: Record<string, unknown> = { id: input.id }
    for (const key of touched) params[key] = (input as Record<string, unknown>)[key] ?? null

    guard(
      () =>
        db.prepare(`UPDATE opening_receivables SET ${sets.join(', ')} WHERE id = @id`).run(params),
      'opening.updateReceivable'
    )

    return getReceivable(db, input.id)
  })

  return run()
}

export function removeReceivable(db: DB, actor: User, raw: unknown): void {
  const { id } = parseOrThrow(DeleteOpeningReceivableInput, coerceId(raw), 'opening.removeReceivable')

  db.transaction(() => {
    assertEditable(db)
    const changed = db.prepare('DELETE FROM opening_receivables WHERE id = ?').run(id).changes
    if (changed === 0) throw noSuchRow('udhaar', id)
  })()
}

export function getReceivable(db: DB, id: number): OpeningReceivable {
  const row = db
    .prepare(
      `SELECT r.*, c.name AS customer_name
         FROM opening_receivables r
         JOIN customers c ON c.id = r.customer_id
        WHERE r.id = ?`
    )
    .get(id) as ReceivableRow | undefined

  if (!row) throw noSuchRow('udhaar', id)
  return toReceivable(row)
}

export type PartyListArgs = { page?: number | undefined; pageSize?: number | undefined }

/** Paginated — CLAUDE.md §4 says every list is, and a wholesaler's opening udhaar list is long. */
export function listReceivables(db: DB, input: PartyListArgs = {}): PagedResult<OpeningReceivable> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const total = db.prepare('SELECT COUNT(*) FROM opening_receivables').pluck().get() as number

  const rows = db
    .prepare(
      `SELECT r.*, c.name AS customer_name
         FROM opening_receivables r
         JOIN customers c ON c.id = r.customer_id
        ORDER BY c.name, r.id
        LIMIT @limit OFFSET @offset`
    )
    .all({ limit: pageSize, offset: (page - 1) * pageSize }) as ReceivableRow[]

  return { total, page, pageSize, rows: rows.map(toReceivable) }
}

/**
 * What the shop already owes a supplier. ONE ROW PER SUPPLIER, for the same reason.
 * INSERT ONLY — editing goes through `updatePayable()`. (Trap #18.)
 */
export function addPayable(db: DB, actor: User, raw: unknown, now = new Date()): OpeningPayable {
  const input = parseOrThrow(OpeningPayableInput, raw, 'opening.addPayable')

  const run = db.transaction((): OpeningPayable => {
    assertEditable(db)
    ensureSetup(db, now)

    assertSupplierExists(db, input.supplierId)
    assertNoDuplicateParty(db, 'payable', input.supplierId, null)

    const id = guard(
      () =>
        Number(
          db
            .prepare(
              `INSERT INTO opening_payables (supplier_id, amount, note, created_at)
               VALUES (@supplierId, @amount, @note, @at)`
            )
            .run({
              supplierId: input.supplierId,
              amount: input.amount,
              note: input.note ?? null,
              at: now.toISOString()
            }).lastInsertRowid
        ),
      'opening.addPayable'
    )

    return getPayable(db, id)
  })

  return run()
}

const UPDATABLE_PAYABLE: Record<string, string> = {
  supplierId: 'supplier_id',
  amount: 'amount',
  note: 'note'
}

/** Edit a supplier due. Only the keys actually sent are written. (Trap #18 — same rule, same reason.) */
export function updatePayable(db: DB, actor: User, raw: unknown, now = new Date()): OpeningPayable {
  const input = parseOrThrow(UpdateOpeningPayableInput, raw, 'opening.updatePayable')

  const run = db.transaction((): OpeningPayable => {
    assertEditable(db)

    const before = getPayable(db, input.id)
    const supplierId = 'supplierId' in input ? input.supplierId! : before.supplierId

    assertSupplierExists(db, supplierId)
    assertNoDuplicateParty(db, 'payable', supplierId, input.id)

    const touched = Object.keys(UPDATABLE_PAYABLE).filter((key) => key in input)
    if (touched.length === 0) return before

    const sets = touched.map((key) => `${UPDATABLE_PAYABLE[key]} = @${key}`)
    const params: Record<string, unknown> = { id: input.id }
    for (const key of touched) params[key] = (input as Record<string, unknown>)[key] ?? null

    guard(
      () => db.prepare(`UPDATE opening_payables SET ${sets.join(', ')} WHERE id = @id`).run(params),
      'opening.updatePayable'
    )

    return getPayable(db, input.id)
  })

  return run()
}

export function removePayable(db: DB, actor: User, raw: unknown): void {
  const { id } = parseOrThrow(DeleteOpeningPayableInput, coerceId(raw), 'opening.removePayable')

  db.transaction(() => {
    assertEditable(db)
    const changed = db.prepare('DELETE FROM opening_payables WHERE id = ?').run(id).changes
    if (changed === 0) throw noSuchRow('supplier due', id)
  })()
}

export function getPayable(db: DB, id: number): OpeningPayable {
  const row = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name
         FROM opening_payables p
         JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.id = ?`
    )
    .get(id) as PayableRow | undefined

  if (!row) throw noSuchRow('supplier due', id)
  return toPayable(row)
}

export function listPayables(db: DB, input: PartyListArgs = {}): PagedResult<OpeningPayable> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const total = db.prepare('SELECT COUNT(*) FROM opening_payables').pluck().get() as number

  const rows = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name
         FROM opening_payables p
         JOIN suppliers s ON s.id = p.supplier_id
        ORDER BY s.name, p.id
        LIMIT @limit OFFSET @offset`
    )
    .all({ limit: pageSize, offset: (page - 1) * pageSize }) as PayableRow[]

  return { total, page, pageSize, rows: rows.map(toPayable) }
}

function assertCustomerExists(db: DB, customerId: number): void {
  const found = db.prepare('SELECT 1 FROM customers WHERE id = ?').pluck().get(customerId)
  if (found == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That customer could not be found. Please add them first.',
      `customer id=${customerId} does not exist`
    )
  }
}

function assertSupplierExists(db: DB, supplierId: number): void {
  const found = db.prepare('SELECT 1 FROM suppliers WHERE id = ?').pluck().get(supplierId)
  if (found == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That supplier could not be found. Please add them first.',
      `supplier id=${supplierId} does not exist`
    )
  }
}

/**
 * One opening balance per party. Two rows for Rashid would double what he owes — and he would be
 * chased for money he never borrowed. The database refuses it (UNIQUE); this says so in words.
 */
function assertNoDuplicateParty(
  db: DB,
  kind: 'receivable' | 'payable',
  partyId: number,
  selfId: number | null
): void {
  const sql =
    kind === 'receivable'
      ? `SELECT r.id, c.name AS name FROM opening_receivables r
           JOIN customers c ON c.id = r.customer_id
          WHERE r.customer_id = ? AND r.id IS NOT ?`
      : `SELECT p.id, s.name AS name FROM opening_payables p
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.supplier_id = ? AND p.id IS NOT ?`

  const existing = db.prepare(sql).get(partyId, selfId) as { id: number; name: string } | undefined
  if (!existing) return

  throw new AppError(
    ErrorCode.VALIDATION,
    kind === 'receivable'
      ? `An opening amount for "${existing.name}" has already been entered. Change that line instead of adding it again.`
      : `An opening amount owed to "${existing.name}" has already been entered. Change that line instead of adding it again.`,
    `duplicate opening ${kind} for party ${partyId} (clashes with row ${existing.id})`
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// THE REVIEW SCREEN
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Everything the wizard's review step shows, and exactly what `commit()` will post — the two read the
 * same figures out of the same tables through the same arithmetic, and the balancing figure comes from
 * `openingBalanceEquityMinor()` in shared/opening.ts, which both of them import. There is no second
 * copy of the identity for the two to disagree about.
 *
 * A READ. It writes nothing, so it works under an expired licence (CLAUDE.md §6: after expiry the app
 * is READ-ONLY, and the owner can still see and export everything).
 */
export function getSummary(db: DB, now = new Date()): OpeningSummary {
  const setup = readSetup(db, now)

  const stockLines = db
    .prepare('SELECT qty_m, unit_cost FROM opening_stock_lines')
    .all() as Array<{ qty_m: number; unit_cost: number }>

  // Summed PER LINE, each rounded on its own — because that is how stock.adjust() will post them.
  // Rounding the total instead would show the owner a figure the journal does not use.
  const stockValueMinor = stockLines.reduce(
    (total, line) => total + lineValueMinor(line.qty_m, line.unit_cost),
    0
  )

  const receivablesMinor =
    (db.prepare('SELECT COALESCE(SUM(amount), 0) FROM opening_receivables').pluck().get() as number)

  const payablesMinor =
    (db.prepare('SELECT COALESCE(SUM(amount), 0) FROM opening_payables').pluck().get() as number)

  const counts = {
    stockLines: stockLines.length,
    receivables: db.prepare('SELECT COUNT(*) FROM opening_receivables').pluck().get() as number,
    payables: db.prepare('SELECT COUNT(*) FROM opening_payables').pluck().get() as number
  }

  return {
    status: setup.status,
    goLiveDate: setup.goLiveDate,
    stockValueMinor,
    openingCashMinor: setup.openingCash,
    openingBankMinor: setup.openingBank,
    receivablesMinor,
    payablesMinor,
    openingBalanceEquityMinor: openingBalanceEquityMinor({
      stockValueMinor,
      openingCashMinor: setup.openingCash,
      openingBankMinor: setup.openingBank,
      receivablesMinor,
      payablesMinor
    }),
    counts,
    committedAt: setup.committedAt,
    committedByUserId: setup.committedByUserId
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMIT — the one-way door
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST THE OPENING BALANCES. Everything, in ONE transaction — or nothing.
 *
 *   1. every stock line  -> stock.adjust({ type: 'opening' }), which appends the movement, posts
 *                           DR Inventory / CR Opening Balance Equity, and seeds the weighted average.
 *                           A line with a batch number gets its batch created (or matched) first.
 *   2. ONE journal       -> cash, bank, udhaar and supplier dues, against Opening Balance Equity.
 *   3. status            -> 'committed', with who and when.
 *   4. audit_log         -> the whole day-one balance sheet, frozen, with a name against it.
 *
 * If ANY line fails — a product deleted since it was typed, a locked period, a batch clash — the whole
 * thing rolls back and the shop still has its draft. A half-posted opening balance would be an
 * inventory that does not match the ledger, and there would be no way to tell which half was real.
 *
 * REFUSED TWICE OVER: once because `status` is already 'committed', and once because the shop has
 * started trading (see assertEditable, and the freeze rule in the header).
 *
 * `confirm` is the wizard's deliberate click. It defaults to true so that a script or a test can call
 * `commit(db, actor)` — the REAL guard against a double commit is `status`, and it does not depend on
 * anyone remembering to pass a flag.
 */
export function commit(
  db: DB,
  actor: User,
  raw: unknown = { confirm: true },
  now = new Date()
): OpeningSummary {
  parseOrThrow(CommitOpeningInput, raw, 'opening.commit')

  const run = db.transaction((): OpeningSummary => {
    // Inside the transaction, and FIRST. Two owners clicking Save at the same moment is not the
    // scenario this defends against — a retry, a double-click and a re-sent IPC message all are.
    //
    // assertCommittable, NOT assertEditable: a sale rung up before the owner finished pressing
    // Commit must not strand the shop's opening balances forever. See assertCommittable.
    assertCommittable(db)
    ensureSetup(db, now)

    const setup = readSetup(db, now)
    const summary = getSummary(db, now)

    // The journals and the movements are dated to the day the balances are AS AT — not to the evening
    // the owner happened to finish typing them.
    //
    // LOCAL NOON, not midnight. ledger.post() reads the accounting period from at.getFullYear() /
    // at.getMonth() (LOCAL), while the row stores at.toISOString() (UTC). Midnight local would land on
    // the previous calendar day in UTC for any shop east of Greenwich — Pakistan included — so an
    // opening balance dated the 1st would be filed under the 30th. Noon is far enough from both edges
    // that no real timezone can push it across a date line.
    const at = new Date(`${setup.goLiveDate}T12:00:00`)

    if (Number.isNaN(at.getTime())) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Please pick the date these opening balances are as at.',
        `unparseable go_live_date "${setup.goLiveDate}"`
      )
    }

    // ── 1. The stock. stock.adjust() does the movement, the journal AND the weighted average. ──
    const lines = db
      .prepare('SELECT * FROM opening_stock_lines ORDER BY id')
      .all() as StockLineRow[]

    // Resolve the reason code ONLY if there is stock to post. A shop that opens with no stock at all
    // — a service business, or one that simply has an empty shelf on day one — must still be able to
    // record its cash and its debts. Demanding a stock-adjustment reason from a shop with no stock
    // would lock it out of its own books over a list it never needed.
    const reasonCode = lines.length > 0 ? openingReasonCode(db) : ''

    for (const line of lines) {
      const batchId = resolveBatchId(db, line, at)

      stock.adjust(
        db,
        actor,
        {
          productId: line.product_id,
          type: 'opening',
          qtyM: line.qty_m,
          unitCost: line.unit_cost,
          batchId,
          reasonCode,
          note: 'Opening stock'
        },
        at
      )
    }

    // ── 2. Cash, bank, udhaar and dues — ONE balanced journal. ──
    postMoneyJournal(db, actor, summary, at)

    // ── 3. The door closes. ──
    db.prepare(
      `UPDATE opening_setup
          SET status = 'committed', committed_at = @at, committed_by = @userId, updated_at = @at
        WHERE id = 1`
    ).run({ at: now.toISOString(), userId: actor.id })

    // ── 4. WHO opened this shop's books, WHEN, and with what figures. (CLAUDE.md §4) ──
    audit.record(
      db,
      actor,
      {
        action: 'opening.commit',
        entity: 'opening_setup',
        entityId: 1,
        after: {
          goLiveDate: summary.goLiveDate,
          stockValueMinor: summary.stockValueMinor,
          openingCashMinor: summary.openingCashMinor,
          openingBankMinor: summary.openingBankMinor,
          receivablesMinor: summary.receivablesMinor,
          payablesMinor: summary.payablesMinor,
          openingBalanceEquityMinor: summary.openingBalanceEquityMinor,
          counts: summary.counts
        }
      },
      now
    )

    return getSummary(db, now)
  })

  return run()
}

/**
 * THE MONEY LEGS — cash, bank, udhaar and supplier dues, in ONE journal:
 *
 *      DR Cash in Hand            (the till)
 *      DR Bank                    (the account)
 *      DR Accounts Receivable     (what customers owe the shop)
 *                CR Accounts Payable          (what the shop owes suppliers)
 *                CR Opening Balance Equity    (the balancing figure — or a DEBIT, see below)
 *
 * The Receivable and Payable legs are AGGREGATED into one line each. `journal_lines` carries no party
 * column, so a line per customer would be N indistinguishable rows against the same account — noise in
 * the general ledger, and no more informative than their total. The per-party detail is kept where it
 * can actually be read: the `opening_receivables` / `opening_payables` worksheet, which migration 0005
 * retains for exactly this purpose (and which Phase 7's customer ledger will open on).
 *
 * OBE = Cash + Bank + Receivables − Payables. Note what is NOT in that sum: the stock. Each stock
 * line posted its OWN credit to Opening Balance Equity through stock.adjust(). Adding it here as well
 * would credit the shop's stock to equity TWICE — and the trial balance would still balance.
 *
 * If OBE comes out NEGATIVE the shop owes more than it owns, and the line flips to the DEBIT side.
 * That is correct, and it is tested.
 *
 * Nothing is posted when every figure is zero: a brand-new shop with an empty till is not an
 * accounting event, and ledger.post() rightly refuses a journal with fewer than two lines.
 */
function postMoneyJournal(db: DB, actor: User, summary: OpeningSummary, at: Date): number | null {
  const cash = summary.openingCashMinor
  const bank = summary.openingBankMinor
  const receivables = summary.receivablesMinor
  const payables = summary.payablesMinor

  if (cash === 0 && bank === 0 && receivables === 0 && payables === 0) return null

  const equity = openingBalanceEquityMinor({
    stockValueMinor: 0, // the stock's equity leg is posted by stock.adjust(), line by line. See above.
    openingCashMinor: cash,
    openingBankMinor: bank,
    receivablesMinor: receivables,
    payablesMinor: payables
  })

  const lines: ledger.JournalLineInput[] = []

  if (cash > 0) lines.push({ account: ACC.CASH, debit: cash })
  if (bank > 0) lines.push({ account: ACC.BANK, debit: bank })
  if (receivables > 0) lines.push({ account: ACC.RECEIVABLE, debit: receivables })
  if (payables > 0) lines.push({ account: ACC.PAYABLE, credit: payables })

  // Exactly zero net worth needs no equity line — and it still balances, because the debits above
  // already equal the credits above.
  if (equity > 0) lines.push({ account: ACC.OPENING_BALANCE_EQUITY, credit: equity })
  if (equity < 0) lines.push({ account: ACC.OPENING_BALANCE_EQUITY, debit: -equity })

  return ledger.post(db, {
    at,
    refType: OPENING_REF_TYPE,
    refId: 1,
    memo: `Opening balances as at ${summary.goLiveDate}`,
    userId: actor.id,
    lines
  })
}

/**
 * A batched line needs a real batch row to hang off — that is what carries the expiry date, and what
 * the near-expiry report and FEFO both read.
 *
 * If the owner has ALREADY created that batch on the product screen, we attach to it rather than
 * failing. We do NOT overwrite its expiry or its cost: they typed those on purpose, on a screen that
 * exists to say what a batch is, and quietly rewriting them from the stock sheet is precisely the kind
 * of silent overwrite this codebase does not do.
 */
function resolveBatchId(db: DB, line: StockLineRow, at: Date): number | null {
  if (line.batch_no == null) return null

  const existing = db
    .prepare('SELECT id FROM batches WHERE product_id = ? AND batch_no = ?')
    .pluck()
    .get(line.product_id, line.batch_no) as number | undefined

  if (existing != null) {
    // The batch already exists — the owner created it on the product screen before typing the
    // opening line. It was created with NO cost (there was nothing to cost it at), and the opening
    // line is the first and only thing that ever knows what that batch was worth. Backfill it.
    //
    // Left at 0, the batch valuation report would price this batch at nothing forever, while the GL
    // and the product's average cost both knew better — a third number disagreeing with the other two.
    const current = db
      .prepare('SELECT cost FROM batches WHERE id = ?')
      .pluck()
      .get(existing) as number | undefined

    if ((current ?? 0) === 0 && line.unit_cost > 0) {
      db.prepare('UPDATE batches SET cost = ? WHERE id = ?').run(line.unit_cost, existing)
    }

    return existing
  }

  // catalog.addBatch refuses a batch on a product that is not flagged track_batches — the same rule
  // assertLineIsPossible() applied when the line was typed. Checked twice, deliberately: the flag can
  // be turned off on the product screen in between.
  return catalog.addBatch(
    db,
    {
      productId: line.product_id,
      batchNo: line.batch_no,
      expiryDate: line.expiry_date,
      cost: line.unit_cost
    },
    at
  ).id
}

/**
 * The reason code frozen onto every opening stock movement.
 *
 * `stock.adjust()` demands a reason from the owner's OWN `adjustment_reason` list, and will not accept
 * a string this file invented (CLAUDE.md §4: no hardcoded dropdown options, ever). 'data_entry' —
 * "Data entry correction" — is the seeded code and is what an opening balance is.
 *
 * If the owner has renamed or retired it, we fall back to whatever IS on their list rather than
 * blocking them from opening their books over a list edit. Only if the list is completely empty do we
 * stop, and then we say what to do about it.
 */
function openingReasonCode(db: DB): string {
  const preferred = db
    .prepare(
      `SELECT code FROM lookups
        WHERE list_key = 'adjustment_reason' AND code = 'data_entry' AND is_active = 1`
    )
    .pluck()
    .get() as string | undefined

  if (preferred != null) return preferred

  const fallback = db
    .prepare(
      `SELECT code FROM lookups
        WHERE list_key = 'adjustment_reason' AND is_active = 1
        ORDER BY sort_order, id
        LIMIT 1`
    )
    .pluck()
    .get() as string | undefined

  if (fallback != null) return fallback

  throw new AppError(
    ErrorCode.VALIDATION,
    'Please add at least one stock adjustment reason under Settings → Manage Lists before saving the opening balances.',
    'lookups(adjustment_reason) is empty — stock.adjust() requires a reason code'
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

/** ISO date (YYYY-MM-DD) in LOCAL terms — the shop's day, not Greenwich's. */
function isoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** `remove(db, actor, 7)` and `remove(db, actor, { id: 7 })` both mean the same thing. */
function coerceId(raw: unknown): unknown {
  return typeof raw === 'number' ? { id: raw } : raw
}

function noSuchLine(id: number): AppError {
  return new AppError(
    ErrorCode.NOT_FOUND,
    'That opening stock line could not be found. It may have already been removed.',
    `opening_stock_lines id=${id} does not exist`
  )
}

function noSuchRow(what: string, id: number): AppError {
  return new AppError(
    ErrorCode.NOT_FOUND,
    `That opening ${what} could not be found. It may have already been removed.`,
    `opening ${what} id=${id} does not exist`
  )
}

/** `%` and `_` are wildcards in LIKE. Somebody searching for "50%" means the characters. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
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

/**
 * SQLite says "UNIQUE constraint failed: opening_stock_lines.product_id". A cashier must never see
 * that. The friendly checks above catch these first; this is the net under them.
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
        'One of the items or people on this line no longer exists. Please pick it again.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That has already been entered on the opening list. Change the existing line instead of adding it again.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That could not be saved. Please check the figures and try again.',
        technical
      )
    }

    throw new AppError(
      ErrorCode.DB,
      'Something went wrong saving the opening balances. Please try again.',
      technical
    )
  }
}
