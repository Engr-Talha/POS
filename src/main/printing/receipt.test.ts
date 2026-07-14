import { describe, it, expect } from 'vitest'
import { renderReceiptHtml } from './receipt'
import { sampleReceipt } from './sample-receipt'

/**
 * The receipt has been RENDERED AND LOOKED AT (preview/receipt-80mm.png, receipt-58mm.png,
 * receipt-80mm-duplicate.png — regenerate with `npm run receipt:preview`). These tests guard the
 * traps that a picture cannot: the ones that only show up on a real thermal printer, in a real shop,
 * when it is too late.
 */
describe('the thermal receipt', () => {
  const html80 = renderReceiptHtml(sampleReceipt(), '80mm')
  const html58 = renderReceiptHtml(sampleReceipt(), '58mm')

  it('has NO box-shadow — Chromium prints a shadow as an ugly grey block', () => {
    // The DECLARATION, not the word: the stylesheet carries a comment telling the next person not to
    // add one, and a test that fails on its own warning label is a test nobody will keep.
    expect(html80).not.toMatch(/box-shadow\s*:/i)
    expect(html58).not.toMatch(/box-shadow\s*:/i)
  })

  it('loads NOTHING from the network — there is no internet at the till, and the CSP forbids it', () => {
    // No webfont, no CDN, no remote image. A receipt that needs the network is a receipt that does
    // not print during a power cut, which is precisely when the shop still has to sell things.
    for (const html of [html80, html58]) {
      expect(html).not.toMatch(/https?:\/\//)
      expect(html).not.toMatch(/@import/)
      expect(html).not.toMatch(/<img/i)
      expect(html).not.toMatch(/fonts\.googleapis/i)
    }
  })

  it('sets the paper width in mm, and NEVER a fixed height', () => {
    // A fixed height is trap #16: it ejects a page of blank thermal paper after every sale.
    expect(html80).toMatch(/size:\s*80mm auto/)
    expect(html58).toMatch(/size:\s*58mm auto/)
    expect(html80).not.toMatch(/min-height/)
    expect(html80).not.toMatch(/page-break-after/)
  })

  it('lets a long product name WRAP instead of running off the paper', () => {
    // Names in this shop are long, and the Urdu ones are longer. A name that overflows is a name the
    // shopkeeper cannot read back to the customer.
    expect(html58).toMatch(/overflow-wrap:\s*anywhere/)
    expect(html58).toContain('YoPod Tune Wireless Earbuds YOLO Bluetooth 5.3 Black')
  })

  it('prints the Urdu name right-to-left', () => {
    expect(html80).toMatch(/direction:\s*rtl/)
    expect(html80).toContain('یو پوڈ ٹیون وائرلیس ائیر بڈز')
  })

  it('prints a weighed quantity as 1.234 kg, not 1', () => {
    // qty_m is thousandths. Printing it as a whole number would sell 1 kg of rice for the price of
    // 1.234 kg, every time, and nobody would notice for months.
    expect(html80).toContain('1.234 kg')
  })

  it('shows a tax summary with a row per rate, because a cart may mix them', () => {
    expect(html80).toContain('17%')
    expect(html80).toContain('0%') // the tax-exempt line
  })

  it('shows the split payment and the change due', () => {
    expect(html80).toContain('Cash')
    expect(html80).toContain('Card')
    expect(html80).toContain('CHANGE')
    expect(html80).toContain('126.12')
  })

  it('stamps a reprint DUPLICATE, unmissably', () => {
    // A second copy of a receipt must never be passable as the first — that is how a refund gets
    // claimed twice on the same sale.
    expect(renderReceiptHtml(sampleReceipt(true), '80mm')).toContain('DUPLICATE')
    expect(renderReceiptHtml(sampleReceipt(false), '80mm')).not.toContain('DUPLICATE')
  })

  it('escapes a product name that contains HTML, rather than rendering it', () => {
    const nasty = sampleReceipt()
    nasty.lines[0]!.name = '<script>alert(1)</script> & "quoted"'
    const html = renderReceiptHtml(nasty, '80mm')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('adds up: subtotal − discount + tax === the total printed', () => {
    const r = sampleReceipt()
    expect(r.subtotalNet - r.cartDiscount + r.taxTotal).toBe(r.grandTotal)
  })
})
