import type { Migration } from './index'

/**
 * 0010 — RETIRING A STAFF MEMBER CLEARS THEIR PIN. Backfill the invariant on existing databases.
 *
 * The quick-switch PIN identifies who rang up a sale, so no two ACTIVE users may share one — the
 * collision check and PIN sign-in both scan active users only (that is all they ever need to). But
 * retiring a user used to leave their `pin_hash` sitting on the row. That dormant PIN was a landmine:
 *
 *     1. Sara (active) has PIN 4821.
 *     2. Sara is retired — is_active flips to 0, but pin_hash 4821 STAYS.
 *     3. Ali is hired and given PIN 4821. The collision check looks at active users, does not see the
 *        retired Sara, and allows it.
 *     4. Sara is reactivated. Now TWO active users hold 4821. PIN sign-in and supervisor-approval both
 *        return the FIRST row that matches — so Ali's sales, and worse, approvals, get logged under
 *        Sara. One PIN, two identities, a false audit trail. Exactly what the rule exists to prevent.
 *
 * The fix is a single invariant, enforced from the write path (users.deactivate now also NULLs the
 * PIN) and established for data written before that fix by this migration:
 *
 *     inactive  ⟹  no PIN.
 *
 * A retired person returns with no quick-switch PIN; the owner sets them a fresh one, which
 * collision-checks the normal way. A PIN is a re-settable credential, not a business record — clearing
 * a dormant one loses nothing (CLAUDE.md "data safety" is about the shop's money, not a login shortcut).
 *
 * FORWARD-ONLY (CLAUDE.md §4): one UPDATE that only NULLs a credential column on already-retired rows.
 * It drops and renames nothing, and touches no active user.
 */
export const migration0010: Migration = {
  version: 10,
  name: 'retire clears PIN: NULL pin_hash on already-inactive users (inactive ⟹ no PIN)',
  up: (db) => {
    db.exec(`
      UPDATE users SET pin_hash = NULL WHERE is_active = 0 AND pin_hash IS NOT NULL;
    `)
  }
}
