import { z } from 'zod'

/**
 * THE CUSTOMER LEDGER CONTRACT — the types and input schemas main and renderer agree on. (Migration
 * 0009, Phase 7.)
 *
 * This supersedes the MINIMAL customer contract that has lived in `shared/opening.ts` since Phase 4,
 * when a customer existed only so that opening udhaar had somebody to be owed by. Phase 7 turns the
 * customer into a real party the shop keeps a running account with: business/tax details for a proper
 * invoice, a default price tier, and the payments that bring an udhaar balance back down.
 *
 * ── WHAT IS STILL ABSENT, DELIBERATELY: A BALANCE. ──────────────────────────────────────────────────
 * What a customer owes is DERIVED, never stored, exactly as stock is derived from movements
 * (CLAUDE.md §4):
 *
 *       opening udhaar  +  credit sales  −  customer_payments
 *
 * There is no `balance` column, no field on the form to type one into, and there never will be. A
 * typed balance is one that can silently disagree with the rows behind it — and then the shop chases a
 * customer for money the ledger says they do not owe. The ledger page below RECOMPUTES on read, and it
 * MUST show the same figure whether a payment was taken from the sell screen or from the ledger screen
 * itself (CLAUDE.md trap #17). `CustomerLedgerRow.balanceAfter` and `CustomerLedgerPage.balance` are
 * computed, returned, and never persisted.
 *
 * ── MONEY IS INTEGER MINOR UNITS (2 dp). NEVER A FLOAT. NEVER A `REAL`. ──────────────────────────────
 * `creditLimit`, `amount`, `charge`, `payment`, `balance` are all 2-dp money in minor units (paisa).
 * Format only at display time, with `shared/money.ts` (`formatMoney`). A `price_tier` is an enum, not a
 * lookup — the pricing engine reads it by value; the shop's payment methods, by contrast, ARE
 * lookups-driven (`methodLookupId` -> lookups('payment_method')).
 */

// ── Enums & constants ────────────────────────────────────────────────────────

/**
 * A customer's DEFAULT price tier. NOT `'customer'`: that tier means "use this customer's own
 * per-customer prices" and is a choice made at the till, not a default stored on the record. A
 * customer defaults to retail or wholesale, or to null — "fall back to the shop default".
 */
export const CUSTOMER_PRICE_TIERS = ['retail', 'wholesale'] as const
export type CustomerPriceTier = (typeof CUSTOMER_PRICE_TIERS)[number]

/**
 * The kinds of line a customer's udhaar statement is built from. An `opening` balance and a `sale` on
 * credit RAISE what they owe (a charge); a `payment` and a `return` credited to the account LOWER it.
 * The ledger service tags every row so the screen can render and total them without re-deriving the kind.
 */
export const CUSTOMER_LEDGER_KINDS = ['opening', 'sale', 'payment', 'return'] as const
export type CustomerLedgerKind = (typeof CUSTOMER_LEDGER_KINDS)[number]

// ── Row types ────────────────────────────────────────────────────────────────

/**
 * A customer, with the fields Phase 7 (migration 0009) added. The new four are all nullable — a retail
 * walk-in added before this build simply has null for each, which is the truth about them.
 *
 * NOTE WHAT IS ABSENT: a balance. What the customer owes is derived from the ledger (see the file
 * header). `creditLimit` is a LIMIT — how much udhaar they are ALLOWED to run up — not a debt.
 */
export type Customer = {
  id: number
  name: string
  phone: string | null
  address: string | null
  /** lookups('customer_type'). Never a hardcoded <Select>. */
  typeLookupId: number | null
  /** 2-dp money. How much udhaar they may run up. A LIMIT, not a balance. */
  creditLimit: number
  /** The SHOP name a wholesale/business customer trades under. Printed on their tax invoice. (0009) */
  businessName: string | null
  /** Their NTN/STRN — what a sales-tax invoice to a registered buyer must carry. (0009) */
  taxNumber: string | null
  /** Anything the owner wants to remember about this customer. Free text. (0009) */
  notes: string | null
  /** This customer's default price tier. Null = fall back to the shop default. (0009) */
  priceTier: CustomerPriceTier | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * One udhaar repayment. Money coming IN, paying a customer's balance DOWN — the CREDIT side of the
 * derived balance, never a balance itself.
 *
 * Posts DR Cash/Bank/wallet, CR Accounts Receivable; `journalId` links that balanced journal. A split
 * settlement (part cash, part cheque) is MANY of these rows, each with its own method — there is no
 * "methods array", the same shape a sale's payments use.
 */
export type CustomerPayment = {
  id: number
  customerId: number
  /** ISO8601. WHEN the money changed hands (MAIN's clock). */
  at: string
  /** 2-dp money, always POSITIVE — udhaar paid down. */
  amount: number
  /** lookups('payment_method') — cash / bank / jazzcash / easypaisa / cheque... */
  methodLookupId: number
  /** For a cheque payment. Null otherwise. */
  chequeNo: string | null
  /** ISO date on the cheque. Null otherwise. */
  chequeDate: string | null
  /** A mobile-wallet transaction id (JazzCash/Easypaisa). Null otherwise. */
  walletRef: string | null
  note: string | null
  /** Who took the payment. Null only for a row written before users were recorded. */
  userId: number | null
  /** The balanced journal this payment posted. Null only mid-transaction, before it is attached. */
  journalId: number | null
  createdAt: string
}

/**
 * ONE LINE of a customer's udhaar statement — a charge or a payment, with the running balance after it.
 *
 * `charge` and `payment` are mutually exclusive: a charge row (opening balance, credit sale) carries a
 * positive `charge` and a zero `payment`; a payment row is the reverse. `balanceAfter` is the running
 * total AFTER this row, at this point in the customer's history — DERIVED on read, never stored. All
 * three are 2-dp money.
 */
export type CustomerLedgerRow = {
  kind: CustomerLedgerKind
  /** The id of the underlying row: opening_receivables.id, sales.id, or customer_payments.id. */
  refId: number
  /** ISO8601 — when this entry is dated. The statement is ordered by it. */
  at: string
  /** Cashier-readable: the invoice number, "Opening balance", or the payment method + reference. */
  description: string
  /** 2-dp money. What this row ADDED to what the customer owes. 0 on a payment row. */
  charge: number
  /** 2-dp money. What this row TOOK OFF what the customer owes. 0 on a charge row. */
  payment: number
  /** 2-dp money. Running balance after this row, in the customer's history. Derived, never stored. */
  balanceAfter: number
}

/**
 * A page of a customer's ledger, PLUS the figures the statement header needs.
 *
 * Paginated like every list in the app — assume 100k+ rows (CLAUDE.md §4). `balance` is what the
 * customer owes RIGHT NOW across their whole history (not just this page), and `creditLimit` is what
 * they are allowed to owe — the two the "over their limit" warning compares. Both are DERIVED/read
 * straight from the record; neither is a stored running total.
 */
export type CustomerLedgerPage = {
  customerId: number
  rows: CustomerLedgerRow[]
  /** Total statement lines for this customer (for the pager). */
  total: number
  page: number
  pageSize: number
  /** 2-dp money. What the customer owes now: opening + credit sales − payments. Derived on read. */
  balance: number
  /** 2-dp money. The customer's credit limit (customers.credit_limit), for the over-limit warning. */
  creditLimit: number
}

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches a service (and by the service itself — the services layer
// is the real boundary, CLAUDE.md §3). The renderer is not trusted to have validated anything, and
// neither is a future LAN client.
//
// UPDATE / PAYMENT SCHEMAS CARRY ONLY WHAT THE FORM EDITS. On an update every field is optional:
//   undefined -> "the form did not touch this; leave the column alone"
//   null      -> "the user cleared it"   (that is what .nullish() is for)
// We NEVER post a whole object back to a save endpoint — it wipes fields the form never loaded.
// (CLAUDE.md §4, trap #18.)

/** Integer money, minor units. Unsigned — a credit limit is never negative. */
const MoneyMinor = z.number().int().min(0)
/** Integer money that must actually be an amount. A zero payment is not a payment. */
const PositiveMoneyMinor = z
  .number()
  .int()
  .positive('Please enter an amount greater than zero.')
const RowId = z.number().int().positive()
const LookupId = z.number().int().positive()

/** ISO date, YYYY-MM-DD. A cheque's date is a DAY, not a timestamp. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')

// ── Customers ────────────────────────────────────────────────────────────────

/**
 * Add a customer. Names are NOT unique (two real people share a name in a neighbourhood shop); the
 * phone number is what tells them apart. `typeLookupId` and `priceTier` are optional — a walk-in needs
 * neither.
 */
export const CreateCustomerInput = z.object({
  name: z.string().trim().min(1, 'Please enter the customer name.').max(200),
  phone: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  /** lookups('customer_type'). Never a hardcoded <Select>. */
  typeLookupId: LookupId.nullish(),
  /** 2-dp money. How much udhaar they may run up. A LIMIT, not a balance. */
  creditLimit: MoneyMinor.default(0),
  /** The wholesale/business customer's shop name. (0009) */
  businessName: z.string().trim().max(200).nullish(),
  /** Their NTN/STRN. (0009) */
  taxNumber: z.string().trim().max(50).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  /** Default price tier: retail or wholesale, or null to use the shop default. (0009) */
  priceTier: z.enum(CUSTOMER_PRICE_TIERS).nullish()
})

/**
 * Save an edit — ONLY the fields the form actually sent. Every field is optional; `.nullish()` on a
 * nullable column lets the user clear it. There is NO balance field: what a customer owes is derived
 * from the ledger. (See the file header, and CLAUDE.md trap #18.)
 */
export const UpdateCustomerInput = z.object({
  id: RowId,
  name: z.string().trim().min(1, 'Please enter the customer name.').max(200).optional(),
  phone: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  typeLookupId: LookupId.nullish(),
  creditLimit: MoneyMinor.optional(),
  businessName: z.string().trim().max(200).nullish(),
  taxNumber: z.string().trim().max(50).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  priceTier: z.enum(CUSTOMER_PRICE_TIERS).nullish(),
  isActive: z.boolean().optional()
  // NO BALANCE FIELD. What a customer owes is derived from the ledger. Not an oversight.
})

// ── Customer payments (udhaar paid back) ─────────────────────────────────────

/**
 * Record a payment against a customer's udhaar. It posts DR Cash/Bank/wallet, CR Receivable in the
 * same transaction — see migration 0009.
 *
 * `amount` is POSITIVE: a payment is money the shop RECEIVED. A negative "payment" would be a fresh
 * charge, and a charge is a credit sale — it goes through the sell screen, not here.
 *
 * `methodLookupId` -> lookups('payment_method'); the cheque/wallet fields are optional and belong to
 * their method (a cash payment fills none of them). A split settlement is TWO calls, one per method.
 *
 * ABSENT, ON PURPOSE:
 *   userId — who took the money comes from the authenticated session in MAIN, NEVER from the renderer.
 *   at     — MAIN stamps the payment with its own clock, like every other money movement in the app.
 */
export const RecordCustomerPaymentInput = z.object({
  customerId: RowId,
  /** 2-dp money, > 0 — udhaar being paid down. */
  amount: PositiveMoneyMinor,
  /** lookups('payment_method') — cash / bank / jazzcash / cheque... Never a hardcoded list. */
  methodLookupId: LookupId,
  chequeNo: z.string().trim().max(50).nullish(),
  chequeDate: IsoDate.nullish(),
  walletRef: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish()
})

// ── Customer ledger (the running statement) ──────────────────────────────────

/**
 * Ask for one page of a customer's ledger. Paginated because a long-standing customer has years of
 * charges and payments — assume 100k+ rows (CLAUDE.md §4). The current balance and credit limit come
 * back on the page itself (`CustomerLedgerPage`), derived on read.
 */
export const CustomerLedgerInput = z.object({
  customerId: RowId,
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

// ── Inferred input types ─────────────────────────────────────────────────────

export type CreateCustomerInput = z.infer<typeof CreateCustomerInput>
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerInput>
export type RecordCustomerPaymentInput = z.infer<typeof RecordCustomerPaymentInput>
export type CustomerLedgerInput = z.infer<typeof CustomerLedgerInput>
