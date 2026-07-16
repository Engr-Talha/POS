import { z } from 'zod'
import type { PagedResult } from './sales'

/**
 * THE PROMOTIONS CONTRACT — the types and input schemas main and renderer agree on. (Migration 0018,
 * whose header is the spec; read it first.)
 *
 * ── A PROMOTION IS A LINE DISCOUNT. THAT IS THE WHOLE DESIGN. ───────────────────────────────────────
 * It invents no new kind of money, no new journal leg and no new money column on a sale. It computes a
 * discount, and from there it travels the road that is already proven and already tested:
 *
 *     sale_lines.line_discount  →  priceCart re-resolves tax on what is ACTUALLY paid
 *                               →  DR Discounts Given (4200, contra-income) at its ex-tax value
 *                               →  frozen onto the line, so a RETURN refunds what was really charged
 *
 * ── THE RULES ARE DATA. THE ARITHMETIC IS CODE. ─────────────────────────────────────────────────────
 * A shop writes its own offers in Settings; nobody edits TypeScript to run a Sunday special
 * (CLAUDE.md §4). But `kind` is a CHECK, not a lookup, because adding a kind means writing the code
 * that computes it.
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ──────────────────────────────────────────────
 * A cart line never sends a discount a promotion "should" give. The engine (`applyTo`) resolves every
 * offer against the catalog in MAIN and computes the discount itself, exactly as `priceCart` resolves
 * every price. A renderer that could name its own promotion discount could sell at any price it liked.
 *
 * ── MONEY / QUANTITY / PERCENT ARE ALL INTEGERS. NEVER A FLOAT. (CLAUDE.md §4) ──────────────────────
 *   `amountMinor`  2-dp integer minor units (paisa)     shared/money.ts
 *   `buyQtyM` / `getQtyM`  3-dp integer thousandths     shared/qty.ts   (1 piece = 1000)
 *   `percentBp`    BASIS POINTS — 10% = 1000, 100% = 10000               shared/tax.ts
 */

// ── Schema primitives ──────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches the service (and by the service itself — the services
// layer is the real boundary, CLAUDE.md §3). We send ONLY the editable fields and use `.nullish()` for
// the nullable columns. (CLAUDE.md §4, trap #18 — never POST a whole object back.)

const RowId = z.number().int().positive()

/**
 * ISO date, YYYY-MM-DD — and a REAL calendar date. The shape alone lets 2026-02-30 through, and JS
 * silently rolls it to March 2, so an offer typed at the service/LAN boundary would run on days nobody
 * chose, with no error. Reject anything whose parts do not round-trip.
 * (Copied from shared/expenses.ts, where the audit that found this is written up.)
 */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')
  .refine((value) => {
    const parts = value.split('-')
    const year = Number(parts[0])
    const month = Number(parts[1])
    const day = Number(parts[2])
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
      date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    )
  }, 'That is not a real calendar date.')

/**
 * WHICH DAYS an offer runs — 7 characters of '0'/'1', MONDAY FIRST. '0000011' is weekends only.
 * NULL/absent = every day. The mask's index is NOT JS's `getDay()`; see `DAYS_MASK_LENGTH` below and
 * `dayIndexOf` for the mapping, which is the one thing about this field that can silently be wrong.
 */
const DaysMask = z
  .string()
  .trim()
  .regex(/^[01]{7}$/, 'Please choose which days this offer runs on.')
  .refine((value) => value.includes('1'), 'An offer must run on at least one day of the week.')

/** Basis points: 10% = 1000. The table CHECKs 0 < percent_bp <= 10000; 100% off IS a legal giveaway. */
const PercentBp = z
  .number()
  .int('That percentage is not valid.')
  .positive('Please enter a discount greater than zero.')
  .max(10_000, 'A discount cannot be more than 100%.')

/** 2-dp integer money, > 0. A promotion that takes off nothing is not an offer. */
const PositiveMoneyMinor = z
  .number()
  .int('That amount is not valid.')
  .positive('Please enter an amount greater than zero.')

/** 3-dp integer thousandths, > 0. 1 piece = 1000; a weighed offer may use 500 (half a kg). */
const PositiveQtyM = z
  .number()
  .int('That quantity is not valid.')
  .positive('Please enter a quantity greater than zero.')

// ── The kinds, and the scopes ──────────────────────────────────────────────────

/**
 * WHAT KIND of offer. Mirrors the CHECK on promotions.kind (migration 0018). The engine branches on it,
 * so it is a closed list, not a lookup: adding a kind means writing the arithmetic that computes it.
 *
 *   'percent_off'   percentBp off the matching line's own extended price
 *   'amount_off'    amountMinor off each matching UNIT (qty_m thousandths — 1.5 units gets 1.5×)
 *   'buy_x_get_y'   for every (buyQtyM + getQtyM), getQtyM is 100% off
 *   'fixed_price'   the matching unit sells at amountMinor instead of its own price
 */
export const PROMOTION_KINDS = ['percent_off', 'amount_off', 'buy_x_get_y', 'fixed_price'] as const
export type PromotionKind = (typeof PROMOTION_KINDS)[number]

/**
 * WHAT a rule matches on. Mirrors the CHECK on promotion_rules.scope (migration 0018).
 * 'product' is one item; 'category'/'brand'/'department' a whole group (the lookup id); 'all' every
 * stocked item (a shop-wide sale).
 */
export const PROMOTION_RULE_SCOPES = ['product', 'category', 'brand', 'department', 'all'] as const
export type PromotionRuleScope = (typeof PROMOTION_RULE_SCOPES)[number]

/**
 * THE DAYS MASK IS MONDAY-FIRST, AND JS IS NOT. THIS IS THE MAPPING, AND IT LIVES IN ONE PLACE.
 *
 * `Date.getDay()` returns 0=Sunday, 1=Monday … 6=Saturday. The mask (migration 0018) is Monday-first:
 * index 0=Monday … 5=Saturday, 6=Sunday. Read the mask with getDay() directly and a weekend offer
 * ('0000011' = Sat+Sun) fires on THURSDAY and FRIDAY — off by exactly one, in a way that looks right
 * until a Saturday arrives.
 *
 *     dayIndexOf(Sunday)    getDay()=0  ->  6
 *     dayIndexOf(Monday)    getDay()=1  ->  0
 *     dayIndexOf(Saturday)  getDay()=6  ->  5
 *
 * LOCAL time, not UTC: "Sunday" means Sunday to the shopkeeper standing at the till. Near midnight the
 * local day and the UTC day are different days, and the one on the shop's wall is the local one — the
 * same reasoning as `quoteValidUntil` in services/sales.ts.
 */
export const DAYS_MASK_LENGTH = 7

/** MONDAY-FIRST day index (0=Monday … 6=Sunday) of a local Date. The one mapping. See above. */
export function dayIndexOf(date: Date): number {
  return (date.getDay() + 6) % DAYS_MASK_LENGTH
}

/** Does this MONDAY-FIRST mask run on this date? A null/absent mask runs every day. */
export function maskRunsOn(daysMask: string | null | undefined, date: Date): boolean {
  if (daysMask == null) return true
  return daysMask[dayIndexOf(date)] === '1'
}

/** Human labels for the mask, Monday first — so a screen and a test agree on which box is which. */
export const DAYS_MASK_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
] as const

// ── Read types (row side) ──────────────────────────────────────────────────────

/**
 * ONE OFFER, as stored (migration 0018). Which knob is meaningful depends on `kind`, and the SERVICE
 * validates that pairing — SQLite cannot express "percentBp is required IF kind='percent_off'".
 */
export type Promotion = {
  id: number
  /** What the cashier and the customer see. FROZEN onto a sale line when it fires (name_snapshot). */
  name: string
  description: string | null
  kind: PromotionKind
  /** BASIS POINTS — 'percent_off' only. 10% = 1000. Null for every other kind. */
  percentBp: number | null
  /** 2-dp money — 'amount_off' (per unit) and 'fixed_price' (the unit price). Null otherwise. */
  amountMinor: number | null
  /** 3-dp qty — 'buy_x_get_y' only: how many must be bought. Null otherwise. */
  buyQtyM: number | null
  /** 3-dp qty — 'buy_x_get_y' only: how many come free. Null otherwise. */
  getQtyM: number | null
  /** ISO date — NULL means "since forever". A DAY, not a timestamp: a shop thinks in days. */
  startsOn: string | null
  /** ISO date — NULL means "until further notice". Inclusive: an offer ending the 14th runs all of it. */
  endsOn: string | null
  /** 7 chars of '0'/'1', MONDAY FIRST. NULL = every day. See `dayIndexOf`. */
  daysMask: string | null
  /** LOWER runs first. Only ONE promotion ever discounts a line — the first that matches takes it. */
  priority: number
  /** An offer is switched OFF, never deleted: last March's sales must still explain themselves. */
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** WHAT an offer applies to. A promotion with NO rules applies to NOTHING (migration 0018). */
export type PromotionRule = {
  id: number
  promotionId: number
  scope: PromotionRuleScope
  /** products.id for 'product', the lookup id for a group scope, NULL for 'all'. */
  targetId: number | null
  createdAt: string
}

/** An offer with its rules — what the Settings screen edits, and what `activeFor` hands the engine. */
export type PromotionDetail = Promotion & {
  rules: PromotionRule[]
}

/** One page of the promotions list. Paginated and indexed, always (CLAUDE.md §4). */
export type PromotionList = PagedResult<Promotion>

export type { PagedResult }

// ── The engine's own types ─────────────────────────────────────────────────────

/**
 * WHAT THE ENGINE NEEDS TO KNOW ABOUT A CART LINE — and nothing more.
 *
 * Deliberately NOT a `SaleLineInput`: the engine is handed lines whose prices MAIN has already resolved
 * from the catalog, so it never re-reads a price and can never be told one. Keeping this shape minimal
 * is what lets the Sell screen preview an offer through the same code that freezes it.
 */
export type PromotableLine = {
  /** products.id. NULL for an OPEN ITEM, which no promotion can ever match — it has no catalog row. */
  productId: number | null
  /** 3-dp qty of what is PRICED (a carton line is 1000 — one carton), matching PricedLine.pricedQtyM. */
  qtyM: number
  /** 2-dp money — the price of ONE of what is priced, as MAIN resolved it. */
  unitPrice: number
  /** 2-dp money — the line's own extended price (unitPrice × qtyM / 1000), as MAIN computed it. */
  lineAmount: number
}

/**
 * WHAT AN OFFER GAVE ONE LINE — the discount, and WHICH offer gave it, ready to freeze.
 *
 * `promotionName` is the name TODAY, captured for `sale_line_promotions.name_snapshot`: renaming or
 * switching an offer off must never rewrite what an old sale says it cost (migration 0018).
 */
export type LinePromotion = {
  promotionId: number
  /** The name AT THIS INSTANT — frozen onto the sale line by the caller. */
  promotionName: string
  /** 2-dp money, >= 0 — never negative, never more than the line's own price. */
  discountMinor: number
}

/**
 * THE ENGINE'S ANSWER, one entry per cart line, IN THE SAME ORDER as the lines it was given.
 * NULL where no offer matched — which is most lines, most of the time.
 */
export type LinePromotionResult = LinePromotion | null

// ── Input schemas ──────────────────────────────────────────────────────────────

/**
 * The knobs, all optional at the SHAPE level — the kind/knob pairing is validated by
 * `refineKindKnobs` below, which is what turns "percent_off with an amount" into a sentence the owner
 * can act on rather than a zod type error nobody can read.
 */
const KnobFields = {
  percentBp: PercentBp.nullish(),
  amountMinor: PositiveMoneyMinor.nullish(),
  buyQtyM: PositiveQtyM.nullish(),
  getQtyM: PositiveQtyM.nullish()
}

const WindowFields = {
  /** ISO date — omit for "since forever". */
  startsOn: IsoDate.nullish(),
  /** ISO date — omit for "until further notice". Inclusive. */
  endsOn: IsoDate.nullish(),
  /** 7 chars '0'/'1', MONDAY FIRST — omit for every day. */
  daysMask: DaysMask.nullish()
}

/**
 * WHICH KNOB BELONGS TO WHICH KIND — the pairing SQLite cannot express, stated ONCE.
 *
 * A knob that does not belong to the kind is REFUSED, not ignored. An offer created as
 * `{ kind: 'percent_off', percentBp: 1000, amountMinor: 5000 }` has TWO readings — "10% off" or "Rs 50
 * off" — and whichever the engine happens to pick, the owner set the other one. A half-described offer
 * must never reach the till, so it is refused here, in plain language, at the boundary.
 */
const KIND_KNOBS: Record<PromotionKind, ReadonlyArray<keyof typeof KnobFields>> = {
  percent_off: ['percentBp'],
  amount_off: ['amountMinor'],
  buy_x_get_y: ['buyQtyM', 'getQtyM'],
  fixed_price: ['amountMinor']
}

const KNOB_LABEL: Record<keyof typeof KnobFields, string> = {
  percentBp: 'a percentage',
  amountMinor: 'an amount',
  buyQtyM: 'how many to buy',
  getQtyM: 'how many are free'
}

const KIND_LABEL: Record<PromotionKind, string> = {
  percent_off: 'a percentage off',
  amount_off: 'an amount off each unit',
  buy_x_get_y: 'buy some, get some free',
  fixed_price: 'a fixed price'
}

const ALL_KNOBS = Object.keys(KnobFields) as Array<keyof typeof KnobFields>

/**
 * Enforce the kind/knob pairing and the date window on a fully-formed input. Attached with
 * `.superRefine` so EVERY problem is reported at once and against the field that is wrong — an owner
 * fixing an offer one error at a time is an owner who gives up halfway and leaves it half-described.
 */
function refineKindKnobs(
  value: {
    kind: PromotionKind
    percentBp?: number | null
    amountMinor?: number | null
    buyQtyM?: number | null
    getQtyM?: number | null
    startsOn?: string | null
    endsOn?: string | null
  },
  ctx: z.RefinementCtx
): void {
  const required = KIND_KNOBS[value.kind]

  for (const knob of ALL_KNOBS) {
    const supplied = value[knob] != null
    const belongs = required.includes(knob)

    if (belongs && !supplied) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [knob],
        message: `An offer of "${KIND_LABEL[value.kind]}" needs ${KNOB_LABEL[knob]}. Please fill it in.`
      })
    }

    if (!belongs && supplied) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [knob],
        message: `An offer of "${KIND_LABEL[value.kind]}" does not use ${KNOB_LABEL[knob]}. Please remove it.`
      })
    }
  }

  // An offer that ends before it starts runs on NO day, and nobody meant that. It is a typo, and it is
  // caught here rather than at the till, where it would look like "the offer just isn't working".
  if (value.startsOn != null && value.endsOn != null && value.endsOn < value.startsOn) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsOn'],
      message: 'The offer cannot end before it starts. Please check the dates.'
    })
  }
}

/**
 * CREATE AN OFFER. The rules are set separately (`setRules`) — an offer with no rules applies to
 * NOTHING and is safe to exist while the owner is still deciding what it covers (migration 0018).
 *
 * ABSENT, ON PURPOSE:
 *   isActive — a new offer is ON. Switching one off is `deactivate`, which is audited.
 */
export const CreatePromotionInput = z
  .object({
    name: z.string().trim().min(1, 'Please give this offer a name.').max(120),
    description: z.string().trim().max(1000).nullish(),
    kind: z.enum(PROMOTION_KINDS, { error: 'Please choose what kind of offer this is.' }),
    ...KnobFields,
    ...WindowFields,
    /** LOWER runs first. Defaults to the table's own default (100) when omitted. */
    priority: z.number().int().min(0).max(10_000).optional()
  })
  .superRefine(refineKindKnobs)

/**
 * EDIT AN OFFER. The kind AND its knobs are sent together, because they only make sense together —
 * the pairing check needs the kind to know which knobs belong. This is NOT "POST the whole object
 * back" (trap #18): `isActive`, `createdAt` and the rules are deliberately absent, so an edit can
 * never silently switch an offer on or wipe what it applies to.
 */
export const UpdatePromotionInput = z
  .object({
    id: RowId,
    name: z.string().trim().min(1, 'Please give this offer a name.').max(120),
    description: z.string().trim().max(1000).nullish(),
    kind: z.enum(PROMOTION_KINDS, { error: 'Please choose what kind of offer this is.' }),
    ...KnobFields,
    ...WindowFields,
    priority: z.number().int().min(0).max(10_000).optional()
  })
  .superRefine(refineKindKnobs)

/** SWITCH AN OFFER OFF. Never a delete: last March's sales must still explain themselves. */
export const DeactivatePromotionInput = z.object({ id: RowId })

export const GetPromotionInput = z.object({ id: RowId })

/** List offers — paginated and indexed, always (CLAUDE.md §4). */
export const ListPromotionsInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** Omit for every offer; true for the live ones only; false for the switched-off ones. */
  isActive: z.boolean().optional(),
  /** Match on the offer's name. */
  search: z.string().trim().max(120).optional()
})

/**
 * ONE RULE. 'all' takes NO target; every other scope REQUIRES one — the table CHECKs it, and this
 * refuses it first, in language the owner reads. A rule saying "category: (nothing)" would match
 * either everything or nothing depending on how the SQL fell out, so it cannot exist.
 */
export const PromotionRuleInput = z
  .object({
    scope: z.enum(PROMOTION_RULE_SCOPES, { error: 'Please choose what this offer applies to.' }),
    /** products.id for 'product', the lookup id for a group scope, omitted for 'all'. */
    targetId: RowId.nullish()
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'all' && value.targetId != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: 'An offer that applies to everything cannot also name one item. Please remove it.'
      })
    }
    if (value.scope !== 'all' && value.targetId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: 'Please choose which item or group this offer applies to.'
      })
    }
  })

/**
 * SET WHAT AN OFFER APPLIES TO — the whole set, replacing whatever was there.
 *
 * An EMPTY list is legal and it means "this offer applies to NOTHING" (migration 0018). That is the
 * safe direction: an owner who clears the rules stops the offer dead rather than accidentally applying
 * it shop-wide, which is the very typo the table's design exists to prevent.
 */
export const SetPromotionRulesInput = z.object({
  promotionId: RowId,
  rules: z.array(PromotionRuleInput).max(500)
})

export const ListPromotionRulesInput = z.object({ promotionId: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────────

export type CreatePromotionInput = z.infer<typeof CreatePromotionInput>
export type UpdatePromotionInput = z.infer<typeof UpdatePromotionInput>
export type DeactivatePromotionInput = z.infer<typeof DeactivatePromotionInput>
export type GetPromotionInput = z.infer<typeof GetPromotionInput>
export type ListPromotionsInput = z.infer<typeof ListPromotionsInput>
export type PromotionRuleInput = z.infer<typeof PromotionRuleInput>
export type SetPromotionRulesInput = z.infer<typeof SetPromotionRulesInput>
export type ListPromotionRulesInput = z.infer<typeof ListPromotionRulesInput>
