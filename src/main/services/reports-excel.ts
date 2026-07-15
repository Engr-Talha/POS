import { Workbook, type Worksheet, type Row as ExcelRow } from 'exceljs'
import {
  buildReportView,
  type Cell,
  type CellKind,
  type Column,
  type ReportPayload,
  type ReportView,
  type Section
} from '@shared/report-export'

/**
 * REPORT -> EXCEL. A workbook the owner opens and totals HIMSELF.
 *
 * The one rule that makes this file worth anything: a number reaches the sheet AS A NUMBER, with a
 * cell NUMBER FORMAT — never a pre-formatted "1,234.50" string. A string cannot be summed, and a
 * report the owner cannot re-total is a report he does not trust. So `cellValue` divides the raw
 * INTEGER by its scale (paisa /100, cost /10000, qty /1000, basis points /10000) and hands Excel a
 * real number plus a format like `#,##0.00`.
 *
 * ── AND THE INTEGER IS THE ONLY SOURCE OF PRECISION (CLAUDE.md §4) ────────────────────────────────
 *
 * The display value is DERIVED from the frozen integer minor units, every time. It is never read off
 * an already-rounded figure. `cellValue` refuses a non-integer raw — loudly, the way `formatMoney`
 * does — because a float in a money cell is the precise failure integer money exists to prevent. The
 * division itself cannot lose a paisa at any total a shop will ever ring up: a value would have to
 * exceed ~2.25e13 rupees before `raw / 100` stopped being exact to two decimals.
 *
 * Layout, per report, on ONE worksheet: title, the parameters, then each section as a header row +
 * data rows + a bold TOTAL. Every section is built in shared/report-export.ts, so this sheet and the
 * PDF cannot show different numbers.
 */

const HEADER_FILL = 'FFEDF2F7'
const HEADER_BORDER = 'FF9AA5B1'
const TOTAL_BORDER = 'FF333333'

/** Excel number formats, one per numeric scale. Grouping on, because a human reads a shop's totals. */
const NUMBER_FORMATS: Record<Exclude<CellKind, 'text'>, string> = {
  money: '#,##0.00',
  cost: '#,##0.0000',
  qty: '#,##0.000',
  percent: '0.00%',
  int: '#,##0'
}

/** The divisor that turns each raw integer back into the real number Excel should store and total. */
const SCALES: Record<Exclude<CellKind, 'text'>, number> = {
  money: 100,
  cost: 10_000,
  qty: 1_000,
  percent: 10_000,
  int: 1
}

/**
 * A cell's value as Excel should hold it: a string for text, a real number for everything else —
 * derived from the raw integer, which MUST be an integer. A float here is a bug we make loud rather
 * than let it corrupt a total silently.
 */
function cellValue(cell: Cell): string | number {
  if (cell.kind === 'text') return cell.text
  if (!Number.isInteger(cell.raw)) {
    throw new Error(
      `reports-excel: a ${cell.kind} cell received a non-integer (${cell.raw}). ` +
        'Report values must be integer minor units / thousandths / basis points.'
    )
  }
  return cell.raw / SCALES[cell.kind]
}

export async function reportToXlsxBuffer(report: ReportPayload): Promise<Buffer> {
  const view = buildReportView(report)

  const workbook = new Workbook()
  workbook.creator = 'Insha POS'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(sheetName(view.title))
  renderView(sheet, view)

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer as unknown as Buffer
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function renderView(sheet: Worksheet, view: ReportView): void {
  const widths = columnWidths(view)
  const span = Math.max(widths.length, 2)

  // Title — one bold line across the whole table.
  const titleRow = sheet.addRow([view.title])
  titleRow.getCell(1).font = { bold: true, size: 16 }
  titleRow.height = 22
  sheet.mergeCells(titleRow.number, 1, titleRow.number, span)

  // Parameters — one `Label: value` line each.
  for (const meta of view.meta) {
    const row = sheet.addRow([`${meta.label}:`, meta.value])
    row.getCell(1).font = { bold: true }
  }

  for (const section of view.sections) {
    sheet.addRow([]) // a blank line before each block
    renderSection(sheet, section)
  }

  if (view.note) {
    sheet.addRow([])
    const row = sheet.addRow([view.note])
    row.getCell(1).font = { bold: true, color: { argb: 'FFB00020' } }
    sheet.mergeCells(row.number, 1, row.number, span)
  }

  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width
  })
}

function renderSection(sheet: Worksheet, section: Section): void {
  if (section.heading) {
    const row = sheet.addRow([section.heading])
    row.getCell(1).font = { bold: true, size: 12 }
  }

  const header = sheet.addRow(section.columns.map((column) => column.header))
  section.columns.forEach((column, index) => {
    const cell = header.getCell(index + 1)
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.alignment = { horizontal: column.align }
    cell.border = { bottom: { style: 'thin', color: { argb: HEADER_BORDER } } }
  })

  for (const dataRow of section.rows) {
    writeCells(sheet.addRow([]), dataRow)
  }

  if (section.totalRow) {
    const row = sheet.addRow([])
    writeCells(row, section.totalRow, { bold: true, topBorder: true })
  }
}

function writeCells(row: ExcelRow, cells: Cell[], opts: { bold?: boolean; topBorder?: boolean } = {}): void {
  cells.forEach((cell, index) => {
    const excelCell = row.getCell(index + 1)
    excelCell.value = cellValue(cell)

    if (cell.kind !== 'text') {
      excelCell.numFmt = NUMBER_FORMATS[cell.kind]
      excelCell.alignment = { horizontal: 'right' }
    }
    if (opts.bold) excelCell.font = { bold: true }
    if (opts.topBorder) excelCell.border = { top: { style: 'thin', color: { argb: TOTAL_BORDER } } }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WIDTHS + SHEET NAME
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A rough width for a numeric column, by how many digits its scale tends to need. */
const NUMERIC_WIDTH: Record<Exclude<CellKind, 'text'>, number> = {
  money: 14,
  cost: 13,
  qty: 11,
  percent: 10,
  int: 10
}

/**
 * A width for every column, wide enough for its header and its widest text cell (numeric columns get
 * a fixed width by scale). Clamped so one long product name cannot make a column fill the screen.
 */
function columnWidths(view: ReportView): number[] {
  const widths: number[] = []
  const bump = (index: number, width: number): void => {
    widths[index] = Math.max(widths[index] ?? 10, Math.min(46, width))
  }

  for (const section of view.sections) {
    section.columns.forEach((column, index) => bump(index, column.header.length + 2))
    const consider = (cells: Cell[]): void =>
      cells.forEach((cell, index) => {
        if (cell.kind === 'text') bump(index, cell.text.length + 2)
        else bump(index, NUMERIC_WIDTH[cell.kind])
      })
    section.rows.forEach(consider)
    if (section.totalRow) consider(section.totalRow)
  }

  return widths
}

/** Excel forbids `* ? : \ / [ ]` in a sheet name and caps it at 31 characters. */
function sheetName(title: string): string {
  return title.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31)
}
