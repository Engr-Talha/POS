# CLAUDE.md — Offline POS

The rules of this codebase. Read before every change. If a change violates a rule here, the change is
wrong — not the rule. If a rule blocks something the user needs, ask; do not silently work around it.

---

## 1. Who this is for

- **End user:** a shop cashier/owner who is NON-TECHNICAL. Never opens a terminal, never runs a
  command. Installs one `.exe`, clicks an icon. Everything is a button.
- **Maintainer:** the repo owner, via Claude Code.

Anything that would require the end user to type a command is a bug.

## 2. Hard constraints

1. **Fully offline.** No cloud, no internet needed to run. Internet is used only to fetch updates.
2. **Zero commands for the end user.** Distribution = one silent Windows installer.
3. **Data safety is sacred.** This is the shop's money. One-click backup + daily prompt. Never lose data.
4. **Fast.** Barcode scan → item on screen instantly. Must hold 1000+ sales/day for years.

## 3. Stack (locked — never silently change)

- Electron + electron-vite + electron-builder (Windows NSIS `.exe` primary; macOS `.dmg` for testing)
- React + TypeScript + Vite
- **Mantine** UI + **lucide-react** icons — **NEVER emojis as icons**
- **Mantine Tiptap** (`@mantine/tiptap`) for rich text — never CKEditor
- **better-sqlite3**, one DB file, WAL mode (backup = copy the file)
- **zod** validation, **vitest** tests
- **electron-updater** — wired in from v0.1.0
- **exceljs** — the ONLY spreadsheet library. Added in Phase 4 for the opening-balance import, and it
  also does the Excel export every report needs in Phase 8. Works fully offline.
  **NEVER let a spreadsheet number reach the ledger as a float.** Excel hands you `2185.0000` as a
  float. Read every numeric cell as TEXT and run it through `parseMoney` / `parseCost` / `parseQty`,
  and REJECT a cell that will not convert exactly — with its row number. Rounding it instead would
  quietly undo the integer discipline the whole app rests on.

### Process boundary (non-negotiable)

- SQLite and all business logic live in the **Electron main process**.
- The renderer talks to main **only** through a typed, whitelisted `contextBridge` IPC layer.
- **Never** expose Node, `fs`, or SQLite to the renderer. `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`.
- Business logic lives in `src/main/services/` and is **transport-agnostic** — a service takes plain
  args and returns plain data; it knows nothing about IPC. This is what lets a future LAN server
  reuse it without a rewrite.

```
src/
  main/          Electron main. IPC handlers (thin) → services (all logic).
    db/          schema, migrations (forward-only), connection
    services/    transport-agnostic business logic — the real app
    ipc/         thin handlers: zod-validate → call service → wrap in Result
    security/    license, RBAC, machine id, audit
    printing/    receipt/report HTML → print/PDF
  preload/       contextBridge only. A whitelist. No logic.
  renderer/      React + Mantine. Dumb about persistence.
  shared/        types + zod schemas shared by main and renderer
tools/           maintainer-only scripts (keygen). NOT shipped in the installer.
```

## 4. Non-negotiable engineering rules

### Money
- **Money is INTEGER minor units (paisa/cents). NEVER floats. NEVER `REAL` columns.**
- Decimal places are **fixed at 2**. Format only at display time, in one place.
- Changing the currency in Settings changes the **label only** — it never converts stored values.
  The UI must warn about this.

### Quantity
- **Quantity is INTEGER thousandths of the base unit** (`qty_m`). 1 piece = `1000`; 1.234 kg = `1234`.
- This is what makes weighed goods (kg) exact without floats. Same rule as money: integers only.

### Tax
- Tax rate is stored in **basis points** (`tax_rate_bp`): 17% = `1700`. No floats.
- A product records whether its price was entered **inclusive** or **exclusive** of tax
  (`price_entry_mode`). Inclusive and exclusive products may be mixed in one cart.
- **Every sale line stores `net`, `tax_rate_bp`, `tax_amount`, `gross`** — computed at sale time and
  frozen. Never recompute a historical line from today's tax settings.

### Rounding
- **No cash rounding. No rounding line.** 2 decimals, exact.

### Selling (Phase 5 — must-dos carried forward)
- **A pack with `retail_price <= 0` is PURCHASE-ONLY and MUST NOT be sellable.** "Buy in cartons,
  sell in pieces" means a carton legitimately carries the supplier's barcode and has no selling
  price. Scanning it at the till is a *receiving* action, not a sale — the sell path must refuse it,
  or the shop rings up a free carton.
- **`cost_price` is never typed.** It is the weighted average of `stock_movements.unit_cost`. A cost
  correction is a business event: it goes through `stock.adjust()`, which posts a movement and a
  balanced journal. A form must never write it, or the ledger and the stock report drift apart
  silently and the trial balance still balances.

### Derived state
- **Stock is DERIVED from `stock_movements`.** There is no mutable `products.stock` column, ever.
  A `stock_cache` table may exist as an optimization, but it is rebuildable from movements and a test
  asserts `cache == SUM(movements)`.
- **Derived status must be correct from EVERY path that can change it.** Prefer *recompute on read*.
  If you must cache it, every write path updates it, and a test proves it — including the path that
  bites: paying an invoice from the customer-ledger screen must flip the invoice to PAID.

### Migrations
- **Forward-only.** Never drop or rename a column that holds user data. Add a new one and backfill.
- Every migration is a numbered file, applied in a transaction, recorded in `schema_migrations`.

### IPC contract
- Every handler: **zod-validate the input**, then return a Result envelope:
  ```ts
  { ok: true, data: T }
  | { ok: false, error: { code: string; userMessage: string; technical: string } }
  ```
- `userMessage` is plain, friendly language a cashier understands. **Never a stack trace.**
- **Never POST a whole object back to a save endpoint** — it wipes fields the form never loaded.
  Send only the editable fields. Use `.nullish()` in zod for nullable columns.

### Security
- **RBAC and license checks are enforced in the MAIN process.** The UI is not a security boundary.
  Hiding a button is a courtesy, not a control.
- Roles: **Cashier** (sell) / **Supervisor** (void, refund, discount above threshold, price override) /
  **Manager** (products, purchases, reports) / **Owner** (everything, users, settings, period unlock).
- **Audit log: WHO did WHAT and WHEN** — user id + name + **role** + timestamp — for every void,
  refund, discount over threshold, price override, no-sale drawer open, negative-stock sale, price
  change, user change, and period lock/unlock. Sensitive actions also require a **reason code**
  (lookups-driven) and supervisor approval.

### Data-driven everything
- **No hardcoded dropdown options, ever.** All options come from the `lookups` table, are editable in
  Settings → Manage Lists, and every select has an inline "+ add new".
- This includes: payment methods, categories, units, reason codes (void/refund/discount/adjustment),
  expense categories, customer types, supplier types.

- **IF A NUMBER OR A BEHAVIOUR COULD REASONABLY DIFFER BETWEEN TWO SHOPS, IT IS A SETTING — NOT A
  CONSTANT IN THE CODE.** Owner's standing instruction. Before you write a literal, ask: would another
  shop want this different? If yes, it goes in the settings registry.
  - Every setting is declared ONCE in `src/shared/settings-registry.ts`: key, type, default, label,
    help text, group, validation. The Settings screen RENDERS ITSELF from that registry — adding a
    setting must never mean hand-writing another form field.
  - The registry is the single source of truth for defaults. `DEFAULT_SETTINGS` is derived from it.
  - Examples that MUST be settings, not constants: the discount threshold that needs supervisor
    approval; whether negative stock warns or blocks; near-expiry warning days; auto-logout minutes;
    loyalty points per rupee and redemption rate; credit-limit enforcement (warn vs block); scanner
    prefix/suffix/terminator/min-length; printer width and cash-drawer kick code; backup reminder
    days; PIN length; low-stock defaults; date format; language.
  - The exceptions are the INVARIANTS, and they are deliberately NOT configurable, because making
    them so would let a shop turn correctness off: money is integer 2dp, cost is 4dp, quantity is
    thousandths, no cash rounding, stock is derived, every journal balances.

### Lists
- **Pagination + an index on every list.** Assume 100k+ rows. No unbounded `SELECT *`.

### Logging
- App log to a file in `userData`. Audit log in the DB. They are different things — keep both.

### Tests
- vitest for **every service**. A **regression test for every bug fixed** — no exceptions.
- The double-entry engine has a standing test: **after every scenario, the trial balance balances.**
- Run `npm rebuild better-sqlite3 --build-from-source` before tests (electron-builder rebuilds it for
  Electron's ABI, which breaks vitest). This is baked into the `test` script — do not remove it.

### UI standards
- Light + dark mode. WCAG AA contrast. Skeletons, loading, empty, and error states. Toasts.
- Keyboard-first on the Sell screen. The cashier's hands never leave the keyboard/scanner.
- **lucide-react icons only. Never emojis.**
- **Never Mantine `AppShell`** — it rendered a blank screen in the packaged build. Use a plain flex
  layout. (See traps.)
- The **app version is always visible in the header** so we can tell which build a user is on.

## 5. Known traps — all of these have already burned us

### Packaging / auto-update
1. **The updater ships in v0.1.0 itself.** Auto-update is performed by the *already-installed* app. An
   app shipped without an updater can never update itself — every user re-installs by hand, forever.
2. electron-builder's GitHub publish defaults to **draft** releases, which the updater cannot see.
   Set `publish.releaseType: "release"`.
3. You **cannot create a GitHub release in an empty repo** (422 "Repository is empty"). CI must seed a
   README commit first.
4. If the code repo is **private**, never embed a token in the app. Publish installers to a **separate
   PUBLIC releases repo**; the PAT lives only in CI secrets.
5. NSIS: `oneClick: true`, `perMachine: false` → silent install *and* fully silent auto-update.
   `allowToChangeInstallationDirectory` is invalid with `oneClick`.
6. Local and CI test builds use `--publish never`, or the build fails demanding a token.
7. macOS: ad-hoc `codesign --force --deep --sign -` after build or the app won't launch. Real mac
   auto-update needs a paid Apple cert — **treat Windows as the real target.**
8. `asarUnpack` native modules (better-sqlite3) or they will not load at runtime.

### Electron runtime
9. **Always test the PACKAGED build, not just dev.** Things work in dev and break packaged. Mantine
   `AppShell` rendered a blank screen packaged — we use a plain flex layout because of it.
10. **better-sqlite3 ABI:** electron-builder rebuilds it for Electron, which then breaks vitest. Run
    `npm rebuild better-sqlite3` before tests (this is baked into the `test` script).
10b. **Do NOT add `--build-from-source` to that rebuild.** The project path contains SPACES
    ("POS Insha Desktop"), and node-gyp generates a Makefile that breaks on them —
    `/bin/sh: Insha: command not found`. Plain `npm rebuild` uses prebuild-install, which downloads
    the correct Node-ABI binary and never invokes the compiler. It is also faster. (If we ever need
    a genuine source build, the project must first be moved to a path with no spaces.)
10c. **`rebuild:electron` MUST delete `node_modules/better-sqlite3/build` first.** Once `npm test`
    has dropped a NODE-ABI prebuilt in place, `electron-builder install-app-deps` looks at it,
    decides nothing needs rebuilding, and **SHIPS THE NODE BINARY INSIDE THE APP**. The installer
    builds cleanly, and then the app dies on launch with
    `NODE_MODULE_VERSION 127 ... requires 148`. It nearly shipped. This is exactly why trap #9 says
    LAUNCH THE PACKAGED BUILD — the tests, the typecheck and the build were all green.
11. Large HTML (e.g. embedded fonts) breaks `loadURL('data:...')`. Write a temp file and `loadFile`.

### Printing / PDF
12. **No `box-shadow` in print HTML** — Chromium renders shadows as ugly gray blocks.
13. **No external fonts or images** (offline + CSP). Embed fonts as base64 data URIs or use system
    fonts. The receipt designer offers a **bundled font list only** — arbitrary system fonts break
    offline PDF.
14. **Render the PDF and LOOK at it before shipping it.** Never ship a print layout you have not seen.
15. Thermal receipts: fixed width (58mm / 80mm), monospace-ish, no color. Test long-name wrapping.
16. Watch for a trailing blank page (`@page` size + `page-break-after` + `min-height`).

### Data / logic
17. **Derived status must update from every path.** (See §4.) Covered by a test.
18. **Don't POST the whole object back** — it wipes fields the form didn't load. (See §4.)
19. Careful with `useEffect` deps — a re-run once reset auth phase and bounced the user to login.

### Architecture
20. **NEVER share the SQLite file over a network drive or static IP — it corrupts.** If multiple
    terminals are ever needed, one machine runs a server process that owns the DB and exposes an API.
    The `services/` layer is transport-agnostic so this is a transport swap, not a rewrite.

## 6. Licensing (commercial product)

- **Ed25519 signed license keys, verified offline.** The app embeds **only the public key**.
- **The private key never enters the app or the repo.** It lives with the vendor, outside the repo,
  and is in `.gitignore`. `tools/` is maintainer-only and is **not shipped in the installer**.
- License payload: `{ licensee, machineId, plan, issuedAt, expiresAt, features }` + signature, base64.
- **Machine ID is a stable hash fingerprint.** Never expose raw hardware serials.
- Plans: **Demo/Trial** (N days, full features, persistent "TRIAL — X days left" banner),
  **Annual** (default), **Lifetime**.
- **License is verified in the MAIN process only.** The renderer is not a security boundary.
- **Expiry NEVER holds data hostage.** Warn at 30/15/7/1 days. After expiry the app goes
  **READ-ONLY**: they can open it, view everything, run reports, and **back up / export their data**.
  They just cannot make new sales/purchases until renewed. **Never delete, hide, or encrypt their data.**
- Clock-rollback detection: last-seen timestamp in the DB *and* a separate file; a large backwards jump
  marks the license tampered and requires re-activation.
- Offline DRM is defeatable by a determined attacker. The goal is to stop **casual copying**, not to
  build unbreakable DRM. Keep it simple and reliable — do not over-engineer.

## 7. Working agreement

- **Ask before inventing a business rule.** Never invent data.
- Work in phases. After **every** phase: `typecheck` → `tests` → **build the installer** → hand over an
  exact click-by-click list to verify.
- **Bump the version on every release.** The version is visible in the app header.
- When given a design (receipt / invoice / report), match it — then **render it and show the output**.
- Prefer boring, obvious code. This app will be maintained for years by someone reading it cold.
