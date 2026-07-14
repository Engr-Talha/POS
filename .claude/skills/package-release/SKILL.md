---
name: package-release
description: Build the installer and ship a release. Use when packaging, bumping the version, testing auto-update, or publishing. Encodes every packaging and auto-update trap.
---

# Package & release

## The rule that governs everything

**The updater must be INSIDE the build you ship** (trap #1). Auto-update is performed by the
*already-installed* app. If v0.1.0 has no updater, every user re-installs by hand — forever. There is no
retrofit. This is why `electron-updater` is wired in from v0.1.0 even though **publishing is deferred**.

Right now: the app checks for updates, finds nothing, and **stays silent**. A failed update check is
**never** shown to the cashier.

## Config that must stay true

```jsonc
// electron-builder
"nsis": {
  "oneClick": true,          // silent install AND fully silent auto-update — no wizard clicks
  "perMachine": false        // no admin prompt
  // NEVER add allowToChangeInstallationDirectory — invalid with oneClick (trap #5)
},
"publish": {
  "provider": "github",
  "releaseType": "release"   // default is "draft" — the updater CANNOT SEE drafts (trap #2)
},
"asarUnpack": ["**/node_modules/better-sqlite3/**"]  // native module won't load otherwise (trap #8)
```

## Build

```bash
npm run build:mac     # .dmg, ad-hoc signed, --publish never
```
- **`--publish never` on every local and CI build** (trap #6) or the build fails demanding a token.
- **macOS needs `codesign --force --deep --sign -`** after build or the app will not launch (trap #7).
  Real mac auto-update needs a paid Apple cert — **Windows is the real target.**

**Windows `.exe` builds in GitHub Actions as a workflow artifact** (`--publish never`, no release).
Cross-building Windows from macOS is unreliable. Push → open the Actions run → download the artifact →
install on the Windows box.

## Proving auto-update before GitHub exists

Use electron-updater's **`generic` provider** against a local HTTP folder:

1. Build v0.1.0, install it.
2. Bump to v0.1.1, build, drop the installer + `latest.yml` into a folder.
3. Serve that folder over HTTP (`npx serve`), point the generic feed at it.
4. Launch the **installed** v0.1.0 → it must update itself to v0.1.1 **with zero clicks**.

If that works, GitHub is just a different URL later.

## Every release

1. **Bump the version.** It is rendered in the app header so we can tell which build a user is on.
2. `npm run typecheck && npm test` (the test script rebuilds better-sqlite3 for the Node ABI — trap #10).
3. Build the installer.
4. **Install and launch the PACKAGED app** (trap #9). Dev working proves nothing — Mantine `AppShell`
   rendered a blank screen packaged.
5. Hand the owner an exact click-by-click verification list.

## When publishing is switched on (later phase)

- If the code repo is **private**, do **not** embed a token in the app. Publish installers to a
  **separate PUBLIC releases repo**; the PAT lives **only** in CI secrets (trap #4).
- **You cannot create a release in an empty repo** (422 "Repository is empty") — CI must seed a README
  commit first (trap #3).
- Confirm `releaseType: "release"`, not draft (trap #2).
