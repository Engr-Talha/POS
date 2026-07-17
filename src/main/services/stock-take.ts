import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import {
  AddStockTakeLinesInput,
  ApplyStockTakeInput,
  CancelStockTakeInput,
  CreateStockTakeInput,
  ListStockTakesInput,
  RemoveStockTakeLineInput,
  SetCountInput,
  StockTakeIdInput,
  type ApplyStockTakeResult,
  type PagedResult,
  type StockTakeDetail,
  type StockTakeLineRow,
  type StockTakeRow,
  type StockTakeStatus
} from '@shared/stock-take'
import * as stock from './stock'
import * as audit from './audit'

/**
 * THE STOCK TAKE — the counting sheet. (Migration 0019, whose header is the spec; read it first.)
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE POSTS NOTHING. IT CALLS `stock.adjust()` AND GETS OUT OF THE WAY.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * There is already exactly one way a human changes stock: `stock.adjust()`. It appends the movement,
 * keeps the weighted average honest, posts the balanced journal (DR/CR Stock Adjustment 5100) and
 * audits the change. A stock take is a BATCH of those with a sheet of paper around it — so `apply()`
 * loops and calls it, once per varying line, inside ONE transaction.
 *
 * There is no `ledger.post` in this file, and there must never be one. Every derived figure in the app
 * — the stock report, the leakage report, COGS, the trial balance — already understands an adjustment.
 * A second path to stock would mean teaching all of them about it separately, and the first one nobody
 * remembered to teach would drift in silence with the trial balance still green. (CLAUDE.md §4.)
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SUBTLE ONE: WHAT HAPPENS IF STOCK MOVES BETWEEN COUNTING AND APPLYING.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * Count 8 tins at 9am against books that say 10. Variance −2 — two tins are missing, and that is a
 * finding worth investigating. Sell 3 more tins at 10am (books now say 7). Apply the sheet at 11am.
 *
 *   THE SHEET POSTS −2. NOT −(-1). On-hand lands on 5, not 8.
 *
 * The variance is FROZEN AT COUNTING TIME and the correction is applied ON TOP of whatever legitimately
 * happened since. This is a DECISION, and it is the one that makes a stock take mean anything:
 *
 *   · A stock take corrects THE DRIFT THE BOOKS COULD NOT SEE — the two tins that walked. It is not a
 *     command to force the shelf to a number that was true two hours ago. Those 3 tins were really
 *     sold; a sheet that "corrected" on-hand back to 8 would silently un-sell them, and the shop's
 *     stock would disagree with its own sales ledger.
 *   · Recomputing expected at apply time would be worse still: expected would read 7, the variance
 *     would come out at +1, and the two missing tins would VANISH FROM THE REPORT. The theft would
 *     erase its own evidence, just by someone taking their time to press Apply.
 *
 * So: THE COUNT WINS at the moment of counting; the variance is history and is applied as history. In
 * the ordinary case — the shop is not selling the item it is counting, which is the whole point of
 * counting after close — nothing moved, and on-hand after apply is EXACTLY what was counted. That is
 * the case the tests assert by name, and the drift case is asserted by name beside it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * OTHER DECISIONS TAKEN HERE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * 1. A ZERO-VARIANCE LINE POSTS NOTHING. The books were already right. A zero movement is a row that
 *    claims something happened while recording that nothing did — `stock.record` refuses one outright.
 *    The line stays on the sheet with movement_id NULL: "we counted this, and it was correct" is a
 *    finding, and the most common one.
 * 2. APPLYING TWICE IS REFUSED. 'applied' is terminal. Without this, a double-click posts every
 *    correction twice and the second one "fixes" a shelf the first already fixed.
 * 3. A STOCK TAKE IS NEVER DELETED. An abandoned sheet is cancelled, and it stays. "What did we count
 *    last March?" must remain answerable — and a sheet that could be deleted is a finding that could
 *    be deleted.
 * 4. THE SHEET IS DATED WHEN IT IS APPLIED, not when it was opened. See `apply()`.
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

  return parsed.data
}

/** The shop's own reason for this correction. Not the renderer's choice — it is what this document IS. */
const STOCK_TAKE_REASON = 'stock_take'

// ── Row shapes ───────────────────────────────────────────────────────────────

type TakeDbRow = {
  id: number
  at: string
  status: StockTakeStatus
  note: string | null
  user_id: number | null
  user_name: string | null
  applied_at: string | null
  applied_by_name: string | null
}

type LineDbRow = {
  id: number
  product_id: number
  name_snapshot: string
  sku: string
  counted_qty_m: number
  expected_qty_m: number
  variance_qty_m: number
  unit_cost: number
  movement_id: number | null
  counted_at: string
  counted_by_name: string | null
}

/**
 * WHAT A VARIANCE IS WORTH, in 2-dp money, SIGNED. Negative = the shop is missing stock.
 *
 * `stock.movementValueMinor` is the ONE place a quantity times a cost becomes money in this app, and it
 * is the very function `stock.record` freezes onto the movement. Using it here means the sheet's
 * "this cost us Rs X" and the journal the apply posts are the same number by construction — not by two
 * implementations of the same sum agreeing today and rounding differently next year.
 *
 * A zero variance has no value: movementValueMinor refuses a zero quantity (as it should — see
 * stock.record), so it is never asked.
 */
function varianceValue(varianceQtyM: number, unitCost: number): number {
  if (varianceQtyM === 0) return 0
  return stock.movementValueMinor(varianceQtyM, unitCost)
}

function toLine(row: LineDbRow): StockTakeLineRow {
  return {
    id: row.id,
    productId: row.product_id,
    nameSnapshot: row.name_snapshot,
    sku: row.sku,
    countedQtyM: row.counted_qty_m,
    expectedQtyM: row.expected_qty_m,
    varianceQtyM: row.variance_qty_m,
    unitCost: row.unit_cost,
    varianceValueMinor: varianceValue(row.variance_qty_m, row.unit_cost),
    movementId: row.movement_id,
    countedAt: row.counted_at,
    countedByName: row.counted_by_name
  }
}

function loadTake(db: DB, stockTakeId: number): TakeDbRow {
  const row = db
    .prepare(
      `SELECT s.id, s.at, s.status, s.note, s.user_id, s.applied_at,
              u.full_name  AS user_name,
              au.full_name AS applied_by_name
       FROM stock_takes s
       LEFT JOIN users u  ON u.id  = s.user_id
       LEFT JOIN users au ON au.id = s.applied_by
       WHERE s.id = ?`
    )
    .get(stockTakeId) as TakeDbRow | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That stock take could not be found. It may have been removed.',
      `stock_take id=${stockTakeId} does not exist`
    )
  }
  return row
}

/**
 * A sheet that has been applied or cancelled is HISTORY. Counting into it would change what a finished
 * document says was found — and in the applied case, the lines no longer match the movements they
 * posted.
 */
function assertEditable(take: TakeDbRow): void {
  if (take.status === 'applied') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This stock take has already been applied, so it cannot be changed. Start a new one.',
      `stock_take ${take.id} is applied`
    )
  }
  if (take.status === 'cancelled') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This stock take was cancelled, so it cannot be changed. Start a new one.',
      `stock_take ${take.id} is cancelled`
    )
  }
}

// ── The sheet ────────────────────────────────────────────────────────────────

/** OPEN A SHEET. The clock and the user are MAIN's — see CreateStockTakeInput. */
export function create(db: DB, actor: User, raw: unknown = {}, now = new Date()): StockTakeDetail {
  const input = parseOrThrow(CreateStockTakeInput, raw ?? {}, 'stockTake.create')

  const id = Number(
    db
      .prepare(
        `INSERT INTO stock_takes (at, status, user_id, note, created_at, updated_at)
         VALUES (?, 'open', ?, ?, ?, ?)`
      )
      .run(now.toISOString(), actor.id, input?.note ?? null, now.toISOString(), now.toISOString())
      .lastInsertRowid
  )

  return get(db, { stockTakeId: id })
}

/**
 * RECORD WHAT WAS COUNTED — the heart of the sheet.
 *
 * Freezes FOUR things at this instant, and every one of them is evidence rather than a live figure:
 *   · the product's NAME      — a rename must not rewrite the sheet
 *   · what the books EXPECTED — see the file header; this is the number the finding is against
 *   · the carried unit COST   — so the variance's value cannot be re-priced later
 *   · the variance itself     — counted − expected, computed once, here
 *
 * Re-counting the same product UPDATES the line and RE-freezes all four at the new instant. That is
 * right: the counter is at the shelf again, now, and it is now's books their finding is against.
 */
export function setCount(db: DB, actor: User, raw: unknown, now = new Date()): StockTakeLineRow {
  const input = parseOrThrow(SetCountInput, raw, 'stockTake.setCount')

  const take = loadTake(db, input.stockTakeId)
  assertEditable(take)

  const run = db.transaction((): StockTakeLineRow => {
    const lineId = writeCount(db, actor, input.stockTakeId, input.productId, input.countedQtyM, now)
    touch(db, input.stockTakeId, now)
    return readLine(db, lineId)
  })

  return run()
}

/** Key a whole shelf in one go. One transaction — a half-saved shelf is a shelf nobody trusts. */
export function addLines(db: DB, actor: User, raw: unknown, now = new Date()): StockTakeDetail {
  const input = parseOrThrow(AddStockTakeLinesInput, raw, 'stockTake.addLines')

  const take = loadTake(db, input.stockTakeId)
  assertEditable(take)

  const run = db.transaction((): StockTakeDetail => {
    for (const line of input.lines) {
      writeCount(db, actor, input.stockTakeId, line.productId, line.countedQtyM, now)
    }
    touch(db, input.stockTakeId, now)
    return get(db, { stockTakeId: input.stockTakeId })
  })

  return run()
}

/**
 * The one place a count is written, so `setCount` and `addLines` cannot freeze different things.
 *
 * NOT-STOCKED ITEMS ARE REFUSED HERE, not at apply time. A service or a bag charge has no stock to
 * count — `stock.adjust` would refuse it — and finding that out only when the whole sheet is applied
 * would strand a counter with a sheet that will not post and no idea which line is to blame.
 */
function writeCount(
  db: DB,
  actor: User,
  stockTakeId: number,
  productId: number,
  countedQtyM: number,
  now: Date
): number {
  const product = db
    .prepare('SELECT id, name, item_type, cost_price, is_active FROM products WHERE id = ?')
    .get(productId) as
    | { id: number; name: string; item_type: string; cost_price: number; is_active: number }
    | undefined

  if (!product) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }

  if (product.item_type !== 'inventory') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not a stocked item, so it cannot be counted.`,
      `stock take line on item_type=${product.item_type} product ${productId}`
    )
  }

  // WHAT THE BOOKS EXPECT, RIGHT NOW. Frozen onto the line — this is the number the variance is
  // against and the number the owner will be asked about. (File header: recomputing it at apply time
  // would let a theft erase its own evidence.)
  const expectedQtyM = stock.onHand(db, productId)
  const varianceQtyM = countedQtyM - expectedQtyM

  db.prepare(
    `INSERT INTO stock_take_lines
       (stock_take_id, product_id, name_snapshot, counted_qty_m, expected_qty_m, variance_qty_m,
        unit_cost, counted_at, counted_by, created_at, updated_at)
     VALUES
       (@stockTakeId, @productId, @nameSnapshot, @countedQtyM, @expectedQtyM, @varianceQtyM,
        @unitCost, @countedAt, @countedBy, @createdAt, @updatedAt)
     ON CONFLICT (stock_take_id, product_id) DO UPDATE SET
       -- A RE-COUNT RE-FREEZES EVERYTHING. The counter is back at the shelf, now, so the finding is
       -- against now's books and now's carried cost — not against what they were an hour ago.
       name_snapshot  = excluded.name_snapshot,
       counted_qty_m  = excluded.counted_qty_m,
       expected_qty_m = excluded.expected_qty_m,
       variance_qty_m = excluded.variance_qty_m,
       unit_cost      = excluded.unit_cost,
       counted_at     = excluded.counted_at,
       counted_by     = excluded.counted_by,
       updated_at     = excluded.updated_at`
  ).run({
    stockTakeId,
    productId,
    nameSnapshot: product.name,
    countedQtyM,
    expectedQtyM,
    varianceQtyM,
    // The 4-dp weighted average the stock is CARRIED at — the same figure stock.adjust will value the
    // movement at. Frozen so the sheet and the journal cannot disagree.
    unitCost: product.cost_price,
    countedAt: now.toISOString(),
    countedBy: actor.id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  })

  return db
    .prepare('SELECT id FROM stock_take_lines WHERE stock_take_id = ? AND product_id = ?')
    .pluck()
    .get(stockTakeId, productId) as number
}

/** Remove a line counted by mistake. Only while the sheet is still open — never after it is applied. */
export function removeLine(db: DB, raw: unknown, now = new Date()): StockTakeDetail {
  const input = parseOrThrow(RemoveStockTakeLineInput, raw, 'stockTake.removeLine')

  const take = loadTake(db, input.stockTakeId)
  assertEditable(take)

  const run = db.transaction((): StockTakeDetail => {
    db.prepare('DELETE FROM stock_take_lines WHERE stock_take_id = ? AND product_id = ?').run(
      input.stockTakeId,
      input.productId
    )
    touch(db, input.stockTakeId, now)
    return get(db, { stockTakeId: input.stockTakeId })
  })

  return run()
}

/**
 * COUNTING FINISHED — waiting to be applied. A soft gate, not a lock: the sheet can still be reopened
 * by counting into it, because "I marked it done and then spotted a shelf I missed" is a Tuesday.
 */
export function markCounted(db: DB, raw: unknown, now = new Date()): StockTakeDetail {
  const input = parseOrThrow(StockTakeIdInput, raw, 'stockTake.markCounted')

  const take = loadTake(db, input.stockTakeId)
  assertEditable(take)

  db.prepare("UPDATE stock_takes SET status = 'counted', updated_at = ? WHERE id = ?").run(
    now.toISOString(),
    input.stockTakeId
  )

  return get(db, { stockTakeId: input.stockTakeId })
}

/**
 * APPLY THE SHEET — post ONE `stock.adjust` per VARYING line, in ONE transaction.
 *
 * ── THE DATE THE CORRECTIONS ARE POSTED AT ──────────────────────────────────────────────────────────
 * `now`, not the sheet's `at`. A sheet opened on the 31st and applied on the 2nd posts into the 2nd.
 * This is deliberate: a correction is a business event that happens WHEN IT IS MADE, and back-dating it
 * into a month the owner may have already reported on is precisely what the period lock exists to
 * prevent. (If the target month IS locked, stock.record's own assertPeriodOpen refuses the line and the
 * whole transaction rolls back — no half-applied sheet. That is the correct outcome and it is tested.)
 *
 * ── ATOMIC, OR NOT AT ALL ───────────────────────────────────────────────────────────────────────────
 * One transaction around the lot. A sheet that posted 40 of its 50 corrections and then hit a locked
 * month would leave the shop with a stock take that is neither applied nor not applied, and no way to
 * tell which lines had landed. better-sqlite3 nests as SAVEPOINTs, so each stock.adjust's own
 * transaction rides safely inside this one.
 */
export function apply(db: DB, actor: User, raw: unknown, now = new Date()): ApplyStockTakeResult {
  const input = parseOrThrow(ApplyStockTakeInput, raw, 'stockTake.apply')

  const take = loadTake(db, input.stockTakeId)

  // APPLYING TWICE IS REFUSED. 'applied' is terminal. A double-click would otherwise post every
  // correction a second time, each one "fixing" a shelf the first pass already fixed.
  if (take.status === 'applied') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This stock take has already been applied. Start a new one to make further corrections.',
      `stock_take ${take.id} is already applied`
    )
  }
  if (take.status === 'cancelled') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This stock take was cancelled, so it cannot be applied. Start a new one.',
      `stock_take ${take.id} is cancelled`
    )
  }

  const lines = db
    .prepare(
      `SELECT id, product_id, variance_qty_m, unit_cost
       FROM stock_take_lines
       WHERE stock_take_id = ?
       ORDER BY id`
    )
    .all(input.stockTakeId) as Array<{
    id: number
    product_id: number
    variance_qty_m: number
    unit_cost: number
  }>

  if (lines.length === 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Nothing has been counted on this stock take yet.',
      `stock_take ${take.id} has no lines`
    )
  }

  const run = db.transaction((): ApplyStockTakeResult => {
    let movementsPosted = 0
    let varianceValueMinor = 0

    const stampMovement = db.prepare(
      'UPDATE stock_take_lines SET movement_id = ?, updated_at = ? WHERE id = ?'
    )

    for (const line of lines) {
      // A ZERO-VARIANCE LINE POSTS NOTHING — the books were already right, and there is no event. Its
      // movement_id stays NULL forever, which reads exactly as what happened: counted, correct.
      if (line.variance_qty_m === 0) continue

      // THE ENGINE. Not ledger.post — never ledger.post. This appends the movement, keeps the weighted
      // average honest, posts the balanced DR/CR Stock Adjustment journal and audits the change. The
      // sheet's job is to decide the quantity and hand it over.
      //
      // No unitCost is passed: `stock.adjust` values a 'stock_take' at the product's CURRENT carried
      // average, which is what the ledger is holding the stock at right now and therefore the only cost
      // at which a write-off leaves the books consistent. (The line's frozen unit_cost is what the SHEET
      // reports the variance was worth when counted — evidence, not an instruction to the ledger.)
      const result = stock.adjust(
        db,
        actor,
        {
          productId: line.product_id,
          type: 'stock_take',
          qtyM: line.variance_qty_m,
          reasonCode: STOCK_TAKE_REASON,
          note: `Stock take #${take.id}`
        },
        now
      )

      stampMovement.run(result.movement.id, now.toISOString(), line.id)
      movementsPosted++
      // The money the correction ACTUALLY moved — read off the movement stock.adjust just froze, not
      // recomputed here. One sum, one rounding, one source. (See stock.movementValueMinor.)
      varianceValueMinor += stock.movementValueMinor(
        result.movement.qtyM,
        result.movement.unitCost
      )
    }

    db.prepare(
      `UPDATE stock_takes
       SET status = 'applied', applied_at = ?, applied_by = ?, updated_at = ?
       WHERE id = ?`
    ).run(now.toISOString(), actor.id, now.toISOString(), input.stockTakeId)

    // WHO signed off WHAT, and WHAT IT COST. The variance total is the point of this row: a big one is
    // a theft signal, and this is the number the leakage report and the owner both read. (CLAUDE.md §4)
    //
    // The per-line movements are audited by stock.adjust itself — this is the sheet-level fact that no
    // individual adjustment can express: forty small corrections that add up to a large loss.
    audit.record(
      db,
      actor,
      {
        action: 'stockTake.apply',
        entity: 'stock_take',
        entityId: take.id,
        reasonCode: STOCK_TAKE_REASON,
        before: { status: take.status, lineCount: lines.length },
        after: { status: 'applied', movementsPosted, varianceValueMinor }
      },
      now
    )

    return { stockTakeId: input.stockTakeId, movementsPosted, varianceValueMinor }
  })

  return run()
}

/**
 * ABANDON A SHEET. It is NOT deleted — it is marked cancelled and it stays, with everything that was
 * counted still on it. A sheet that could be deleted is a finding that could be deleted.
 */
export function cancel(db: DB, actor: User, raw: unknown, now = new Date()): StockTakeDetail {
  const input = parseOrThrow(CancelStockTakeInput, raw, 'stockTake.cancel')

  const take = loadTake(db, input.stockTakeId)
  assertEditable(take)

  const run = db.transaction(() => {
    db.prepare("UPDATE stock_takes SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      now.toISOString(),
      input.stockTakeId
    )

    audit.record(
      db,
      actor,
      {
        action: 'stockTake.cancel',
        entity: 'stock_take',
        entityId: take.id,
        ...(input.reason != null ? { reasonText: input.reason } : {}),
        before: { status: take.status },
        after: { status: 'cancelled' }
      },
      now
    )
  })
  run()

  return get(db, { stockTakeId: input.stockTakeId })
}

// ── Reading it back ──────────────────────────────────────────────────────────

export function get(db: DB, raw: unknown): StockTakeDetail {
  const input = parseOrThrow(StockTakeIdInput, raw, 'stockTake.get')
  const take = loadTake(db, input.stockTakeId)

  const lines = db
    .prepare(
      `SELECT l.id, l.product_id, l.name_snapshot, l.counted_qty_m, l.expected_qty_m,
              l.variance_qty_m, l.unit_cost, l.movement_id, l.counted_at,
              p.sku       AS sku,
              u.full_name AS counted_by_name
       FROM stock_take_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN users u ON u.id = l.counted_by
       WHERE l.stock_take_id = ?
       ORDER BY l.id`
    )
    .all(input.stockTakeId) as LineDbRow[]

  return { ...toRow(take, lines), lines: lines.map(toLine) }
}

/**
 * THE SHEETS, newest first — paginated, always. (CLAUDE.md §4: assume 100k+ rows.)
 *
 * The line counts and the variance total are computed per row of the PAGE, not for the whole table:
 * an ordinary page is 50 index seeks on idx_stock_take_lines_take.
 */
export function list(db: DB, raw: unknown = {}): PagedResult<StockTakeRow> {
  const input = parseOrThrow(ListStockTakesInput, raw ?? {}, 'stockTake.list')

  const page = Math.max(1, input?.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input?.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input?.status) {
    where.push('s.status = @status')
    params['status'] = input.status
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(`SELECT COUNT(*) FROM stock_takes s ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT s.id, s.at, s.status, s.note, s.user_id, s.applied_at,
              u.full_name  AS user_name,
              au.full_name AS applied_by_name
       FROM stock_takes s
       LEFT JOIN users u  ON u.id  = s.user_id
       LEFT JOIN users au ON au.id = s.applied_by
       ${whereSql}
       ORDER BY s.at DESC, s.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as TakeDbRow[]

  const linesFor = db.prepare(
    'SELECT variance_qty_m, unit_cost FROM stock_take_lines WHERE stock_take_id = ?'
  )

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) =>
      toRow(
        row,
        linesFor.all(row.id) as Array<{ variance_qty_m: number; unit_cost: number }>
      )
    )
  }
}

/**
 * The sheet's headline figures, derived from its lines — never stored. `varianceValueMinor` is the sum
 * of each line's own value at its own frozen cost, so the summary and the lines can never disagree.
 */
function toRow(
  take: TakeDbRow,
  lines: Array<{ variance_qty_m: number; unit_cost: number }>
): StockTakeRow {
  let varianceLineCount = 0
  let varianceValueMinor = 0

  for (const line of lines) {
    if (line.variance_qty_m === 0) continue
    varianceLineCount++
    varianceValueMinor += varianceValue(line.variance_qty_m, line.unit_cost)
  }

  return {
    id: take.id,
    at: take.at,
    status: take.status,
    note: take.note,
    userId: take.user_id,
    userName: take.user_name,
    appliedAt: take.applied_at,
    appliedByName: take.applied_by_name,
    lineCount: lines.length,
    varianceLineCount,
    varianceValueMinor
  }
}

function readLine(db: DB, lineId: number): StockTakeLineRow {
  const row = db
    .prepare(
      `SELECT l.id, l.product_id, l.name_snapshot, l.counted_qty_m, l.expected_qty_m,
              l.variance_qty_m, l.unit_cost, l.movement_id, l.counted_at,
              p.sku       AS sku,
              u.full_name AS counted_by_name
       FROM stock_take_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN users u ON u.id = l.counted_by
       WHERE l.id = ?`
    )
    .get(lineId) as LineDbRow

  return toLine(row)
}

function touch(db: DB, stockTakeId: number, now: Date): void {
  db.prepare('UPDATE stock_takes SET updated_at = ? WHERE id = ?').run(
    now.toISOString(),
    stockTakeId
  )
}
