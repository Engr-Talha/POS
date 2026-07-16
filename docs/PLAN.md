# PLAN — Offline POS

Roadmap, data model, and screens. `CLAUDE.md` holds the rules; this holds the shape.

---

## 1. Decisions already locked

| Area | Decision |
|---|---|
| Money | INTEGER minor units, 2 decimals fixed. Never floats. |
| Quantity | INTEGER thousandths (`qty_m`). 1 pc = 1000, 1.234 kg = 1234. |
| Tax rate | Basis points (17% = 1700). Per-product rate + global default. Tax globally on/off. |
| Tax mode | **Per product**: price entered inclusive OR exclusive. Both shown in the product form, each computes the other. Mixed carts allowed. |
| Rounding | **None.** No cash rounding, no rounding line. |
| Currency/country | Configurable in Settings. Country drives tax defaults + date format. Currency change = **label only**, no conversion (UI warns). |
| Invoice numbers | **Sequential and gapless.** Configurable format (prefix, zero-pad, optional `{YYYY}`), optional yearly reset. A **voided invoice keeps its number** — never reused, never renumbered. |
| Stock | Derived from `stock_movements`. No mutable stock column. |
| Negative stock | **Warn, allow, flag.** Records user id + name + **role** + timestamp + audit entry, and the row is **visibly flagged in every list it appears in**. |
| Batches | Per-product `track_batches`. Cashier never picks a batch — **FEFO auto-pick** (first-expiry-first-out). |
| Double-entry | **Day one.** Every sale, purchase, payment, return, adjustment and expense auto-posts a balanced journal. The cashier never sees debits/credits. |
| Loyalty | Day one. Points per currency unit, redeem rules in Settings, per-customer balance. |
| License | Ed25519, offline, mandatory. Expiry → read-only, never data loss. |
| Publishing | **Deferred.** The updater ships in v0.1.0 anyway (see §3). |

## 2. Scope confirmed by the owner

| Feature | Decision |
|---|---|
| **Variants** (size/color) | **Build in v1.** Variant group + child products, each with its own SKU, barcode, price, stock. Catalog UI in Phase 3; variant picker on the Sell screen in Phase 5. |
| **Serial / IMEI tracking** | **Build in v1.** Per-product `track_serials` flag. Serial captured at purchase and at sale. **Only flagged products prompt** — a grocery item must still scan in one keystroke. |
| **Quotations** | **Build in v1.** A quote is a `sales` row with `status='quote'` that takes **no invoice number** until it converts to a real sale. |
| **Promotions** (buy-2-get-1) | **Build in v1, in its own phase (8).** A rules engine that must interact correctly with line discounts, cart discounts, tax and the ledger — it goes in *after* selling, returns and the ledger are proven, not before. |
| **Multi-branch / transfers** | **No.** Single shop. A `branch_id` seam stays in the schema. Real multi-branch means branches *share* data, which per trap #20 requires a server process owning the DB — that is the LAN phase, not an offline file. |

**Sequencing principle:** these are additive to the core POS, not prerequisites for it. The schema
carries all of them from Phase 3 so nothing needs a migration later, but the core sell → return →
ledger loop must work first.

## 3. Release & update strategy

Publishing to GitHub is **deferred** — but per trap #1 the **updater ships inside v0.1.0** or no
installed app can ever update itself.

- v0.1.0 wires `electron-updater` against a placeholder public releases repo. On launch it checks,
  finds nothing, and **stays silent**. No error is ever shown to the cashier for a failed update check.
- Phase 0 proves the updater **end-to-end** using electron-updater's **`generic` provider** pointed at
  a local HTTP folder: install v0.1.0, serve v0.1.1, watch the installed app update itself with zero
  clicks. This de-risks the whole thing before GitHub exists.
- **Windows `.exe` is built in GitHub Actions as a workflow artifact** (`--publish never`, no release).
  Cross-building Windows from macOS is unreliable. macOS `.dmg` is built locally (ad-hoc signed) for
  the dev loop.
- **Later phase:** flip the publish target to a real public releases repo, `releaseType: "release"`,
  PAT in CI secrets only.

### Proven in Phase 0 (v0.1.0, local `generic` feed)

An installed **v0.1.0** was pointed at a local HTTP folder serving **v0.1.1**. With no clicks it did:

```
[updater] Checking for update
[updater] Found version 0.1.1
[updater] Downloading update ...
[updater] New version 0.1.1 has been downloaded
[updater] 0.1.1 downloaded — it will install silently when the app quits
```

So the whole chain — feed resolution → version compare → download → hand-off to the OS installer —
**works**, and GitHub is now just a different URL.

**The macOS install step then failed**, exactly as trap #7 predicts:
`Code signature ... did not pass validation`. **Squirrel.Mac requires a real Apple Developer
certificate** and rejects our ad-hoc signature. This is a macOS-only limitation — Windows NSIS does
no such check, which is **why Windows is the real target and macOS is only the dev loop.** The
remaining unknown is the Windows install step, and that is verified by installing the CI `.exe` on
the owner's Windows machine.

## 4. Data model

Conventions: `*_at` = ISO8601 UTC text. Money = INTEGER minor units. Qty = INTEGER `qty_m`
(thousandths). Every table gets `created_at`; user-editable tables get `updated_at`. Every foreign key
and every list-filter column gets an index.

### Platform
- **`schema_migrations`** — `version`, `name`, `applied_at`
- **`settings`** — `key`, `value_json`. Namespaced: `shop.*`, `tax.*`, `receipt.*`, `printer.*`,
  `scanner.*`, `loyalty.*`, `invoice.*`, `backup.*`
- **`lookups`** — `id`, `list_key`, `code`, `label`, `sort_order`, `is_active`, `is_system`.
  **Every dropdown in the app reads from here.** Lists: `payment_method`, `category`, `uom`,
  `void_reason`, `refund_reason`, `discount_reason`, `adjustment_reason`, `expense_category`,
  `customer_type`, `supplier_type`.
- **`users`** — `id`, `username`, `full_name`, `password_hash`, `pin_hash`, `role`, `is_active`
- **`audit_log`** — `id`, `at`, `user_id`, `user_name`, `user_role`, `action`, `entity`, `entity_id`,
  `reason_code`, `reason_text`, `before_json`, `after_json`, `approved_by_user_id`
- **`license`** — `key_text`, `licensee`, `machine_id`, `plan`, `issued_at`, `expires_at`,
  `features_json`, `status` (`active|expired|tampered|none`), `activated_at`
- **`clock_guard`** — `last_seen_at` (mirrored to a file outside the DB; a backwards jump ⇒ tampered)
- **`attachments`** — `id`, `entity_type`, `entity_id`, `file_name`, `stored_path`, `mime`, `size`,
  `sha256`. Files are **copied into app data** and are **included in backups**.

### Accounting (posting engine — exists before any sale can be made)
- **`accounts`** — `id`, `code`, `name`, `type` (`asset|liability|equity|income|expense`), `parent_id`,
  `is_system`. Seeded chart of accounts: Cash, Bank, Inventory, Accounts Receivable, Accounts Payable,
  Sales, Sales Returns, COGS, Tax Payable, Discounts, Expenses, Owner's Equity, Opening Balance Equity,
  Stock Adjustment, Loyalty Liability.
- **`journals`** — `id`, `at`, `ref_type`, `ref_id`, `memo`, `created_by`, `period_id`
- **`journal_lines`** — `id`, `journal_id`, `account_id`, `debit`, `credit` (both INTEGER, one is 0)
  - **Invariant: `SUM(debit) == SUM(credit)` per journal.** Enforced in the engine, asserted by a
    standing test: *the trial balance balances after every scenario.*
- **`periods`** — `id`, `year`, `month`, `status` (`open|locked`), `locked_by`, `locked_at`.
  **Period lock:** a locked period rejects new/edited entries. **Owner-only unlock**, audit-logged.

### Catalog & stock
- **`categories`** — `id`, `name`, `parent_id`, `is_active`
- **`products`** — `id`, `sku` (STOCK CODE), `name`, `name_other_lang` (Urdu — printable on the
  receipt; UI is bilingual), `department_id`, `category_id`, `sub_category_id`, `brand_id`,
  `location_id`, `favourite_group_id` (all **`lookups`-driven**), `sale_uom_id`, `base_pack_size`,
  `size_volume`, `cost_price` (**4-dp**), `retail_price`, `wholesale_price`, `wholesale_margin_bp`,
  `tax_rate_bp`, `price_entry_mode` (`inclusive|exclusive`), `is_tax_exempt`, `item_type`
  (`inventory|non_inventory`), `track_batches`, `is_weighted`, `min_stock_m` (RE-ORDER LEVEL),
  `image_path`, `is_active`, `variant_group_id`, `attributes_json` (e.g. `{size:"M", color:"red"}`),
  `track_serials`
  - **The price chain** (from the legacy form, computed live in the form, only the inputs stored):
    supplier price → discount → **cost price** → unit cost → **retail price** (+ profit %) →
    **wholesale price** (+ margin %) → net profit. Derived figures (profit %, net profit, unit cost)
    are **never stored as typed-in truth** — they recompute from cost + prices.
  - **BALANCE QUANTITY is READ-ONLY here.** The legacy form let you type over stock; we don't. Stock
    is `SUM(stock_movements.qty_m)`, an opening figure comes from the Opening Setup wizard, and a
    correction comes from an approved stock take. The field shows the derived on-hand.
  - **Show History** → the item's full `stock_movements` + price-change audit trail.
- **`variant_groups`** — `id`, `name`, `attribute_keys_json` (e.g. `["size","color"]`). A group's child
  products each carry their own SKU, barcode, price and stock. The Sell screen shows a **variant picker**.
- **`serial_numbers`** — `id`, `product_id`, `serial`, `status` (`in_stock|sold|returned`),
  `purchase_id`, `sale_id`, `at`. Captured at purchase and at sale — **only for `track_serials` products**,
  so a normal item still scans in one keystroke.
- **`product_barcodes`** — `product_id`, `barcode` (a product may have many). Unique index on `barcode`.
- **`barcode_replacements`** — `product_id`, `old_barcode`, `new_barcode`, `at`, `user_id`. From the
  legacy "Replace Barcode" panel: when a barcode changes, **old labels already stuck on shelf stock
  must still scan.** Old barcodes are never deleted — they resolve to the product forever.
- **`product_suppliers`** — `product_id`, `supplier_id`, `supplier_item_code`, `supplier_price`
  (**4-dp cost**), `discount`, `is_preferred`. A product has **many suppliers, each with its own item
  code and its own price**. (Legacy "Multiple Supplier" panel.)
- **`product_packs`** — `product_id`, `uom_id`, `pack_size` (units of the base UOM), `cost` (**4-dp**),
  `retail_price`, `wholesale_price`, `barcode`. The legacy "Alternate Packings" grid: PCS / box /
  carton, **each with its own cost, retail, wholesale and barcode**. This supersedes a single
  purchase→sale conversion factor — the base sale unit is one row, larger packs are more rows.
- **`customer_prices`** — `customer_id`, `product_id`, `price` (optional per-customer tier)
- **`batches`** — `id`, `product_id`, `batch_no`, `expiry_date`, `cost_price`
- **`stock_movements`** — `id`, `at`, `type` (`opening|sale|purchase|sale_return|purchase_return|adjustment|damage|transfer`),
  `product_id`, `batch_id`, `qty_m` **(signed)**, `unit_cost`, `ref_type`, `ref_id`, `user_id`, `note`
  - **Stock on hand = `SUM(qty_m)`.** `stock_cache` is an optional rebuildable index of that sum; a
    test asserts they agree.
- **`stock_takes`** / **`stock_take_lines`** — count sheet → counted qty → variance → **approved**
  adjustment with reason + approver. **Never silently overwrite stock.**
- **`promotions`** / **`promotion_rules`** — rule-driven cart discounts (buy-2-get-1 etc.). Phase 8.
- *Seam only:* `branch_id` (single shop confirmed — see §7)

### Selling
- **`sales`** — `id`, `invoice_no`, `invoice_seq`, `invoice_year`, `at`, `customer_id`, `user_id`,
  `price_tier` (`retail|wholesale|customer`), `status` (`quote|held|completed|voided`), `subtotal_net`,
  `discount_amount`, `tax_total`, `grand_total`, `paid_total`, `change_due`,
  `had_negative_stock` **(the flag)**, `void_reason_code`, `voided_by`, `voided_at`,
  `exchange_group_id`
  - *FBR seam (Pakistan Tier-1, build later):* `fbr_invoice_no`, `fbr_qr`, `fbr_sync_status`,
    plus an offline **`sync_queue`** table so real-time FBR reporting can be added without a rewrite.
- **`sale_lines`** — `id`, `sale_id`, `product_id` (**nullable** — open/misc item), `name_snapshot`,
  `batch_id`, `qty_m`, `unit_price`, `line_discount`, `net_amount`, `tax_rate_bp`, `tax_amount`,
  `gross_amount`, `tax_mode`, `is_open_item`, `price_override_by`
- **`sale_payments`** — `id`, `sale_id`, `method_lookup_id`, `amount`, `cheque_no`, `cheque_date`,
  `wallet_ref`. **Split payment** = many rows. **Credit (udhaar)** = a payment row that creates a
  customer receivable.
- **`invoice_counters`** — `series`, `year`, `next_seq`. Incremented **in the same transaction** as the
  sale insert. This is what makes numbering gapless.
- **Held sales** = `sales` rows with `status='held'`. **Quotations** = `status='quote'`. **Neither takes
  an invoice number** — the number is assigned only on completion, which is what keeps numbering gapless.
- **Returns / exchange:** `returns`, `return_lines`. An **exchange** is a return + a sale sharing an
  `exchange_group_id`, settling the difference either way. Return by receipt number, partial return,
  restock, refund. **Supervisor role required.**
- **Reprint** of any past receipt, clearly marked **DUPLICATE**.

### Shift / drawer
- **`shifts`** — `id`, `opened_at`, `opened_by`, `opening_float`, `closed_at`, `closed_by`,
  `counted_cash`, `expected_cash`, `variance`, `status`
- **`cash_movements`** — `id`, `shift_id`, `at`, `type` (`cash_in|cash_out|no_sale|drop`), `amount`,
  `reason_code`, `note`, `user_id`
  - **Every "no-sale" drawer open is logged** (who, when, why). Classic theft vector.

### Parties & money
- **`suppliers`**, **`purchases`** (GRN), **`purchase_lines`**, **`purchase_payments`**,
  **`purchase_returns`** — supplier ledger with billed / paid / running balance
- **`customers`**, **`customer_payments`** — customer ledger, credit sales (udhaar)
- **`loyalty_ledger`** — `customer_id`, `at`, `points`, `ref_type`, `ref_id`. Balance = `SUM(points)`.
- **`expenses`** — `id`, `at`, `category_lookup_id`, `amount`, `paid_from`, `note`, `user_id`.
  Posts to the ledger; appears in P&L.
- **`tax_returns`** — `year`, `submitted_at`, `filed_by`, `reference_no`, `details_html`
  (**Mantine Tiptap**), + attachments.

### Opening balances (CRITICAL — without this every report is wrong)
A guided **Opening Setup** wizard captures what the shop already has on day one: opening stock per
product (qty + cost), opening cash, opening customer receivables (udhaar), opening supplier payables.
All of it posts correct **opening journal entries against Opening Balance Equity** so the books balance
from day one.

## 5. Screens

**Sell** (keyboard-first, the hot path) · Hold/Resume · Returns & Exchange · Shift open/close + Z-report ·
Products (list, form, labels/barcode printing) · Categories · Batches & expiry · Stock movements ·
Stock take · Purchases/GRN · Suppliers + ledger · Customers + ledger + loyalty · Expenses ·
Opening Setup wizard · Reports · Dashboard · Settings (Shop, Currency/Country, Tax, Invoice numbering,
**Receipt/Invoice designer with live preview**, Printer, Cash drawer, **Scanner profiles + Learn mode**,
Loyalty, Users & roles, Manage Lists, Backup/Restore, **License**, Tax Returns) · Activation · Login /
PIN quick-switch · Audit log viewer.

**Reports** (every one exports to **Excel and PDF**): Daily sales X/Z · Item-wise · Category-wise ·
Profit · Payment-method breakdown · Tax summary · Stock valuation (incl. by batch) · Low stock /
reorder · Near expiry · **Leakage: discounts by user, voids, returns, no-sales** · Customer aging
(current/30/60/90+) · Supplier aging · **Trial Balance · P&L · Balance Sheet · Cash Book ·
General Ledger**.

## 6. Phases

Reordered from the original brief for one reason: **the posting engine and opening balances must exist
before the first sale**, or the books never balance and we'd be backfilling journals later.

| # | Phase | Done when |
|---|---|---|
| **0** | Scaffold + docs + skills + **installer + updater working end-to-end** | An installed v0.1.0 silently updates itself to v0.1.1 via the local `generic` provider. Windows `.exe` builds in CI as an artifact. Version shows in the header. |
| **1** | DB + forward-only migrations + seed + **backup/restore** + auth (users/roles/PIN) + audit log + **license & activation** | Fresh install → activate → log in → back up → restore. Expired key ⇒ read-only, data still exportable. |
| **2** | Settings framework + **lookups** (all dropdowns) + **chart of accounts + posting engine** | Trial balance balances on a seeded scenario. No dropdown anywhere is hardcoded. |
| **3** | Products, categories, UoM + conversion, barcodes, batches, price tiers, stock movements, label printing, **variants**, **serial-tracking flag** | Buy in cartons, sell in pieces; stock and cost both correct. A variant group behaves like one product with many SKUs. |
| **4** | **Opening Setup wizard** (stock, cash, receivables, payables) | Books balance from day one. |
| **5** | **Sell screen** — barcode, cart, discounts, split payment, credit sale, hold/resume, open item, weighted items, price tier, **variant picker**, **serial capture (flagged products only)** — + **thermal receipt (58/80mm)** + cash drawer + reprint (DUPLICATE) | Scan → item instantly. A non-serialised item still takes **one keystroke**. Receipt rendered and *looked at*. Negative-stock sale warns, completes, and is flagged. |
| **6** | Returns / refunds / **exchange** + void (reason + supervisor) + shift open/close + **Z-report** + no-sale logging | Every control action carries a reason code and an audit row. |
| **7** | Purchases/GRN + suppliers + ledger + returns to supplier; customers + ledger + **loyalty**; **expenses**; **quotations** | Aging reports reconcile with the ledger. A quote converts to a sale and only then takes an invoice number. |
| **8** | **Promotions** rules engine (buy-2-get-1 etc.) | Promotion + line discount + cart discount + tax all compose correctly, and the journal still balances. Tested against every discount combination. |
| **9** | **Reports + Excel/PDF export** + dashboard | Every PDF rendered and *looked at* before shipping. |
| **10** | **Period lock**, stock take, tax-returns section (Tiptap + attachments), RBAC hardening, dark mode, skeletons/empty states, polish | RBAC enforced in main and proven by a test that calls the service directly. |
| **11** | **Publishing**: real public releases repo, `releaseType: "release"`, PAT in CI secrets | A real user's installed app updates itself from GitHub. |

After **every** phase: `typecheck` → `vitest` → **build the installer** → an exact click-list to verify.

### Progress (as built)

- **Phase 0 done** (v0.1.0). Installer + updater proven end-to-end via the local `generic` feed.
- **Phase 1 done** (v0.2.0). DB, migrations, backup/restore, auth, audit, offline Ed25519 licence.
- **Phase 2 done** (v0.3.1). Double-entry engine + chart of accounts; adversarial audit fixed a
  paisa-drift the trial balance couldn't see.
- **Phase 3 done** (v0.4.0). Products, stock (weighted average), barcodes, packs, suppliers, batches,
  variants, serials. Audit fixed 6 bugs incl. the form rewriting the derived cost.
- **Phase 4 done** (v0.5.0). Opening Setup wizard **+ Excel import** (exceljs) + **settings registry**
  (self-rendering Settings screen) + thermal receipts (rendered and looked at). Audit fixed 3
  critical Excel bugs (formula-cell float bypass, blank-cost zero valuation, import deleting udhaar).
- **Phase 5 done** (v0.6.1). Sell screen: barcode, cart, split payment, hold/resume, quote, receipt,
  cash drawer, void. The 50-agent audit found **15 real bugs** (4 critical); **13 fixed**:
  New Year invoice brick, unauthenticated supervisor approval (now PIN-proven in main), price-tier
  focus-kill, FEFO whole-line-to-one-batch, held-cart override dropped, reprint pack-qty drift, cart
  lost on tab switch, approver role now in the audit log, and more.

  **Two Phase-5 findings deliberately deferred (need owner input, low severity):**
  1. **A price override records no reason code.** The override is already supervisor-PIN-authenticated
     and audited with the real approver's name and role — the gap is only the *why*. Needs the owner
     to confirm the reason options before a `price_override_reason` list is seeded and enforced.
  2. **A cashier is told the wholesale tier is forbidden only at the Pay button**, not when they
     switch to it. Pure UX; the control itself is enforced in main.
- **Phase 7 (customers half) done** (v0.7.0 → v0.7.1). Customers + inline "+ new customer" on Sell,
  per-customer ledger with payments, Sales history, Users/staff admin, and one reusable Paginator on
  **every** list (page size + page numbers — the owner's explicit ask). Audit fixed a retired-staff PIN
  that could be reused and, on reactivation, collide (two active users behind one PIN, one identity).
  The **suppliers / purchases / loyalty / expenses / quotations** half of Phase 7 is still to come.
- **Phase 6a done** (v0.8.0). Returns / refunds: partial, restock-or-damage, refund vs apply-to-account,
  supervisor-PIN, frozen-figure reversal (a refund matches the original receipt; restocked goods keep
  GL Inventory == the stock report). Adversarial audit found **11 real bugs** — a refund misroutable onto
  the udhaar tender, a void double-reversing an already-returned sale, and returns missing from the
  derived customer balance/statement (all trap #17) — every one fixed with a regression test.
- **v0.8.1** (owner-reported bug). An over-threshold discount demanded a supervisor PIN even for the
  Owner — who, in a one-user shop, has no PIN and no other supervisor, so the sale could not complete.
  The person at the till now authorises their own over-threshold discount when their role clears the bar
  (exactly as void / return / wholesale-tier already did); the discount is still audited.
- **Phase 6b done** (v0.9.0). Shift open/close + **Z-report** + cash-drawer movements — no-sale logged
  with a reason (the theft vector), pay-in / pay-out / drop each posting a clean journal. Drawer
  reconciliation: expected = opening float + cash sales (net of change) + cash udhaar + pay-ins − cash
  refunds − pay-outs − drops; **over/short is recorded, never journaled** (a miscount must not silently
  adjust the books). Adversarial audit found **7 real bugs**, all fixed with regression tests — chiefly
  that voiding a sale from an already-CLOSED shift rewrote its frozen Z-report and mis-charged today's
  drawer (now refused — after close, the instrument is a return, exactly as the returns guard works).
- **Phase 9 (Reports) first increment DONE** (v0.11.0). The payoff: the owner finally SEES the business.
  §5 lists ~18 reports; the FIRST increment is the core set that a shop reads daily/weekly, each exporting
  to **Excel (exceljs) AND PDF** with the PDF **rendered and looked at before shipping** (trap #14), behind
  one Reports screen (pick report → date range/params → view → export):
    1. **Sales summary** (date range: count, gross, net, discounts, tax, by tender, by day).
    2. **Profit** (revenue − COGS from the frozen sale-line cost; gross margin).
    3. **Stock valuation** (on-hand × weighted cost = inventory value; ties to GL Inventory).
    4. **Customer aging** + **Supplier aging** (current / 30 / 60 / 90+, reconciling to Receivable/Payable).
    5. **Leakage** (discounts by user, voids, returns, no-sales — the anti-theft report).
    6. **Financial statements** from the ledger: **Trial Balance**, **Profit & Loss**, **Balance Sheet**.
  Every figure is DERIVED from the existing tables/ledger — reports read, never write, and never recompute
  a frozen historical number. Excel numbers reach the sheet as real numbers with a cell format (never a
  pre-formatted string); the PDF is offline-safe (system fonts, no external asset, A4). I rendered the
  Balance Sheet / Sales summary / Leakage PDFs and looked at them — clean and reconciling. Adversarial
  audit found **7 real bugs**, all fixed: chiefly that **customer/supplier aging ignored the `asOf` date**
  (they used today's balance aged against an old date, disagreeing with the balance sheet for that date) —
  now bounded to `asOf` so `Σ aging === GL Receivable/Payable` for the report date, with anonymous udhaar
  surfaced as an "Unassigned" row. The remaining §5 reports (item/category-wise, payment-method, tax
  summary, low-stock/near-expiry as reports, Cash Book, General Ledger, dashboard) follow in a later increment.
- **Phase 7 Expenses done** (v0.12.0). The shop's NON-STOCK running costs (rent, wages, bills, transport)
  paid from cash or bank: one balanced journal, DR the mapped expense account (category → 5200/5210/5220/
  5230/5240, any other → General Expenses 5900) CR the tender; a 'credit'/on-account tender is refused (an
  unpaid bill is not an expense row — that's an accrued liability, later). These flow straight into the
  P&L. An Expenses screen lists + totals them by date range/category with a record form. Focused audit came
  back clean (accounting/tender/RBAC/atomicity all hold) — one LOW fix: the date schema accepted a
  calendar-invalid value (2026-02-30 rolled to March), now rejected, with a regression test. NOTE: a
  transient machine overload made vitest's PARALLEL workers time out (spurious, varying failures); the
  suite is green run sequentially (`vitest run --no-file-parallelism`) — 720 tests.
- **Phase 7 buying side done** (v0.10.0). The mirror of selling: **Suppliers** (CRUD), **Purchases / GRN**
  (received stock re-averages the weighted cost through a frozen movement; DR Inventory + Input-Tax, CR
  cash/bank tenders, CR Payable for the unpaid remainder — balanced by construction), and the **Supplier
  ledger** (what's owed = opening payable + credit purchases − payments, reconciling to GL Payables like a
  customer's udhaar). Also **consolidated a duplicate supplier service**: the workflow's new party-service
  is now the single supplier home; catalog's old supplier CRUD, the two pickers, and the Excel importer
  were repointed to it. Adversarial audit came back clean on the accounting/ledger/consolidation — only
  **3 LOW UI findings** (no inline add-supplier on the purchase screen; a stale batch/expiry blocking
  submit; unvalidated date filters), all fixed with a regression test where testable. Input tax defaults
  to 0 (needs the owner's GST status to confirm the treatment). The **loyalty / expenses / quotations**
  part of Phase 7, and **returns-to-supplier**, remain.

## 7. Deferred, deliberately

- **Printed dates ignore the shop's country — they use the MACHINE's locale** (found while eyeballing the
  quotation, medium; PRE-EXISTING and app-wide, not new). `shop.country` defaults to PK and its help says
  it "sets the default tax rate and the date format", but **nothing reads a date format**: the receipt
  (`new Date(data.at).toLocaleString()`) and the quotation (`toLocaleDateString()`) both take whatever the
  OS locale is — so a Pakistani shop's paper currently prints **7/22/2026** (US m/d/y) instead of
  22/07/2026. Ambiguous dates on a customer-facing offer are exactly where this bites. Fix with the
  timezone work below: derive a date format from `shop.country` (or add an explicit `shop.dateFormat`) and
  route EVERY printed/exported date through one formatter. Phase 10.
- **Report date bucketing uses UTC, not the shop's local day** (reports audit, medium). A report's
  from/to/as-of are compared against UTC timestamps, so a sale in the local midnight–05:00 window (for
  PKT, UTC+5) can land on the neighbouring calendar day. For a shop that does not trade those hours the
  impact is nil, and all reports use the SAME boundary so they still reconcile with each other. The proper
  fix is a **shop-timezone setting** (CLAUDE.md §4) threaded through the date comparisons — slated for the
  Phase 10 polish pass.
- **Returns-to-supplier** (purchase returns) — sending goods back to a supplier, reducing the payable.
  The mirror of a customer return; deferred from the v0.10.0 buying increment to keep it reviewable.

- **Guided exchange** (a return + a linked replacement sale, settling the difference either way). Phase 6a
  ships a *minimal* exchange that parks store credit on a named customer's account (`exchange_group_id`
  seam is in the schema). Best built alongside the next selling work.
- **Petty-cash categories.** Phase 6b's pay-out posts to General Expenses and pay-in to Owner Equity so
  GL Cash stays honest; proper expense/supplier categorisation arrives with the **Expenses** phase.

- **FBR real-time invoice reporting** (Pakistan Tier-1 retailers) — needs internet. Schema seams
  (`fbr_invoice_no`, `fbr_qr`, `fbr_sync_status`, `sync_queue`) are in from day one so it drops in later.
- **LAN / multi-terminal** — the `services/` layer is transport-agnostic. When it's needed, one machine
  runs a server that owns the DB. **Never share the SQLite file over a network drive** (trap #20).
- **Multi-branch / stock transfer** — single shop confirmed. A `branch_id` seam stays in the schema;
  real multi-branch depends on the LAN phase above.
