import type { ReceiptData, ReceiptWidth, ReceiptLine } from '@shared/receipt'
import { formatMoney } from '@shared/money'
import { formatQty } from '@shared/qty'

/**
 * THE THERMAL RECEIPT — 58 mm and 80 mm.
 *
 * Every rule here is one the project has already been burned by (CLAUDE.md §5):
 *
 *   NO box-shadow           Chromium prints a shadow as an ugly grey block.
 *   NO external font        Offline + CSP. There is no network at the till, ever. System monospace
 *                           only — and a thermal printer renders monospace best anyway.
 *   NO external image       Same reason. A logo, when we add one, is a base64 data URI.
 *   FIXED WIDTH             58 mm and 80 mm are physical paper. The layout is measured in mm.
 *   NO COLOUR               A thermal head has one colour: burnt.
 *   LONG NAMES MUST WRAP    Product names in this shop are long, and half of them are Urdu.
 *   NO TRAILING BLANK PAGE  @page + page-break + min-height interact badly. Nothing sets a height.
 *
 * The output is HTML because Chromium already lives in this app and prints it perfectly. It is
 * written to a temp file and loaded with loadFile — NOT loadURL('data:...'), which breaks on large
 * HTML (trap #11).
 */

/**
 * EXPORTED for the QUOTATION (./quotation.ts), which is a different document printed on the same
 * paper by the same printer. Sharing these is not tidiness — it is the guarantee that a quote and the
 * sale it becomes can never format one number two ways. The customer holds the quote up next to the
 * receipt; "Rs 3,999.00" against "3999" is a phone call, and "1.234 kg" against "1 kg" is a refund.
 */
export const WIDTHS: Record<ReceiptWidth, { paper: string; body: string; chars: number }> = {
  // Printable area is narrower than the paper — the head does not reach the edge.
  '58mm': { paper: '58mm', body: '48mm', chars: 32 },
  '80mm': { paper: '80mm', body: '72mm', chars: 48 }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A row of dashes, the full width of the paper. Cheaper than a border, and it prints crisply. */
export function rule(chars: number, char = '-'): string {
  return char.repeat(chars)
}

export function formatRate(bp: number): string {
  // 1700 -> "17%", 1750 -> "17.5%". Basis points in, human out.
  const percent = bp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
}

/**
 * ONE PRINTED LINE — name, the optional second-language name, qty x unit price, and the amount.
 *
 * SHARED WITH THE QUOTATION, deliberately: an offer's lines and the receipt's lines are the same
 * lines, and they are built from the same `ReceiptLine` shape by this same function. That is what
 * makes "the price you were quoted is the price you paid" checkable by eye at the counter.
 */
export function lineHtml(line: ReceiptLine): string {
  const qty = formatQty(line.qtyM)
  const uom = line.uom ? ` ${escapeHtml(line.uom)}` : ''

  return `
    <div class="item">
      <div class="item-name">${escapeHtml(line.name)}</div>
      ${
        line.nameOtherLang
          ? `<div class="item-name-alt">${escapeHtml(line.nameOtherLang)}</div>`
          : ''
      }
      <div class="item-figures">
        <span class="qty">${qty}${uom} x ${formatMoney(line.unitPrice, { grouping: false })}</span>
        <span class="amount">${formatMoney(line.gross, { grouping: false })}</span>
      </div>
      ${
        line.lineDiscount > 0
          ? `<div class="item-figures discount">
               <span>Discount</span>
               <span>-${formatMoney(line.lineDiscount, { grouping: false })}</span>
             </div>`
          : ''
      }
    </div>`
}

export function renderReceiptHtml(data: ReceiptData, width: ReceiptWidth = '80mm'): string {
  const w = WIDTHS[width]
  const symbol = data.currencySymbol
  const money = (n: number): string => formatMoney(n, { grouping: false })


  const paid = data.payments.reduce((sum, p) => sum + p.amount, 0)

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
  .big    { font-size: ${width === '58mm' ? '13px' : '15px'}; }
  .small  { font-size: ${width === '58mm' ? '9px' : '10px'}; }
  .rule   { white-space: nowrap; overflow: hidden; letter-spacing: 0; }

  .shop-name { font-size: ${width === '58mm' ? '14px' : '16px'}; font-weight: 700; }

  .meta { display: flex; justify-content: space-between; gap: 4px; }

  .item { margin: 2mm 0; }

  /* THE WRAP. Long names are the norm here, not the exception — and Urdu names are longer still.
     A name that overflows the paper is a name the shopkeeper cannot read. */
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

  /* A reprint must never be mistaken for the original. */
  .duplicate {
    text-align: center;
    font-weight: 700;
    letter-spacing: 2px;
    border: 1px solid #000;
    padding: 1mm 0;
    margin-bottom: 2mm;
  }
</style>
</head>
<body>

${data.isDuplicate ? `<div class="duplicate">DUPLICATE</div>` : ''}

<div class="center">
  <div class="shop-name">${escapeHtml(data.shop.name)}</div>
  ${data.shop.address ? `<div class="small">${escapeHtml(data.shop.address)}</div>` : ''}
  ${data.shop.phone ? `<div class="small">${escapeHtml(data.shop.phone)}</div>` : ''}
  ${data.shop.taxNumber ? `<div class="small">NTN: ${escapeHtml(data.shop.taxNumber)}</div>` : ''}
</div>

<div class="rule">${rule(w.chars, '=')}</div>

${
    // On 58 mm there is not room for the invoice number and the date side by side — the number broke
    // across two lines mid-word ("INV-2026-" / "000142"), which is exactly the number a shopkeeper
    // reads back to a customer over the phone. On narrow paper they stack instead.
    width === '58mm'
      ? `<div>${escapeHtml(data.invoiceNo)}</div>
         <div class="small">${escapeHtml(new Date(data.at).toLocaleString())}</div>`
      : `<div class="meta"><span>${escapeHtml(data.invoiceNo)}</span><span>${escapeHtml(
          new Date(data.at).toLocaleString()
        )}</span></div>`
  }
<div class="meta"><span>Cashier: ${escapeHtml(data.cashierName)}</span>${
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

<div class="rule">${rule(w.chars)}</div>

${data.payments
  .map(
    (p) => `<div class="meta"><span>${escapeHtml(p.method)}${
      p.reference ? ` (${escapeHtml(p.reference)})` : ''
    }</span><span>${money(p.amount)}</span></div>`
  )
  .join('')}
${
  data.changeDue > 0
    ? `<div class="meta bold"><span>CHANGE</span><span>${money(data.changeDue)}</span></div>`
    : ''
}
${
  paid !== data.grandTotal && data.changeDue === 0
    ? `<div class="meta bold"><span>BALANCE DUE</span><span>${money(
        data.grandTotal - paid
      )}</span></div>`
    : ''
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

${
  data.pointsEarned != null
    ? `<div class="rule">${rule(w.chars)}</div>
       <div class="meta small"><span>Points earned</span><span>${data.pointsEarned}</span></div>
       ${
         data.pointsBalance != null
           ? `<div class="meta small"><span>Points balance</span><span>${data.pointsBalance}</span></div>`
           : ''
       }`
    : ''
}

<div class="rule">${rule(w.chars, '=')}</div>

<div class="center small">
  ${data.footer ? `<div>${escapeHtml(data.footer)}</div>` : ''}
  <div>Thank you</div>
</div>

</body>
</html>`
}
