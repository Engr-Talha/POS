import { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReceiptData, ReceiptWidth } from '@shared/receipt'
import type { QuotationData } from '@shared/sales'
import type { DrawerOutcome, PrintOutcome, PrinterInfo } from '@shared/ipc'
import { AppError, ErrorCode } from '@shared/result'
import { renderReceiptHtml } from './receipt'
import { renderQuotationHtml } from './quotation'
import { renderInvoiceA4Html, type InvoiceA4Data, type InvoiceA4Options } from './invoice-a4'
import log from '../logger'

/**
 * THE PRINTER AND THE CASH DRAWER — the two pieces of hardware this app touches.
 *
 * ── THE ONE RULE THAT OUTRANKS EVERYTHING ELSE IN THIS FILE ─────────────────────────────────────
 *
 * A PRINTER JAM MUST NEVER LOSE A COMPLETED SALE.
 *
 * By the time anything here runs, the money has been taken, the stock has moved and the journal has
 * posted — all committed, in one transaction, by services/sales.ts. Out of paper is a Tuesday. So
 * NOTHING in this file throws: `printReceipt` and `openCashDrawer` return an OUTCOME
 * ({ printed: false, problem }) and the caller carries on. The cashier is told the receipt did not
 * print and is offered a reprint; they are never told the sale failed, because it did not.
 *
 * This is why the two exported entry points have no `throws` in them at all, and why the temp-file
 * cleanup and the window teardown sit in `finally` blocks. A shop doing 1000 sales a day will hit
 * every one of these paths within a month.
 *
 * ── HOW A RECEIPT ACTUALLY GETS ONTO PAPER ──────────────────────────────────────────────────────
 *
 * renderReceiptHtml() -> a temp FILE -> loadFile() in a hidden window -> webContents.print().
 *
 * NEVER loadURL('data:...'). Large HTML (an embedded font is enough) silently breaks a data URL, and
 * the receipt comes out blank or half-printed. Write the file. (Trap #11.)
 *
 * ── HOW THE DRAWER ACTUALLY OPENS ───────────────────────────────────────────────────────────────
 *
 * The cash drawer is a peripheral OF THE PRINTER — a solenoid on the end of an RJ11 cable. It opens
 * when the printer receives an ESC/POS "kick" code (`drawer.kickCode`, default `27,112,0,25,250` =
 * ESC p 0 25 250).
 *
 * Chromium prints HTML *through the driver* and cannot send raw bytes, so the kick has to go round
 * it: the bytes are written to a file and handed to the OS spooler as a RAW job. See sendRaw().
 *
 * ── EVERY NUMBER HERE COMES FROM SETTINGS ───────────────────────────────────────────────────────
 *
 * `printer.receiptWidth`, `printer.name`, `printer.copies`, `drawer.enabled`, `drawer.kickCode`.
 * Not one of them is a constant in this file — a different shop has a different printer.
 * (CLAUDE.md §4.) The two timeouts below are the exception, and they are explained where they sit.
 */

/**
 * HOW LONG WE WAIT FOR THE PRINTER BEFORE WE GIVE THE CASHIER THEIR TILL BACK.
 *
 * `webContents.print()` takes a callback, and a printer that is switched off, jammed, or waiting on a
 * driver dialog can simply never call it. Without this, the promise never settles, the IPC call never
 * returns, and the Sell screen hangs forever after a sale that has ALREADY been committed — the
 * single worst outcome available to this file. So we give up, tell them, and offer a reprint.
 *
 * These are hardware safety valves, not business rules, which is why they are not in the settings
 * registry. If a shop ever turns out to have a printer slower than 20s, they become settings.
 */
const PRINT_TIMEOUT_MS = 20_000
const DRAWER_TIMEOUT_MS = 5_000

/** `printer.copies` is 1–5 in the registry. A hand-edited settings row is not to be trusted. */
const MIN_COPIES = 1
const MAX_COPIES = 5

// ═════════════════════════════════════════════════════════════════════════════
// The pure bits — the ones that decide something, and are therefore tested
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE ESC/POS KICK CODE, from the text the owner typed in Settings, to bytes.
 *
 * "27,112,0,25,250" -> <27 70 00 19 fa>. Decimal, comma-separated, one byte each — the notation every
 * thermal-printer manual in this market prints on the back page, which is where a shopkeeper will be
 * copying it from.
 *
 * It is STRICT on purpose. A drawer that does not open is a support call; a drawer that opens on a
 * *corrupted* code is a printer spitting out garbage characters mid-receipt. If the code is not a list
 * of plain numbers 0–255, we refuse it and say so in words the owner can act on.
 */
export function parseKickCode(text: string): Buffer {
  const raw = text.trim()

  if (raw === '') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'No cash drawer code is set. An owner can set it in Settings → Hardware.',
      'drawer.kickCode is empty'
    )
  }

  const bytes = raw.split(',').map((token) => {
    const part = token.trim()

    if (!/^\d+$/.test(part)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'The cash drawer code in Settings is not valid. It should be plain numbers separated by commas, like 27,112,0,25,250.',
        `drawer.kickCode contains a non-numeric part: "${part}"`
      )
    }

    const value = Number(part)
    if (value > 255) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'The cash drawer code in Settings is not valid. Each number must be between 0 and 255.',
        `drawer.kickCode part out of range: ${value}`
      )
    }

    return value
  })

  return Buffer.from(bytes)
}

/**
 * The paper width, from the setting. Anything unrecognised falls back to 80mm rather than throwing:
 * a receipt on the wrong width is a receipt; no receipt at all is a customer with no proof of purchase.
 */
export function resolveWidth(value: unknown): ReceiptWidth {
  return value === '58mm' ? '58mm' : '80mm'
}

/** `printer.copies`, clamped to what the registry allows. A settings row is data, and data can be wrong. */
export function clampCopies(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return MIN_COPIES
  return Math.min(MAX_COPIES, Math.max(MIN_COPIES, n))
}

// ═════════════════════════════════════════════════════════════════════════════
// Printing
// ═════════════════════════════════════════════════════════════════════════════

export type PrintReceiptOptions = {
  /** `printer.receiptWidth`. */
  width: ReceiptWidth
  /** `printer.name`. Empty = the system default printer. */
  printerName: string
  /** `printer.copies`. */
  copies: number
}

/**
 * PRINT A RECEIPT. NEVER THROWS — see the file header.
 *
 * The sale that produced this ReceiptData is already committed. Whatever happens in here, the shop's
 * books are correct and the customer has been charged. The worst this function may do is come back and
 * say "it did not print", which the Sell screen turns into a warning and a Print again button.
 */
export async function printReceipt(
  data: ReceiptData,
  options: PrintReceiptOptions
): Promise<PrintOutcome> {
  const copies = clampCopies(options.copies)
  const deviceName = options.printerName.trim()
  const printerName = deviceName === '' ? null : deviceName

  try {
    const html = renderReceiptHtml(data, options.width)
    await printHtml(html, { deviceName, copies })

    log.info(
      `[printer] receipt ${data.invoiceNo} printed x${copies} on ` +
        `${printerName ?? 'the system default printer'}`
    )

    return { printed: true, copies, printerName, problem: null }
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error)
    // LOUD in the log, because this is the one failure the shopkeeper will phone about.
    log.error(`[printer] receipt ${data.invoiceNo} DID NOT PRINT: ${technical}`)

    return {
      printed: false,
      copies: 0,
      printerName,
      problem:
        'The sale is saved, but the receipt did not print. Check the printer is switched on, has paper, and is connected — then print it again.'
    }
  }
}

/**
 * PRINT A QUOTATION — the offer, on the same thermal paper, from the same settings. NEVER THROWS.
 *
 * It is its own function for the same reason `renderQuotationHtml` is its own template: a quote and a
 * receipt are two documents, and a shared function behind an `isQuote` flag is one forgotten `if` away
 * from printing a blank invoice number on a document the customer reads as a bill.
 *
 * WHAT IS AT STAKE HERE IS LESS THAN A RECEIPT, AND THE RULE STILL HOLDS. No money has been taken and no
 * number drawn, so a jam costs nothing but paper — but the caller is still told in a sentence rather than
 * an exception, so the quote-saved toast can offer "Print again" exactly as the sale's does. Failing
 * loudly here would be a red box over a cart the cashier has already parked safely.
 */
export async function printQuotation(
  data: QuotationData,
  options: PrintReceiptOptions
): Promise<PrintOutcome> {
  const copies = clampCopies(options.copies)
  const deviceName = options.printerName.trim()
  const printerName = deviceName === '' ? null : deviceName

  try {
    const html = renderQuotationHtml(data, options.width)
    await printHtml(html, { deviceName, copies })

    log.info(
      `[printer] quotation #${data.quoteId} printed x${copies} on ` +
        `${printerName ?? 'the system default printer'}`
    )

    return { printed: true, copies, printerName, problem: null }
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error)
    log.error(`[printer] quotation #${data.quoteId} DID NOT PRINT: ${technical}`)

    return {
      printed: false,
      copies: 0,
      printerName,
      problem:
        'The quotation is saved, but it did not print. Check the printer is switched on, has paper, and is connected — then print it again from the Quotations list.'
    }
  }
}

/**
 * PRINT AN A4 INVOICE — a sale or a purchase, on a full page with the shop letterhead. NEVER THROWS,
 * exactly like printReceipt: for a sale this runs AFTER the sale is committed (the money is taken, the
 * stock has moved), so a printer jam must never surface as a failed sale. It comes back with an OUTCOME
 * and the caller carries on. (For a purchase reprint nothing is at stake but paper, and the same gentle
 * contract still lets the drawer offer "Print again".)
 *
 * This is the A4 branch of the format switch (`invoice.printFormat`): 'a4' prints this, 'thermal' prints
 * the slip. renderInvoiceA4Html builds the HTML; the existing printHtml() puts it on paper.
 */
export async function printInvoiceA4(
  data: InvoiceA4Data,
  invoiceOpts: InvoiceA4Options,
  options: PrintReceiptOptions
): Promise<PrintOutcome> {
  const copies = clampCopies(options.copies)
  const deviceName = options.printerName.trim()
  const printerName = deviceName === '' ? null : deviceName

  try {
    const html = renderInvoiceA4Html(data, invoiceOpts)
    await printHtml(html, { deviceName, copies })

    log.info(
      `[printer] A4 ${data.kind} invoice ${data.number} printed x${copies} on ` +
        `${printerName ?? 'the system default printer'}`
    )

    return { printed: true, copies, printerName, problem: null }
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error)
    log.error(`[printer] A4 ${data.kind} invoice ${data.number} DID NOT PRINT: ${technical}`)

    return {
      printed: false,
      copies: 0,
      printerName,
      problem:
        'The invoice did not print. Check the printer is switched on, has paper, and is connected — then print it again.'
    }
  }
}

/**
 * AN A4 INVOICE -> a PDF buffer, for a shop with no A4 printer that wants to SAVE or email it. An export,
 * like a report PDF — it DOES throw on failure (there is no committed sale to protect; the owner clicked
 * "Save as PDF" and wants to be told plainly if it did not work). htmlToPdfBuffer honours the page size.
 */
export async function invoiceA4ToPdfBuffer(
  data: InvoiceA4Data,
  invoiceOpts: InvoiceA4Options
): Promise<Buffer> {
  return htmlToPdfBuffer(renderInvoiceA4Html(data, invoiceOpts), invoiceOpts.pageSize)
}

/**
 * HTML -> paper. The temp file and the hidden window are both torn down in `finally`, because a shop
 * doing 1000 sales a day would otherwise leak 1000 windows and 1000 temp files before closing time.
 */
async function printHtml(
  html: string,
  options: { deviceName: string; copies: number }
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pos-receipt-'))
  const file = join(dir, 'receipt.html')
  writeFileSync(file, html, 'utf8')

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      // A receipt is markup. It has no business running code, so it is not given the chance.
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    // loadFile — NOT loadURL('data:...'), which breaks on large HTML and prints a blank receipt.
    // (Trap #11.)
    await window.loadFile(file)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the printer did not respond within ${PRINT_TIMEOUT_MS}ms`))
      }, PRINT_TIMEOUT_MS)

      window.webContents.print(
        {
          silent: true, // the cashier never sees a print dialog — their hands are on the scanner
          printBackground: false, // a thermal head has exactly one colour: burnt
          margins: { marginType: 'none' }, // the paper IS the margin; the layout is measured in mm
          copies: options.copies,
          ...(options.deviceName === '' ? {} : { deviceName: options.deviceName })
        },
        (success, failureReason) => {
          clearTimeout(timer)
          if (success) resolve()
          else reject(new Error(failureReason || 'the print job was not accepted'))
        }
      )
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * HTML -> an A4 PDF buffer, for the reports the owner exports (services/reports-pdf.ts renders the
 * HTML). SAME hidden-window + temp-file + teardown as printHtml — a report file can carry embedded
 * content just as a receipt can, and loadURL('data:...') breaks on large HTML (trap #11), so it is
 * written to a FILE and loaded with loadFile. `javascript: false` because a report is markup with no
 * business running code, and there is no network at the till regardless (offline + CSP).
 *
 * Unlike printReceipt this DOES throw on failure: there is no committed sale to protect here, and the
 * caller (an owner clicking "Export to PDF") wants to be told plainly if it did not work. The window
 * and the temp directory are still torn down in `finally`, because this runs on demand and must not
 * leak a hidden window per export.
 */
export async function htmlToPdfBuffer(
  html: string,
  pageSize: 'A4' | 'Letter' | 'A5' = 'A4'
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pos-report-'))
  const file = join(dir, 'report.html')
  writeFileSync(file, html, 'utf8')

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    await window.loadFile(file)

    // printBackground so the header/total shading actually prints; the page size is the report's A4
    // default or, for an A4 invoice, whatever the shop set (Letter/A5); ~13mm margins so nothing is
    // clipped. The document's own CSS keeps the layout within this — no @page margin doubling, and no
    // fixed height that would add a trailing blank page.
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      pageSize,
      margins: PDF_MARGINS
    })

    log.info(`[pdf] rendered a ${pdf.length}-byte report`)
    return pdf
  } finally {
    if (!window.isDestroyed()) window.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A4 report margins, in inches (Electron's printToPDF unit) — about 13mm all round. */
const PDF_MARGINS = { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } as const

/**
 * The printers the OS can see — for the Settings dropdown, so the owner PICKS their printer instead of
 * typing its name and getting it subtly wrong.
 *
 * Needs a live webContents to ask, so it borrows the main window. Before the window exists there is
 * nobody to show the list to anyway.
 *
 * NO "is default" FLAG. Electron removed `isDefault` from its own PrinterInfo, and reconstructing it
 * from the platform-specific `options` bag would produce a flag that is right on Windows and wrong on
 * macOS. It is not needed: an EMPTY `printer.name` already means "use the system default", so the blank
 * entry in the dropdown IS the default printer.
 */
export async function listPrinters(): Promise<PrinterInfo[]> {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return []

  const devices = await window.webContents.getPrintersAsync()

  return devices.map(
    (device): PrinterInfo => ({
      name: device.name,
      displayName: device.displayName || device.name,
      description: device.description
    })
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The cash drawer
// ═════════════════════════════════════════════════════════════════════════════

export type OpenDrawerOptions = {
  /** `drawer.kickCode`. */
  kickCode: string
  /** `printer.name`. The drawer hangs off the receipt printer. */
  printerName: string
}

/**
 * KICK THE DRAWER. NEVER THROWS — same reason as printReceipt: on a cash sale this runs *after* the
 * money is in the books, and a drawer that will not open must not roll a sale back.
 *
 * WHO is allowed to do this without a sale, and the fact that it is always audited, is the IPC layer's
 * business (`drawer.no_sale`) — not this file's. This file is the hardware.
 */
export async function openCashDrawer(options: OpenDrawerOptions): Promise<DrawerOutcome> {
  try {
    const bytes = parseKickCode(options.kickCode)
    await sendRaw(bytes, options.printerName.trim())

    log.info('[drawer] kick code sent')
    return { opened: true, problem: null }
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error)
    log.error(`[drawer] DID NOT OPEN: ${technical}`)

    return {
      opened: false,
      // A bad kick code is the owner's typo and we can say exactly that. Anything else is the cable.
      problem:
        error instanceof AppError
          ? error.userMessage
          : 'The cash drawer did not open. Check it is plugged into the receipt printer and that the printer is switched on.'
    }
  }
}

/**
 * RAW BYTES TO THE PRINTER — the one thing Chromium cannot do for us.
 *
 * `webContents.print()` goes through the printer *driver*, which renders a page. ESC/POS is not a
 * page; it is a command to the firmware. So the bytes go to the OS spooler as a RAW job instead.
 *
 *   WINDOWS  `copy /b <file> \\localhost\<printer>` — the standard raw-print route, and the reason
 *            `printer.name` MUST be set: there is no "default share" to copy to. It requires the
 *            printer to be SHARED under that exact name (Printer properties → Sharing → Share this
 *            printer). This is the one step of this app's setup that is not a single click, and it is
 *            called out in the hand-over notes.
 *
 *   macOS / Linux  `lp -o raw` — CUPS passes the bytes through untouched. An empty printer name uses
 *            the system default, which is why the drawer can be tested on the dev machine at all.
 */
async function sendRaw(bytes: Buffer, printerName: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pos-drawer-'))
  const file = join(dir, 'kick.bin')
  writeFileSync(file, bytes)

  try {
    if (process.platform === 'win32') {
      if (printerName === '') {
        throw new AppError(
          ErrorCode.VALIDATION,
          'Please choose your receipt printer in Settings → Hardware before using the cash drawer.',
          'a raw drawer kick on Windows needs an explicit printer name to copy to'
        )
      }
      await run('cmd', ['/c', 'copy', '/b', file, `\\\\localhost\\${printerName}`])
    } else {
      const args =
        printerName === '' ? ['-o', 'raw', file] : ['-d', printerName, '-o', 'raw', file]
      await run('lp', args)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** execFile, promisified, with a timeout — a hung spooler must not hang the till. */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: DRAWER_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} failed: ${stderr.trim() || error.message}`))
          return
        }
        resolve()
      }
    )
  })
}
