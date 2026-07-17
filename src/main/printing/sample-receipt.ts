import type { ReceiptData } from '@shared/receipt'

/**
 * A sample sale, for looking at the receipt before there is a sell screen to make one.
 *
 * DELIBERATELY AWKWARD. A receipt that only looks right with tidy data is a receipt that has not been
 * tested. So this one carries:
 *
 *   - a product name long enough to wrap (they are, in this shop)
 *   - an Urdu second name, which prints right-to-left
 *   - a weighed item (1.234 kg), to prove quantity is not assumed to be whole
 *   - a line discount and a cart discount
 *   - a MIXED tax cart: one item taxed at 17%, one tax-exempt — so the tax summary has to have rows
 *   - a split payment across cash and card, with change due
 *   - the legacy screen's real numbers (Rs 3,999.00 retail, Rs 2,185.0000 cost)
 */
export function sampleReceipt(isDuplicate = false): ReceiptData {
  return {
    shop: {
      name: 'Insha Store',
      address: 'Shop 12, Main Bazaar, Lahore',
      phone: '0300-1234567',
      taxNumber: '1234567-8'
    },

    invoiceNo: 'INV-2026-000142',
    at: new Date('2026-07-15T18:42:00').toISOString(),
    cashierName: 'Sara',
    customerName: 'Ali Raza',

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

    payments: [
      { method: 'Cash', amount: 300_000 },
      { method: 'Card', amount: 150_000 }
    ],
    changeDue: 12_612,

    currencySymbol: 'Rs',
    // A Pakistani shop, like the currency above — so the preview shows the dates a real shop sees.
    country: 'PK',
    isDuplicate,

    pointsEarned: 43,
    pointsBalance: 1_286,

    footer: 'Goods once sold are returnable within 7 days with this receipt.'
  }
}
