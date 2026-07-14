---
name: engineering-standards
description: The non-negotiable correctness rules — integer money, integer quantity, tax, double-entry, derived state, errors, RBAC, audit, tests. Use before and after any change to business logic.
---

# Engineering standards

This app holds a shop's money. Correctness beats cleverness every time.

## Numbers

- **Money = INTEGER minor units (paisa/cents). NEVER a float. NEVER a `REAL` column.** 2 decimals fixed.
  Format only at display time.
- **Quantity = INTEGER thousandths** (`qty_m`). 1 pc = 1000; 1.234 kg = 1234. This is what makes weighed
  goods exact without floats.
- **Tax rate = basis points.** 17% = 1700.
- **No rounding.** No cash rounding, no rounding line. Exact to 2 decimals.
- Currency change in Settings changes the **label only** — it never converts stored values, and the UI
  says so.

## Tax

- Per product: the price was entered **inclusive** or **exclusive** (`price_entry_mode`). Both are shown
  in the product form and each computes the other. **A cart may mix both.**
- **Every sale line freezes `net`, `tax_rate_bp`, `tax_amount`, `gross` at sale time.** Never recompute
  a historical line from today's settings — last year's receipt must reprint identically.

## Double-entry (day one)

Every sale, purchase, payment, return, stock adjustment and expense **auto-posts a balanced journal**.
The cashier never sees debits or credits.

- **Invariant: `SUM(debit) == SUM(credit)` per journal.**
- **Standing test: the trial balance balances after every scenario.** Add your new scenario to it.
- Opening balances post against **Opening Balance Equity**, or day-one books are wrong.

## Derived state (trap #17)

Stock, invoice paid/unpaid, customer balance, loyalty points, supplier balance — all derived.
- **Stock is `SUM(stock_movements.qty_m)`.** There is no mutable stock column.
- **Prefer recompute-on-read.** If you cache, *every* write path updates it — and you write the test
  that proves it from the path that bites (pay an invoice from the **customer-ledger** screen; the
  invoice must show PAID).

## Errors

Every IPC handler returns:
```ts
{ ok: true, data } | { ok: false, error: { code, userMessage, technical } }
```
`userMessage` is plain language a cashier understands. `technical` goes to the log file. Never leak a
stack trace to the screen.

**Never POST the whole object back to a save endpoint** (trap #18) — it wipes fields the form never
loaded. Send only the editable fields; `.nullish()` for nullable columns.

## Security (enforced in MAIN — the renderer is not a security boundary)

- **RBAC:** Cashier / Supervisor / Manager / Owner. Checked in the service, not the UI.
- **License:** checked in main. Expired ⇒ **read-only**: they can still view, report, export, and
  **back up**. Never delete, hide, or encrypt their data.
- **Audit log:** user id + name + **role** + timestamp for every void, refund, over-threshold discount,
  price override, **no-sale drawer open**, **negative-stock sale**, price change, user change, and
  period lock/unlock. Sensitive actions carry a **reason code** (lookups-driven) + supervisor approval.
- **Negative stock:** warn, allow, **flag** — and the flag is visible in **every** list that row appears
  in (sales list, item history, reports).
- **Period lock:** a locked month rejects edits. Owner-only unlock, audit-logged.

## Migrations

**Forward-only.** Never drop or rename a column holding user data.

## Tests

- vitest for **every service**.
- **A regression test for every bug fixed.** No exceptions — that is how a trap becomes permanent.
- Run `npm rebuild better-sqlite3 --build-from-source` before tests (trap #10). It's in the `test`
  script; don't remove it.

## Done means

`typecheck` → `tests` → **the packaged installer built and launched** → an exact click-list handed to
the owner. Dev-only verification is not verification (trap #9).
