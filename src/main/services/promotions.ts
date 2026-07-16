import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { BASIS_POINTS } from '@shared/tax'
import { extendPrice } from '@shared/pricing'
import {
  CreatePromotionInput,
  DeactivatePromotionInput,
  GetPromotionInput,
  ListPromotionRulesInput,
  ListPromotionsInput,
  SetPromotionRulesInput,
  UpdatePromotionInput,
  maskRunsOn,
  type LinePromotionResult,
  type PagedResult,
  type PromotableLine,
  type Promotion,
  type PromotionDetail,
  type PromotionKind,
  type PromotionRule,
  type PromotionRuleScope
} from '@shared/promotions'
import * as audit from './audit'

/**
 * THE PROMOTIONS SERVICE — the shop's own offers, applied automatically at the till so the cashier never
 * has to remember one. (Migration 0018, whose header is the spec; read it first.)
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * A PROMOTION IS A LINE DISCOUNT. THAT IS THE WHOLE DESIGN.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This service computes ONE number per cart line — a discount, in 2-dp integer minor units — and says
 * which offer gave it. It writes nothing to a sale, posts no journal, and touches no stock. The caller
 * (sales.ts) puts that number into `sale_lines.line_discount`, the column that has existed since
 * migration 0007, and from there it travels a road that is already proven and already tested:
 *
 *     sale_lines.line_discount  →  priceCart re-resolves tax on what is ACTUALLY paid
 *                               →  DR Discounts Given (ACC.DISCOUNTS 4200, contra-income), ex-tax
 *                               →  frozen onto the line, so a RETURN refunds what was really charged
 *
 * A promotion with its own journal leg or its own money column would be a SECOND path to the same
 * place, and every derived figure in the app — returns, the profit report, leakage, loyalty's earn
 * basis, output tax — would have to learn about it separately. They do not have to, because there is
 * nothing new to learn.
 *
 * ── WHAT A "FREE" ITEM ACTUALLY IS ──────────────────────────────────────────────────────────────────
 * Buy-2-get-1 does NOT ring the free tin at zero. It rings all three at the normal price and discounts
 * one of them 100%. Stock moves for all 3 at cost (the shelf and the books agree), the giveaway's cost
 * is VISIBLE in Discounts Given rather than hidden in a smaller Sales figure, and output tax is charged
 * on what the customer actually pays. Ring it at zero and all three break.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * BUSINESS DECISIONS TAKEN HERE, AND WHY. Each is a rule the owner should be told about.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. ONE PROMOTION PER LINE. LOWER `priority` WINS; THE FIRST MATCH TAKES IT.
 *    Stacking two offers on one tin is how a shop accidentally sells at a loss — 20% off, then Rs 30
 *    off, and the tin goes out below cost with a perfectly balanced journal behind it. A shop that
 *    wants "10% off, then Rs 20 off" writes ONE offer that does that. Ties on priority break by `id`
 *    (the older offer wins), so the same cart always resolves the same way.
 *
 * 2. AN OFFER WITH NO RULES FIRES ON NOTHING. (Migration 0018's header says why.) An offer that
 *    silently applied shop-wide because someone forgot to add a rule is a very expensive typo.
 *
 * 3. AN OPEN ITEM CAN NEVER MATCH. It has no `productId`, so there is no catalog row to test a rule
 *    against — not even 'all', which means "every stocked item". A "Misc — Rs 500" line the cashier
 *    typed is not something the owner put an offer on.
 *
 * 4. THE CHEAPEST UNITS ARE THE FREE ONES — and on a single cart line they are all the same price, so
 *    this is exact rather than a choice. A cart LINE carries ONE `unitPrice` (sales.ts resolves it
 *    once, from the catalog, per line). Scanning the same tin twice merges into one line; a line with
 *    an override or a discount does NOT merge (see `addLine`), so it is priced separately and its own
 *    offer is computed against its own price. There is therefore no mix of prices WITHIN a line to
 *    choose between, and "the cheapest ones are free" (0018's header) is satisfied by construction:
 *    every unit on the line costs the same, so any getQtyM of them is the cheapest getQtyM. If a
 *    future line ever carried mixed prices, THIS is the decision that would have to be revisited.
 *
 * 5. A PROMOTION NEVER DISCOUNTS BELOW ZERO, AND NEVER MORE THAN THE LINE'S OWN PRICE. Every kind is
 *    clamped to [0, lineAmount]. A "fixed price" ABOVE the shelf price discounts by 0 — it does not
 *    charge more; an offer is an offer, never a surcharge. An `amount_off` bigger than the line takes
 *    the line to zero, never negative — a negative discount is a price rise nobody authorised.
 *
 * 6. THE WINDOW IS INCLUSIVE AT BOTH ENDS, AND IT IS MEASURED IN LOCAL DAYS. An offer "until the 14th"
 *    runs for all of the 14th — a shop thinks in days, and the day on the shop's wall is the LOCAL one
 *    (near midnight the local and UTC dates differ). Same reasoning as `quoteValidUntil` in sales.ts.
 *
 * 7. THE DAYS MASK IS MONDAY-FIRST AND JS IS NOT. `dayIndexOf` (shared/promotions.ts) is the one
 *    mapping: `(getDay() + 6) % 7`. Read the mask with getDay() directly and a weekend offer fires on
 *    Thursday. Tested against a real Sunday and a real Monday.
 *
 * ── TRANSPORT-AGNOSTIC (CLAUDE.md §3) ───────────────────────────────────────────────────────────────
 * Plain args in, plain data out. No Result envelope, no `electron` import. The IPC layer zod-validates
 * again at its boundary, enforces `promotion.manage` (manager) / `promotion.view` (cashier), checks the
 * read-only/expired-licence block with assertWritable, and wraps the answer.
 */

// ═════════════════════════════════════════════════════════════════════════════
// WRITING — an offer is created, edited, and switched OFF. Never deleted.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * CREATE AN OFFER. It is ON from the moment it is made, and it applies to NOTHING until rules are set
 * (decision 2) — so an owner can save a half-thought-out offer without it reaching the till.
 *
 * The kind/knob pairing is enforced by the schema (`refineKindKnobs` in shared/promotions.ts): a knob
 * that does not belong to the kind is REFUSED, in plain language, because a half-described offer has
 * two readings and the engine would have to guess which one the owner meant.
 *
 * AUDITED. An offer is a standing decision to sell below the shelf price; who made it and when is
 * exactly the evidence the owner needs when the margin report looks wrong (CLAUDE.md §4).
 */
export function createPromotion(db: DB, actor: User, raw: unknown, now = new Date()): PromotionDetail {
  const input = parseOrThrow(CreatePromotionInput, raw, 'promotion.create')

  const run = db.transaction((): number => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO promotions
             (name, description, kind, percent_bp, amount_minor, buy_qty_m, get_qty_m,
              starts_on, ends_on, days_mask, priority, is_active, created_at, updated_at)
           VALUES
             (@name, @description, @kind, @percentBp, @amountMinor, @buyQtyM, @getQtyM,
              @startsOn, @endsOn, @daysMask, @priority, 1, @at, @at)`
        )
        .run({
          name: input.name,
          description: input.description ?? null,
          kind: input.kind,
          percentBp: input.percentBp ?? null,
          amountMinor: input.amountMinor ?? null,
          buyQtyM: input.buyQtyM ?? null,
          getQtyM: input.getQtyM ?? null,
          startsOn: input.startsOn ?? null,
          endsOn: input.endsOn ?? null,
          daysMask: input.daysMask ?? null,
          priority: input.priority ?? DEFAULT_PRIORITY,
          at: now.toISOString()
        }).lastInsertRowid
    )

    audit.record(
      db,
      actor,
      { action: 'promotion.create', entity: 'promotion', entityId: id, after: auditShape(input) },
      now
    )

    return id
  })

  return getById(db, run())
}

/**
 * EDIT AN OFFER. Only the editable fields (trap #18 — never POST the whole object back): `isActive`
 * and the rules are absent, so an edit can never silently switch an offer back on or wipe what it
 * applies to. Both `before` and `after` land in the audit, because "who changed 10% to 40%" is the
 * whole question.
 *
 * A CHANGE NEVER REWRITES HISTORY. Old sales carry a FROZEN name_snapshot and a FROZEN discount_minor
 * (migration 0018), so re-pricing an offer changes what it does TOMORROW and nothing about what it
 * already did.
 */
export function updatePromotion(db: DB, actor: User, raw: unknown, now = new Date()): PromotionDetail {
  const input = parseOrThrow(UpdatePromotionInput, raw, 'promotion.update')

  const before = getById(db, input.id)

  const run = db.transaction((): void => {
    db.prepare(
      `UPDATE promotions
          SET name = @name, description = @description, kind = @kind,
              percent_bp = @percentBp, amount_minor = @amountMinor,
              buy_qty_m = @buyQtyM, get_qty_m = @getQtyM,
              starts_on = @startsOn, ends_on = @endsOn, days_mask = @daysMask,
              priority = @priority, updated_at = @at
        WHERE id = @id`
    ).run({
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      percentBp: input.percentBp ?? null,
      amountMinor: input.amountMinor ?? null,
      buyQtyM: input.buyQtyM ?? null,
      getQtyM: input.getQtyM ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      daysMask: input.daysMask ?? null,
      // An omitted priority KEEPS the one the offer already has. Defaulting it back to 100 here would
      // silently reshuffle which of two offers wins, on an edit that never mentioned priority.
      priority: input.priority ?? before.priority,
      at: now.toISOString()
    })

    audit.record(
      db,
      actor,
      {
        action: 'promotion.update',
        entity: 'promotion',
        entityId: input.id,
        before: auditShape(before),
        after: auditShape({ ...input, priority: input.priority ?? before.priority })
      },
      now
    )
  })

  run()
  return getById(db, input.id)
}

/**
 * SWITCH AN OFFER OFF. NEVER A DELETE (migration 0018): last March's sales must still explain
 * themselves, and `sale_line_promotions.promotion_id` points here with no ON DELETE CASCADE — deleting
 * a promotion that has ever fired would either fail on the foreign key or orphan the history.
 *
 * Switching one off is instant and total: `activeFor` never returns it again. It cannot reach back —
 * every sale it ever discounted froze its own name and its own money.
 *
 * Deactivating an already-off offer is a no-op that still returns it, and writes no audit row: nothing
 * changed, and an audit log full of non-events is one nobody reads.
 */
export function deactivatePromotion(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): PromotionDetail {
  const input = parseOrThrow(DeactivatePromotionInput, raw, 'promotion.deactivate')

  const before = getById(db, input.id)
  if (!before.isActive) return before

  const run = db.transaction((): void => {
    db.prepare('UPDATE promotions SET is_active = 0, updated_at = @at WHERE id = @id').run({
      id: input.id,
      at: now.toISOString()
    })

    audit.record(
      db,
      actor,
      {
        action: 'promotion.deactivate',
        entity: 'promotion',
        entityId: input.id,
        before: { name: before.name, isActive: true },
        after: { name: before.name, isActive: false }
      },
      now
    )
  })

  run()
  return getById(db, input.id)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE RULES — what an offer applies to
// ═════════════════════════════════════════════════════════════════════════════

/**
 * SET WHAT AN OFFER APPLIES TO — the WHOLE set, replacing whatever was there. One transaction: the
 * offer is never briefly applying to a half-written set of rules.
 *
 * AN EMPTY LIST IS LEGAL, and it means the offer fires on NOTHING (decision 2). That is the safe
 * direction: clearing the rules stops the offer dead rather than accidentally applying it shop-wide.
 *
 * EVERY TARGET IS CHECKED TO EXIST. A rule pointing at a deleted product or a lookup id from the wrong
 * list would simply never match, and "the offer isn't working" with no error is the worst failure this
 * feature has — the owner would blame the till.
 *
 * Audited as an update of the offer: what an offer APPLIES TO is as much a part of it as its
 * percentage, and changing it from "one tin" to "everything" is the single most expensive edit here.
 */
export function setRules(db: DB, actor: User, raw: unknown, now = new Date()): PromotionRule[] {
  const input = parseOrThrow(SetPromotionRulesInput, raw, 'promotion.setRules')

  const promotion = getById(db, input.promotionId)

  for (const rule of input.rules) assertTargetExists(db, rule.scope, rule.targetId ?? null)

  const run = db.transaction((): void => {
    db.prepare('DELETE FROM promotion_rules WHERE promotion_id = ?').run(input.promotionId)

    const insert = db.prepare(
      `INSERT INTO promotion_rules (promotion_id, scope, target_id, created_at)
       VALUES (@promotionId, @scope, @targetId, @at)`
    )

    for (const rule of input.rules) {
      insert.run({
        promotionId: input.promotionId,
        scope: rule.scope,
        targetId: rule.scope === 'all' ? null : (rule.targetId ?? null),
        at: now.toISOString()
      })
    }

    db.prepare('UPDATE promotions SET updated_at = @at WHERE id = @id').run({
      id: input.promotionId,
      at: now.toISOString()
    })

    audit.record(
      db,
      actor,
      {
        action: 'promotion.update',
        entity: 'promotion',
        entityId: input.promotionId,
        before: { name: promotion.name, rules: promotion.rules.map(ruleShape) },
        after: { name: promotion.name, rules: input.rules.map(ruleShape) }
      },
      now
    )
  })

  run()
  return listRules(db, { promotionId: input.promotionId })
}

/** WHAT AN OFFER APPLIES TO. An empty list is the honest answer that it applies to nothing. */
export function listRules(db: DB, raw: unknown): PromotionRule[] {
  const input = parseOrThrow(ListPromotionRulesInput, raw, 'promotion.listRules')

  return db
    .prepare(
      `SELECT id, promotion_id, scope, target_id, created_at
         FROM promotion_rules WHERE promotion_id = ? ORDER BY id`
    )
    .all(input.promotionId)
    .map(hydrateRule)
}

/**
 * A rule must point at something that EXISTS, and at the RIGHT KIND of thing. A `list_key` filter
 * refuses a lookup id borrowed from another list — "category: <a payment method's id>" is a rule that
 * would match nothing forever, with no error anywhere (CLAUDE.md §4 — no hardcoded lists; these are
 * the owner's own).
 */
function assertTargetExists(db: DB, scope: PromotionRuleScope, targetId: number | null): void {
  // 'all' takes no target — the schema already refused one, and the table CHECKs it too.
  if (scope === 'all') return

  if (targetId == null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose which item or group this offer applies to.',
      `rule scope="${scope}" has no target_id`
    )
  }

  if (scope === 'product') {
    const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').pluck().get(targetId)
    if (exists == null) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'That item could not be found. It may have been removed.',
        `promotion rule targets product id=${targetId}, which does not exist`
      )
    }
    return
  }

  // The group scopes are all lookups on the owner's own lists, and the list a rule names must be the
  // list the id actually lives on.
  const listKey = RULE_LIST_KEY[scope]
  const exists = db
    .prepare('SELECT 1 FROM lookups WHERE id = ? AND list_key = ?')
    .pluck()
    .get(targetId, listKey)

  if (exists == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `That ${scope} could not be found. Please choose one from the list.`,
      `promotion rule targets ${listKey} lookup id=${targetId}, which does not exist on that list`
    )
  }
}

/**
 * Which lookup list backs each group scope, and which product column it is matched against. ONE table,
 * so the validation and the matching SQL can never disagree about what a 'brand' is.
 */
const RULE_LIST_KEY: Record<Exclude<PromotionRuleScope, 'product' | 'all'>, string> = {
  category: 'category',
  brand: 'brand',
  department: 'department'
}

const RULE_PRODUCT_COLUMN: Record<Exclude<PromotionRuleScope, 'product' | 'all'>, string> = {
  category: 'category_id',
  brand: 'brand_id',
  department: 'department_id'
}

// ═════════════════════════════════════════════════════════════════════════════
// READING
// ═════════════════════════════════════════════════════════════════════════════

/** ONE offer, with its rules. */
export function getPromotion(db: DB, raw: unknown): PromotionDetail {
  const input = parseOrThrow(GetPromotionInput, raw, 'promotion.get')
  return getById(db, input.id)
}

/** ONE offer with its rules, by id — the internal read every write path returns through. */
function getById(db: DB, id: number): PromotionDetail {
  const row = db.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`).get(id)

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That offer could not be found. It may have been removed.',
      `promotion id=${id} does not exist`
    )
  }

  return { ...hydrate(row as PromotionRow), rules: listRules(db, { promotionId: id }) }
}

/**
 * THE OFFERS LIST — paginated and indexed, always (CLAUDE.md §4). Ordered the way the engine resolves
 * them (priority, then id), so the screen shows them in the order they would actually fire — an owner
 * looking at "which of these two wins?" reads the answer off the top of the list.
 */
export function listPromotions(db: DB, raw: unknown = {}): PagedResult<Promotion> {
  const input = parseOrThrow(ListPromotionsInput, raw, 'promotion.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.isActive != null) {
    where.push('is_active = @isActive')
    params['isActive'] = input.isActive ? 1 : 0
  }
  if (input.search) {
    where.push('name LIKE @search')
    params['search'] = `%${input.search}%`
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db.prepare(`SELECT COUNT(*) FROM promotions ${whereSql}`).pluck().get(params) as number

  const rows = db
    .prepare(
      `SELECT ${PROMOTION_COLUMNS} FROM promotions ${whereSql}
        ORDER BY priority ASC, id ASC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as PromotionRow[]

  return { total, page, pageSize, rows: rows.map(hydrate) }
}

/**
 * THE OFFERS LIVE ON A GIVEN DATE — active, inside their window, and running on that WEEKDAY.
 *
 * Ordered by `priority` then `id`, which IS the order the engine takes the first match in (decision 1).
 * The order is total and stable, so the same cart on the same day always resolves the same way.
 *
 * THE DATE IS A LOCAL DAY (decision 6). `starts_on`/`ends_on` are inclusive: an offer that starts today
 * runs today, and one that ends today runs for all of today. The weekday comes from `maskRunsOn`, which
 * owns the Monday-first mapping (decision 7).
 *
 * Rules are loaded WITH each offer, in ONE query rather than one per promotion — a busy till calls this
 * on every cart, and a shop may run a dozen offers.
 */
export function activeFor(db: DB, at: Date): PromotionDetail[] {
  const today = toIsoDate(at)

  const rows = db
    .prepare(
      `SELECT ${PROMOTION_COLUMNS} FROM promotions
        WHERE is_active = 1
          AND (starts_on IS NULL OR starts_on <= @today)
          AND (ends_on   IS NULL OR ends_on   >= @today)
        ORDER BY priority ASC, id ASC`
    )
    .all({ today }) as PromotionRow[]

  // The weekday is decided in TS, not SQL: SQLite's strftime('%w') is 0=Sunday like JS, and putting the
  // Monday-first shift into a WHERE clause would be a SECOND copy of the one mapping that can silently
  // be off by one (decision 7). There is one, and it is `maskRunsOn`.
  const live = rows.filter((row) => maskRunsOn(row.days_mask, at))
  if (live.length === 0) return []

  const rules = rulesFor(
    db,
    live.map((row) => row.id)
  )

  return live.map((row) => ({ ...hydrate(row), rules: rules.get(row.id) ?? [] }))
}

/** Every rule for a set of offers, in ONE query — keyed by promotion id, ordered by rule id. */
function rulesFor(db: DB, promotionIds: readonly number[]): Map<number, PromotionRule[]> {
  const byPromotion = new Map<number, PromotionRule[]>()
  if (promotionIds.length === 0) return byPromotion

  const placeholders = promotionIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, promotion_id, scope, target_id, created_at
         FROM promotion_rules WHERE promotion_id IN (${placeholders}) ORDER BY id`
    )
    .all(...promotionIds)

  for (const row of rows) {
    const rule = hydrateRule(row)
    const list = byPromotion.get(rule.promotionId)
    if (list) list.push(rule)
    else byPromotion.set(rule.promotionId, [rule])
  }

  return byPromotion
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ENGINE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * APPLY THE SHOP'S OFFERS TO A CART. THE ENGINE.
 *
 * For each line, in order: find the FIRST active offer (lowest priority) whose rules match that line's
 * product, and compute its discount. Returns one entry per line, IN THE SAME ORDER, null where no offer
 * matched — which is most lines, most of the time.
 *
 * ONE PROMOTION PER LINE (decision 1). The first match takes it, and no other offer is considered for
 * that line — stacking is how a shop accidentally sells at a loss.
 *
 * IT WRITES NOTHING. It reads the offers and computes numbers. The caller decides what to do with them
 * (put them in `line_discount`, freeze them into `sale_line_promotions`), which is what lets the Sell
 * screen PREVIEW an offer through the same code that later FREEZES it — the same reasoning that put
 * `extendPrice` and `apportionCartDiscount` in shared/pricing.ts.
 *
 * `at` decides which offers are live AND is the weekday the mask is read against — one instant for the
 * whole cart, so a sale rung up across midnight cannot take Sunday's price on Monday's line.
 */
export function applyTo(
  db: DB,
  lines: readonly PromotableLine[],
  at: Date
): LinePromotionResult[] {
  const offers = activeFor(db, at)
  if (offers.length === 0) return lines.map(() => null)

  // One product lookup per DISTINCT product in the cart, not one per offer per line: a cart of 30 lines
  // against a dozen offers would otherwise be 360 queries on the busiest screen in the shop.
  const facts = productFacts(db, lines)

  return lines.map((line) => {
    // An OPEN ITEM can never match (decision 3) — there is no catalog row to test a rule against.
    if (line.productId == null) return null

    const fact = facts.get(line.productId)
    if (!fact) return null

    for (const offer of offers) {
      // AN OFFER WITH NO RULES FIRES ON NOTHING (decision 2).
      if (offer.rules.length === 0) continue
      if (!matches(offer.rules, fact)) continue

      const discountMinor = discountFor(offer, line)

      // A matched offer that gives nothing (a fixed price above the shelf price, a line of zero) still
      // TAKES the line: it matched, and it is the offer the owner meant to apply. Reporting it with a
      // zero discount is the honest answer — and it stops a second, worse offer from firing on a line
      // the first one already claimed.
      return {
        promotionId: offer.id,
        // FROZEN by the caller: what it was CALLED today. Renaming the offer next month must never
        // rewrite what this sale says it cost (migration 0018).
        promotionName: offer.name,
        discountMinor
      }
    }

    return null
  })
}

/** What a rule needs to know about a product. Loaded once per distinct product in the cart. */
type ProductFact = {
  id: number
  categoryId: number | null
  brandId: number | null
  departmentId: number | null
}

function productFacts(db: DB, lines: readonly PromotableLine[]): Map<number, ProductFact> {
  const ids = [...new Set(lines.map((line) => line.productId).filter((id): id is number => id != null))]

  const facts = new Map<number, ProductFact>()
  if (ids.length === 0) return facts

  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, category_id, brand_id, department_id FROM products WHERE id IN (${placeholders})`
    )
    .all(...ids) as Array<{
    id: number
    category_id: number | null
    brand_id: number | null
    department_id: number | null
  }>

  for (const row of rows) {
    facts.set(row.id, {
      id: row.id,
      categoryId: row.category_id,
      brandId: row.brand_id,
      departmentId: row.department_id
    })
  }

  return facts
}

/**
 * Does ANY of this offer's rules match this product? The rules of one offer are an OR: "tea OR coffee
 * OR anything in Beverages" is one offer with three rules. (An AND would be a different feature and
 * nobody asked for one — CLAUDE.md §7.)
 */
function matches(rules: readonly PromotionRule[], product: ProductFact): boolean {
  return rules.some((rule) => {
    switch (rule.scope) {
      case 'all':
        return true
      case 'product':
        return rule.targetId === product.id
      case 'category':
        // A product with no category cannot match a category rule. `targetId` is never null here (the
        // schema and the table both refuse it), so this is a real comparison, never null === null.
        return product.categoryId != null && product.categoryId === rule.targetId
      case 'brand':
        return product.brandId != null && product.brandId === rule.targetId
      case 'department':
        return product.departmentId != null && product.departmentId === rule.targetId
      default:
        // The scope came out of a CHECKed column, so this is unreachable — but an unknown scope must
        // match NOTHING rather than everything. A future scope this code has not learned yet must not
        // silently discount the whole shop.
        return false
    }
  })
}

/**
 * THE ARITHMETIC. INTEGERS ONLY, in every branch, and clamped to [0, lineAmount] on the way out
 * (decision 5).
 *
 * The clamp is applied ONCE, here, rather than in each branch: every kind is capable of overshooting in
 * its own way (a 100% offer on a line, a fixed price above the shelf price, an amount_off bigger than
 * the line), and one clamp that every kind passes through cannot be the one somebody forgot.
 */
function discountFor(offer: Promotion, line: PromotableLine): number {
  const raw = rawDiscountFor(offer, line)

  // Never negative (a discount that charges more is a price rise nobody authorised), never more than
  // the line itself (a line that pays the customer is a hole in the till).
  return Math.min(Math.max(raw, 0), Math.max(line.lineAmount, 0))
}

function rawDiscountFor(offer: Promotion, line: PromotableLine): number {
  switch (offer.kind) {
    case 'percent_off':
      return percentOff(line.lineAmount, offer.percentBp ?? 0)

    case 'amount_off':
      // PER UNIT, and a unit is 1000 thousandths: a 1.5 kg line at Rs 10/unit off gets Rs 15 off.
      // `extendPrice` is exactly this arithmetic (an amount × a qty_m, rounded once, in BigInt) and it
      // is the same function that extended the line's price — so the discount and the price it comes
      // off cannot round differently.
      return extendPrice(offer.amountMinor ?? 0, line.qtyM)

    case 'fixed_price': {
      // The unit sells at `amountMinor` instead of its own price. The discount is the DIFFERENCE, and
      // never negative: a "fixed price" ABOVE the shelf price discounts by 0, it does not charge more
      // (decision 5). The clamp in `discountFor` enforces that; this returns the honest difference.
      const target = extendPrice(offer.amountMinor ?? 0, line.qtyM)
      return line.lineAmount - target
    }

    case 'buy_x_get_y':
      return buyXGetY(line, offer.buyQtyM ?? 0, offer.getQtyM ?? 0)

    default:
      // Unreachable: `kind` is a CHECKed column. An unknown kind gives NOTHING away rather than
      // guessing — the safe direction for a number that leaves the shop.
      return 0
  }
}

/**
 * A PERCENTAGE OF A PRICE, AS AN INTEGER OPERATION. `amount × percentBp / 10000`, rounded half-up to
 * the paisa, ONCE — the same shape `computeLineTax` uses for a rate in basis points, and for the same
 * reason: 10% of Rs 9.99 is 99.9 paisa and there is no such coin.
 *
 * BigInt for the multiply, exactly as `extendPrice` does: a large line times 10000 overflows a JS
 * float's exact-integer range, and past that point two different totals silently compare equal.
 *
 * percentBp = 10000 gives back the whole line — a 100% offer IS a giveaway, and it is a legal offer
 * (the table CHECKs `<= 10000`). It is not a negative price: the caller rings the line at its normal
 * price with a 100% discount, which is what a "free" item actually is.
 */
function percentOff(amount: number, percentBp: number): number {
  if (amount <= 0 || percentBp <= 0) return 0

  const bp = BigInt(BASIS_POINTS)
  const raw = BigInt(amount) * BigInt(percentBp)
  const value = (raw * 2n + bp) / (bp * 2n) // floor(raw/bp + 1/2) — round half up

  return Number(value)
}

/**
 * BUY X, GET Y FREE — on integer thousandths, with no float anywhere.
 *
 * THE GROUP. Every (buyQtyM + getQtyM) of the line's quantity is one complete group, and each group
 * gives getQtyM away at 100%. The count is INTEGER DIVISION, which is what makes a PARTIAL group come
 * out right: 5 units on a 2+1 offer is floor(5000/3000) = 1 group = ONE free unit, not 1.67. The 2
 * units left over are not a group and nothing is free about them — the customer has not bought enough
 * to earn a second one yet.
 *
 * THE CHEAPEST UNITS ARE THE FREE ONES (decision 4) — and every unit on a cart line carries the same
 * `unitPrice`, so any getQtyM of them is the cheapest getQtyM. It is exact rather than a choice.
 *
 * A WEIGHED LINE WORKS BY THE SAME ARITHMETIC, because a quantity is always thousandths: "buy 1 kg get
 * 500 g free" is buyQtyM=1000, getQtyM=500, and 3.2 kg is floor(3200/1500) = 2 groups = 1 kg free. No
 * special case, because there is no special case — a kg and a tin are the same integer.
 *
 * The free quantity is priced with `extendPrice` — the SAME function that extended the line — so the
 * discount is exactly what those units are charged at and the line can never round to a residue.
 */
function buyXGetY(line: PromotableLine, buyQtyM: number, getQtyM: number): number {
  if (buyQtyM <= 0 || getQtyM <= 0 || line.qtyM <= 0) return 0

  const groupQtyM = buyQtyM + getQtyM

  // INTEGER division: a partial group earns nothing. Both operands are integers and positive, so this
  // is exact — `Math.floor` states the intent rather than relying on the division.
  const groups = Math.floor(line.qtyM / groupQtyM)
  if (groups <= 0) return 0

  const freeQtyM = groups * getQtyM

  // What those units are charged, at the line's own unit price. Never more than the line: `freeQtyM`
  // is at most (getQtyM/groupQtyM) of the quantity, which is < 1 — but the clamp in `discountFor`
  // stands behind it regardless.
  return extendPrice(line.unitPrice, freeQtyM)
}

// ═════════════════════════════════════════════════════════════════════════════
// Row → domain
// ═════════════════════════════════════════════════════════════════════════════

/** The table's own default (migration 0018). Stated once, so the service and the schema agree. */
const DEFAULT_PRIORITY = 100

const PROMOTION_COLUMNS = `id, name, description, kind, percent_bp, amount_minor, buy_qty_m, get_qty_m,
                           starts_on, ends_on, days_mask, priority, is_active, created_at, updated_at`

type PromotionRow = {
  id: number
  name: string
  description: string | null
  kind: PromotionKind
  percent_bp: number | null
  amount_minor: number | null
  buy_qty_m: number | null
  get_qty_m: number | null
  starts_on: string | null
  ends_on: string | null
  days_mask: string | null
  priority: number
  is_active: number
  created_at: string
  updated_at: string
}

function hydrate(row: PromotionRow): Promotion {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    percentBp: row.percent_bp,
    amountMinor: row.amount_minor,
    buyQtyM: row.buy_qty_m,
    getQtyM: row.get_qty_m,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    daysMask: row.days_mask,
    priority: row.priority,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function hydrateRule(row: unknown): PromotionRule {
  const rule = row as {
    id: number
    promotion_id: number
    scope: PromotionRuleScope
    target_id: number | null
    created_at: string
  }

  return {
    id: rule.id,
    promotionId: rule.promotion_id,
    scope: rule.scope,
    targetId: rule.target_id,
    createdAt: rule.created_at
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/** What an offer looked like, for the audit log — the fields that decide what it gives away. */
function auditShape(promotion: {
  name: string
  kind: PromotionKind
  percentBp?: number | null
  amountMinor?: number | null
  buyQtyM?: number | null
  getQtyM?: number | null
  startsOn?: string | null
  endsOn?: string | null
  daysMask?: string | null
  priority?: number | null
}): Record<string, unknown> {
  return {
    name: promotion.name,
    kind: promotion.kind,
    percentBp: promotion.percentBp ?? null,
    amountMinor: promotion.amountMinor ?? null,
    buyQtyM: promotion.buyQtyM ?? null,
    getQtyM: promotion.getQtyM ?? null,
    startsOn: promotion.startsOn ?? null,
    endsOn: promotion.endsOn ?? null,
    daysMask: promotion.daysMask ?? null,
    priority: promotion.priority ?? DEFAULT_PRIORITY
  }
}

function ruleShape(rule: { scope: PromotionRuleScope; targetId?: number | null }): {
  scope: PromotionRuleScope
  targetId: number | null
} {
  return { scope: rule.scope, targetId: rule.targetId ?? null }
}

/**
 * A local Date -> ISO 'YYYY-MM-DD'. Never toISOString(), which would silently shift to UTC and run a
 * Sunday offer on a Saturday night in a shop east of Greenwich. (The same helper, and the same
 * reasoning, as `toIsoDate` in services/sales.ts.)
 */
function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today and a LAN server will call it tomorrow. The zod
 * messages are already written in language a shopkeeper reads.
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
 * THE ENGINE'S OWN TYPES, re-exported from the service that produces them — so a caller (sales.ts, the
 * IPC layer, a test) types its variables off `promotions.LinePromotion` rather than reaching past this
 * service into @shared for the shape of what this service returns. The definitions live in
 * shared/promotions.ts because the Sell screen previews an offer through the same contract.
 */
export type { LinePromotion, LinePromotionResult, PromotableLine } from '@shared/promotions'
