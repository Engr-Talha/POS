# LICENSING — generating keys and issuing licences

This app is licensed. It verifies licences **offline**, using Ed25519 signatures. You (the vendor) hold a
**private key** that mints licences; the app ships with only the matching **public key**, which can
verify a licence but never create one.

There are two separate things here, and it is worth keeping them straight:

1. **The keypair** — created ONCE, ever. The private half is the product; guard it with your life.
2. **A licence** — created per customer, per machine, as many times as you sell.

---

## Part 1 — Create the keypair (one time, ever)

```bash
npm run make:keypair
```

> These are npm scripts on purpose. Running the files directly with `npx tsx tools/make-keypair.ts`
> **will not work** — the tools import from `@shared/*`, and the scripts pass `--tsconfig` so those path
> aliases resolve. Always use `npm run make:keypair` and `npm run keygen`.

This writes three files:

| File | Where | What it is |
|---|---|---|
| `license-private.pem` | `~/.insha-pos-keys/` | **THE PRODUCT. Mints licences. Never commit, never share.** |
| `license-public.pem` | `~/.insha-pos-keys/` | Harmless. A copy of what goes in the app. |
| `public-key.ts` | `src/main/security/` | The public key, embedded in the app source. Commit this. |

`~/.insha-pos-keys/` is a folder in your home directory, **outside the repo** — the private key can never
be committed from there. The private file is written owner-read-only (`chmod 600`).

**The tool refuses to overwrite an existing private key.** That is deliberate: regenerating it would
invalidate every licence you have ever issued, and every customer would go read-only until re-licensed.
If you ever truly need a new keypair, delete the old private key by hand first — and know that you are
starting the whole customer base over.

### RIGHT AFTER YOU RUN IT — back the private key up

```bash
cat ~/.insha-pos-keys/license-private.pem
```

Copy that whole block (including the `-----BEGIN/END-----` lines) into a **password manager**, or another
safe you control. This is the one irreplaceable thing in the whole business:

> **Lose the private key and you can never issue or renew a licence for an existing customer again**
> without shipping a whole new app build with a new public key baked in — which every existing customer
> would then have to reinstall.

It is not stored in the cloud, not in the repo, not anywhere but your machine and wherever you back it up
to. That is the point. If your laptop dies and you have no backup, the product's licensing is gone.

### Then commit the public key

```bash
git add src/main/security/public-key.ts
git commit -m "Embed licence public key"
```

The public key in the app is **safe to be public** — it can only *check* a licence's signature, never
forge one. It is fine that the repo is public and this key is in it.

---

## Part 2 — Issue a licence to a customer

When someone buys, they send you their **Machine ID** and you send back a **key**. No internet either
side — you email/WhatsApp two short strings.

### The flow

1. The customer installs the app. On first run (or when the trial ends) it shows an **Activation**
   screen with a **Machine ID** — a short fingerprint like `A1B2-C3D4-E5F6-7890`. They send it to you.
2. You mint a key for that exact machine:

   ```bash
   # A one-year licence (the default). Note the `--` before the arguments.
   npm run keygen -- --licensee "Insha Kiryana Store" --machine-id A1B2-C3D4-E5F6-7890

   # A 14-day free trial — full features, shows a "TRIAL — N days left" banner
   npm run keygen -- --licensee "Test Shop" --machine-id A1B2-C3D4-E5F6-7890 --plan trial --days 14

   # A lifetime licence — never expires
   npm run keygen -- --licensee "Big Shop" --machine-id A1B2-C3D4-E5F6-7890 --plan lifetime
   ```

3. The tool prints a licence key. **Paste that key back to the customer.** They enter it on the
   Activation screen and they are running.

### The plans

| `--plan` | Expiry | Use for |
|---|---|---|
| `annual` (default) | 1 year from today (`--days N` to override) | the normal sale |
| `trial` | `--days N` (default 14) | letting someone try it |
| `lifetime` | never | a one-off purchase |

### The Machine ID matters

A licence is **bound to the machine** it was issued for. If the customer changes computers, their old key
will not activate the new one — they send you the new Machine ID and you mint a fresh key. This is what
stops one purchased licence being copied to ten tills. (It is a fingerprint, not a hardware serial — the
app never exposes real serial numbers.)

---

## What expiry does — and does NOT do

**Expiry never holds a shop's data hostage.** This is a hard rule (CLAUDE.md §6). After a licence expires
the app goes **read-only**:

- they can still open it, see everything, run every report, and **back up / export all their data**;
- they just cannot make new sales, purchases or other changes until they renew.

The app warns them at **30, 15, 7 and 1 days** before expiry. Renewing is the same flow as activating: you
mint a new key for the same Machine ID, they paste it in.

**Nothing is ever deleted, hidden, or encrypted when a licence lapses.** A shop's books are theirs.

---

## The rules, in one place

- **The private key is the product.** `~/.insha-pos-keys/license-private.pem`, outside the repo, backed up
  in a password manager, shared with no one.
- **The public key is safe to ship** and safe to have in a public repo — it only verifies.
- **`tools/` is maintainer-only** and is *not* bundled into the installer a customer receives.
- **`.gitignore` is a safety net, not the storage.** The keys live outside the repo by design; the ignore
  patterns (`*private*.pem`, `license-private.*`, `.insha-pos-keys/`, …) exist only to catch a mistake if
  a key is ever copied into the tree.
- **Regenerating the keypair invalidates every licence ever issued.** Do it only if you mean to.
