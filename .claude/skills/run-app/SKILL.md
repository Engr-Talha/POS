---
name: run-app
description: Run the POS in dev, run the tests, or run the PACKAGED build. Use whenever asked to start, launch, test, or verify the app. Always covers the better-sqlite3 ABI trap.
---

# Run the app

## Dev
```bash
npm run dev          # electron-vite dev — hot reload
```

## Typecheck + tests
```bash
npm run typecheck
npm test             # runs `npm rebuild better-sqlite3 --build-from-source` first — see below
```

**The better-sqlite3 ABI trap (#10).** electron-builder rebuilds better-sqlite3 against Electron's ABI,
which then breaks vitest (Node ABI). The `test` script rebuilds it from source first. If you see
`NODE_MODULE_VERSION` / "was compiled against a different Node.js version":

```bash
npm rebuild better-sqlite3 --build-from-source   # to run tests
npm run build:mac                                # rebuilds it for Electron again
```

They fight each other. That is expected. Rebuild for whichever you're about to run.

## The packaged build — this is the one that matters

**Trap #9: things work in dev and break packaged.** A phase is not done until the packaged app runs.
Mantine `AppShell` rendered a blank screen packaged; we use a plain flex layout. If the window is blank,
suspect a component that behaves differently under `file://`, not your logic.

```bash
npm run build:mac    # .dmg + ad-hoc codesign (trap #7) + --publish never (trap #6)
open release/*.dmg
```

Windows `.exe` is built in **GitHub Actions as a workflow artifact** — cross-building from macOS is
unreliable. Push, then download the artifact from the Actions run and install it on the Windows box.

## Debugging the packaged app
- Main-process log: `~/Library/Application Support/<app>/logs/` (macOS),
  `%APPDATA%\<app>\logs\` (Windows).
- Renderer errors: open DevTools in the packaged build (enabled in non-production, or via the menu).
- The DB file sits next to the logs in `userData`. **Copy it before poking at it.**
