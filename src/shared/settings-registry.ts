/**
 * THE SETTINGS REGISTRY — every knob in the app, declared exactly once.
 *
 * Owner's standing instruction: "if a number could differ between two shops, it is a SETTING, not a
 * constant." This is what makes that sustainable. A setting is declared HERE — key, type, default,
 * label, help, group, validation — and three things follow for free:
 *
 *   1. `DEFAULT_SETTINGS` is derived from it. No second list to forget to update.
 *   2. The Settings screen RENDERS ITSELF from it. Adding a knob is one entry, not another form field.
 *   3. The main process validates writes against it, so a tampered renderer cannot set
 *      `tax.defaultRateBp` to "banana" or a negative discount threshold.
 *
 * WHAT IS DELIBERATELY *NOT* HERE — and this is the important part:
 *
 *   money is integer 2dp · cost is 4dp · quantity is thousandths · no cash rounding ·
 *   stock is derived from movements · every journal balances
 *
 * Those are INVARIANTS, not preferences. Making them configurable would ship a switch labelled
 * "turn correctness off", and one day, on a slow afternoon, somebody would flip it.
 */

export type SettingType = 'text' | 'number' | 'money' | 'percent' | 'boolean' | 'select'

export type SettingDef = {
  key: string
  type: SettingType
  default: unknown
  label: string
  /** Written for a shopkeeper, not a programmer. Explain the CONSEQUENCE, not the mechanism. */
  help?: string
  group: SettingGroup
  /** For 'select'. Static options only — anything a shop might add to belongs in `lookups`. */
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  /** A loud warning shown beside the field. Use only where getting it wrong costs real money. */
  warning?: string
  /** Owner-only in the UI as well as in main. (Main is the real check; this is the courtesy.) */
  ownerOnly?: boolean
}

export const SETTING_GROUPS = [
  'shop',
  'ui',
  'currency',
  'tax',
  'invoice',
  'selling',
  'stock',
  'loyalty',
  'hardware',
  'security',
  'backup'
] as const

export type SettingGroup = (typeof SETTING_GROUPS)[number]

export const GROUP_LABEL: Record<SettingGroup, string> = {
  shop: 'Shop',
  ui: 'Appearance',
  currency: 'Currency',
  tax: 'Tax',
  invoice: 'Invoices & financial year',
  selling: 'Selling',
  stock: 'Stock',
  loyalty: 'Loyalty points',
  hardware: 'Printer, drawer & scanner',
  security: 'Security',
  backup: 'Backup'
}

export const SETTINGS: SettingDef[] = [
  // ── Shop ───────────────────────────────────────────────────────────────────
  { key: 'shop.name', type: 'text', default: 'My Shop', label: 'Shop name', group: 'shop' },
  { key: 'shop.address', type: 'text', default: '', label: 'Address', group: 'shop' },
  { key: 'shop.phone', type: 'text', default: '', label: 'Phone', group: 'shop' },
  {
    key: 'shop.taxNumber',
    type: 'text',
    default: '',
    label: 'Tax number (NTN / STRN)',
    help: 'Printed on the receipt.',
    group: 'shop'
  },
  {
    key: 'shop.country',
    type: 'select',
    default: 'PK',
    label: 'Country',
    help: 'Sets the default tax rate and the date format.',
    group: 'shop',
    options: [
      { value: 'PK', label: 'Pakistan' },
      { value: 'AE', label: 'United Arab Emirates' },
      { value: 'SA', label: 'Saudi Arabia' },
      { value: 'IN', label: 'India' },
      { value: 'GB', label: 'United Kingdom' },
      { value: 'US', label: 'United States' }
    ]
  },
  // The shop's own clock. A report asks "what did we take on the 8th?" and the answer must be the 8th
  // as the SHOP counts it, not as UTC does. A sale rung at 01:00 in Karachi is stored as 20:00 UTC the
  // day before (CLAUDE.md §4: `at` is always a full ISO UTC timestamp, and that storage is correct) —
  // so without this the takings of a shop trading past midnight land on the wrong day. It is a SETTING
  // and not the machine's clock: the till's OS zone can be wrong, and the books must not move if it is.
  {
    key: 'shop.timezone',
    type: 'select',
    default: 'Asia/Karachi',
    label: 'Time zone',
    help: 'The shop\'s local day. Reports count a day from midnight to midnight in this zone — set it to where the shop actually trades, or a late-night sale can be counted on the wrong day.',
    group: 'shop',
    options: [
      { value: 'Asia/Karachi', label: 'Pakistan (PKT)' },
      { value: 'Asia/Dubai', label: 'United Arab Emirates (GST)' },
      { value: 'Asia/Riyadh', label: 'Saudi Arabia (AST)' },
      { value: 'Asia/Kolkata', label: 'India (IST)' },
      { value: 'Europe/London', label: 'United Kingdom (GMT/BST)' },
      { value: 'America/New_York', label: 'United States — Eastern' },
      { value: 'America/Chicago', label: 'United States — Central' },
      { value: 'America/Denver', label: 'United States — Mountain' },
      { value: 'America/Los_Angeles', label: 'United States — Pacific' },
      { value: 'UTC', label: 'UTC' }
    ]
  },
  {
    key: 'shop.language',
    type: 'select',
    default: 'en',
    label: 'Language',
    group: 'shop',
    options: [
      { value: 'en', label: 'English' },
      { value: 'ur', label: 'اردو (Urdu)' }
    ]
  },

  // ── Appearance ─────────────────────────────────────────────────────────────
  // A shop counter can sit under fluorescent light at midday or a single bulb at night, and the two
  // want opposite screens. So it is a SETTING, not localStorage: it lives in the DB, it survives a
  // reinstall, and it is the same answer on the till in the morning as it was last night.
  {
    key: 'ui.colorScheme',
    type: 'select',
    default: 'auto',
    label: 'Appearance',
    help: 'Follow the computer means the screen turns dark when Windows does. The sun/moon button in the top bar switches light and dark right now, whatever is chosen here.',
    group: 'ui',
    options: [
      { value: 'auto', label: 'Follow the computer' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' }
    ]
  },

  // ── Currency ───────────────────────────────────────────────────────────────
  {
    key: 'currency.symbol',
    type: 'text',
    default: 'Rs',
    label: 'Symbol',
    help: 'Shown before every amount.',
    group: 'currency',
    warning:
      'Changing the currency changes the LABEL ONLY. It does NOT convert your saved prices — Rs 500 becomes $500, not $1.79. Set this once, before you enter your prices.'
  },
  { key: 'currency.code', type: 'text', default: 'PKR', label: 'Code', group: 'currency' },
  { key: 'currency.name', type: 'text', default: 'Pakistani Rupee', label: 'Name', group: 'currency' },

  // ── Tax ────────────────────────────────────────────────────────────────────
  { key: 'tax.enabled', type: 'boolean', default: true, label: 'Charge tax on sales', group: 'tax' },
  {
    key: 'tax.defaultRateBp',
    type: 'percent',
    default: 1700, // stored in BASIS POINTS. 17% = 1700. Never a float.
    label: 'Default tax rate',
    help: "Each item can override this. 17% is Pakistan's standard GST.",
    group: 'tax',
    min: 0,
    max: 10_000
  },
  {
    key: 'tax.defaultMode',
    type: 'select',
    default: 'exclusive',
    label: 'Prices are entered',
    help: 'Each item can be set the other way, and one sale may mix both.',
    group: 'tax',
    options: [
      { value: 'exclusive', label: 'Excluding tax (tax added at the till)' },
      { value: 'inclusive', label: 'Including tax (shelf price is what they pay)' }
    ]
  },

  // ── Invoice & financial year ───────────────────────────────────────────────
  { key: 'invoice.prefix', type: 'text', default: 'INV-', label: 'Invoice prefix', group: 'invoice' },
  {
    key: 'invoice.padding',
    type: 'number',
    default: 6,
    label: 'Number length',
    help: 'INV-000001',
    group: 'invoice',
    min: 1,
    max: 12
  },
  {
    key: 'invoice.includeYear',
    type: 'boolean',
    default: false,
    label: 'Show the year in the number',
    help: 'INV-2026-000123 instead of INV-000123. Turned on automatically when you restart numbering each year, so the numbers stay unique.',
    group: 'invoice'
  },
  {
    key: 'invoice.resetYearly',
    type: 'boolean',
    default: false,
    label: 'Restart numbering each year',
    help: 'Off: numbers run straight through, INV-000001, INV-000002, forever. On: they restart at 1 each January (and the year is shown, so last year’s numbers are never repeated). Either way they are sequential with no gaps, and a cancelled invoice keeps its number.',
    group: 'invoice'
  },
  {
    key: 'fiscal.yearStartMonth',
    type: 'select',
    default: 7,
    label: 'Financial year starts in',
    help: "Pakistan's tax year runs 1 July – 30 June.",
    group: 'invoice',
    options: [
      { value: '1', label: 'January' }, { value: '2', label: 'February' }, { value: '3', label: 'March' },
      { value: '4', label: 'April' }, { value: '5', label: 'May' }, { value: '6', label: 'June' },
      { value: '7', label: 'July' }, { value: '8', label: 'August' }, { value: '9', label: 'September' },
      { value: '10', label: 'October' }, { value: '11', label: 'November' }, { value: '12', label: 'December' }
    ]
  },

  // ── Selling ────────────────────────────────────────────────────────────────
  {
    key: 'selling.discountApprovalPercent',
    type: 'percent',
    default: 1000, // basis points. 10%.
    label: 'Discount needing a supervisor',
    help: 'A cashier may give a discount up to this much on their own. Above it, a supervisor must approve — and the approval is recorded with a name and a reason.',
    group: 'selling',
    min: 0,
    max: 10_000
  },
  {
    key: 'selling.discountApprovalAmount',
    type: 'money',
    default: 50_000, // Rs 500.00
    label: 'Or a discount above this amount',
    help: 'Whichever limit is reached first. Set to 0 to use the percentage only.',
    group: 'selling',
    min: 0
  },
  {
    key: 'selling.negativeStock',
    type: 'select',
    default: 'warn',
    label: 'Selling stock the shop does not have',
    help: 'The count is often simply wrong, and a cashier with a customer waiting cannot stop to fix it. "Warn and allow" is almost always right — the sale is flagged in every list it appears in.',
    group: 'selling',
    options: [
      { value: 'warn', label: 'Warn, allow the sale, and flag it' },
      { value: 'block', label: 'Block the sale' },
      { value: 'allow', label: 'Allow silently (not recommended)' }
    ]
  },
  {
    key: 'selling.priceOverrideRole',
    type: 'select',
    default: 'supervisor',
    label: 'Who may change a price at the till',
    group: 'selling',
    options: [
      { value: 'cashier', label: 'Cashier' },
      { value: 'supervisor', label: 'Supervisor' },
      { value: 'manager', label: 'Manager' },
      { value: 'owner', label: 'Owner only' }
    ]
  },
  {
    key: 'selling.wholesaleTierRole',
    type: 'select',
    default: 'supervisor',
    label: 'Who may switch to wholesale prices',
    group: 'selling',
    options: [
      { value: 'cashier', label: 'Cashier' },
      { value: 'supervisor', label: 'Supervisor' },
      { value: 'manager', label: 'Manager' },
      { value: 'owner', label: 'Owner only' }
    ]
  },
  {
    key: 'selling.requireCustomerForCredit',
    type: 'boolean',
    default: true,
    label: 'A credit sale (udhaar) must name a customer',
    help: 'Money owed with nobody attached to it is money you will not collect.',
    group: 'selling'
  },
  {
    key: 'selling.quoteValidDays',
    type: 'number',
    default: 7,
    label: 'A quotation is valid for (days)',
    help: 'How long a quoted price holds. The date is printed on the quotation and shown in the quote tray. Nothing is blocked when it lapses — an old quote is a conversation with the customer, not something the till should refuse.',
    group: 'selling',
    min: 1,
    max: 365
  },
  {
    key: 'selling.creditLimit',
    type: 'select',
    default: 'warn',
    label: 'When a customer is over their credit limit',
    group: 'selling',
    options: [
      { value: 'warn', label: 'Warn, but allow' },
      { value: 'block', label: 'Block the sale' },
      { value: 'ignore', label: 'Ignore the limit' }
    ]
  },

  // ── Stock ──────────────────────────────────────────────────────────────────
  {
    key: 'catalog.returnToListAfterSave',
    type: 'boolean',
    // Two shops genuinely want opposite things here, which is exactly what makes it a setting
    // (CLAUDE.md §4). Setting a shop up for the first time, you save an item and immediately want its
    // barcodes and its opening stock — so the form STAYS OPEN. Once the shop is running and you are
    // fixing one price on one item, staying on the form means an extra click every single time, and a
    // real shop asked for it to go back. Default false keeps the setup flow that already worked.
    default: false,
    label: 'Go back to the item list after saving an item',
    help: 'Off: the item stays open so you can add its barcodes and opening stock straight away.',
    group: 'stock'
  },
  {
    key: 'stock.nearExpiryDays',
    type: 'number',
    default: 30,
    label: 'Warn about expiry this many days ahead',
    group: 'stock',
    min: 1,
    max: 365
  },
  {
    key: 'stock.lowStockDefault',
    type: 'number',
    default: 5,
    label: 'Default re-order level for a new item',
    help: 'In whole units. Each item can set its own.',
    group: 'stock',
    min: 0
  },

  // ── Loyalty ────────────────────────────────────────────────────────────────
  { key: 'loyalty.enabled', type: 'boolean', default: false, label: 'Give loyalty points', group: 'loyalty' },
  {
    key: 'loyalty.pointsPerCurrencyUnit',
    type: 'number',
    default: 1,
    label: 'Points earned per rupee spent',
    group: 'loyalty',
    min: 0
  },
  {
    key: 'loyalty.redeemValueMinor',
    type: 'money',
    default: 100, // Rs 1.00 per point
    label: 'What one point is worth when redeemed',
    group: 'loyalty',
    min: 0
  },
  {
    key: 'loyalty.minPointsToRedeem',
    type: 'number',
    default: 100,
    label: 'Minimum points before they can be spent',
    group: 'loyalty',
    min: 0
  },

  // ── Hardware ───────────────────────────────────────────────────────────────
  {
    key: 'printer.receiptWidth',
    type: 'select',
    default: '80mm',
    label: 'Receipt paper width',
    group: 'hardware',
    options: [
      { value: '58mm', label: '58 mm' },
      { value: '80mm', label: '80 mm' }
    ]
  },
  { key: 'printer.name', type: 'text', default: '', label: 'Receipt printer', help: 'Leave blank to use the system default.', group: 'hardware' },
  { key: 'printer.copies', type: 'number', default: 1, label: 'Receipt copies', group: 'hardware', min: 1, max: 5 },
  { key: 'drawer.enabled', type: 'boolean', default: true, label: 'Open the cash drawer on a cash sale', group: 'hardware' },
  {
    key: 'drawer.kickCode',
    type: 'text',
    default: '27,112,0,25,250',
    label: 'Cash drawer kick code',
    help: 'The ESC/POS code your drawer expects. Only change this if the drawer does not open.',
    group: 'hardware'
  },
  {
    key: 'scanner.terminator',
    type: 'select',
    default: 'enter',
    label: 'Scanner sends, after each barcode',
    group: 'hardware',
    options: [
      { value: 'enter', label: 'Enter' },
      { value: 'tab', label: 'Tab' },
      { value: 'none', label: 'Nothing' }
    ]
  },
  { key: 'scanner.prefix', type: 'text', default: '', label: 'Scanner prefix to strip', group: 'hardware' },
  { key: 'scanner.suffix', type: 'text', default: '', label: 'Scanner suffix to strip', group: 'hardware' },
  {
    key: 'scanner.minLength',
    type: 'number',
    // 1, not 4. A real shop reported stock whose barcodes are THREE digits, and some are words — a
    // 4-character floor silently refused to scan a chunk of their catalogue, with no message that
    // explained why. The guard against a stray keypress being read as a scan matters less than the
    // till refusing goods that are physically on the shelf, so it is off by default and a shop that
    // wants it can raise the number.
    default: 1,
    label: 'Shortest barcode to accept',
    help: 'Stops a stray keypress being read as a scan. Set to 1 to accept short or word barcodes.',
    group: 'hardware',
    min: 1,
    max: 40
  },

  // ── Security ───────────────────────────────────────────────────────────────
  {
    key: 'security.autoLogoutMinutes',
    type: 'number',
    default: 0,
    label: 'Sign out after this many idle minutes',
    help: '0 = never. On a shared counter, a short timeout stops sales being rung up under someone else’s name.',
    group: 'security',
    min: 0,
    max: 480,
    ownerOnly: true
  },
  {
    key: 'security.pinLength',
    type: 'number',
    default: 4,
    label: 'PIN length for the quick cashier switch',
    group: 'security',
    min: 4,
    max: 8,
    ownerOnly: true
  },
  {
    key: 'security.minPasswordLength',
    type: 'number',
    default: 8,
    label: 'Shortest password allowed',
    group: 'security',
    min: 8,
    max: 32,
    ownerOnly: true
  },

  // ── Backup ─────────────────────────────────────────────────────────────────
  {
    key: 'backup.promptDaily',
    type: 'boolean',
    default: true,
    label: 'Remind me to back up',
    help: 'A backup on the same failing disk is not a backup. Save it to a USB drive.',
    group: 'backup'
  },
  {
    key: 'backup.remindAfterDays',
    type: 'number',
    default: 1,
    label: 'Remind me if there has been no backup for this many days',
    group: 'backup',
    min: 1,
    max: 30
  }
]

/** Fast lookup by key. */
export const SETTINGS_BY_KEY: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS.map((s) => [s.key, s])
)

/**
 * The defaults, DERIVED from the registry — there is no second hand-written list to fall out of step
 * with it. Anything not declared above (a remembered folder, a last-run timestamp) is app STATE, not
 * a setting, and lives in `RUNTIME_STATE_DEFAULTS`.
 */
export const REGISTRY_DEFAULTS: Record<string, unknown> = Object.fromEntries(
  SETTINGS.map((s) => [s.key, s.default])
)

/**
 * Values the app remembers but the shopkeeper never "sets". They are not knobs and must not appear
 * on the Settings screen.
 */
export const RUNTIME_STATE_DEFAULTS: Record<string, unknown> = {
  'backup.lastRunAt': null,
  'backup.directory': null
}

export const ALL_DEFAULTS: Record<string, unknown> = {
  ...REGISTRY_DEFAULTS,
  ...RUNTIME_STATE_DEFAULTS
}

/**
 * Validate a value against its declaration. Run in the MAIN process, because the renderer is not a
 * security boundary — a tampered one could otherwise set the tax rate to "banana", or a negative
 * discount threshold that makes every sale need a supervisor.
 */
export function validateSetting(key: string, value: unknown): { ok: true } | { ok: false; message: string } {
  const def = SETTINGS_BY_KEY[key]

  // Not in the registry: it is runtime state (a remembered folder), which the app sets, not the user.
  if (!def) {
    return key in RUNTIME_STATE_DEFAULTS
      ? { ok: true }
      : { ok: false, message: 'That setting does not exist.' }
  }

  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, message: `${def.label} must be on or off.` }

    case 'text':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, message: `${def.label} must be text.` }

    case 'select': {
      const allowed = (def.options ?? []).map((o) => o.value)
      return allowed.includes(String(value))
        ? { ok: true }
        : { ok: false, message: `Please choose one of the options for ${def.label}.` }
    }

    case 'number':
    case 'money':
    case 'percent': {
      // Integers only, everywhere. A percent is BASIS POINTS (17% = 1700); money is MINOR UNITS.
      // A float here is how a rate quietly becomes 16.999999999999998%.
      if (!Number.isSafeInteger(value)) {
        return { ok: false, message: `${def.label} must be a whole number.` }
      }
      const n = value as number
      if (def.min != null && n < def.min) {
        return { ok: false, message: `${def.label} cannot be less than ${def.min}.` }
      }
      if (def.max != null && n > def.max) {
        return { ok: false, message: `${def.label} cannot be more than ${def.max}.` }
      }
      return { ok: true }
    }
  }
}
