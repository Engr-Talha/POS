---
name: add-feature
description: Add any new feature or screen to the POS. Use for new IPC handlers, services, or renderer screens. Enforces the main/renderer boundary, the Result envelope, RBAC, and the audit log.
---

# Add a feature

Work outside-in through the layers. **Never skip a layer** — a renderer that talks to the DB is the one
architectural mistake we cannot undo later.

## The layers

```
renderer (React+Mantine)  →  preload (contextBridge whitelist)  →  ipc handler (thin)  →  service (all logic)  →  db
```

1. **`src/shared/`** — the zod schema + TS types for the input and output. One definition, both sides.
2. **`src/main/services/xyz.ts`** — the real logic. **Transport-agnostic**: plain args in, plain data
   out. It must not import anything from `electron`. This is what lets it become a LAN server later.
3. **`src/main/ipc/xyz.ts`** — thin. zod-validate the input → check RBAC → check the license → call the
   service → wrap in the Result envelope. No business logic.
4. **`src/preload/index.ts`** — add the method to the whitelist. Nothing else.
5. **`src/renderer/`** — the screen. Mantine + lucide-react. **No emojis as icons.**
6. **vitest** — test the *service*, not the IPC layer. That's where the logic is.

## Every IPC handler

```ts
{ ok: true, data: T }
| { ok: false, error: { code, userMessage, technical } }
```

`userMessage` is what a **cashier** reads. "This item is out of stock" — not
`SQLITE_CONSTRAINT: FOREIGN KEY failed`. The technical string goes to the log, not the screen.

## Enforce in main, always

- **RBAC in the main process.** Hiding a button is a courtesy; the check that matters is the one the
  service does. Prove it with a test that calls the service directly as a Cashier and expects a refusal.
- **License in the main process.** If the license is expired, every *write* path refuses — but every
  *read*, report, and export still works. **Never hold their data hostage.**

## If the feature touches money, stock, or a party balance

- It **posts a balanced journal entry**. Double-entry is day one.
- It writes a **`stock_movements`** row if stock changes. Never mutate a stock column.
- If it's a **void, refund, discount above the threshold, price override, or no-sale drawer open**:
  it requires a **reason code** (lookups-driven) + **supervisor approval**, and writes an
  **audit_log** row with user id + name + **role** + timestamp.

## Dropdowns
**Every** select reads from the `lookups` table, is editable in Settings → Manage Lists, and has an
inline "+ add new". **Never hardcode options.** If you are about to type an array of strings for a
`<Select>`, stop — it belongs in `lookups`.

## Lists
Paginated, with an index behind the sort/filter. Assume 100k+ rows. Skeleton → empty state → error
state → data. All four.
