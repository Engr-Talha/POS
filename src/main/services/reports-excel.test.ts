import { describe, it, expect, afterEach } from 'vitest'
import { Workbook, type Worksheet, type Xlsx } from 'exceljs'
import { REPORT_TITLES, type ReportPayload } from '@shared/report-export'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as reports from './reports'
import { reportToXlsxBuffer } from './reports-excel'
import { SAMPLE_PAYLOADS } from './reports-export.fixture'

/**
 * REPORT -> EXCEL.
 *
 * Two things have to be true, and the second is the one CLAUDE.md §4 cares about:
 *
 *   1. Every report produces a workbook that OPENS — one titled worksheet, and it parses back.
 *   2. A number reaches the sheet AS A NUMBER the owner can total, and WITHOUT LOSING A PAISA. The
 *      value is the raw integer divided by its scale, carrying an Excel number format — never a
 *      pre-rounded string, and never a float that has already drifted.
 */

async function parse(buffer: Buffer): Promise<Workbook> {
  const workbook = new Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<Xlsx['load']>[0])
  return workbook
}

type NumericCell = { value: number; numFmt: string | undefined }

/** Every numeric cell in the sheet, with the format it carries — the pair a precision test needs. */
function numericCells(sheet: Worksheet): NumericCell[] {
  const cells: NumericCell[] = []
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === 'number') cells.push({ value: cell.value, numFmt: cell.numFmt })
    })
  })
  return cells
}

const byKind = (kind: ReportPayload['kind']): ReportPayload =>
  SAMPLE_PAYLOADS.find((payload) => payload.kind === kind) as ReportPayload

// ═════════════════════════════════════════════════════════════════════════════
// 1. Every report renders to a workbook that opens
// ═════════════════════════════════════════════════════════════════════════════

describe('reportToXlsxBuffer — one workbook per report', () => {
  it.each(SAMPLE_PAYLOADS.map((payload) => [payload.kind, payload] as const))(
    'produces a titled, parseable workbook for %s',
    async (kind, payload) => {
      const buffer = await reportToXlsxBuffer(payload)

      expect(buffer.byteLength).toBeGreaterThan(0)

      const workbook = await parse(buffer)
      const sheet = workbook.worksheets[0] as Worksheet

      // The title is the first cell, and it names the sheet — so the owner knows what he opened.
      expect(String(sheet.getCell('A1').value)).toBe(REPORT_TITLES[kind])
      expect(sheet.name).toBe(REPORT_TITLES[kind])
    }
  )
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Numbers are real numbers, formatted — and precise to the last place
// ═════════════════════════════════════════════════════════════════════════════

describe('numbers survive as numbers, at full precision', () => {
  it('writes money as a real number with a 2-dp format, not a rounded string', async () => {
    const sheet = (await parse(await reportToXlsxBuffer(byKind('salesSummary')))).worksheets[0] as Worksheet
    const cells = numericCells(sheet)

    // 616983 paisa -> 6169.83, exactly. Present as a number, and formatted to two places.
    const grand = cells.find((cell) => cell.value === 616_983 / 100)
    expect(grand, 'the gross total should be a real number in the sheet').toBeDefined()
    expect(grand!.numFmt).toMatch(/0\.00/)
    expect(grand!.value.toFixed(2)).toBe('6169.83')

    // Not a pre-formatted "6,169.83" string sitting in a cell.
    expect(cells.map((cell) => cell.value)).toContain(401_983 / 100) // Cash tender, 4019.83
  })

  it('keeps a 4-dp cost and a 3-dp weighed quantity to the last digit', async () => {
    const sheet = (await parse(await reportToXlsxBuffer(byKind('stockValuation')))).worksheets[0] as Worksheet
    const cells = numericCells(sheet)

    // Cost is 4-dp: 910417 ten-thousandths is 91.0417, and the .0417 must not be rounded away.
    const cost = cells.find((cell) => cell.value === 910_417 / 10_000)
    expect(cost, 'the average cost should be present as a number').toBeDefined()
    expect(cost!.numFmt).toBe('#,##0.0000')
    expect(cost!.value.toFixed(4)).toBe('91.0417')

    // Quantity is 3-dp: 1234 thousandths is 1.234 kg.
    const weighed = cells.find((cell) => cell.value === 1234 / 1000)
    expect(weighed, 'the weighed quantity should be present as a number').toBeDefined()
    expect(weighed!.numFmt).toBe('#,##0.000')

    // The value column is money again: 546250 -> 5462.50.
    expect(cells.map((cell) => cell.value)).toContain(546_250 / 100)
  })

  it('writes a margin as a real percentage (basis points / 10000), formatted with %', async () => {
    const sheet = (await parse(await reportToXlsxBuffer(byKind('profit')))).worksheets[0] as Worksheet
    const cells = numericCells(sheet)

    // 3655 bp -> 0.3655 stored, shown as 36.55% by the number format. Excel can average a column of these.
    const margin = cells.find((cell) => cell.numFmt === '0.00%')
    expect(margin, 'the margin should carry a percent number format').toBeDefined()
    expect(margin!.value).toBe(3655 / 10_000)
  })

  it('carries the aging total through as a number that ties to the buckets', async () => {
    const sheet = (await parse(await reportToXlsxBuffer(byKind('customerAging')))).worksheets[0] as Worksheet
    expect(numericCells(sheet).map((cell) => cell.value)).toContain(75_000 / 100) // 750.00 grand total
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. The REAL reports service flows into the writer unchanged
// ═════════════════════════════════════════════════════════════════════════════

describe('the writer accepts what services/reports.ts actually returns', () => {
  let t: TestDb
  afterEach(() => t.cleanup())

  it('renders every report from a freshly seeded (empty) book without throwing', async () => {
    t = makeTestDb({ withSeed: true })
    const range = { from: '2026-07-01', to: '2026-07-31' }
    const asOf = { asOf: '2026-07-15' }

    const payloads: ReportPayload[] = [
      { kind: 'salesSummary', data: reports.salesSummary(t.db, range) },
      { kind: 'profit', data: reports.profit(t.db, range) },
      { kind: 'stockValuation', data: reports.stockValuation(t.db) },
      { kind: 'customerAging', data: reports.customerAging(t.db, asOf) },
      { kind: 'supplierAging', data: reports.supplierAging(t.db, asOf) },
      { kind: 'leakage', data: reports.leakage(t.db, range) },
      { kind: 'trialBalance', data: reports.trialBalance(t.db, asOf) },
      { kind: 'profitAndLoss', data: reports.profitAndLoss(t.db, range) },
      { kind: 'balanceSheet', data: reports.balanceSheet(t.db, asOf) }
    ]

    for (const payload of payloads) {
      const buffer = await reportToXlsxBuffer(payload)
      expect(buffer.byteLength, `${payload.kind} should produce a workbook`).toBeGreaterThan(0)
      const sheet = (await parse(buffer)).worksheets[0] as Worksheet
      expect(String(sheet.getCell('A1').value)).toBe(REPORT_TITLES[payload.kind])
    }
  })
})
