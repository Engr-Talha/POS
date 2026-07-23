import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderInvoiceA4Html,
  invoiceA4FromReceipt,
  invoiceA4FromPurchase,
  type InvoiceA4Options
} from './invoice-a4'
import { sampleReceipt } from './sample-receipt'
import { formatMoney } from '@shared/money'
import type { PurchaseDetail } from '@shared/purchases'

/**
 * THE A4 INVOICE HAS BEEN RENDERED AND LOOKED AT — the emitted HTML is written to
 * /tmp/invoice-a4-{sale,purchase}.html by the first two tests below, and the assertions here read that
 * exact text. These tests guard the print traps a picture cannot (CLAUDE.md §5): no box-shadow, nothing
 * off the network, the logo as a data: URI, and no dangling contact labels — plus that the adapters
 * carry the FROZEN totals through unchanged.
 */

const FULL_OPTS: InvoiceA4Options = {
  shop: {
    name: 'Insha Store',
    address: 'Shop 12, Main Bazaar',
    city: 'Lahore',
    phone: '0300-1234567',
    phone2: '042-35000000',
    email: 'shop@insha.pk',
    contactPerson: 'Bilal',
    taxNumber: '1234567-8'
  },
  // A tiny valid 1x1 PNG data URI — offline-safe, exactly the shape settings stores.
  logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAYH0kQoUAAAAAElFTkSuQmCC',
  pageSize: 'A4',
  terms: 'Goods once sold are not returnable after 7 days.\nPayment due on receipt.',
  footer: 'Thank you for your business.'
}

/** A purchase detail with everything a purchase invoice needs — mixed qty, a long name, a part-payment. */
function samplePurchase(): PurchaseDetail {
  return {
    id: 42,
    supplierId: 3,
    supplierInvoiceNo: 'SUP-2026-0091',
    at: new Date('2026-07-10T11:20:00').toISOString(),
    subtotalNet: 500_000,
    taxTotal: 0,
    grandTotal: 500_000,
    paidTotal: 200_000,
    notes: null,
    status: 'completed',
    voidReasonCode: null,
    voidedBy: null,
    voidedAt: null,
    userId: 1,
    journalId: 99,
    createdAt: new Date('2026-07-10T11:20:00').toISOString(),
    supplierName: 'Rehman Distributors',
    userName: 'Manager Sana',
    lines: [
      {
        id: 1,
        purchaseId: 42,
        productId: 10,
        nameSnapshot: 'Extra Long Product Name That Really Should Wrap Across The Column Nicely Carton of 24',
        qtyM: 10_000, // 10 units
        uom: 'pcs',
        unitCost: 300_000, // 4-dp cost — a DIFFERENT scale, not shown raw
        lineTotal: 300_000, // 2-dp money, frozen
        batchId: null,
        createdAt: new Date('2026-07-10T11:20:00').toISOString()
      },
      {
        id: 2,
        purchaseId: 42,
        productId: 11,
        nameSnapshot: 'Basmati Rice (loose)',
        qtyM: 2_000, // 2 kg
        uom: 'kg',
        unitCost: 1_000_000,
        lineTotal: 200_000,
        batchId: null,
        createdAt: new Date('2026-07-10T11:20:00').toISOString()
      }
    ],
    payments: [
      {
        id: 1,
        purchaseId: 42,
        methodLookupId: 1,
        amount: 200_000,
        chequeNo: null,
        chequeDate: null,
        walletRef: null,
        createdAt: new Date('2026-07-10T11:20:00').toISOString()
      }
    ]
  }
}

describe('the A4 invoice — a SALE', () => {
  const data = invoiceA4FromReceipt(sampleReceipt())
  const html = renderInvoiceA4Html(data, FULL_OPTS)

  it('was rendered and written out for a human to look at', () => {
    const path = join(tmpdir(), 'invoice-a4-sale.html')
    writeFileSync(path, html, 'utf8')
    expect(html).toContain('<!doctype html>')
  })

  it('carries the shop name, the title INVOICE, and the invoice number', () => {
    expect(html).toContain('Insha Store')
    expect(html).toContain('INVOICE')
    expect(html).toContain('INV-2026-000142')
  })

  it('prints the grand total as the app formats money — never re-rounded', () => {
    // The sample sale's grand total is 437388 minor units. The adapter must not recompute it.
    expect(data.grandTotal).toBe(437_388)
    expect(html).toContain(formatMoney(437_388, { symbol: 'Rs' }))
  })

  it('shows the terms text and the footer note when they are set', () => {
    expect(html).toContain('Goods once sold are not returnable')
    expect(html).toContain('Thank you for your business.')
  })

  it('has NO box-shadow — Chromium prints a shadow as a grey block (trap #12)', () => {
    expect(html).not.toMatch(/box-shadow\s*:/i)
  })

  it('loads NOTHING off the network — offline + CSP (trap #13)', () => {
    // The logo is a data: URI; there must be no http(s), no @import, no webfont host.
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/@import/)
    // The DECLARATION, not the word in a comment (the CSS comment names @font-face to warn the next
    // person off it). A real @font-face rule is followed by a brace.
    expect(html).not.toMatch(/@font-face\s*\{/i)
    expect(html).not.toMatch(/fonts\.googleapis/i)
  })

  it('sets NO fixed body height — a height plus a page break is a trailing blank page (trap #16)', () => {
    // No min-height, and no bare `height:` (max-height on the capped logo is fine and expected).
    expect(html).not.toMatch(/min-height\s*:/i)
    expect(html).not.toMatch(/(?<!max-)(?<!line-)height\s*:/i)
  })

  it('renders the logo as the data: URI it was handed', () => {
    expect(html).toMatch(/<img src="data:image\/png;base64,/)
  })

  it('prints only non-empty contact fields, never a dangling label', () => {
    // All fields set here, so all labels appear.
    expect(html).toContain('Phone: ')
    expect(html).toContain('Email: ')
    expect(html).toContain('shop@insha.pk')
    expect(html).toContain('Contact: ')
    expect(html).toContain('NTN / STRN: ')
  })
})

describe('the A4 invoice — a PURCHASE', () => {
  const purchase = samplePurchase()
  const data = invoiceA4FromPurchase(purchase, 'Rs', 'PK')
  const html = renderInvoiceA4Html(data, FULL_OPTS)

  it('was rendered and written out for a human to look at', () => {
    const path = join(tmpdir(), 'invoice-a4-purchase.html')
    writeFileSync(path, html, 'utf8')
    expect(html).toContain('<!doctype html>')
  })

  it('carries the title PURCHASE, the supplier bill number, and the supplier name', () => {
    expect(html).toContain('PURCHASE')
    expect(html).toContain('SUP-2026-0091')
    expect(html).toContain('Rehman Distributors')
  })

  it('carries the FROZEN totals through — grand total matches the source', () => {
    expect(data.grandTotal).toBe(500_000)
    expect(data.subtotalNet).toBe(500_000)
    // paid = Σ payments; owed = grand − paid.
    expect(data.paid).toBe(200_000)
    expect(data.owed).toBe(300_000)
    expect(html).toContain(formatMoney(500_000, { symbol: 'Rs' }))
    expect(html).toContain('Balance owed')
    expect(html).toContain(formatMoney(300_000, { symbol: 'Rs' }))
  })

  it('shows the per-unit money figure derived from the frozen line total, not the raw 4-dp cost', () => {
    // Line 1: 300000 minor over 10 units = 30000/unit = Rs 300.00. NOT the 4-dp unitCost of 300000.
    expect(html).toContain(formatMoney(30_000))
  })

  it('has NO box-shadow and loads NOTHING off the network', () => {
    expect(html).not.toMatch(/box-shadow\s*:/i)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('wraps a very long item name inside the table rather than overflowing the sheet', () => {
    // The long name is present, and the name cell carries the wrap rule.
    expect(html).toContain('Extra Long Product Name That Really Should Wrap')
    expect(html).toMatch(/overflow-wrap\s*:\s*anywhere/i)
  })
})

describe('the A4 invoice — empty letterhead fields print nothing (no stray labels)', () => {
  const bare: InvoiceA4Options = {
    shop: { name: 'Tiny Shop' },
    logo: '',
    pageSize: 'A4',
    terms: '',
    footer: ''
  }
  const html = renderInvoiceA4Html(invoiceA4FromReceipt(sampleReceipt()), bare)

  it('renders NO logo <img> when the logo is empty', () => {
    expect(html).not.toMatch(/<img/i)
  })

  it('renders NO Terms & Conditions block when terms is empty', () => {
    expect(html).not.toContain('Terms &amp; Conditions')
  })

  it('renders NO phone/email/contact labels when those fields are empty', () => {
    expect(html).not.toContain('Phone: ')
    expect(html).not.toContain('Email: ')
    expect(html).not.toContain('Contact: ')
    expect(html).not.toContain('NTN / STRN: ')
  })

  it('still prints the shop name and the grand total', () => {
    expect(html).toContain('Tiny Shop')
    expect(html).toContain(formatMoney(437_388, { symbol: 'Rs' }))
  })
})
