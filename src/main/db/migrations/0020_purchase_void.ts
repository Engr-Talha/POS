import type { Migration } from './index'

/**
 * 0020 — CORRECTING A PURCHASE INVOICE.
 *
 * The client's words: "Purchase invoice me agar koi mistake ho jaye to use edit ho jaye ya delete karni
 * ho to kar do" — they keyed a delivery wrong and cannot fix it.
 *
 * ── WHY THIS IS A VOID AND NOT AN EDIT ──────────────────────────────────────────────────────────────
 * A purchase has ALREADY moved stock onto the shelves and money into the books. Editing it in place
 * would silently rewrite months the owner has already looked at: last month's closing stock value and
 * last month's profit would BOTH change after they were reported. Worse, the weighted average cost is a
 * running blend of every movement in order — rewriting one movement's cost in the middle of that chain
 * does not recompute the sales that were costed off it, so COGS on invoices already given to customers
 * would quietly become wrong.
 *
 * So the wrong invoice is REVERSED with a contra, and a corrected one is entered fresh. Nothing is ever
 * erased. To the shopkeeper this is ONE button — "Correct this invoice" — so it FEELS like editing. The
 * books tell the truth underneath: what was received, that it was cancelled, why, and by whom.
 *
 * ── FORWARD-ONLY (CLAUDE.md §4) ─────────────────────────────────────────────────────────────────────
 * Nothing is dropped or renamed. Four columns are ADDED to `purchases`, mirroring exactly what
 * migration 0007 added to `sales` for a sale void. Every existing purchase backfills to 'completed',
 * which is what every row in every existing database already is.
 *
 * ── THE CHECK CONSTRAINT IS THE POINT ───────────────────────────────────────────────────────────────
 * A voided purchase MUST carry its reason, its author and its timestamp; a live one must carry none of
 * them. That pairing is enforced by the DATABASE, not by hope — a void with no reason is a void nobody
 * can explain a year later, and this is the shop's money. (Same constraint sales carries.)
 */
export const migration0020: Migration = {
  version: 20,
  name: 'purchase void: status, void_reason_code, voided_by, voided_at',
  up: (db) => {
    db.exec(`
      -- 'completed' -> the goods were received and the books have it. The only status a new purchase has.
      -- 'voided'    -> reversed by a contra. The document STAYS, with its number and all its lines, and
      --                the stock movements and journal that reversed it also stay. TERMINAL.
      ALTER TABLE purchases ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';

      -- WHY, from lookups('void_reason') — the owner's OWN list, never a hardcoded dropdown
      -- (CLAUDE.md §4). The same list a sale void uses: "keyed wrong", "wrong supplier", "duplicate".
      ALTER TABLE purchases ADD COLUMN void_reason_code TEXT;
      -- WHO cancelled it, and WHEN. The audit row says it too; this keeps it on the document itself, so
      -- the printed GRN can say "CANCELLED" without a join to the audit log.
      ALTER TABLE purchases ADD COLUMN voided_by INTEGER REFERENCES users (id);
      ALTER TABLE purchases ADD COLUMN voided_at TEXT;
    `)

    // The purchases list filters and sorts on status the moment there is more than one value in it.
    db.exec(`CREATE INDEX idx_purchases_status ON purchases (status, at DESC);`)

    // SQLite cannot ADD a CHECK constraint to an existing table, and rebuilding `purchases` to get one
    // would mean copying a shop's entire buying history through a temp table — the single riskiest thing
    // this migration could do, for a constraint a trigger enforces just as absolutely. So: triggers.
    // They fire on the real write path, they cannot be bypassed by the service layer, and they say the
    // same thing the sales CHECK says.
    db.exec(`
      CREATE TRIGGER trg_purchases_void_fields_insert
      BEFORE INSERT ON purchases
      FOR EACH ROW
      WHEN NOT (
        (NEW.status = 'voided'     AND NEW.void_reason_code IS NOT NULL
                                   AND NEW.voided_by IS NOT NULL AND NEW.voided_at IS NOT NULL)
        OR
        (NEW.status <> 'voided'    AND NEW.void_reason_code IS NULL
                                   AND NEW.voided_by IS NULL AND NEW.voided_at IS NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'a voided purchase must carry a reason, an author and a timestamp');
      END;

      CREATE TRIGGER trg_purchases_void_fields_update
      BEFORE UPDATE ON purchases
      FOR EACH ROW
      WHEN NOT (
        (NEW.status = 'voided'     AND NEW.void_reason_code IS NOT NULL
                                   AND NEW.voided_by IS NOT NULL AND NEW.voided_at IS NOT NULL)
        OR
        (NEW.status <> 'voided'    AND NEW.void_reason_code IS NULL
                                   AND NEW.voided_by IS NULL AND NEW.voided_at IS NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'a voided purchase must carry a reason, an author and a timestamp');
      END;
    `)
  }
}
