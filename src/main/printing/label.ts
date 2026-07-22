import { formatMoney } from '@shared/money'
import { htmlToPdfBuffer } from './printer'

/**
 * PEEL-AND-STICK LABEL SHEETS.
 *
 * The shop generates in-store barcodes (services/barcode-gen.ts) for its loose goods, then prints
 * sheets of labels to stick on them. This lays those labels out on an A4 sheet as a grid of cells,
 * each one carrying the item name, the barcode as an inline SVG, the human-readable digit string,
 * and (optionally) the price.
 *
 * ── THE BARCODE IS DRAWN, NOT FETCHED ───────────────────────────────────────────────────────────
 *
 * There is NO barcode npm library and there will not be one: nothing is installed, CLAUDE.md forbids
 * adding external print assets, and a webfont/image/CDN cannot be reached at the till anyway (offline
 * + CSP). So the EAN-13 bars are drawn here, in pure TypeScript, as `<rect>` modules in an inline
 * `<svg>`. The encoding tables (L/G/R, the first-digit parity table, the guard patterns) are small
 * and well known. The digits underneath print in a SYSTEM font.
 *
 * ── EVERY PRINT TRAP APPLIES (CLAUDE.md §5) ─────────────────────────────────────────────────────
 *
 *   NO box-shadow           Chromium prints a shadow as a grey block (trap #12). Borders only.
 *   NO external font/image  System font stack, no @font-face, no url(), no <img>. (trap #13)
 *   NO trailing blank page  Nothing sets a fixed page height and the last cell forces no page break,
 *                           so there is no phantom final page. (trap #16)
 *
 * The HTML is a full document written to a temp file and rendered by printToPDF via printing/printer.ts
 * — NEVER loadURL('data:...'), which breaks on large HTML (trap #11).
 */

export type LabelSpec = {
  name: string
  /** A 13-digit EAN-13 (the digit string is drawn as-is; the bars encode the first 12 + check). */
  barcode: string
  /** Integer minor units. Omit to print no price. */
  price?: number | undefined
  /** The stock code, printed small. Optional. */
  sku?: string | undefined
}

export type LabelSheetOptions = {
  /** How many label cells across the page. From settings (`labels.perRow`). */
  perRow: number
  /** Label width in millimetres. From settings (`labels.widthMm`). */
  widthMm: number
  /** Label height in millimetres. From settings (`labels.heightMm`). */
  heightMm: number
  /** Print the price on the label. From settings (`labels.showPrice`). */
  showPrice: boolean
  /** Currency symbol for the price, from Settings (`currency.symbol`). */
  currencySymbol: string
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EAN-13 ENCODING — the well-known tables, and the pure SVG generator
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The L, G and R digit patterns. Each is 7 modules wide; a '1' is a bar, a '0' is a space.
 *
 * EAN-13 encodes 12 visible digits into bars. The FIRST digit is not drawn as bars at all — it is
 * encoded implicitly by the L/G parity pattern chosen for the six digits of the left half. The right
 * half is always R. These three tables and the parity table below are the whole of the standard.
 */
const L_CODES = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011'
]
const G_CODES = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111'
]
const R_CODES = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100'
]

/**
 * THE FIRST-DIGIT PARITY TABLE. The first digit chooses which of the six left-half digits are L and
 * which are G ('L' = left/odd parity, 'G' = even parity). The right half is always R.
 */
const FIRST_DIGIT_PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'
]

const GUARD = '101' // start and end
const CENTRE = '01010' // splits the two halves

/**
 * The 95-module bar string for a 13-digit EAN-13.
 *
 *   guard(3) + 6 left digits ×7 (42) + centre(5) + 6 right digits ×7 (42) + guard(3) = 95 modules.
 *
 * Requires exactly 13 digits — this is fed a code that already passed generation/validation, so a bad
 * input is a programmer error, and we let it throw rather than draw a wrong barcode.
 */
export function ean13Modules(code13: string): string {
  if (!/^\d{13}$/.test(code13)) {
    throw new Error(`ean13Modules expects 13 digits, got "${code13}"`)
  }

  const digits = code13.split('').map((d) => d.charCodeAt(0) - 48)
  const first = digits[0]!
  const parity = FIRST_DIGIT_PARITY[first]!

  let modules = GUARD
  // Left half — digits 2..7 (indices 1..6), each L or G per the parity pattern.
  for (let i = 0; i < 6; i++) {
    const digit = digits[i + 1]!
    modules += parity[i] === 'L' ? L_CODES[digit]! : G_CODES[digit]!
  }
  modules += CENTRE
  // Right half — digits 8..13 (indices 7..12), always R.
  for (let i = 0; i < 6; i++) {
    modules += R_CODES[digits[i + 7]!]!
  }
  modules += GUARD

  return modules
}

/**
 * The EAN-13 as an inline SVG: one `<rect>` per run of bar modules, plus the human-readable digits
 * beneath in a system font. Pure markup — no font, no image, no script, no external anything.
 *
 * Guard and centre bars are drawn taller than the data bars, the way a real EAN-13 is, so the code
 * reads correctly and looks like the barcodes a scanner is built to see.
 */
export function ean13Svg(code13: string): string {
  const modules = ean13Modules(code13)

  const moduleWidth = 2 // SVG user units per module
  const barsHeight = 60
  const guardHeight = 66 // guard + centre bars extend below the data bars
  const textHeight = 14
  const totalWidth = modules.length * moduleWidth // 95 × 2 = 190
  const totalHeight = guardHeight + textHeight

  // Which module indices belong to the taller guard/centre bars: start 0..2, centre 45..49, end 92..94.
  const isGuard = (i: number): boolean =>
    (i >= 0 && i < 3) || (i >= 45 && i < 50) || (i >= 92 && i < 95)

  // One <rect> per contiguous run of '1's. Fewer rects than one-per-module, and every bar is exact.
  const rects: string[] = []
  let i = 0
  while (i < modules.length) {
    if (modules[i] === '1') {
      let run = 1
      // A run must not merge a guard bar with a normal bar — they are different heights.
      while (i + run < modules.length && modules[i + run] === '1' && isGuard(i + run) === isGuard(i)) {
        run++
      }
      const x = i * moduleWidth
      const width = run * moduleWidth
      const height = isGuard(i) ? guardHeight : barsHeight
      rects.push(`<rect x="${x}" y="0" width="${width}" height="${height}" />`)
      i += run
    } else {
      i++
    }
  }

  // The human-readable line: EAN-13 conventionally prints the first digit to the LEFT of the bars and
  // the rest beneath, but printing the whole string centred beneath is universally scanned and far
  // simpler to lay out in a tiny label cell. We print the full 13-digit string.
  const textY = guardHeight + textHeight - 3

  return `<svg class="bars" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="barcode ${code13}">
  <g fill="#000">${rects.join('')}</g>
  <text x="${totalWidth / 2}" y="${textY}" text-anchor="middle" font-family="monospace" font-size="12" letter-spacing="1" fill="#000">${code13}</text>
</svg>`
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SHEET
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Clamp the layout settings to something sane — a hand-edited settings row is not to be trusted. */
function resolveLayout(opts: LabelSheetOptions): {
  perRow: number
  widthMm: number
  heightMm: number
} {
  const perRow = Math.min(6, Math.max(1, Math.trunc(opts.perRow) || 3))
  const widthMm = Math.min(210, Math.max(20, Math.trunc(opts.widthMm) || 63))
  const heightMm = Math.min(297, Math.max(15, Math.trunc(opts.heightMm) || 30))
  return { perRow, widthMm, heightMm }
}

function labelCellHtml(label: LabelSpec, opts: LabelSheetOptions): string {
  const price =
    opts.showPrice && label.price != null
      ? `<div class="price">${escapeHtml(formatMoney(label.price, { symbol: opts.currencySymbol }))}</div>`
      : ''
  const sku = label.sku ? `<div class="sku">${escapeHtml(label.sku)}</div>` : ''

  // The name is wrapped, not truncated in the data — a long name simply flows to a second line inside
  // the cell, and `overflow: hidden` on the cell keeps it from spilling into the neighbour. The bars
  // and the price stay put because the name sits in its own clamped box.
  return `<div class="label">
  <div class="name">${escapeHtml(label.name)}</div>
  <div class="code">${ean13Svg(label.barcode)}</div>
  ${price}
  ${sku}
</div>`
}

export function renderLabelSheetHtml(labels: LabelSpec[], opts: LabelSheetOptions): string {
  const { perRow, widthMm, heightMm } = resolveLayout(opts)

  const cells = labels.map((label) => labelCellHtml(label, opts)).join('\n')
  const empty =
    labels.length === 0
      ? '<div class="empty">No labels to print.</div>'
      : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* A4, no page margin — the grid gap does the spacing. No fixed body height (trap #16). */
  @page { size: A4; margin: 8mm; }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }

  body {
    /* System fonts ONLY — no webfont fetched or embedded. Offline + CSP (trap #13). */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .sheet {
    display: grid;
    grid-template-columns: repeat(${perRow}, ${widthMm}mm);
    gap: 2mm;
    justify-content: center;
  }

  /* No box-shadow anywhere — Chromium prints it as a grey block (trap #12). A hairline border is the
     cut guide for the label stock. */
  .label {
    width: ${widthMm}mm;
    height: ${heightMm}mm;
    border: 0.2mm dashed #bbb;
    padding: 1.5mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .name {
    width: 100%;
    text-align: center;
    font-size: 8pt;
    line-height: 1.1;
    font-weight: 600;
    /* Two lines at most — a long name wraps, then is clipped so it can never push the bars out. */
    max-height: 2.4em;
    overflow: hidden;
  }

  .code { width: 100%; text-align: center; flex: 0 0 auto; }
  .code svg { width: 100%; height: auto; max-height: ${Math.max(8, heightMm - 14)}mm; }

  .price { font-size: 10pt; font-weight: 700; }
  .sku { font-size: 6.5pt; color: #444; font-family: monospace; }

  .empty { padding: 20mm; text-align: center; color: #666; }
</style>
</head>
<body>
<div class="sheet">
${cells}
</div>
${empty}
</body>
</html>`
}

export async function renderLabelSheetPdf(
  labels: LabelSpec[],
  opts: LabelSheetOptions
): Promise<Buffer> {
  return htmlToPdfBuffer(renderLabelSheetHtml(labels, opts))
}
