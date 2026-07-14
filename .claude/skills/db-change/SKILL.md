---
name: db-change
description: Change the database schema. Use for any new table, column, index, or migration. Enforces forward-only migrations, integer money/quantity, and derived stock.
---

# Change the database

## The rules you cannot break

1. **Forward-only.** Never drop or rename a column that holds user data. Add a new column and backfill.
   A shop already has years of data in there; a "clean up" migration is how you destroy it.
2. **Money is INTEGER minor units.** Never `REAL`. Never floats. 2 decimals fixed.
3. **Quantity is INTEGER thousandths** (`qty_m`). 1 pc = 1000, 1.234 kg = 1234.
4. **Tax rate is basis points** (17% = 1700).
5. **Stock is DERIVED from `stock_movements`.** Never add a mutable stock column. If you need speed,
   add to `stock_cache` — rebuildable, and a test asserts it equals `SUM(qty_m)`.
6. **Index every foreign key and every column a list filters or sorts by.** Assume 100k+ rows.

## Steps

1. Add `src/main/db/migrations/NNNN_what_it_does.ts` — the next number, never reusing one.
   Each migration runs **inside a transaction** and is recorded in `schema_migrations`.
2. Update the zod schemas + types in `src/shared/`. Main and renderer share them.
3. Update the service in `src/main/services/`. **Logic lives here, not in the IPC handler.**
4. If the change touches money, stock, or a party balance: **it must post a journal entry.**
   Double-entry is day one — see the posting engine. Every journal balances.
5. Write the vitest test. Migration runs on an empty DB *and* on a seeded one.
6. Run `npm test`, then **build and open the packaged app** — a migration that only ran in dev has
   not been tested.

## Nullable columns
Use `.nullish()` in the zod schema for nullable columns, and **never POST the whole object back to a
save endpoint** (trap #18 — that is how the saved logo and signature got wiped). Send only the fields
the form actually edited.

## Derived state (trap #17)
If a value is derived (invoice paid/unpaid, stock on hand, customer balance, loyalty points):
**prefer recomputing it on read.** If you cache it, *every* write path must update it — including the
one that bites: a payment recorded from the customer-ledger screen must flip the invoice to PAID.
Write the test that pays from the *other* screen.
