import type { QuotationData } from '@shared/sales'

/**
 * A sample quotation, for looking at the document before shipping it — and for the tests.
 *
 * AWKWARD ON PURPOSE, exactly as sampleReceipt() is: a name long enough to wrap, an Urdu second name,
 * a weighed item at 1.234 kg, a line discount AND a cart discount, and a MIXED tax cart so the tax
 * summary has to grow rows. A document that only looks right with tidy data has not been tested.
 *
 * The figures are sampleReceipt()'s own, minus everything a quote does not have (no invoice number, no
 * payments, no change, no points). Same cart, same money — so a quote and the sale it becomes can be
 * held side by side and must read identically down to the paisa.
 */
export function sampleQuotation(overrides: Partial<QuotationData> = {}): QuotationData {
  return {
    shop: {
      name: 'Insha Store',
      address: 'Shop 12, Main Bazaar, Lahore',
      phone: '0300-1234567',
      taxNumber: '1234567-8'
    },

    // The DOCUMENT id — NOT an invoice number. A quote has none, by design.
    quoteId: 142,
    at: new Date('2026-07-15T18:42:00').toISOString(),
    cashierName: 'Sara',
    customerName: 'Ali Raza',

    validUntil: '2026-07-22',
    isExpired: false,

    lines: [
      {
        // Long name — the wrap test. This is a normal length for this shop.
        name: 'YoPod Tune Wireless Earbuds YOLO Bluetooth 5.3 Black',
        nameOtherLang: 'یو پوڈ ٹیون وائرلیس ائیر بڈز',
        qtyM: 1_000, // 1 pc
        unitPrice: 399_900, // Rs 3,999.00
        lineDiscount: 0,
        net: 341_795,
        taxRateBp: 1700,
        taxAmount: 58_105,
        gross: 399_900,
        uom: 'pcs'
      },
      {
        // A weighed item. 1.234 kg — quantity is thousandths, and it must print as 1.234, not 1.
        name: 'Basmati Rice (loose)',
        nameOtherLang: 'باسمتی چاول',
        qtyM: 1_234,
        unitPrice: 32_000, // Rs 320.00 / kg
        lineDiscount: 1_000, // Rs 10 off
        net: 38_488,
        taxRateBp: 0, // tax-exempt — so the tax summary needs TWO rows
        taxAmount: 0,
        gross: 38_488,
        uom: 'kg'
      },
      {
        name: 'Carrier bag',
        qtyM: 2_000,
        unitPrice: 500,
        lineDiscount: 0,
        net: 855,
        taxRateBp: 1700,
        taxAmount: 145,
        gross: 1_000,
        uom: 'pcs'
      }
    ],

    subtotalNet: 381_138,
    cartDiscount: 2_000, // Rs 20 off the whole cart
    taxTotal: 58_250,
    grandTotal: 437_388,

    taxSummary: [
      { taxRateBp: 1700, net: 342_650, tax: 58_250 },
      { taxRateBp: 0, net: 38_488, tax: 0 }
    ],

    currencySymbol: 'Rs',
    // A Pakistani shop, like the currency above — so the preview shows the dates a real shop sees.
    country: 'PK',

    footer: 'Prices are subject to stock availability.',

    ...overrides
  }
}
