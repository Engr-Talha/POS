import { describe, it, expect } from 'vitest'
import { renderQuotationHtml } from './quotation'
import { renderReceiptHtml } from './receipt'
import { sampleQuotation } from './sample-quotation'
import { sampleReceipt } from './sample-receipt'

/**
 * THE QUOTATION. A DIFFERENT DOCUMENT FROM THE RECEIPT, and these tests exist to keep it that way.
 *
 * The thing being guarded is not a layout — it is that a piece of paper the shop hands a customer
 * cannot claim money changed hands when it did not. Everything else here is the receipt's own trap
 * list (CLAUDE.md §5), re-asserted, because this prints on the same thermal head.
 */
/**
 * WHAT ACTUALLY PRINTS — the <body>, with the stylesheet and the comments above it stripped off.
 *
 * Every "this word must NOT appear" test below asserts against THIS, not the raw HTML. The template
 * explains itself in prose ("...exactly like the receipt's DUPLICATE stamp..."), and a test that fails
 * on its own warning label is a test the next person deletes instead of fixing — the receipt's suite
 * learned this already. The paper is what matters; the comments are for whoever reads the file cold.
 */
function body(html: string): string {
  return html.slice(html.indexOf('<body>'))
}

describe('the quotation', () => {
  const html80 = renderQuotationHtml(sampleQuotation(), '80mm')
  const html58 = renderQuotationHtml(sampleQuotation(), '58mm')
  const body80 = body(html80)
  const body58 = body(html58)

  // ── It is a QUOTATION, and it says so ──────────────────────────────────────

  it('says QUOTATION, unmissably', () => {
    expect(html80).toContain('QUOTATION')
    expect(html58).toContain('QUOTATION')
  })

  it('states plainly that it is not a bill and no money has been taken', () => {
    // The sentence that stops a quote being passed off as proof of purchase.
    for (const html of [html80, html58]) {
      expect(html).toContain('This is a price quotation, not a receipt.')
      expect(html).toContain('No payment has been received.')
    }
  })

  it('carries NO invoice number — a quote has none, and that is what keeps numbering gapless', () => {
    // THE BUG THIS DOCUMENT EXISTS TO PREVENT. A quote printed through the receipt template showed an
    // EMPTY invoice number and read as a real sale. There is no invoice number on the type, so there
    // must be none on the paper — not a blank, not a placeholder, not "(not issued yet)".
    for (const printed of [body80, body58]) {
      expect(printed).not.toMatch(/invoice/i)
      expect(printed).not.toContain('INV-')
      // The receipt's own number must not have leaked in from a copy-paste of the template.
      expect(printed).not.toContain('INV-2026-000142')
    }
  })

  it('shows the quote reference LABELLED as a quote, never as an invoice', () => {
    // A quote does have a document id, and the shopkeeper needs to find it again. It prints as
    // "Quote #142" so it can never be read back down the phone as an invoice number.
    expect(html80).toContain('Quote #142')
    expect(html58).toContain('Quote #142')
  })

  it('has NO tender, change or DUPLICATE framing — none of it has happened', () => {
    // A receipt has all three. A quotation must have none: nothing was paid, so nothing was tendered,
    // nothing was given back, and a reprinted OFFER is not a second receipt for one sale.
    for (const printed of [body80, body58]) {
      expect(printed).not.toContain('DUPLICATE')
      expect(printed).not.toContain('CHANGE')
      expect(printed).not.toContain('BALANCE DUE')
      expect(printed).not.toMatch(/\bCash\b/)
      expect(printed).not.toMatch(/\bCard\b/)
    }
  })

  // ── The shelf life ─────────────────────────────────────────────────────────

  it('shows the valid-until date prominently, as a date and not an ISO string', () => {
    // 2026-07-22 rendered the way the shopkeeper reads a date. toLocaleDateString so the assertion
    // does not hard-code this machine's locale.
    const expected = new Date(2026, 6, 22).toLocaleDateString()

    for (const html of [html80, html58]) {
      expect(html).toContain('Valid until')
      expect(html).toContain(expected)
    }
  })

  it('reads the expiry as a LOCAL day — never a UTC instant that lapses a day early', () => {
    // new Date('2026-07-22') is UTC midnight, which west of Greenwich prints as the 21st. The offer
    // would appear to lapse a day early ON THE CUSTOMER'S COPY, in writing.
    const html = renderQuotationHtml(sampleQuotation({ validUntil: '2026-07-22' }), '80mm')
    expect(html).toContain(new Date(2026, 6, 22).toLocaleDateString())
  })

  it('marks an expired quote EXPIRED, and an unexpired one not at all', () => {
    const expired = body(renderQuotationHtml(sampleQuotation({ isExpired: true }), '80mm'))
    const live = body(renderQuotationHtml(sampleQuotation({ isExpired: false }), '80mm'))

    expect(expired).toContain('EXPIRED')
    expect(live).not.toContain('EXPIRED')

    // Expiry marks the paper. It does not remove the price — the shopkeeper decides whether to honour
    // it with the customer standing there. (Migration 0015.)
    expect(expired).toContain('4373.88')
  })

  // ── The money, exactly as the receipt shows it ─────────────────────────────

  it('prints the totals — subtotal, discount, tax and the grand total', () => {
    // UNGROUPED, exactly as the receipt prints them: formatMoney(..., { grouping: false }). A thermal
    // line is 32/48 characters wide and a comma is a character that could push the amount onto a
    // second line. The receipt made that call; the quotation does not get to make a different one.
    expect(html80).toContain('3811.38') // subtotal net
    expect(html80).toContain('20.00') // cart discount
    expect(html80).toContain('582.50') // tax
    expect(html80).toContain('4373.88') // the grand total
    expect(html80).toContain('Rs')
  })

  it('adds up: subtotal − discount + tax === the total printed', () => {
    const q = sampleQuotation()
    expect(q.subtotalNet - q.cartDiscount + q.taxTotal).toBe(q.grandTotal)
  })

  it('formats every number EXACTLY as the receipt does — one formatter, not two', () => {
    // The customer holds the quote against the receipt at the counter. "Rs 3,999.00" on one and "3999"
    // on the other is a phone call; "1.234 kg" against "1 kg" is a refund. Same cart, same figures.
    const receipt = renderReceiptHtml(sampleReceipt(), '80mm')

    // sampleQuotation() is sampleReceipt()'s cart minus what a quote does not have, so every one of
    // these must appear, character for character, on BOTH documents. Asserting each against the
    // receipt too is the point: it pins the shared format down rather than just agreeing with itself.
    for (const figure of ['3999.00', '1.234 kg', '320.00', '3811.38', '582.50', '4373.88']) {
      expect(receipt).toContain(figure)
      expect(html80).toContain(figure)
    }
  })

  it('prints a weighed quantity as 1.234 kg, not 1', () => {
    // qty_m is thousandths. Quoting 1 kg of rice at the price of 1.234 kg is a promise the shop then
    // has to honour at the till.
    expect(html80).toContain('1.234 kg')
  })

  it('shows a tax summary with a row per rate, because a cart may mix them', () => {
    expect(html80).toContain('17%')
    expect(html80).toContain('0%') // the tax-exempt line
  })

  // ── The print traps (CLAUDE.md §5) — same paper, same head ─────────────────

  it('has NO box-shadow — Chromium prints a shadow as an ugly grey block', () => {
    expect(html80).not.toMatch(/box-shadow\s*:/i)
    expect(html58).not.toMatch(/box-shadow\s*:/i)
  })

  it('loads NOTHING from the network — there is no internet at the till, and the CSP forbids it', () => {
    for (const html of [html80, html58]) {
      expect(html).not.toMatch(/https?:\/\//)
      expect(html).not.toMatch(/@import/)
      expect(html).not.toMatch(/@font-face/i)
      expect(html).not.toMatch(/url\(/i)
      expect(html).not.toMatch(/<img/i)
      expect(html).not.toMatch(/fonts\.googleapis/i)
    }
  })

  it('sets the paper width in mm, and NEVER a fixed height', () => {
    // A fixed height is trap #16: it ejects a page of blank thermal paper after every quote.
    expect(html80).toMatch(/size:\s*80mm auto/)
    expect(html58).toMatch(/size:\s*58mm auto/)
    expect(html80).not.toMatch(/min-height/)
    expect(html80).not.toMatch(/page-break-after/)
    expect(html58).not.toMatch(/min-height/)
    expect(html58).not.toMatch(/page-break-after/)
  })

  it('lets a long product name WRAP instead of running off the paper', () => {
    expect(html58).toMatch(/overflow-wrap:\s*anywhere/)
    expect(html58).toContain('YoPod Tune Wireless Earbuds YOLO Bluetooth 5.3 Black')
  })

  it('prints the Urdu name right-to-left', () => {
    expect(html80).toMatch(/direction:\s*rtl/)
    expect(html80).toContain('یو پوڈ ٹیون وائرلیس ائیر بڈز')
  })

  it('escapes a product name that contains HTML, rather than rendering it', () => {
    const nasty = sampleQuotation()
    nasty.lines[0]!.name = '<script>alert(1)</script> & "quoted"'
    const html = renderQuotationHtml(nasty, '80mm')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('escapes the shop name and the customer name too', () => {
    const nasty = sampleQuotation({ customerName: '<b>Ali</b>' })
    nasty.shop.name = 'Insha & Sons <Ltd>'
    const html = renderQuotationHtml(nasty, '80mm')

    expect(html).toContain('Insha &amp; Sons &lt;Ltd&gt;')
    expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;')
  })

  it('renders without a customer, a footer or an address — a walk-in asking for a price', () => {
    // The commonest quote in the shop: someone at the counter asking what a thing costs.
    const bare = sampleQuotation({ customerName: null, footer: null })
    bare.shop.address = null
    bare.shop.phone = null
    bare.shop.taxNumber = null

    const printed = body(renderQuotationHtml(bare, '80mm'))

    expect(printed).toContain('QUOTATION')
    expect(printed).toContain('Valid until')
    expect(printed).toContain('4373.88')
    // A missing optional must print NOTHING — never the string "null"/"undefined" at the customer.
    expect(printed).not.toContain('undefined')
    expect(printed).not.toContain('null')
  })

  it('defaults to 80mm, the width most of these shops print on', () => {
    expect(renderQuotationHtml(sampleQuotation())).toMatch(/size:\s*80mm auto/)
  })
})
