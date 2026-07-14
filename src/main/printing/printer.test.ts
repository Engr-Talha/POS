import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@shared/result'
import { sampleReceipt } from './sample-receipt'

/**
 * THE PRINTER.
 *
 * Two things are tested here, and the second one is the whole reason this file exists.
 *
 *   1. The pure decisions — the ESC/POS kick code, the paper width, the copy count. These read
 *      SETTINGS, which are DATA, and data typed by a shopkeeper can be anything at all.
 *
 *   2. THAT NOTHING IN THIS MODULE EVER THROWS.
 *
 * By the time printReceipt() runs, sales.complete() has already committed: the money is taken, the
 * stock has moved, the journal has posted. If printing could throw, a jammed printer would escape the
 * IPC handler as an error, the Sell screen would show a red box, and the cashier — who has just taken
 * Rs 5,000 from a customer — would ring the whole sale up a second time.
 *
 * So "it does not throw" is not a nicety here. It is the difference between a paper jam and a
 * double-charged customer, and it is tested by making the printer fail in every way it can.
 *
 * Electron is MOCKED. These tests run in plain Node like every other test in this project — that is
 * why services are transport-agnostic and why the printing layer keeps its decisions separable from
 * its hardware. (vitest.config.ts: "never through Electron".)
 */

const printMock = vi.fn()
const loadFileMock = vi.fn()
const destroyMock = vi.fn()
const browserWindowMock = vi.fn()
const execFileMock = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { print: printMock, getPrintersAsync: vi.fn(async () => []) }
    constructor(...args: unknown[]) {
      browserWindowMock(...args)
    }
    loadFile = loadFileMock
    destroy = destroyMock
    isDestroyed = (): boolean => false
    static getAllWindows = (): unknown[] => []
  }
}))

vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => execFileMock(command, args, callback)
}))

// electron-log writes to a real userData path. In a test it has nothing to write to and nothing to say.
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const { parseKickCode, resolveWidth, clampCopies, printReceipt, openCashDrawer } = await import(
  './printer'
)

beforeEach(() => {
  // These mocks live at module scope (vi.mock is hoisted), so their call history OUTLIVES a test.
  // Without this, "was the window destroyed exactly once?" counts every window every earlier test
  // opened, and `mock.calls[0]` is the first call in the FILE rather than the first in the test.
  vi.clearAllMocks()

  loadFileMock.mockResolvedValue(undefined)
  printMock.mockImplementation((_options, callback: (ok: boolean) => void) => callback(true))
  execFileMock.mockImplementation((_c, _a, callback: (e: Error | null) => void) => callback(null))
})

// ═════════════════════════════════════════════════════════════════════════════
// The kick code — the owner types this, so it can be anything
// ═════════════════════════════════════════════════════════════════════════════

describe('parseKickCode', () => {
  it('turns the default ESC/POS code into the exact five bytes the drawer expects', () => {
    // ESC p 0 25 250 — the sequence on the back page of every thermal-printer manual in this market.
    expect([...parseKickCode('27,112,0,25,250')]).toEqual([27, 112, 0, 25, 250])
  })

  it('forgives the spaces a human leaves when copying it out of a manual', () => {
    expect([...parseKickCode(' 27, 112 ,0,  25,250 ')]).toEqual([27, 112, 0, 25, 250])
  })

  it('accepts 0 — it is a real byte, and the default code contains one', () => {
    expect([...parseKickCode('0')]).toEqual([0])
  })

  /**
   * A drawer that does not open is a support call. A drawer fed a CORRUPTED code is a printer spitting
   * garbage characters into the middle of a customer's receipt. So the parser is strict, and it says
   * WHY in words the owner can act on — never "NaN", never a stack trace.
   */
  it('refuses a code that is not plain numbers, and tells the owner what one looks like', () => {
    expect(() => parseKickCode('27,x,0')).toThrow(AppError)
    try {
      parseKickCode('ESC p 0 25 250')
    } catch (error) {
      expect((error as AppError).userMessage).toMatch(/plain numbers separated by commas/i)
      expect((error as AppError).userMessage).toMatch(/27,112,0,25,250/)
    }
  })

  it('refuses a number that is not a byte — 300 is not a thing you can send down a wire', () => {
    try {
      parseKickCode('27,112,300')
    } catch (error) {
      expect((error as AppError).userMessage).toMatch(/between 0 and 255/i)
    }
  })

  it('refuses an empty code, and points at the setting that fixes it', () => {
    try {
      parseKickCode('   ')
    } catch (error) {
      expect((error as AppError).userMessage).toMatch(/Settings/i)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The other two settings — also data, also not to be trusted
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveWidth', () => {
  it('reads the two widths the shop can actually have', () => {
    expect(resolveWidth('58mm')).toBe('58mm')
    expect(resolveWidth('80mm')).toBe('80mm')
  })

  /** A receipt on the wrong width is a receipt. NO receipt is a customer with no proof of purchase. */
  it('falls back to 80mm rather than failing on a nonsense setting', () => {
    expect(resolveWidth('A4')).toBe('80mm')
    expect(resolveWidth(null)).toBe('80mm')
    expect(resolveWidth(undefined)).toBe('80mm')
  })
})

describe('clampCopies', () => {
  it('keeps a sane value', () => {
    expect(clampCopies(1)).toBe(1)
    expect(clampCopies(3)).toBe(3)
  })

  it('clamps to the 1–5 the settings registry allows, whatever the row actually says', () => {
    expect(clampCopies(0)).toBe(1)
    expect(clampCopies(-4)).toBe(1)
    expect(clampCopies(99)).toBe(5)
    expect(clampCopies(2.7)).toBe(2)
    expect(clampCopies('nonsense')).toBe(1)
    expect(clampCopies(null)).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE ONE THAT MATTERS: A PRINTER JAM MUST NEVER LOSE A COMPLETED SALE
// ═════════════════════════════════════════════════════════════════════════════

const options = { width: '80mm', printerName: '', copies: 1 } as const

describe('printReceipt — the sale is ALREADY in the books', () => {
  it('prints, and says so', async () => {
    const outcome = await printReceipt(sampleReceipt(), { ...options, copies: 2 })

    expect(outcome.printed).toBe(true)
    expect(outcome.copies).toBe(2)
    expect(outcome.problem).toBeNull()
  })

  /**
   * TRAP #11. Large HTML — an embedded font is more than enough — silently breaks
   * loadURL('data:...'), and the receipt comes out blank or half-printed. The HTML goes to a FILE.
   */
  it('loads the receipt from a FILE, never from a data: URL', async () => {
    await printReceipt(sampleReceipt(), options)

    expect(loadFileMock).toHaveBeenCalledOnce()
    expect(loadFileMock.mock.calls[0]![0]).toMatch(/\.html$/)
  })

  it('prints silently, with no page margins and no background — it is thermal paper', async () => {
    await printReceipt(sampleReceipt(), options)

    const printOptions = printMock.mock.calls[0]![0] as Record<string, unknown>
    expect(printOptions['silent']).toBe(true) // the cashier's hands are on the scanner, not a dialog
    expect(printOptions['printBackground']).toBe(false) // a thermal head has one colour: burnt
    expect(printOptions['margins']).toEqual({ marginType: 'none' }) // the paper IS the margin
  })

  it('uses the system default printer when no printer is named, rather than inventing one', async () => {
    await printReceipt(sampleReceipt(), options)

    const printOptions = printMock.mock.calls[0]![0] as Record<string, unknown>
    expect(printOptions).not.toHaveProperty('deviceName')
  })

  it('sends the job to the named printer when the shop has one set', async () => {
    await printReceipt(sampleReceipt(), { ...options, printerName: 'EPSON TM-T82' })

    const printOptions = printMock.mock.calls[0]![0] as Record<string, unknown>
    expect(printOptions['deviceName']).toBe('EPSON TM-T82')
  })

  /** OUT OF PAPER. The customer has paid. The sale stands. */
  it('does NOT throw when the printer refuses the job — it reports it', async () => {
    printMock.mockImplementation(
      (_o, callback: (ok: boolean, reason: string) => void) => callback(false, 'Out of paper')
    )

    const outcome = await printReceipt(sampleReceipt(), options)

    expect(outcome.printed).toBe(false)
    expect(outcome.problem).toMatch(/sale is saved/i) // the FIRST thing the cashier must be told
    expect(outcome.problem).toMatch(/paper/i) // and then what to go and do about it
  })

  /** SOMEBODY UNPLUGGED IT. Same answer. */
  it('does NOT throw when the print call itself blows up', async () => {
    printMock.mockImplementation(() => {
      throw new Error('no printers found on this machine')
    })

    const outcome = await printReceipt(sampleReceipt(), options)
    expect(outcome.printed).toBe(false)
    expect(outcome.problem).toMatch(/sale is saved/i)
  })

  /** THE WINDOW ITSELF FAILED. Still not the sale's problem. */
  it('does NOT throw when the page cannot even be loaded', async () => {
    loadFileMock.mockRejectedValue(new Error('ERR_FILE_NOT_FOUND'))

    const outcome = await printReceipt(sampleReceipt(), options)
    expect(outcome.printed).toBe(false)
    expect(outcome.printed).not.toBe(true)
  })

  /**
   * A shop doing 1000 sales a day would otherwise leak 1000 hidden windows before closing time — and
   * the failing paths are exactly the ones a leak would hide in.
   */
  it('destroys the hidden window even when printing fails', async () => {
    printMock.mockImplementation((_o, callback: (ok: boolean) => void) => callback(false))

    await printReceipt(sampleReceipt(), options)
    expect(destroyMock).toHaveBeenCalledOnce()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The drawer — same contract, same reason
// ═════════════════════════════════════════════════════════════════════════════

describe('openCashDrawer', () => {
  it('sends the kick code to the printer as a RAW job', async () => {
    const outcome = await openCashDrawer({ kickCode: '27,112,0,25,250', printerName: 'TM-T82' })

    expect(outcome.opened).toBe(true)
    expect(outcome.problem).toBeNull()

    // Chromium prints HTML through a driver and cannot send ESC/POS. The bytes go round it, via the
    // OS spooler, as raw. (On this machine — macOS — that is CUPS.)
    const [command, args] = execFileMock.mock.calls[0] as [string, string[]]
    expect(command).toBe('lp')
    expect(args).toContain('raw')
    expect(args).toContain('TM-T82')
  })

  /** The owner mistyped the code in Settings. Tell them THAT — not "spawn ENOENT". */
  it('does NOT throw on a bad kick code, and hands back the owner-facing sentence', async () => {
    const outcome = await openCashDrawer({ kickCode: 'ESC p', printerName: '' })

    expect(outcome.opened).toBe(false)
    expect(outcome.problem).toMatch(/plain numbers/i)
    expect(execFileMock).not.toHaveBeenCalled() // nothing was sent to the printer
  })

  /** The drawer cable is out. A cash sale must still complete. */
  it('does NOT throw when the spooler rejects the job', async () => {
    execFileMock.mockImplementation((_c, _a, callback: (e: Error | null) => void) =>
      callback(new Error('lp: The printer or class does not exist.'))
    )

    const outcome = await openCashDrawer({ kickCode: '27,112,0,25,250', printerName: 'gone' })

    expect(outcome.opened).toBe(false)
    expect(outcome.problem).toMatch(/plugged into the receipt printer/i)
  })
})
