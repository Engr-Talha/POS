---
name: license-keygen
description: Generate and manage offline Ed25519 license keys (vendor-only). Use when working on activation, license verification, expiry, read-only mode, clock-rollback detection, or issuing a key for a customer.
---

# Licensing (vendor-only)

Offline, cryptographically signed licenses. **The goal is to stop casual copying, not to build
unbreakable DRM.** Offline DRM is always defeatable by a determined attacker. Keep it simple and
reliable; do not over-engineer.

## The keypair

- **Ed25519.** The app embeds **only the public key**.
- **The private key NEVER goes into the app or the repo.** It lives outside the repo (local file / env
  var) and is in `.gitignore`. If it leaks, anyone can mint licenses.
- `tools/` is **maintainer-only** and is **not shipped in the installer**.

```bash
npx tsx tools/make-keypair.ts        # ONCE. Writes the public key into the app; stores the private key OUTSIDE the repo.
npx tsx tools/keygen.ts --licensee "Insha Store" --machine-id <ID> --plan annual --days 365
```

## A key is

base64 of `{ licensee, machineId, plan, issuedAt, expiresAt, features }` + an **Ed25519 signature**.
Verified **offline**, in the **main process only** — the renderer is not a security boundary.

## Activation flow (no internet, ever)

1. First run → **Activation screen** showing the **Machine ID** — a **stable hash fingerprint**. Never
   expose raw hardware serials.
2. Customer sends the Machine ID to the vendor.
3. Vendor runs `tools/keygen.ts` → produces a key.
4. Customer pastes the key → verified → activated. Key + parsed license stored in the DB.

## Plans

- **Demo / Trial** — N days, full features, persistent **"TRIAL — X days left"** banner.
- **Annual** — 1 year. **The default.**
- **Lifetime** — no expiry.

## Expiry — never hold the customer's data hostage

- Warn in-app at **30 / 15 / 7 / 1 days** before expiry (banner + notification).
- After expiry the app goes **READ-ONLY**:
  - ✅ open the app, view everything, run every report, **export**, and **back up**
  - ❌ new sales, purchases, or any other write
- **NEVER delete, hide, or encrypt their data.** They paid for it; it's their shop's books.
- Renewal = vendor issues a new key, customer pastes it into **Settings → License**.

## Anti-tamper (light, pragmatic)

**Clock rollback:** store a last-seen timestamp in the DB **and** in a separate file. If system time
jumps backwards beyond a tolerance, mark the license `tampered` and require re-activation. That's it —
resist the urge to add more.

## Settings → License shows

Licensee, plan, **Machine ID**, issued date, **expiry date + days remaining**, status badge, and an
"Enter / update key" box.

## Required tests

- valid key activates
- **tampered key rejected** (payload edited, signature no longer verifies)
- **expired key → read-only** — and the data is **still readable and exportable**
- **wrong-machine key rejected**
- **clock rollback detected**
