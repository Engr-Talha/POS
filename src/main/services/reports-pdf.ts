import { APP_NAME } from '@shared/branding'
import { formatMoney } from '@shared/money'
import { formatCost } from '@shared/cost'
import { formatQty } from '@shared/qty'
import {
  buildReportView,
  type Cell,
  type Column,
  type ReportPayload,
  type ReportView,
  type Section
} from '@shared/report-export'
import { htmlToPdfBuffer } from '../printing/printer'

/**
 * REPORT -> A4 PDF. The same report the owner can open in Excel, laid out to be printed and filed.
 *
 * Every rule here is a print trap this project has already been burned by (CLAUDE.md §5):
 *
 *   NO box-shadow          Chromium prints a shadow as an ugly grey block (trap #12). Borders only.
 *   NO external font/image  Offline + CSP — there is no network at the till, ever (trap #13). A system
 *                           sans-serif stack, no @font-face, no url(), no <img>.
 *   A4, and no blank page   The page is A4; nothing sets a fixed height, and the last element has no
 *                           forced page break, so there is no trailing blank page (trap #16).
 *
 * The HTML is a full document written to a temp file and rendered by printToPDF via
 * printing/printer.ts — NEVER loadURL('data:...'), which breaks on large HTML (trap #11).
 *
 * The numbers come from the SAME `ReportView` the Excel writer uses, formatted through the app's one
 * money / cost / qty formatter — so the printed report and the spreadsheet cannot disagree, and each
 * figure is derived from its frozen integer, never re-rounded.
 */

export function reportToPdfHtml(report: ReportPayload, shopName: string): string {
  const view = buildReportView(report)
  return documentHtml(view, shopName)
}

export async function reportToPdfBuffer(report: ReportPayload, shopName: string): Promise<Buffer> {
  return htmlToPdfBuffer(reportToPdfHtml(report, shopName))
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

/** Basis points to a human percentage: 3655 -> "36.55%", 3600 -> "36%". */
function formatPercentBp(bp: number): string {
  const percent = bp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/** One cell as display text. The integer is the source of truth; the app's formatters do the rest. */
function cellText(cell: Cell): string {
  switch (cell.kind) {
    case 'text':
      return escapeHtml(cell.text)
    case 'money':
      return escapeHtml(formatMoney(cell.raw))
    case 'cost':
      return escapeHtml(formatCost(cell.raw))
    case 'qty':
      return escapeHtml(formatQty(cell.raw))
    case 'percent':
      return escapeHtml(formatPercentBp(cell.raw))
    case 'int':
      return escapeHtml(cell.raw.toLocaleString('en-US'))
  }
}

function cellClass(cell: Cell): string {
  return cell.kind === 'text' ? 'txt' : 'num'
}

function rowHtml(cells: Cell[], tag: 'td' | 'th' = 'td'): string {
  const inner = cells
    .map((cell) => `<${tag} class="${cellClass(cell)}">${cellText(cell)}</${tag}>`)
    .join('')
  return `<tr>${inner}</tr>`
}

function headerHtml(columns: Column[]): string {
  const inner = columns
    .map((column) => `<th class="${column.align === 'right' ? 'num' : 'txt'}">${escapeHtml(column.header)}</th>`)
    .join('')
  return `<tr>${inner}</tr>`
}

function sectionHtml(section: Section): string {
  const heading = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : ''
  const body = section.rows.map((row) => rowHtml(row)).join('')
  const foot = section.totalRow
    ? `<tfoot>${rowHtml(section.totalRow)}</tfoot>`
    : ''
  return `
    <section>
      ${heading}
      <table>
        <thead>${headerHtml(section.columns)}</thead>
        <tbody>${body}</tbody>
        ${foot}
      </table>
    </section>`
}

function metaHtml(view: ReportView): string {
  if (view.meta.length === 0) return ''
  const parts = view.meta
    .map((meta) => `${escapeHtml(meta.label)}: <strong>${escapeHtml(meta.value)}</strong>`)
    .join(' &nbsp;·&nbsp; ')
  return `<div class="meta">${parts}</div>`
}

function documentHtml(view: ReportView, shopName: string): string {
  const note = view.note ? `<div class="note">${escapeHtml(view.note)}</div>` : ''
  const sections = view.sections.map(sectionHtml).join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  /* A4, and the page height is auto — set a height and Chromium adds a trailing blank page. */
  @page { size: A4; margin: 0; }

  * { box-sizing: border-box; }

  html, body { margin: 0; padding: 0; background: #fff; }

  body {
    /* System fonts ONLY — no webfont is fetched or embedded. Offline + CSP (trap #13). */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    color: #1a1a1a;
    /* Print the header/total shading, not just the ink. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* No drop-shadows anywhere — Chromium prints them as grey blocks (trap #12). Borders do the work. */

  .report-head {
    border-bottom: 2px solid #333;
    padding-bottom: 8px;
    margin-bottom: 14px;
  }
  .shop { font-size: 19px; font-weight: 700; }
  .title { font-size: 13px; font-weight: 600; margin-top: 2px; }
  .meta { font-size: 10px; color: #555; margin-top: 6px; }

  h2 { font-size: 12px; margin: 16px 0 4px; }

  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  /* Repeat the header on every page a long table spills onto; keep a row from splitting across pages. */
  thead { display: table-header-group; }
  tbody tr { page-break-inside: avoid; }

  th, td { padding: 4px 8px; border-bottom: 1px solid #e2e2e2; }
  thead th {
    background: #eef2f7;
    border-bottom: 1px solid #9aa5b1;
    font-weight: 700;
  }
  th.txt, td.txt { text-align: left; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

  tfoot td {
    font-weight: 700;
    border-top: 2px solid #333;
    border-bottom: none;
  }

  .note { margin-top: 12px; font-weight: 700; color: #b00020; }
  .foot { margin-top: 18px; font-size: 9px; color: #888; text-align: center; }
</style>
</head>
<body>

<div class="report-head">
  <div class="shop">${escapeHtml(shopName)}</div>
  <div class="title">${escapeHtml(view.title)}</div>
  ${metaHtml(view)}
</div>

${sections}
${note}

<div class="foot">Generated by ${APP_NAME}</div>

</body>
</html>`
}
