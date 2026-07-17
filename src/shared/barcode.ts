/**
 * ONE definition of "what did the scanner really mean", used EVERYWHERE a barcode is stored or looked
 * up — the product form, `addBarcode`, `findProductByBarcode`, the Sell screen, the Excel importer.
 *
 * WHY THIS EXISTS. A barcode has to be normalised the SAME way when it goes in as when it is searched,
 * or a product created by a scan will not ring up at the till. That bug was real: the product form and
 * `addBarcode` stored the code raw, while the Sell screen stripped a configured prefix before looking
 * up — so a Code-128 item scanned in as `]C19200108` was stored as `]C19200108` and searched for as
 * `9200108`, and never matched. Store and lookup now both call `normalizeBarcode`, so they cannot drift.
 *
 * ── AIM SYMBOLOGY IDENTIFIERS ───────────────────────────────────────────────────────────────────────
 * Many scanners can be set to prepend a 3-character "AIM identifier" announcing the barcode TYPE:
 *   ]C1  Code 128      ]E0  EAN-13 / UPC-A     ]E4  EAN-8      ]d2  Data Matrix     ]Q1  QR
 * The format is fixed: `]` + one LETTER + one DIGIT. It is metadata about the symbology, never part of
 * the article number, so it is stripped. A shop should not have to find the config barcode in a scanner
 * manual to make the till work — the app removes it whatever type the item is, with no setting to set.
 * (The per-shop `scanner.prefix`/`scanner.suffix` settings still exist for the ODD scanner that wraps a
 * code in something non-standard; this handles the standard case for free, and runs first.)
 *
 * ── THE GUARD THAT KEEPS IT SAFE ────────────────────────────────────────────────────────────────────
 * A real barcode CAN start with `]`. So we strip ONLY a well-formed 3-char AIM identifier, and ONLY when
 * something is left after it — never turning a genuine code into an empty string. Anything that does not
 * match the exact `]`-letter-digit shape is left completely untouched.
 */

/** `]` followed by exactly one ASCII letter and one digit, at the very start. */
const AIM_IDENTIFIER = /^\][A-Za-z][0-9]/

/**
 * Trim, then strip a leading AIM symbology identifier if one is present (and something remains).
 * Idempotent: normalising an already-clean code returns it unchanged, so it is safe to call on both the
 * way in and the way out.
 */
export function normalizeBarcode(raw: string): string {
  const trimmed = raw.trim()
  if (AIM_IDENTIFIER.test(trimmed) && trimmed.length > 3) {
    return trimmed.slice(3)
  }
  return trimmed
}
