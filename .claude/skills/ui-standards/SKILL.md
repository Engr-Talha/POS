---
name: ui-standards
description: UI rules for any screen, component, receipt, or printed document. Use when building or changing anything the user sees or prints. Covers Mantine, icons, states, keyboard-first Sell screen, and the print/PDF traps.
---

# UI standards

The user is a **non-technical cashier** who may be serving a queue. Every screen is judged by: can he do
this fast, without reading?

## Rules

- **Mantine** + **lucide-react** icons. **NEVER emojis as icons.**
- **Never Mantine `AppShell`** — it rendered a **blank screen in the packaged build** (trap #9). Plain
  flex layout. If you're tempted, don't.
- Rich text = **Mantine Tiptap** (`@mantine/tiptap`). Never CKEditor.
- **Light + dark mode**, both real. **WCAG AA contrast** in both.
- **Four states on every data view: skeleton → empty → error → data.** An empty table with no message
  is a bug.
- Toasts for every mutation, success and failure. The failure toast shows `userMessage` — never a stack
  trace.
- **The app version is always visible in the header.**
- Every list is **paginated**.
- Every dropdown is **`lookups`-driven** with an inline "+ add new". Never hardcode options.
- Money is formatted in **one** place, at display time. It is an integer everywhere else.

## The Sell screen is keyboard-first

The cashier's hands stay on the keyboard and the scanner. The barcode scanner is an **HID
keyboard-wedge** — it types fast and hits Enter. So:

- The barcode field holds focus by default and **takes focus back** after every action.
- Scan → item on screen **instantly**. No spinner, no round-trip that can stall.
- Everything reachable by key: quantity, discount, payment, hold, resume.
- Scanner profiles are configurable (prefix, suffix, terminator, min length, inter-key timing) plus a
  **Learn mode**: the user scans a sample barcode and the app configures itself.
- Beware `useEffect` deps (trap #19) — a stray re-run once reset the auth phase and bounced the user
  back to login. On this screen it would drop the cart.

## Printing and PDF — the traps that have already burned us

- **NO `box-shadow` in print CSS.** Chromium renders shadows as ugly gray blocks (trap #12).
- **NO external fonts or images** — offline + CSP. Embed fonts as **base64 data URIs**. The receipt
  designer offers a **bundled font list only**; arbitrary system fonts break offline PDF (trap #13).
- Large HTML (embedded fonts) **breaks `loadURL('data:...')`** — write a temp file and `loadFile`
  (trap #11).
- **Thermal receipts:** fixed width **58mm / 80mm**, monospace-ish, no color. **Test long-name
  wrapping** — product names are long and Urdu/English mixed.
- Watch for a **trailing blank page**: `@page` size + `page-break-after` + `min-height` interact badly
  (trap #16).
- **A reprint is stamped `DUPLICATE`.**

## Before you say a print layout is done

**Render it and LOOK at it** (trap #14). Render headless to PDF/PNG, open the output, and actually look
at the image. Never ship a receipt or report you have not seen. Show it to the owner too.
