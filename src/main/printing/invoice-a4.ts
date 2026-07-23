import { APP_NAME } from '@shared/branding'
import { formatMoney } from '@shared/money'
import { formatQty } from '@shared/qty'
import { formatDateTime } from '@shared/dates'
import type { ReceiptData } from '@shared/receipt'
import type { PurchaseDetail } from '@shared/purchases'

/**
 * THE A4 INVOICE — a full-page, letterhead invoice for a SALE and for a PURCHASE.
 *
 * The thermal receipt (./receipt.ts) is a narrow slip off a till roll. THIS is the other document the
 * same shop wants: a proper A4 sheet — logo, letterhead, the lines, the totals, then the terms and a
 * closing note — the thing a customer files, or a shop emails as a PDF. A4 is the DEFAULT print format
 * (invoice.printFormat); the thermal roll is kept as the alternative.
 *
 * ── EVERY PRINT TRAP THIS PROJECT HAS ALREADY BEEN BURNED BY (CLAUDE.md §5) ─────────────────────────
 *
 *   NO box-shadow            Chromium prints a shadow as an ugly grey block (trap #12). Borders only.
 *   NO external font/image   Offline + CSP — there is no network at the till, ever (trap #13). A system
 *                            sans-serif stack, no @font-face, no url(). The ONE image is the shop logo,
 *                            and it is a `data:` URI already embedded in settings — never a remote src.
 *   NO fixed body height     A height plus @page plus a page break is a trailing blank page (trap #16).
 *                            The @page sets the paper size and a zero margin; body padding is the margin.
 *   FILE, not data: URL      The HTML is written to a temp file and rendered by loadFile (printer.ts) —
 *                            NEVER loadURL('data:...'), which breaks on large HTML (trap #11). An embedded
 *                            logo alone is enough to break a data: URL.
 *
 * ── THE NUMBERS ARE NOT RECOMPUTED HERE ─────────────────────────────────────────────────────────────
 *
 * A sale's figures come STRAIGHT off the ReceiptData the thermal receipt already builds from the frozen
 * sale lines (invoiceA4FromReceipt). A purchase's come off the PurchaseDetail's own frozen line totals
 * (invoiceA4FromPurchase). Nothing multiplies qty × price afresh, and nothing re-rounds — the numbers on
 * the A4 sheet and the numbers on the thermal slip are the same numbers, because they are literally the
 * same integers, formatted once through the app's formatMoney / formatQty. (CLAUDE.md §4.)
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE DATA SHAPE — one shape, built from either a sale or a purchase
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type InvoiceA4Line = {
  name: string
  /** Urdu / second-language name. Printed under the name when present. */
  nameOtherLang?: string | null
  /** qty_m — integer thousandths. Formatted through formatQty. */
  qtyM: number
  /** The unit it is sold / bought in — "pcs", "kg". */
  uom?: string | null
  /** Integer minor units. For a purchase this is the line's unit COST, already normalised to 2-dp money. */
  unitPrice: number
  /** Basis points — 1700 = 17%. 0 prints "—". */
  taxRateBp: number
  /** Integer minor units. The line's gross total (net + tax), frozen. */
  lineTotal: number
}

/**
 * Everything the A4 renderer needs, built from a sale OR a purchase. The letterhead (shop, logo, terms,
 * footer) is NOT in here — it comes from settings via InvoiceA4Options, so a sale invoice and a purchase
 * invoice wear the same letterhead no matter which document built the body.
 */
export type InvoiceA4Data = {
  kind: 'sale' | 'purchase'
  /** The invoice number (sale) or the supplier's bill number (purchase). */
  number: string
  /** ISO8601 — when it happened. Written in the shop's own date format. */
  at: string
  /** The customer (sale) or the supplier (purchase). May be blank. */
  partyName?: string | null
  /** "Cashier" (sale) or "Received by" (purchase). May be blank. */
  handledBy?: string | null

  lines: InvoiceA4Line[]

  /** Integer minor units — all frozen off the source document. */
  subtotalNet: number
  discount: number
  taxTotal: number
  grandTotal: number

  /** Money tendered. On a sale, `change` may be > 0; on a purchase, `owed` may be > 0. */
  paid?: number | null
  change?: number | null
  owed?: number | null

  currencySymbol: string
  /** The shop's country decides how a DATE is written. Travels ON the data, never guessed. */
  country?: string | null
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LETTERHEAD — from settings, so both documents look the same
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type InvoiceA4Options = {
  shop: {
    name: string
    address?: string | null
    city?: string | null
    phone?: string | null
    phone2?: string | null
    email?: string | null
    contactPerson?: string | null
    taxNumber?: string | null
  }
  /** A `data:` URI (may be '') — the embedded logo. Offline-safe. Empty = no logo, no gap. */
  logo?: string | null
  /** invoice.pageSize — the @page size. */
  pageSize: 'A4' | 'Letter' | 'A5'
  /** invoice.terms — the shop's terms & conditions. Blank = printed nothing. */
  terms?: string | null
  /** invoice.footer — a closing note. Blank = printed nothing. */
  footer?: string | null
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ADAPTERS — a sale or a purchase into the one shape
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A SALE, as A4 data. The figures come straight off the ReceiptData the thermal receipt already built
 * from the frozen sale lines — no re-multiply, no re-round. `paid` is the sum of the tenders; `change`
 * is what was handed back.
 */
export function invoiceA4FromReceipt(receipt: ReceiptData): InvoiceA4Data {
  const paid = receipt.payments.reduce((sum, p) => sum + p.amount, 0)

  return {
    kind: 'sale',
    number: receipt.invoiceNo,
    at: receipt.at,
    partyName: receipt.customerName ?? null,
    handledBy: receipt.cashierName || null,
    lines: receipt.lines.map((line) => ({
      name: line.name,
      nameOtherLang: line.nameOtherLang ?? null,
      qtyM: line.qtyM,
      uom: line.uom ?? null,
      unitPrice: line.unitPrice,
      taxRateBp: line.taxRateBp,
      lineTotal: line.gross
    })),
    subtotalNet: receipt.subtotalNet,
    discount: receipt.cartDiscount,
    taxTotal: receipt.taxTotal,
    grandTotal: receipt.grandTotal,
    paid,
    change: receipt.changeDue,
    currencySymbol: receipt.currencySymbol,
    country: receipt.country ?? null
  }
}

/**
 * A PURCHASE, as A4 data — the mirror. The figures come off the PurchaseDetail's own frozen line totals.
 *
 * The unit-price column shows the line's UNIT COST. `unitCost` is stored 4-dp (a different scale from
 * money); the LINE total is 2-dp money and it EQUALS the frozen stock-movement value, so we never divide
 * lineTotal by qty and never re-round the 4-dp cost into a 2-dp column. Instead we derive a 2-dp
 * per-unit figure from the frozen line total and the quantity (exact when it divides; otherwise it is a
 * display figure only, and the LINE total — the one that reconciles — is the frozen integer). `owed` is
 * grandTotal − paid, the payable this bill leaves behind.
 */
export function invoiceA4FromPurchase(
  purchase: PurchaseDetail,
  currencySymbol: string,
  country: string | null
): InvoiceA4Data {
  const paid = purchase.payments.reduce((sum, p) => sum + p.amount, 0)

  return {
    kind: 'purchase',
    number: purchase.supplierInvoiceNo || `#${purchase.id}`,
    at: purchase.at,
    partyName: purchase.supplierName ?? null,
    handledBy: purchase.userName || null,
    lines: purchase.lines.map((line) => ({
      name: line.nameSnapshot,
      nameOtherLang: null,
      qtyM: line.qtyM,
      uom: line.uom,
      // The per-unit money figure for the column, derived from the FROZEN 2-dp line total and the
      // quantity — never the raw 4-dp cost re-rounded. The lineTotal is the figure that reconciles.
      unitPrice: unitMoneyFromLine(line.lineTotal, line.qtyM),
      taxRateBp: 0, // purchase lines do not carry a per-line tax rate; input tax is a bill-level total
      lineTotal: line.lineTotal
    })),
    subtotalNet: purchase.subtotalNet,
    discount: 0,
    taxTotal: purchase.taxTotal,
    grandTotal: purchase.grandTotal,
    paid,
    owed: purchase.grandTotal - paid,
    currencySymbol,
    country
  }
}

/**
 * A per-unit 2-dp money figure for the column, from the frozen line total and qty_m (thousandths).
 * lineTotal is minor units; qtyM/1000 is the unit count. Rounded to the nearest minor unit for DISPLAY
 * only — the line total beside it is the frozen integer that actually reconciles to the bill.
 */
function unitMoneyFromLine(lineTotal: number, qtyM: number): number {
  if (qtyM <= 0) return lineTotal
  return Math.round((lineTotal * 1000) / qtyM)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// HTML
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Preserve the shopkeeper's own line breaks in terms/footer — they typed them for a reason. */
function escapeMultiline(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

/** Basis points to a human percentage: 1700 -> "17%", 1750 -> "17.5%". 0 -> "—". */
function formatRate(bp: number): string {
  if (bp === 0) return '&mdash;'
  const percent = bp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/** One letterhead line, rendered ONLY when its value is non-empty — never "Phone: " with nothing after. */
function contactLine(label: string, value: string | null | undefined): string {
  const v = (value ?? '').trim()
  if (v === '') return ''
  return `<div class="contact"><span class="contact-label">${escapeHtml(label)}</span>${escapeHtml(v)}</div>`
}

function lineRowHtml(line: InvoiceA4Line): string {
  const qty = formatQty(line.qtyM)
  const uom = line.uom ? ` ${escapeHtml(line.uom)}` : ''
  const altName = line.nameOtherLang
    ? `<div class="alt-name">${escapeHtml(line.nameOtherLang)}</div>`
    : ''

  return `<tr>
    <td class="name">
      <div>${escapeHtml(line.name)}</div>
      ${altName}
    </td>
    <td class="num">${qty}${uom}</td>
    <td class="num">${formatMoney(line.unitPrice)}</td>
    <td class="num">${formatRate(line.taxRateBp)}</td>
    <td class="num">${formatMoney(line.lineTotal)}</td>
  </tr>`
}

function totalRow(label: string, amount: number, symbol: string, cls = ''): string {
  return `<tr class="${cls}">
    <td class="t-label">${escapeHtml(label)}</td>
    <td class="t-amount">${formatMoney(amount, { symbol })}</td>
  </tr>`
}

export function renderInvoiceA4Html(doc: InvoiceA4Data, opts: InvoiceA4Options): string {
  const symbol = doc.currencySymbol
  const title = doc.kind === 'sale' ? 'INVOICE' : 'PURCHASE'
  const numberLabel = doc.kind === 'sale' ? 'Invoice No' : 'Bill No'
  const partyLabel = doc.kind === 'sale' ? 'Customer' : 'Supplier'
  const handledLabel = doc.kind === 'sale' ? 'Cashier' : 'Received by'

  const logoHtml =
    opts.logo && opts.logo.trim() !== ''
      ? `<div class="logo"><img src="${opts.logo}" alt=""></div>`
      : ''

  const shop = opts.shop

  // Only non-empty letterhead fields are printed — never a dangling label.
  const contactBlock = [
    contactLine('', [shop.address, shop.city].map((s) => (s ?? '').trim()).filter(Boolean).join(', ')),
    contactLine('Phone: ', [shop.phone, shop.phone2].map((s) => (s ?? '').trim()).filter(Boolean).join(' / ')),
    contactLine('Email: ', shop.email),
    contactLine('NTN / STRN: ', shop.taxNumber),
    contactLine('Contact: ', shop.contactPerson)
  ].join('')

  const partyHtml =
    (doc.partyName ?? '').trim() !== ''
      ? `<div class="meta-row"><span class="meta-label">${partyLabel}</span><span class="meta-value">${escapeHtml(
          doc.partyName!.trim()
        )}</span></div>`
      : ''

  const handledHtml =
    (doc.handledBy ?? '').trim() !== ''
      ? `<div class="meta-row"><span class="meta-label">${handledLabel}</span><span class="meta-value">${escapeHtml(
          doc.handledBy!.trim()
        )}</span></div>`
      : ''

  const lineRows = doc.lines.map((line) => lineRowHtml(line)).join('')

  // The totals: subtotal, discount (only if any), tax (only if any), then the grand total. Then the
  // paid/change (sale) or paid/owed (purchase) — each printed only when it has something to say.
  const totalRows = [
    totalRow('Subtotal', doc.subtotalNet, symbol),
    doc.discount > 0 ? totalRow('Discount', -doc.discount, symbol) : '',
    doc.taxTotal > 0 ? totalRow('Tax', doc.taxTotal, symbol) : '',
    totalRow('GRAND TOTAL', doc.grandTotal, symbol, 'grand'),
    doc.paid != null && doc.paid > 0 ? totalRow('Paid', doc.paid, symbol, 'soft') : '',
    doc.kind === 'sale' && doc.change != null && doc.change > 0
      ? totalRow('Change', doc.change, symbol, 'soft')
      : '',
    doc.kind === 'purchase' && doc.owed != null && doc.owed > 0
      ? totalRow('Balance owed', doc.owed, symbol, 'soft')
      : ''
  ].join('')

  const termsHtml =
    (opts.terms ?? '').trim() !== ''
      ? `<div class="terms"><div class="terms-head">Terms &amp; Conditions</div>${escapeMultiline(
          opts.terms!.trim()
        )}</div>`
      : ''

  const footerNoteHtml =
    (opts.footer ?? '').trim() !== ''
      ? `<div class="footer-note">${escapeMultiline(opts.footer!.trim())}</div>`
      : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* The page size comes from settings; margin 0, then body padding is the margin. NO fixed height —
     a height plus a page break is a trailing blank page (trap #16). */
  @page { size: ${opts.pageSize}; margin: 0; }

  * { box-sizing: border-box; }

  html, body { margin: 0; padding: 0; background: #fff; }

  body {
    /* System fonts ONLY — no @font-face, no url(). Offline + CSP (trap #13). */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    color: #1a1a1a;
    /* Body padding is the margin when this HTML is sent to PAPER (webContents.print uses margins:none,
       so the sheet needs its own inset). For the SAVE-as-PDF path, printToPDF adds ~13mm of its own —
       a modest padding here keeps that from doubling into a fat margin, and nothing is ever clipped. */
    padding: 10mm;
    /* Print the header/total shading, not just the ink. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* NO box-shadow anywhere — Chromium prints it as a grey block (trap #12). Borders do the work. */

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    border-bottom: 2px solid #333;
    padding-bottom: 12px;
  }
  .header-left { display: flex; gap: 14px; align-items: flex-start; }
  .logo img { max-height: 64px; max-width: 160px; display: block; }
  .shop-name { font-size: 22px; font-weight: 700; line-height: 1.15; }
  .contact { font-size: 10px; color: #555; margin-top: 2px; }
  .contact-label { color: #888; }

  .doc-title { text-align: right; }
  .doc-title .word { font-size: 26px; font-weight: 700; letter-spacing: 2px; color: #333; }

  .meta {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    margin: 14px 0 12px;
    flex-wrap: wrap;
  }
  .meta-col { min-width: 40%; }
  .meta-row { display: flex; gap: 8px; margin-top: 3px; }
  .meta-label { color: #888; min-width: 78px; }
  .meta-value { font-weight: 600; }

  table.lines { width: 100%; border-collapse: collapse; margin-top: 6px; }
  /* Repeat the header if a long invoice spills to a second page; keep a row whole. */
  table.lines thead { display: table-header-group; }
  table.lines tbody tr { page-break-inside: avoid; }

  table.lines th, table.lines td { padding: 6px 8px; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
  table.lines thead th {
    background: #eef2f7;
    border-bottom: 1px solid #9aa5b1;
    font-weight: 700;
    text-align: left;
  }
  table.lines th.num, table.lines td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Long names must wrap, not overflow the sheet — half the names in this shop are long, and Urdu. */
  table.lines td.name { width: 46%; }
  table.lines td.name div { word-wrap: break-word; overflow-wrap: anywhere; }
  .alt-name { direction: rtl; text-align: left; color: #444; font-size: 10px; margin-top: 1px; }

  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 12px; }
  table.totals { border-collapse: collapse; min-width: 46%; }
  table.totals td { padding: 4px 8px; }
  table.totals .t-label { text-align: left; color: #444; }
  table.totals .t-amount {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    font-weight: 600;
  }
  table.totals tr.grand td {
    border-top: 2px solid #333;
    border-bottom: 2px solid #333;
    font-size: 14px;
    font-weight: 700;
  }
  table.totals tr.soft td { color: #555; font-weight: 500; }

  .terms {
    margin-top: 22px;
    font-size: 10px;
    color: #555;
    border-top: 1px solid #e2e2e2;
    padding-top: 8px;
  }
  .terms-head { font-weight: 700; color: #333; margin-bottom: 3px; }

  .footer-note {
    margin-top: 14px;
    font-size: 10px;
    color: #555;
    text-align: center;
  }

  .generated { margin-top: 18px; font-size: 8px; color: #aaa; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    ${logoHtml}
    <div>
      <div class="shop-name">${escapeHtml(shop.name)}</div>
      ${contactBlock}
    </div>
  </div>
  <div class="doc-title">
    <div class="word">${title}</div>
  </div>
</div>

<div class="meta">
  <div class="meta-col">
    <div class="meta-row"><span class="meta-label">${numberLabel}</span><span class="meta-value">${escapeHtml(
      doc.number
    )}</span></div>
    <div class="meta-row"><span class="meta-label">Date</span><span class="meta-value">${escapeHtml(
      formatDateTime(doc.at, doc.country)
    )}</span></div>
  </div>
  <div class="meta-col">
    ${partyHtml}
    ${handledHtml}
  </div>
</div>

<table class="lines">
  <thead>
    <tr>
      <th>Item</th>
      <th class="num">Qty</th>
      <th class="num">Unit price</th>
      <th class="num">Tax</th>
      <th class="num">Line total</th>
    </tr>
  </thead>
  <tbody>
    ${lineRows}
  </tbody>
</table>

<div class="totals-wrap">
  <table class="totals">
    ${totalRows}
  </table>
</div>

${termsHtml}
${footerNoteHtml}

<div class="generated">Generated by ${APP_NAME}</div>

</body>
</html>`
}
