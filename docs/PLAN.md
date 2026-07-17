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
- **Phase 10, second increment** (v0.19.0): the two UI screens + BOTH deferred date fixes from §7.
  · **"Close the month"** (Settings, owner-only as a courtesy — MAIN enforces it) and the **STOCK TAKE**
    screen (scan → count → live variance → apply; keyboard-first for a scanner in one hand). The two
    period confirmations are deliberately asymmetrical: unlocking leads with MAIN's own journal count
    ("March 2026 has 412 entries. Reopening it lets them be changed.") because reopening a reported month
    is the weightier act. The stock-take renderer never computes a variance — it only reads MAIN's, which
    is the whole reason the preload contract is shaped that way: a renderer that can name its own variance
    can hide a theft.
  · **PRINTED DATES NOW FOLLOW THE SHOP, NOT THE PC** (§7 deferred, fixed). Every printed date was
    `toLocaleString()` with NO locale — "whatever this PC is set to" — so a Pakistani shop on a US Windows
    image printed **7/22/2026** on its own customers' receipts, while `shop.country` sat in Settings with
    help text literally promising "Sets the default tax rate and the date format". New `shared/dates.ts`
    (`formatDate`/`formatDateTime`); `country` travels ON the ReceiptData/QuotationData exactly as
    `currencySymbol` already did, because the renderer has no settings and must never guess. **Written as
    an explicit table, NOT a locale string:** `toLocaleDateString('en-PK')` depends on the ICU data
    compiled into the running Electron build, and a slim ICU build silently falls back to en-US — the same
    bug again, invisibly, on a machine we cannot inspect. Receipt rendered and LOOKED AT (trap #14):
    `15/07/2026 6:42 pm`. **Two old tests had encoded the bug** — they asserted
    `new Date(...).toLocaleDateString()`, i.e. they asked the machine the same question the code did, so
    they passed on every machine and could never see it. Fixed, and they now name real strings.
    It matters most on a quotation: "Valid until 07/22/2026" read day-first is a promise held four months
    too long.
  · **CALENDAR-INVALID DATES REFUSED EVERYWHERE** (§7 deferred, fixed). The expenses audit added a
    round-trip guard rejecting 2026-02-30 (which JS silently rolls to **March 2**) — but the same bare
    regex had been copied WITHOUT it into **seven** other schemas: reports, sales, returns, purchases,
    customers, suppliers, opening. A February tax return happily accepted a March date. Now ONE `IsoDate`
    in `shared/dates.ts`, imported everywhere — seven copies of a guard is seven chances to miss the
    eighth. Proven at the schemas themselves, with the leap-year cases (2000 yes, 1900 no).
- **Dark mode done** (v0.20.0) — **Phase 10 complete**. `ui.colorScheme` (auto | light | dark, default
  auto) in the registry under a new "Appearance" group, so the Settings screen renders the picker itself.
  **The toggle already existed in the header and already used lucide Sun/Moon — what it did not do was
  PERSIST:** Mantine's own `setColorScheme` writes to **localStorage**, which §4 forbids for something two
  shops would set differently (and which does not survive a reinstall). It now writes through to the DB;
  `ColorSchemeSync` applies it on mount OUTSIDE the phase switch, so the Login screen wears the shop's
  theme too.
  **THE SWEEP FOUND A PRE-EXISTING LIGHT-MODE ACCESSIBILITY BUG, which is the opposite of what it went
  looking for.** The renderer had ZERO `#fff`/`rgb()`/`white`/`black` literals — every background was
  already a Mantine variable. The real problem was 23 bare shade-6 colours (`c="red"`, `c="teal"`, icons
  pinned to `-6`), and **shade 6 was already failing WCAG AA on the EXISTING light theme**: red 3.28 and
  teal 2.55 against the 4.5 minimum. I verified those numbers independently rather than take them on
  trust. They now use `var(--mantine-color-<c>-text)`, which resolves to shade 9 on light and shade 4 on
  dark and passes AA on both (red 5.46/7.44, teal 5.00/9.57). `violet.6` at 3.14 on dark was the one true
  dark-mode failure. Status colours stay semantically red/teal — only the shade moves.
  **`src/main/printing/*` deliberately untouched** (verified): receipts and reports print on WHITE PAPER,
  and a "dark mode receipt" is a black rectangle (traps #12/#13).
  KNOWN, out of scope, flagged not fixed: orange and green fail AA in light mode even at shade 9
  (4.30 / 4.37). They are only icons and badges today, so nothing is failing — but `c="green"` on body
  text would be a real defect. Also: the renderer bundle is 2.34 MB in one chunk (Vite warns).
- **Phase 10, first increment** (v0.18.0): **period lock made reachable**, **stock take**, and the
  **RBAC-in-main proof**. Backends only (three agent runs died on API errors mid-phase; the services
  survived complete and verified, so it shipped rather than sat).
  · **PERIOD LOCK: the engine was always there and enforced — nobody could reach it.** `ledger.lockPeriod`
    / `unlockPeriod` / `assertPeriodOpen` existed since Phase 2, with no IPC and no UI, so an owner could
    not actually close a month. Now `periods.ts` + `period:list|lock|unlock` (OWNER only, audited both
    ways; an unlock reports how many journals sit in the month it would reopen — the difference between
    reopening a quiet month and the busiest quarter).
    **I verified the lock myself rather than trusting it:** the tests covered expenses and stock
    corrections, but the file's own header PROMISED sales, purchases and returns were refused and NONE of
    those were tested — the paths a shop touches a thousand times a day, where one gap makes the lock a
    lie. All three correctly refuse, for one reason worth stating: every journal goes through
    `ledger.post`, which asks `assertPeriodOpen` first. One door, one lock. Now pinned by three tests,
    mutation-checked (disabling the lock fails all three).
  · **STOCK TAKE** (migration 0019): the counting sheet. It calls `stock.adjust()` and posts NO journal of
    its own — one stock path, not two. The subtle decision: `expected` is FROZEN AT COUNT TIME, not
    recomputed at apply. Recompute it and a theft erases its own evidence — count short, sell the missing
    stock before pressing Apply, and the variance reads zero. Applying twice is refused; a zero-variance
    line posts nothing; an applied sheet is history.
  · **THE RBAC-IN-MAIN PROOF** — PLAN's stated acceptance test for this phase, now real:
    `src/main/security/rbac-enforcement.test.ts` (52 tests). It walks the PERMISSIONS map ITSELF, so a
    permission added tomorrow without a guard fails THERE rather than shipping unguarded. Proves: every
    role below the bar is refused BY MAIN for all 35 permissions (and every role at/above is let through —
    a guard that refuses everyone is an outage, not a guard); nobody signed in is refused everything;
    `requirePermissionOf` takes ONE argument, so **there is no seat for a claimed role** — a tampered
    renderer cannot say "I am the owner"; and the map grants monotonically by rank. Mutation-checked:
    silently downgrading `sale.void` to cashier fails it immediately.
- **Promotions done** (v0.17.0) — the last feature; Phase 8 complete. Migration 0018 (`promotions`, `promotion_rules`,
  `sale_line_promotions`). Four kinds: percent_off, amount_off, buy_x_get_y, fixed_price — scoped by
  product / category / brand / department / all, with a date window, a Monday-first weekday mask and a
  priority. **THE WHOLE DESIGN IS ONE SENTENCE: a promotion is a LINE DISCOUNT.** It invents no new money,
  no new journal leg and no new column: it writes the `line_discount` that has existed since 0007, so
  priceCart re-resolves tax on what is ACTUALLY paid, `DR Discounts Given (4200)` already accounts for it,
  and returns / loyalty / every report need to learn NOTHING — there is nothing new to learn. That is
  exactly why this phase was scheduled LAST (§6): a promotion with its own journal leg would be a SECOND
  path to the same place, and every derived figure would have to learn about it separately.
  **A "free" tin is not a zero-price line:** it rings at its normal price with a 100% line discount, so
  stock moves for all three tins at cost (shelf and books agree), the giveaway is VISIBLE in Discounts
  Given rather than hidden in a smaller Sales figure, and output tax is charged on what the customer
  actually pays. ONE promotion per line (lowest priority wins) — stacking two offers on one tin is how a
  shop accidentally sells at a loss. A promotion must NOT trip the manual-discount supervisor PIN: it is
  the shop's own standing offer, not a cashier's decision. `sale_line_promotions` freezes the offer's name
  and the money it gave away, so renaming or switching it off never rewrites what an old sale cost.
  **The PIN rule, and why it is a SECURITY decision, not a convenience one:** `checkDiscountApproval` now
  measures `discountGiven − promotionDiscountGiven` — only what a HUMAN chose to give away. A shop running
  "25% off everything" would otherwise trip a 10% threshold on EVERY basket all day; the supervisor would
  be called forty times a morning, and by mid-morning the cashier would simply have been handed the PIN.
  The control that guards real discounting would stop existing, on the busiest day of the month, because it
  fired when nothing was wrong. A cashier's OWN over-threshold discount is still stopped, and a promotion
  can neither hide one nor drag one over the line — both proven.
  **A manual discount on a promoted line STACKS, with the offer computed on what is LEFT.** Computing both
  off the shelf price and adding them (60% + Rs 60 off a Rs 100 tin = Rs 120 given away on a Rs 100 item)
  is the version that loses money; measuring each on the remainder cannot overshoot, and it keeps the
  cashier's promise to the customer instead of silently discarding it.
  **A real bug the wiring found in itself:** `toCartLines` carried the whole `lineDiscount` back to a
  resumed cart, so a parked cart's promotion returned as a MANUAL discount with today's offer stacked on
  top — compounding every re-park, and surviving after the offer ended. Fixed by subtracting the offer's
  frozen share; both directions tested (a parked cart rings at TODAY's offers, and picks up an offer that
  started after it was parked).
  **THE OTHER-READERS SWEEP CAME BACK CLEAN — and that is the payoff of the design, not luck:** loyalty
  earns on `subtotalNet` (what was PAID: a Rs 400 list cart at 25% off earns 300 points, not 400), leakage
  reads the AUDIT LOG for over-threshold discounts so a promotion never lands on a cashier's row, and the
  P&L/balance sheet walk `accountActivity` by TYPE. NOT ONE reader needed changing, because there is
  nothing new to read — all three now pinned by tests.
- **Reports finished** (v0.16.0). The remaining EIGHT, read-only, no migration: itemWise, categoryWise,
  paymentMethodBreakdown, taxSummary, lowStock, nearExpiry, cashBook, generalLedger — 17 reports now, all
  17 exporting to Excel and PDF. Everything is read FROZEN (a line's tax_rate_bp/tax_amount, a movement's
  value_minor) and the ones with a ledger counterpart ASSERT they tie to it: taxSummary vs GL
  OUTPUT_TAX/INPUT_TAX, cashBook vs GL Cash, generalLedger vs the account balance, itemWise/categoryWise vs
  the profit report (the same money cut differently — if they disagree, one of them is lying to the
  shopkeeper). The reconciliation earned its keep AGAIN: taxSummary first DOUBLE-REVERSED a void's tax
  (report said Rs 17, GL said Rs 34) because voiding both flips status off 'completed' AND posts a contra;
  `taxReversed` now counts RETURNS ONLY. **A CLAUDE.md §4 violation found and fixed:** `nearExpiry`
  hardcoded a 30-day horizon in TWO places (catalog.ts, the live IPC path, and stock.ts) while
  'stock.nearExpiryDays' sat in the registry doing nothing — an owner who set 90 still got 30. Every
  existing test passed `days` explicitly, which is why nothing caught it; now pinned by a regression test.
  Both PDFs rendered and LOOKED AT (trap #14): single page, no box-shadow, no external assets, the expired
  batch showing −5 days with its red "may still be on the shelf" warning.
  **OWNER CONFIRMED (2026-07-16), a tax-filing rule — no longer a default:** a sale rung in June but VOIDED
  in July STAYS in JUNE's tax summary. Its contra journal is dated July, so June's GL still shows the
  credit, and a return already filed for June is never silently rewritten — the reversal belongs to July.
  Do not "simplify" this to a status-only filter: that would retroactively change a filed period.
- **Loyalty done** (v0.15.0). Migration 0017 (`loyalty_movements` + account 5300 Loyalty Points Expense);
  the four `loyalty.*` settings already existed and are the business rules — the scheme is OFF until a shop
  turns it on, and everything hides when it is. Two decisions drive the whole design:
  **(1) Points are a LIABILITY booked when EARNED, not when redeemed** (earn DR 5300 CR 2200). Book them
  only at redemption and every P&L until then overstates profit by the promises quietly piling up, and the
  day a big customer cashes them the shop takes a hit it never saw coming.
  **(2) Redemption is a TENDER, not a discount** — points PAY for goods, they do not cut their price. So
  revenue and OUTPUT TAX are unchanged and the frozen sale lines are untouched. As a discount it would
  understate revenue AND under-collect the government's sales tax on every single redemption.
  The balance is DERIVED (`SUM(loyalty_movements.points)`) — no `customers.points` column, ever — and each
  movement freezes its rupee value at the rate in force THEN, so a later rate change cannot rewrite history.
  **The rate-change engine is the subtle part:** a redeeming customer gets TODAY's rate, but the liability
  is released FIFO at the rate each batch was BOOKED at, and the difference books to 5300 (the cost of a
  rate change lands in the P&L of the month it was changed). Settling at today's rate would drive 2200
  negative. The standing invariant is therefore `Σ(points × the rate they were BOOKED at) === GL 2200` —
  NOT the current rate, which cannot tie to a FIFO-frozen liability. Earning is on the sale's NET, ex-tax,
  and excludes the points-funded portion (or points breed points, and rewards would track the tax rate).
  Earn/redeem ride INSIDE `sales.complete()`'s existing transaction — a sale and its points are one atomic
  act — and `voidSale` claws both back; the builder's first version missed the earn's own journal (the
  sale's contra filters `ref_type='sale'` and never sees it), which a test caught. **No report needed
  changing** — the P&L and balance sheet walk `accountActivity` by account TYPE, so a new account lands in
  them by construction; that property is now pinned by a test, since it is exactly what `supplierAging`
  (which recomputes) could not do. **A REAL MONEY LEAK was found and fixed before shipping:** the builder
  scoped "a return of a points-earning sale" OUT, and it turned out to be free money — buy Rs 1000 of
  goods, earn 1000 points, return the lot for a full refund, KEEP the points, repeat forever; the trial
  balance stayed green because the liability really was owed, it just should never have been booked. Now
  `returns.ts` calls `loyalty.clawbackForReturn` INSIDE the return's own transaction: proportional to the
  NET going back (the basis the points were earned on), remainder-on-last so a sale returned in pieces
  claws back exactly what it earned, released FIFO at the rate each batch was BOOKED at, and CAPPED at the
  balance so a customer who already SPENT the points is never driven negative. **OWNER CONFIRMED
  (2026-07-16):** a customer who already spent the points is left at ZERO, never pushed negative — taking
  those back is the owner's call, by hand, with a reason. Do not "improve" this into a negative balance
  that future earnings pay off. Four regression tests. Same trap #17 shape as the last three phases — a
  derived value must be correct from EVERY path that can change it.
- **Returns to supplier done** (v0.14.0). The mirror of a customer return, pointing the other way: stock
  goes BACK out and either lowers what the shop owes or brings a refund in. Migration 0016
  (`purchase_returns` + `purchase_return_lines`), with `purchase_return_reason` seeded as its own editable
  list. **Goods leave at the cost they came in at** — each line copies the purchase line's FROZEN 4-dp
  `unit_cost` and reads back the negative movement's frozen `value_minor` for its total, so buying 10@Rs60
  then 10@Rs80 (average Rs70) and sending back one of the FIRST tins credits Rs 60, not Rs 70, and
  `GL Inventory === SUM(value_minor)` still holds by construction. One balanced journal: CR Inventory
  (Σ frozen line values) + CR Input Tax (pro-rata, omitted when the bill reclaimed none) DR the settlement —
  `supplier_credit` → Payable (the common case), `refund` → the tender (a method resolving to
  Payable/Receivable is refused: a refund is real money, and taking it off the bill is its own settlement).
  Input tax is apportioned by **cumulative differencing**, so a bill sent back in pieces sums back to its
  `tax_total` to the paisa with the final return taking the exact remainder — no stranded paisa. The
  over-return guard sums every prior return of the line, inside the transaction.
  **`supplier-ledger.balance()` and the statement now subtract `supplier_credit` returns** (trap #17), and
  the audit's own catch was the *second* reader: **`reports.supplierAging` still summed only payments**, so
  the aging report chased a distributor for Rs 240 of goods already taken back while GL Payable and the
  supplier ledger both correctly said Rs 360 — the trial balance stayed green throughout, and only the
  `Σ aging === GL Payable` reconciliation caught it. Fixed, bounded to `asOf` like its siblings, with two
  regression tests (credit reduces the bill; a cash refund must NOT). A `refund` return never touches
  Payables. The Balance Sheet needed nothing — it reads the journals, which is the payoff of real
  double-entry: only a report that recomputes payables independently can drift.
- **Quotations done** (v0.13.0). They were already ~90% built (save/resume/convert, and a quote takes its
  invoice number only on completion). Closed the two gaps that make them usable: **a printable QUOTATION**
  (58/80mm — boxed heading, no invoice number, a labelled "Quote #142" reference, "Valid until", an EXPIRED
  box, "not a receipt, no payment received"; reuses the receipt's own formatters so the two can never
  disagree, pinned by a test) and **a validity date** (migration 0015 `sales.valid_until` + the
  `selling.quoteValidDays` setting, default 7). INVARIANT: valid_until non-NULL IFF status='quote' — set on
  quote, re-dated on re-quote, cleared on hold and on conversion; the SERVICE owns it (SQLite can't
  ALTER-TABLE a CHECK) and tests prove both halves. `receiptFor` now refuses a quote/held cart — it would
  have printed a *receipt* reading "(not issued yet)" for the number while everything else said SALE.
  An expired quote is shown, never blocked — that's a conversation with the customer, not the till's call.
  All three previews rendered and looked at (trap #14).
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

*Kept honest as of v0.20.0 — every feature in the plan is BUILT. What follows is what is genuinely left.*

### Still open, and worth doing

- **The list/filter screens still bucket by UTC** (NEW, found while fixing the reports half). `dayAfter`
  is duplicated in SEVEN services — sales, purchases, returns, purchase-returns, expenses, loyalty, and
  `daysBetween` in stock — and they all still assume UTC. So filtering the sales *list* by "the 8th" can
  include a row the sales *report* for the 8th excludes. Contained (a list, not the books — no ledger
  impact, nothing stops reconciling), but a shop trading past midnight will eventually notice. The clean
  fix is lifting those helpers into one shared module, which deserves its own scoped change rather than
  being smuggled into the reports one.
- **Tax-returns section** (Tiptap rich text + attachments). In §5's screen list; `@mantine/tiptap` is not
  even a dependency yet. The 17 reports already give an accountant everything a return needs, so this is a
  convenience: somewhere to keep the filing itself. **The owner has never asked for it.**
- **A price override records no REASON CODE** (Phase 5, low). It is already PIN-authenticated against
  `selling.priceOverrideRole`, stamped with `price_override_by`, and audited — so WHO and WHAT are
  answered; only WHY is not. **Needs the owner to say what the reason options should be** (it would be a
  lookups list, like void/refund/discount reasons).
- **Orange and green fail WCAG AA in light mode even at shade 9** (4.30 / 4.37) — found by the dark-mode
  sweep. They are only icons and badges today, so nothing is failing; `c="green"` on body text would be a
  real defect.
- **The renderer bundle is 2.34 MB in one chunk** (Vite warns). It is a desktop app loading from disk, so
  it costs a little startup time, not a download.

### Deliberately not built (a decision, not a gap)

- **Guided exchange** (a return + a linked replacement sale, settling the difference either way). Phase 6a
  ships a *minimal* exchange that parks store credit on a named customer's account; the
  `exchange_group_id` seam is in the schema. Best built alongside the next selling work, if it is wanted.
- **FBR real-time invoice reporting** (Pakistan Tier-1 retailers) — needs internet, which the app
  deliberately does not require. The schema seams (`fbr_invoice_no`, `fbr_qr`, `fbr_sync_status`,
  `sync_queue`) have been in since day one so it drops in later.
- **LAN / multi-terminal** — the `services/` layer is transport-agnostic, so this is a transport swap, not
  a rewrite. When it is needed, ONE machine runs a server that owns the DB. **Never share the SQLite file
  over a network drive** (trap #20).
- **Multi-branch / stock transfer** — single shop confirmed. A `branch_id` seam stays in the schema; real
  multi-branch depends on the LAN phase above.

### Done — resolved from this list, kept for the record

- ~~The profit report was QUADRATIC~~ — **FIXED v0.21.1, found by benchmarking a real grocery shop.**
  `stock_movements.ref_id` is TEXT, indexed as (ref_type, ref_id). The COGS join used the
  natural-looking `CAST(m.ref_id AS INTEGER) = s.id`, which wraps the **indexed** column in a function —
  so SQLite could not use the index and scanned-and-cast every movement, once per sale. Measured:
  **2k sales 200ms → 10k sales 5.0s → 20k sales 20.5s**, and the report runs that query twice (total and
  by-day), so a shopkeeper clicking Profit on a year's data waited **90 seconds** on a report every other
  one of which answers in 40ms. Casting the OTHER side (`m.ref_id = CAST(s.id AS TEXT)`) keeps the index:
  **20.5s → 8.5ms**, the same answer to the paisa, and LINEAR so it stays fast as the shop grows. The
  whole profit report is now **42ms**. The same anti-pattern was fixed in `returns.ts` (it runs during a
  refund, with a customer waiting). Pinned by a regression test that asserts the SHAPE — doubling the data
  must not quadruple the time — not a millisecond figure, which would flake on a loaded box. Verified it
  catches the bug by putting the CAST back: it fails at 3.9x and names the cause.

- ~~Report date bucketing uses UTC, not the shop's local day~~ — **FIXED v0.21.0.** `shop.timezone`
  (default Asia/Karachi; 10 zones, because `shop.country` offers 6 countries but the US spans 4 — a
  country maps to a zone one-to-many, not as a mirror). `reports.ts`'s date helpers now resolve to the
  UTC instant of LOCAL midnight, threaded through all 10 range reports, both agings (`ageBuckets` was
  ageing an 01:00 invoice a day early), the trial balance, the P&L, the balance sheet, stock valuation and
  near-expiry. `Intl.DateTimeFormat` ships with Node/Electron, so no date library. **`endOfDay` is now
  derived as `dayAfter − 1ms`**, so the trial balance and the balance sheet cut the ledger at the
  identical instant and cannot drift. The five standing reconciliations all still hold.
  **TWO EXISTING TESTS HAD ENCODED THE BUG** and were changed — flagged here because "the fix broke a
  test, so I changed the test" is exactly the move that deserves scrutiny. They wrote `23:59:59Z` and
  asserted it was the 15th's takings; in Karachi that instant is **04:59 on the 16th**. I verified that
  independently before accepting it. Their intent (a late sale stays in its own day) was right; the
  timestamp was not. Now `23:59:59+05:00`.
- ~~Settings is one long scroll~~ — **FIXED v0.21.0** (owner asked). 34 settings across 12 sections were
  stacked in one column, so finding the discount limit meant scrolling past the printer and the backup
  schedule. Now a **sidebar**, one section at a time (largest panel: 9 settings). A sidebar rather than
  top tabs because there are twelve sections and the registry is DESIGNED to grow — twelve tabs wrap onto
  a second row and stop reading as tabs. It collapses to a dropdown on a narrow window, and both layouts
  render the same `SettingsPanel`, so they cannot drift. The nav is built from `SETTING_GROUPS`, so a new
  group appears by itself — a hand-written nav would be the same trap the hand-written form fields were.
  "Close the month" joins it as a section (it is an ACT, not a knob, so it stays out of the registry).

- ~~Printed dates ignore the shop's country~~ — **FIXED v0.20.0.** `shared/dates.ts`; `country` travels on
  the receipt/quotation exactly as `currencySymbol` does. Written as an explicit table, not a locale
  string (a slim-ICU Electron build silently falls back to en-US — the same bug, invisibly).
- ~~Calendar-invalid dates (2026-02-30 rolling to March 2)~~ — **FIXED v0.20.0.** One canonical `IsoDate`;
  seven schemas had copied the bare regex without the guard.
- ~~Returns-to-supplier~~ — **BUILT v0.14.0** (migration 0016).
- ~~Petty-cash categories~~ — **BUILT v0.12.0** with the Expenses phase.
- ~~The wholesale-tier permission is only surfaced at Pay~~ — pure UX, and the tier is enforced in MAIN.
