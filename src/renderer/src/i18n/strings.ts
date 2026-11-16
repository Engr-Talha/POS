/**
 * UI STRINGS — English + Urdu.
 *
 * `shop.language` in Settings picks which pack is active. The till is for a non-technical cashier:
 * every label they stare at all day lives here. Product NAMES stay as the shop typed them (often
 * already bilingual via name_other_lang); this file is the chrome around them.
 *
 * Adding a string: put it in BOTH packs, same key. Missing Urdu falls back to English at runtime.
 */

export type Lang = 'en' | 'ur'

export type StringKey = keyof typeof EN

const EN = {
  // ── Common ────────────────────────────────────────────────────────────────
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.search': 'Search',
  'common.loading': 'Loading…',
  'common.error': 'Something went wrong',
  'common.saved': 'Saved',
  'common.back': 'Back',
  'common.add': 'Add',
  'common.signOut': 'Sign out',
  'common.readOnly': 'READ-ONLY',
  'common.version': 'v{version}',
  'common.language': 'Language',
  'common.noMatch': 'No items match “{term}”.',
  'common.typeToSearch': 'Type a name, stock code or barcode…',
  'common.onHand': '{qty} on hand',
  'common.pieces': 'Pieces',

  // ── Login ─────────────────────────────────────────────────────────────────
  'login.username': 'Username',
  'login.password': 'Password',
  'login.signIn': 'Sign in',

  // ── Nav ───────────────────────────────────────────────────────────────────
  'nav.sell': 'Sell',
  'nav.overview': 'Overview',
  'nav.products': 'Items',
  'nav.stock': 'Stock',
  'nav.stockTake': 'Stock take',
  'nav.sales': 'Sales',
  'nav.returns': 'Returns',
  'nav.purchases': 'Purchases',
  'nav.expenses': 'Expenses',
  'nav.promotions': 'Offers',
  'nav.shifts': 'Shift',
  'nav.opening': 'Opening setup',
  'nav.books': 'Books',
  'nav.reports': 'Reports',
  'nav.customers': 'Customers',
  'nav.suppliers': 'Suppliers',
  'nav.lists': 'Manage lists',
  'nav.users': 'Staff',
  'nav.settings': 'Settings',

  // ── Sell ──────────────────────────────────────────────────────────────────
  'sell.scanPlaceholder': 'Scan barcode or type item code / name',
  'sell.scanReadonly': 'The licence has expired — the till is read-only',
  'sell.qty': 'Qty',
  'sell.discount': 'Discount',
  'sell.changePrice': 'Change price',
  'sell.hold': 'Hold',
  'sell.resume': 'Resume',
  'sell.customer': 'Customer',
  'sell.pay': 'Pay',
  'sell.saleComplete': 'Sale complete',
  'sell.changeDue': 'Change due',
  'sell.paidInFull': 'Paid in full — no change',
  'sell.printAgain': 'Print again',
  'sell.nextCustomer': 'Next customer',
  'sell.orScanNext': 'Or just scan the next item — this will clear itself.',
  'sell.wrongBill': 'Wrong bill — fix it',
  'sell.wrongBillHint': 'Voids this sale and puts the lines back on the till to correct.',
  'sell.parkedCarts': 'Parked carts',
  'sell.held': 'Held',
  'sell.quotations': 'Quotations',
  'sell.nothingHeld': 'Nothing is on hold.',
  'sell.noQuotes': 'No quotations saved.',
  'sell.resumeCart': 'Resume',
  'sell.pressEnterToPick': 'Enter picks the highlighted item (first match by default)',

  // ── Products ──────────────────────────────────────────────────────────────
  'products.title': 'Items',
  'products.new': 'New item',
  'products.searchPlaceholder': 'Search by name, code, shelf or barcode…',

  // ── Settings ──────────────────────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.intro':
    'Changes here are recorded in the audit log — currency, tax and discount limits all move money.',
  'settings.licence': 'Licence',
  'settings.periods': 'Close the month',
  'settings.guide': 'How to use',
  'settings.guide.intro':
    'Owner-only guide to running this POS — from first setup to backup. Switch English / اردو above.',
  'settings.updates': 'Updates',
  'settings.updates.intro':
    'The app checks for a new version quietly in the background. It never restarts mid-sale — a download installs the next time you quit.',
  'settings.updates.check': 'Check for updates',
  'settings.updates.checking': 'Checking…',
  'settings.updates.idle': 'Not checked yet',
  'settings.updates.upToDate': 'You are on the latest version',
  'settings.updates.available': 'Version {version} is available — downloading…',
  'settings.updates.downloading': 'Downloading… {percent}%',
  'settings.updates.ready':
    'Version {version} is ready. It will install silently when you quit the app.',
  'settings.updates.error':
    'Could not reach the update server. That is normal when the shop is offline — try again when you have internet.',
  'settings.updates.headerReady': 'Update ready — installs when you quit',

  // ── Roles (short) ─────────────────────────────────────────────────────────
  'role.cashier': 'Cashier',
  'role.supervisor': 'Supervisor',
  'role.manager': 'Manager',
  'role.owner': 'Owner'
} as const

const UR: Record<StringKey, string> = {
  'common.save': 'محفوظ کریں',
  'common.cancel': 'منسوخ',
  'common.close': 'بند کریں',
  'common.search': 'تلاش',
  'common.loading': 'لوڈ ہو رہا ہے…',
  'common.error': 'کچھ غلط ہو گیا',
  'common.saved': 'محفوظ ہو گیا',
  'common.back': 'واپس',
  'common.add': 'شامل کریں',
  'common.signOut': 'سائن آؤٹ',
  'common.readOnly': 'صرف پڑھنے کے لیے',
  'common.version': 'v{version}',
  'common.language': 'زبان',
  'common.noMatch': '“{term}” سے کوئی چیز نہیں ملی۔',
  'common.typeToSearch': 'نام، کوڈ یا بارکوڈ لکھیں…',
  'common.onHand': 'موجودہ {qty}',
  'common.pieces': 'عدد',

  'login.username': 'صارف نام',
  'login.password': 'پاس ورڈ',
  'login.signIn': 'سائن اِن',

  'nav.sell': 'فروخت',
  'nav.overview': 'جائزہ',
  'nav.products': 'اشیاء',
  'nav.stock': 'اسٹاک',
  'nav.stockTake': 'اسٹاک گنتی',
  'nav.sales': 'سیلز',
  'nav.returns': 'واپسی',
  'nav.purchases': 'خریداری',
  'nav.expenses': 'اخراجات',
  'nav.promotions': 'آفرز',
  'nav.shifts': 'شفٹ',
  'nav.opening': 'ابتدائی سیٹ اپ',
  'nav.books': 'کھاتہ',
  'nav.reports': 'رپورٹس',
  'nav.customers': 'گاہک',
  'nav.suppliers': 'سپلائر',
  'nav.lists': 'فہرستیں',
  'nav.users': 'عملہ',
  'nav.settings': 'ترتیبات',

  'sell.scanPlaceholder': 'بارکوڈ اسکین کریں یا نام / کوڈ لکھیں',
  'sell.scanReadonly': 'لائسنس ختم — ٹِل صرف دیکھنے کے لیے ہے',
  'sell.qty': 'مقدار',
  'sell.discount': 'رعایت',
  'sell.changePrice': 'قیمت بدلیں',
  'sell.hold': 'ہولڈ',
  'sell.resume': 'دوبارہ کھولیں',
  'sell.customer': 'گاہک',
  'sell.pay': 'ادائیگی',
  'sell.saleComplete': 'فروخت مکمل',
  'sell.changeDue': 'واپسی رقم',
  'sell.paidInFull': 'مکمل ادا — کوئی واپسی نہیں',
  'sell.printAgain': 'دوبارہ پرنٹ',
  'sell.nextCustomer': 'اگلا گاہک',
  'sell.orScanNext': 'یا اگلی چیز اسکین کریں — یہ خود صاف ہو جائے گا۔',
  'sell.wrongBill': 'غلط بل — درست کریں',
  'sell.wrongBillHint': 'یہ فروخت منسوخ کر کے لائنز ٹِل پر واپس لاتا ہے تاکہ درست کی جا سکیں۔',
  'sell.parkedCarts': 'رکھی ہوئی گاڑیاں',
  'sell.held': 'ہولڈ',
  'sell.quotations': 'کوٹیشن',
  'sell.nothingHeld': 'کچھ ہولڈ پر نہیں ہے۔',
  'sell.noQuotes': 'کوئی کوٹیشن نہیں۔',
  'sell.resumeCart': 'دوبارہ کھولیں',
  'sell.pressEnterToPick': 'Enter پہلی / منتخب چیز چنتا ہے',

  'products.title': 'اشیاء',
  'products.new': 'نئی چیز',
  'products.searchPlaceholder': 'نام، کوڈ، شیلف یا بارکوڈ سے تلاش…',

  'settings.title': 'ترتیبات',
  'settings.intro':
    'یہاں کی تبدیلیاں آڈٹ لاگ میں محفوظ ہوتی ہیں — کرنسی، ٹیکس اور رعایت کی حد سب پیسے کو چھوتی ہیں۔',
  'settings.licence': 'لائسنس',
  'settings.periods': 'مہینہ بند کریں',
  'settings.guide': 'استعمال گائیڈ',
  'settings.guide.intro':
    'صرف مالک کے لیے — اس POS کو چلانے کی مکمل گائیڈ۔ اوپر English / اردو بدلیں۔',
  'settings.updates': 'اپڈیٹس',
  'settings.updates.intro':
    'ایپ نیا ورژن خاموشی سے چیک کرتی ہے۔ فروخت کے دوران ری سٹارٹ نہیں ہوتا — ڈاؤن لوڈ بند کرتے وقت انسٹال ہوتا ہے۔',
  'settings.updates.check': 'اپڈیٹ چیک کریں',
  'settings.updates.checking': 'چیک ہو رہا ہے…',
  'settings.updates.idle': 'ابھی چیک نہیں ہوا',
  'settings.updates.upToDate': 'آپ تازہ ترین ورژن پر ہیں',
  'settings.updates.available': 'ورژن {version} دستیاب ہے — ڈاؤن لوڈ ہو رہا ہے…',
  'settings.updates.downloading': 'ڈاؤن لوڈ… {percent}%',
  'settings.updates.ready':
    'ورژن {version} تیار ہے۔ ایپ بند کرتے وقت خاموشی سے انسٹال ہو جائے گا۔',
  'settings.updates.error':
    'اپڈیٹ سرور تک نہیں پہنچ سکے۔ آف لائن دکان کے لیے یہ عام ہے — انٹرنیٹ پر دوبارہ کوشش کریں۔',
  'settings.updates.headerReady': 'اپڈیٹ تیار — بند کرنے پر انسٹال',

  'role.cashier': 'کیشیئر',
  'role.supervisor': 'سپروائیذر',
  'role.manager': 'منیجر',
  'role.owner': 'مالک'
}

export const STRINGS: Record<Lang, Record<StringKey, string>> = {
  en: EN,
  ur: UR
}

export function formatString(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] === undefined || vars[key] === null ? `{${key}}` : String(vars[key])
  )
}
