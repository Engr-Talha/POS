---
name: backup-restore
description: Backup and restore the shop's database. Use when touching backup, restore, the daily backup prompt, or anything that could risk data. Data safety is the highest priority in this app.
---

# Backup & restore

**This is the shop's money. Losing it is the worst thing this app can do.** Every other feature is
negotiable; this one is not.

## How backup works

One SQLite file in `userData`. **Backup = copy the file** — but *correctly*, because WAL mode means the
file on disk is not the whole story.

- Use **`db.backup()`** (better-sqlite3's online backup API) — **not** a raw `fs.copyFile`. A raw copy
  while WAL has uncommitted pages produces a **subtly corrupt** backup that looks fine until you need it.
- The backup is a **single self-contained file**, timestamped: `pos-backup-YYYY-MM-DD-HHmm.db`.
- **Attachments are included** (tax-return files etc.) — the backup is a folder or archive containing the
  DB + the attachments directory. A backup that restores the books but loses the filed tax documents is
  not a backup.
- Record every backup (when, by whom, where, size) and show it in Settings → Backup.

## Rules

- **One-click backup**, always available — including when the **license is expired** (read-only mode
  still allows backup and export; we never hold their data hostage).
- **Daily prompt.** If the last backup is older than a day, prompt on launch. The cashier can back up in
  one click, to a path he chose once.
- Verify the backup **after** writing it: open it and run `PRAGMA integrity_check`. An unverified backup
  is a rumour.
- Let him back up to a **USB drive / another folder** — a backup sitting on the same failing disk is not
  a backup.

## Restore

Restoring **overwrites the shop's live data**. Treat it accordingly.

1. Confirm loudly, in plain language, naming the file and its date.
2. **Back up the current DB first**, automatically, before overwriting it. Always. Even if he says no.
3. Close all DB handles, replace the file, restart the app.
4. Run the **migration runner** on the restored file — it may be from an older version. Migrations are
   forward-only, so this is safe.
5. `PRAGMA integrity_check` after restore. If it fails, roll back to the safety copy taken in step 2 and
   tell him nothing was lost.
6. **Audit-log the restore** (who, when, which file).

## Never

- Never delete a backup automatically.
- Never restore without an explicit confirmation from the user.
- Never write a "cleanup" or "reset" path that can wipe the DB. If one is ever needed, it takes a backup
  first and it is Owner-only.
- Never share the SQLite file over a network drive (trap #20) — it corrupts.

## Test it for real

A restore path that has never been exercised does not work. The test: seed a DB, back it up, make
changes, restore, and assert the data is exactly the backed-up state — **and that the trial balance
still balances.**
