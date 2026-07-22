/**
 * THE PRODUCT NAME — the software's own name, shown in the window title, the login and activation
 * screens, the header, and as the "creator" stamped into exported spreadsheets and PDFs.
 *
 * This is NOT the shop's name. The SHOP's name, address and receipt footer are the shopkeeper's own,
 * editable in Settings (`shop.name`, `shop.address`, `shop.receiptFooter`) and printed on their
 * receipts. This constant is OUR name — the vendor's — and it changes only when the vendor renames
 * the product.
 *
 * DISPLAY ONLY. It is deliberately decoupled from `appId` and the userData folder name, which stay
 * `com.insha.pos` / "Insha POS" so that a machine already carrying a database keeps finding it. The
 * folder a shop's money lives in is not renamed lightly — that is a data-migration, not a rebrand
 * (see electron-builder.yml, where appId and the data path are intentionally left unchanged).
 */
export const APP_NAME = 'Malgary Labs POS'

/** The vendor, for the "made by" line. Used where the full product name would be redundant. */
export const VENDOR_NAME = 'Malgary Labs'
