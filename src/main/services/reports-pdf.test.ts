import { describe, it, expect, vi, beforeEach } from 'vitest'
import { REPORT_TITLES, type ReportPayload } from '@shared/report-export'
import { SAMPLE_PAYLOADS, SHOP_NAME } from './reports-export.fixture'

/**
 * REPORT -> A4 PDF.
 *
 * The HTML tests are the ones that matter, because the HTML is what actually prints. They check that
 * the shop, the title and the KEY TOTALS are on the page, and that every print trap this project has
 * been burned by is avoided: no box-shadow, no external font or image, no network URL, an A4 page.
 *
 * The buffer test proves the render pipeline is wired the safe way — a temp FILE (never a data: URL,
 * trap #11), printToPDF at A4 with backgrounds, and the hidden window torn down afterwards. Electron
 * is MOCKED, exactly as in printer.test.ts: these tests run in plain Node.
 */

const printToPDFMock = vi.fn()
const loadFileMock = vi.fn()
const destroyMock = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { printToPDF: printToPDFMock }
    loadFile = loadFileMock
    destroy = destroyMock
    isDestroyed = (): boolean => false
    static getAllWindows = (): unknown[] => []
  }
}))

// electron-log writes to a real userData path it does not have in a test.
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { reportToPdfHtml, reportToPdfBuffer } = await import('./reports-pdf')

const byKind = (kind: ReportPayload['kind']): ReportPayload =>
  SAMPLE_PAYLOADS.find((payload) => payload.kind === kind) as ReportPayload

/** The renderer escapes all text, so 'Profit & Loss' appears as 'Profit &amp; Loss' on the page. */
const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The distinctive figure(s) each report must actually show — the totals the owner opens it for. */
const EXPECTED_TOTALS: Record<ReportPayload['kind'], string[]> = {
  salesSummary: ['6,169.83'],
  profit: ['1,927.75', '36.55%'],
  stockValuation: ['91.0417', '5,771.00'],
  customerAging: ['750.00'],
  supplierAging: ['350.00'],
  leakage: ['200.00'],
  trialBalance: ['13,136.44', 'Balanced'],
  profitAndLoss: ['1,427.75'],
  balanceSheet: ['10,540.83', 'Balanced']
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The HTML — shop, title, totals
// ═════════════════════════════════════════════════════════════════════════════

describe('reportToPdfHtml — the page that prints', () => {
  it.each(SAMPLE_PAYLOADS.map((payload) => [payload.kind, payload] as const))(
    'puts the shop, the title and the key totals on %s',
    (kind, payload) => {
      const html = reportToPdfHtml(payload, SHOP_NAME)

      expect(html).toMatch(/^<!doctype html>/i)
      expect(html).toContain(SHOP_NAME)
      expect(html).toContain(esc(REPORT_TITLES[kind]))
      for (const total of EXPECTED_TOTALS[kind]) {
        expect(html, `${kind} must show ${total}`).toContain(total)
      }
    }
  )
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The traps — offline-safe, A4, no grey shadow blocks
// ═════════════════════════════════════════════════════════════════════════════

describe('the HTML is offline-safe and print-safe', () => {
  it.each(SAMPLE_PAYLOADS.map((payload) => [payload.kind, payload] as const))(
    'avoids every print trap on %s',
    (_kind, payload) => {
      const html = reportToPdfHtml(payload, SHOP_NAME)

      expect(html, 'box-shadow prints as a grey block (trap #12)').not.toMatch(/box-shadow/i)
      expect(html, 'no external font or image — offline + CSP (trap #13)').not.toMatch(/url\(/i)
      expect(html).not.toMatch(/@font-face/i)
      expect(html).not.toMatch(/<img\b/i)
      expect(html, 'no network reference of any kind').not.toMatch(/https?:\/\//i)

      expect(html, 'the page is A4').toMatch(/@page[^}]*A4/)
    }
  )

  it('escapes shop names so a stray < cannot break the layout', () => {
    const html = reportToPdfHtml(byKind('salesSummary'), 'Ali & Sons <Traders>')
    expect(html).toContain('Ali &amp; Sons &lt;Traders&gt;')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. The buffer — same safe pipeline as the receipt printer
// ═════════════════════════════════════════════════════════════════════════════

describe('reportToPdfBuffer — HTML to an A4 PDF', () => {
  beforeEach(() => {
    // These vi.fn() mocks live at module scope, so their call history OUTLIVES a test. restoreMocks
    // (vitest.config.ts) only resets vi.spyOn spies, not manual mocks — so clear them by hand, exactly
    // as printer.test.ts does, then re-arm their implementations.
    vi.clearAllMocks()
    loadFileMock.mockResolvedValue(undefined)
    printToPDFMock.mockResolvedValue(Buffer.from('%PDF-1.4 test-report'))
  })

  it('produces a PDF buffer for every report', async () => {
    for (const payload of SAMPLE_PAYLOADS) {
      const buffer = await reportToPdfBuffer(payload, SHOP_NAME)
      expect(Buffer.isBuffer(buffer), `${payload.kind} should yield a buffer`).toBe(true)
      expect(buffer.byteLength).toBeGreaterThan(0)
    }
  })

  it('loads from a FILE, never a data: URL, and prints A4 with backgrounds (traps #11, #13)', async () => {
    await reportToPdfBuffer(byKind('balanceSheet'), SHOP_NAME)

    expect(loadFileMock).toHaveBeenCalledOnce()
    expect(String(loadFileMock.mock.calls[0]![0])).toMatch(/\.html$/)

    const options = printToPDFMock.mock.calls[0]![0] as Record<string, unknown>
    expect(options['printBackground']).toBe(true)
    expect(options['pageSize']).toBe('A4')
    expect(options['margins']).toBeDefined()
  })

  it('tears the hidden window down, even on the happy path', async () => {
    await reportToPdfBuffer(byKind('profit'), SHOP_NAME)
    expect(destroyMock).toHaveBeenCalledOnce()
  })
})
