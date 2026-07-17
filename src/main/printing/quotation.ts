import type { QuotationData } from '@shared/sales'
import type { ReceiptWidth } from '@shared/receipt'
import { formatMoney } from '@shared/money'
// SHARED WITH THE RECEIPT, ON PURPOSE. See the header below.
import { WIDTHS, escapeHtml, rule, formatRate, lineHtml } from './receipt'
import { formatDate, formatDateTime } from '@shared/dates'

/**
 * THE QUOTATION — the offer, on the same thermal paper the receipt prints on (58 mm / 80 mm).
 *
 * ── WHY THIS IS NOT renderReceiptHtml WITH A FLAG ───────────────────────────────────────────────
 *
 * A receipt is PROOF THAT MONEY CHANGED HANDS. A quotation is an OFFER, and nothing has been paid.
 * They are two documents, so they are two functions. A shared function behind an `isQuote` flag is how
 * the tender rows, the change line and the invoice number end up one forgotten `if` away from printing
 * on a document where every one of them would be a lie.
 *
 * The type enforces most of it before this file gets a say: `QuotationData` (shared/sales.ts) carries
 * NO invoiceNo, NO payments, NO changeDue and NO isDuplicate, because a quote HAS none of those. There
 * is no field here to print them from. This template cannot fabricate a sale even by accident.
 *
 * ── WHAT IS SHARED, AND WHY IT MUST BE ──────────────────────────────────────────────────────────
 *
 * The LINES and the MONEY are the receipt's own: `lineHtml`, `formatMoney`, `formatQty`, `formatRate`
 * and the same WIDTHS table. The customer stands at the counter holding the quote against the receipt.
 * "Rs 3,999.00" on one and "3999" on the other is a phone call; "1.234 kg" against "1 kg" is a refund.
 * Two formatters would drift the first time one of them was touched, so there is exactly one.
 *
 * ── THE SAME PRINT DISCIPLINE AS THE RECEIPT (CLAUDE.md §5) ─────────────────────────────────────
 *
 *   NO box-shadow           Chromium prints a shadow as an ugly grey block.
 *   NO external font        Offline + CSP. System monospace only — same stack as the receipt.
 *   NO external image       Same reason.
 *   FIXED WIDTH             58 mm and 80 mm are physical paper. Measured in mm.
 *   NO COLOUR               A thermal head has one colour: burnt.
 *   LONG NAMES MUST WRAP    Inherited from the receipt's .item-name rules.
 *   NO TRAILING BLANK PAGE  Nothing sets a height. @page is `auto`.
 */

/**
 * The expiry, printed as the shopkeeper reads a date — never a raw ISO string.
 *
 * `validUntil` is a DAY ('YYYY-MM-DD'), not an instant, and it is parsed as ONE: splitting the parts and
 * building a LOCAL date. `new Date('2026-03-11')` parses as UTC midnight, which west of Greenwich prints
 * as the 10th — the offer would appear to lapse a day early, on the customer's copy, in writing.
 */
function formatValidUntil(iso: string, country: string | null | undefined): string {
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso // not a date we recognise: print it as it is, never a blank

  // The SHOP's country decides the order, not the machine's locale — see shared/dates.ts.
  return formatDate(new Date(year, month - 1, day), country)
}

export function renderQuotationHtml(data: QuotationData, width: ReceiptWidth = '80mm'): string {
  const w = WIDTHS[width]
  const symbol = data.currencySymbol
  const money = (n: number): string => formatMoney(n, { grouping: false })

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* The page IS the paper. Height is auto — set a height and you get a trailing blank page. */
  @page {
    size: ${w.paper} auto;
    margin: 0;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    width: ${w.paper};
    background: #fff;
  }

  body {
    /* System monospace ONLY. No webfont: there is no network at the till, and the CSP forbids it. */
    font-family: "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: ${width === '58mm' ? '10px' : '11px'};
    line-height: 1.35;
    color: #000;               /* a thermal head has one colour */
    width: ${w.body};
    margin: 0 auto;
    padding: 3mm 0 6mm;        /* bottom padding = the tear-off gap, NOT a fixed height */
  }

  /* NO box-shadow anywhere. Chromium prints it as a grey block. */

  .center { text-align: center; }
  .bold   { font-weight: 700; }
  .small  { font-size: ${width === '58mm' ? '9px' : '10px'}; }
  .rule   { white-space: nowrap; overflow: hidden; letter-spacing: 0; }

  .shop-name { font-size: ${width === '58mm' ? '14px' : '16px'}; font-weight: 700; }

  .meta { display: flex; justify-content: space-between; gap: 4px; }

  .item { margin: 2mm 0; }

  /* THE WRAP. Long names are the norm here, not the exception — and Urdu names are longer still.
     Identical to the receipt's, because these are the receipt's own lines. */
  .item-name {
    word-wrap: break-word;
    overflow-wrap: anywhere;
    font-weight: 700;
  }
  .item-name-alt {
    word-wrap: break-word;
    overflow-wrap: anywhere;
    direction: rtl;            /* Urdu reads right to left */
    text-align: right;
  }

  .item-figures {
    display: flex;
    justify-content: space-between;
    gap: 4px;
  }
  .item-figures .amount { white-space: nowrap; }
  .discount { font-style: italic; }

  .totals { margin-top: 1mm; }
  .totals .row { display: flex; justify-content: space-between; gap: 4px; }
  .totals .grand { font-size: ${width === '58mm' ? '13px' : '15px'}; font-weight: 700; margin: 1mm 0; }

  .tax-table { width: 100%; border-collapse: collapse; }
  .tax-table td { padding: 0; }
  .tax-table .r { text-align: right; }

  /* THE HEADING. This is the whole document's job: nobody must ever mistake this for a receipt.
     Boxed and letter-spaced, exactly like the receipt's DUPLICATE stamp — the shopkeeper already
     reads that shape as "this is not an ordinary receipt". */
  .doc-type {
    text-align: center;
    font-weight: 700;
    letter-spacing: 2px;
    border: 1px solid #000;
    padding: 1mm 0;
    margin-bottom: 2mm;
    font-size: ${width === '58mm' ? '13px' : '15px'};
  }

  /* THE DEADLINE. The one thing a receipt has no concept of, so it is given its own weight. */
  .validity {
    text-align: center;
    font-weight: 700;
    margin: 1mm 0;
  }
  .expired {
    text-align: center;
    font-weight: 700;
    letter-spacing: 2px;
    border: 1px solid #000;
    padding: 1mm 0;
    margin: 1mm 0;
  }

  /* THE DISCLAIMER. Small, but it is the sentence that stops this being passed off as a bill. */
  .not-a-bill {
    text-align: center;
    margin-top: 1mm;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
</style>
</head>
<body>

<div class="doc-type">QUOTATION</div>

<div class="center">
  <div class="shop-name">${escapeHtml(data.shop.name)}</div>
  ${data.shop.address ? `<div class="small">${escapeHtml(data.shop.address)}</div>` : ''}
  ${data.shop.phone ? `<div class="small">${escapeHtml(data.shop.phone)}</div>` : ''}
  ${data.shop.taxNumber ? `<div class="small">NTN: ${escapeHtml(data.shop.taxNumber)}</div>` : ''}
</div>

<div class="rule">${rule(w.chars, '=')}</div>

${
    // NO INVOICE NUMBER — a quote has none, and that is exactly what keeps sale numbering gapless
    // (PLAN.md §1/§2). What prints instead is the QUOTE's own reference, labelled as one so that it can
    // never be read back down the phone as an invoice number. On 58 mm it stacks, same as the receipt:
    // there is no room for a reference and a date side by side.
    width === '58mm'
      ? `<div>Quote #${data.quoteId}</div>
         <div class="small">${escapeHtml(formatDateTime(data.at, data.country))}</div>`
      : `<div class="meta"><span>Quote #${data.quoteId}</span><span>${escapeHtml(
          formatDateTime(data.at, data.country)
        )}</span></div>`
  }
<div class="meta"><span>Prepared by: ${escapeHtml(data.cashierName)}</span>${
    data.customerName ? `<span>${escapeHtml(data.customerName)}</span>` : '<span></span>'
  }</div>

<div class="rule">${rule(w.chars)}</div>

${data.lines.map((line) => lineHtml(line)).join('')}

<div class="rule">${rule(w.chars)}</div>

<div class="totals">
  <div class="row"><span>Subtotal</span><span>${money(data.subtotalNet)}</span></div>
  ${
    data.cartDiscount > 0
      ? `<div class="row"><span>Discount</span><span>-${money(data.cartDiscount)}</span></div>`
      : ''
  }
  ${
    data.taxTotal > 0
      ? `<div class="row"><span>Tax</span><span>${money(data.taxTotal)}</span></div>`
      : ''
  }
  <div class="row grand"><span>TOTAL</span><span>${symbol} ${money(data.grandTotal)}</span></div>
</div>

${
  // NOTHING BELOW THE TOTAL ABOUT MONEY RECEIVED. No tender, no change, no balance due — a receipt has
  // all three and this document must have none, because none of them has happened. There is no field
  // on QuotationData to print them from even if someone tried.
  ''
}
${
  data.taxSummary.length > 0
    ? `
<div class="rule">${rule(w.chars)}</div>
<table class="tax-table small">
  <tr><td>Tax</td><td class="r">Net</td><td class="r">Tax</td></tr>
  ${data.taxSummary
    .map(
      (row) => `<tr>
        <td>${formatRate(row.taxRateBp)}</td>
        <td class="r">${money(row.net)}</td>
        <td class="r">${money(row.tax)}</td>
      </tr>`
    )
    .join('')}
</table>`
    : ''
}

<div class="rule">${rule(w.chars, '=')}</div>

<div class="validity">Valid until ${escapeHtml(formatValidUntil(data.validUntil, data.country))}</div>
${
  // The paper says it has lapsed. It does NOT refuse anything — honouring an expired quote is the
  // shopkeeper's call to make with the customer standing there, not the till's. (Migration 0015.)
  data.isExpired ? `<div class="expired">EXPIRED</div>` : ''
}

<div class="not-a-bill small">
  This is a price quotation, not a receipt. No payment has been received.
</div>

<div class="rule">${rule(w.chars, '=')}</div>

<div class="center small">
  ${data.footer ? `<div>${escapeHtml(data.footer)}</div>` : ''}
  <div>Thank you</div>
</div>

</body>
</html>`
}
