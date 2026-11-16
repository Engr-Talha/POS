/**
 * OWNER / ADMIN USAGE GUIDE — English + Urdu.
 *
 * Shown only to the Owner (Settings → How to use). Written for a non-technical shopkeeper:
 * buttons and scans, never terminal commands. Keep both languages in lockstep by section id.
 */

import type { Lang } from './strings'

export type GuideSectionId =
  | 'start'
  | 'roles'
  | 'products'
  | 'stockIn'
  | 'sell'
  | 'fixSale'
  | 'stock'
  | 'parties'
  | 'reports'
  | 'backup'
  | 'settings'

export type GuideSection = {
  id: GuideSectionId
  title: string
  steps: string[]
}

const EN: GuideSection[] = [
  {
    id: 'start',
    title: '1. First day — get the shop ready',
    steps: [
      'Install the app once (the .exe). Open it from the desktop icon — no commands.',
      'Activate with the licence key we sent you (Settings → Licence), then create the Owner account.',
      'Go to Opening setup: set the opening date, count till cash, and enter opening stock for items you already have.',
      'Add your suppliers and payment methods under Manage lists if anything is missing.',
      'Make a Backup folder on a USB (Overview or Settings → Backup). Do this before a busy day.'
    ]
  },
  {
    id: 'roles',
    title: '2. Staff and who can do what',
    steps: [
      'Staff (Users) is Owner-only. Add each person with a username, password, and optional PIN.',
      'Cashier — sells, opens/closes their shift, looks up loyalty points.',
      'Supervisor — voids a sale, refunds, big discounts, price changes at the till (when Settings require it).',
      'Manager — products, purchases, stock, expenses, reports, offers, lists.',
      'Owner — everything above, plus Settings, licence, close the month, restore a backup.',
      'Hiding a button is only a courtesy. Main always checks the role — a cashier cannot buy stock or change users.'
    ]
  },
  {
    id: 'products',
    title: '3. Items (products) — add, edit, scan to open',
    steps: [
      'Open Items. Press New item. Fill stock code, name, selling unit (Pieces is the default), prices and tax.',
      'On a new item you can scan the barcode into the Barcode field before you create it.',
      'On the Items list: put the cursor in Search and scan a barcode — the item opens with prices, tax and stock filled.',
      'While editing an item: use “Scan to open another item” at the top to jump to the next tin without going back to the list.',
      'Unit cost on edit is read-only — it is the average of what you paid. Change it with a purchase or a stock adjustment, not by typing over it.',
      'A pack (carton) with no selling price is purchase-only: scanning it at the till is refused; use it when receiving goods.',
      'Retire an item when you stop selling it — it leaves the lists and will not scan at the till.'
    ]
  },
  {
    id: 'stockIn',
    title: '4. Buying stock (Purchases) and opening qty',
    steps: [
      'Purchases → New bill. Choose the supplier, then scan or search each item.',
      'Picking an item fills quantity (1), cost, and selling prices — change the qty and cost to match the supplier bill.',
      'Enter what you paid (or leave unpaid for credit). Record the bill — stock rises and the average cost updates.',
      'For day-one stock without a supplier bill: open the item → Change stock → Opening, with quantity and cost.',
      'Wrong purchase bill: Correct this invoice (Manager+) — it cancels with a reason and you re-enter the right one. Nothing is erased.'
    ]
  },
  {
    id: 'sell',
    title: '5. Selling at the till',
    steps: [
      'Open Shift first (Shift screen) so the Z-report knows whose drawer it is.',
      'Sell screen: scan barcodes. Hands stay on the scanner and keyboard — quantity, pay, hold are all keys.',
      'Type a name and press Enter to pick the first match. F8 = open item (misc) when there is no catalogue row.',
      'Choose the customer for credit / loyalty. Pay with cash, card, or split — take the change the screen shows.',
      'Hold parks a cart; Resume brings it back. Quotations can be saved and printed without taking stock.',
      'If the licence expires the till goes read-only: you can still view and back up, but not make new sales until renewed.'
    ]
  },
  {
    id: 'fixSale',
    title: '6. Wrong bill, returns, discounts',
    steps: [
      'Wrong bill on the till: use Wrong bill / void — needs Supervisor or higher (and Settings → who may correct).',
      'Sales history → Correct this invoice: voids the wrong sale and puts the lines back on Sell to re-ring.',
      'Customer return: Returns screen — pick the sale, choose lines and qty, restock or mark damaged, take the refund.',
      'Big discounts and price overrides need the role set in Settings (often Supervisor PIN at the till).',
      'Every void, refund and override is in the audit log with a name and role.'
    ]
  },
  {
    id: 'stock',
    title: '7. Stock screen and stock take',
    steps: [
      'Stock → levels: scan a barcode to open Adjust for that item (add/remove with a reason).',
      'Low stock lists everything at or below its re-order level — take that list to the supplier.',
      'Near expiry shows batch-tracked items that are close to their date.',
      'Stock take: open a sheet, scan each shelf item, type what you see. Pack barcodes count in packs (10 cartons of 24 = 240 pieces).',
      'Apply the sheet when finished — variances post as adjustments with your name. Cancel abandons the sheet.'
    ]
  },
  {
    id: 'parties',
    title: '8. Customers, suppliers, offers, expenses',
    steps: [
      'Customers: add people, set credit limits, see what they owe. Paying from the ledger marks invoices paid.',
      'Suppliers: add them, see what you owe, record a payment against their balance.',
      'Offers (promotions): Manager sets rules (percent off, fixed off, buy X get Y). Cashiers can see why a line got cheaper.',
      'Expenses: book shop costs (rent, utilities) with a category from Manage lists.'
    ]
  },
  {
    id: 'reports',
    title: '9. Reports and the books',
    steps: [
      'Reports: sales, profit, tax, leakage (discounts/voids), item-wise — export Excel when you need a file.',
      'Books: trial balance and accounts. After every sale and purchase the books must balance — that is built in.',
      'Close the month (Settings → Close the month) when you have finished reporting — Owner only. Unlock is also Owner only.'
    ]
  },
  {
    id: 'backup',
    title: '10. Backup — protect the shop’s money',
    steps: [
      'Overview or Settings → Backup: one click writes a verified copy of the database.',
      'Put backups on a USB, not only on the same PC. An unchecked backup on a dying disk is not a backup.',
      'Restore overwrites the shop data — Owner only, and you should only restore from a backup you trust.',
      'The app may remind you when a backup is overdue (Backup reminder in Settings).'
    ]
  },
  {
    id: 'settings',
    title: '11. Settings, language, updates, licence',
    steps: [
      'Settings change labels and shop rules (tax default, discount threshold, scanner min length, language). They do not convert old money.',
      'Language: English or Urdu (and right-to-left for Urdu) for the chrome around the till.',
      'Updates: Settings → Updates. The app downloads quietly and installs when you quit — never mid-sale.',
      'Licence: renew under Settings → Licence. After expiry you stay open in read-only until you paste a new key.',
      'This guide is Owner-only so cashiers are not distracted — train them on Sell, Shift, and Returns.'
    ]
  }
]

const UR: GuideSection[] = [
  {
    id: 'start',
    title: '۱. پہلا دن — دکان تیار کریں',
    steps: [
      'ایپ ایک بار انسٹال کریں (.exe)۔ ڈیسک ٹاپ آئیکن سے کھولیں — کوئی کمانڈ نہیں۔',
      'جو لائسنس کلید بھیجی گئی ہے وہ Settings → Licence میں لگائیں، پھر مالک (Owner) اکاؤنٹ بنائیں۔',
      'Opening setup کھولیں: ابتدائی تاریخ، کیش، اور جو مال پہلے سے ہے اس کا opening stock لکھیں۔',
      'سپلائر اور ادائیگی کے طریقے Manage lists میں چیک کریں؛ کچھ کم ہو تو شامل کریں۔',
      'Backup فولڈر USB پر سیٹ کریں (Overview یا Settings → Backup)۔ مصروف دن سے پہلے یہ کر لیں۔'
    ]
  },
  {
    id: 'roles',
    title: '۲. عملہ اور اجازتیں',
    steps: [
      'Staff (Users) صرف مالک کے لیے ہے۔ ہر شخص کا یوزرنیم، پاس ورڈ اور اختیاری PIN بنائیں۔',
      'کیشیئر — فروخت، اپنی شفٹ کھولنا/بند کرنا، لائلٹی پوائنٹس دیکھنا۔',
      'سپروائیذر — بل منسوخ، واپسی، بڑی رعایت، ٹِل پر قیمت بدلنا (جب Settings میں لکھا ہو)۔',
      'منیجر — اشیاء، خریداری، اسٹاک، اخراجات، رپورٹس، آفرز، فہرستیں۔',
      'مالک — اوپر سب کچھ، نیز Settings، لائسنس، مہینہ بند، بیک اپ بحال۔',
      'بٹن چھپانا صرف سہولت ہے۔ اصل چیک مین پروسیس میں ہے — کیشیئر اسٹاک نہیں خرید سکتا۔'
    ]
  },
  {
    id: 'products',
    title: '۳. اشیاء — شامل کرنا، ترمیم، اسکین سے کھولنا',
    steps: [
      'Items کھولیں۔ New item دبائیں۔ اسٹاک کوڈ، نام، فروخت کی اکائی (Pieces ڈیفالٹ)، قیمتیں اور ٹیکس بھریں۔',
      'نئی چیز بناتے وقت Barcode والے خانے میں اسکینر سے بارکوڈ ڈال سکتے ہیں۔',
      'Items کی فہرست میں Search پر کرسر رکھ کر بارکوڈ اسکین کریں — چیز کھل جائے گی، قیمت/ٹیکس/اسٹاک بھرا ہوا۔',
      'ترمیم کے دوران اوپر “Scan to open another item” سے اگلی چیز کھولیں، فہرست پر واپس جانے کی ضرورت نہیں۔',
      'Edit پر یونٹ لاگت صرف دیکھنے کے لیے ہے — یہ ادائیگی کی اوسط ہے۔ خریداری یا اسٹاک ایڈجسٹ سے بدلیں، ٹائپ کر کے نہیں۔',
      'کارٹن جس کی فروخت قیمت نہ ہو purchase-only ہے: ٹِل پر اسکین نہیں ہوگا؛ وصولی پر استعمال کریں۔',
      'جب چیز بند کرنی ہو تو retire کریں — فہرستوں سے ہٹ جائے گی اور ٹِل پر اسکین نہیں ہوگی۔'
    ]
  },
  {
    id: 'stockIn',
    title: '۴. خریداری اور ابتدائی مقدار',
    steps: [
      'Purchases → New bill۔ سپلائر چنیں، پھر ہر چیز اسکین یا تلاش کریں۔',
      'چیز چنتے ہی مقدار (۱)، لاگت اور فروخت قیمتیں بھر جاتی ہیں — بل کے مطابق درست کر لیں۔',
      'ادائیگی درج کریں (یا ادھار چھوڑیں)۔ Record دبائیں — اسٹاک بڑھے گا اور اوسط لاگت اپڈیٹ ہوگی۔',
      'بغیر بل کے ابتدائی مال: چیز کھولیں → Change stock → Opening، مقدار اور لاگت کے ساتھ۔',
      'غلط خریداری بل: Correct this invoice (منیجر+) — وجہ کے ساتھ منسوخ، پھر درست بل دوبارہ۔ کچھ مٹتا نہیں۔'
    ]
  },
  {
    id: 'sell',
    title: '۵. ٹِل پر فروخت',
    steps: [
      'پہلے Shift کھولیں تاکہ Z-رپورٹ جانے کس کی ڈراور ہے۔',
      'Sell: بارکوڈ اسکین کریں۔ ہاتھ اسکینر/کی بورڈ پر رہیں — مقدار، ادائیگی، ہولڈ سب کیز سے۔',
      'نام لکھ کر Enter — پہلی چیز چن لی جاتی ہے۔ F8 = کھلی چیز (misc) جب کیٹلاگ میں نہ ہو۔',
      'ادھار/لائلٹی کے لیے گاہک چنیں۔ نقد، کارڈ یا تقسیم سے ادا کریں — سکرین پر نظر آنے والی واپسی دیں۔',
      'Hold گاڑی روکتا ہے؛ Resume واپس لاتا ہے۔ کوٹیشن پرنٹ ہو سکتی ہے بغیر اسٹاک گھٹائے۔',
      'لائسنس ختم ہو تو ٹِل read-only: دیکھ اور بیک اپ چل سکتا ہے، نئی فروخت نہیں جب تک تجدید نہ ہو۔'
    ]
  },
  {
    id: 'fixSale',
    title: '۶. غلط بل، واپسی، رعایت',
    steps: [
      'ٹِل پر غلط بل: Wrong bill / void — سپروائیذر یا اوپر (اور Settings میں اصلاح کی اجازت)۔',
      'Sales history → Correct this invoice: غلط فروخت منسوخ، لائنز Sell پر واپس تاکہ دوبارہ لگائیں۔',
      'گاہک واپسی: Returns — فروخت چنیں، لائن/مقدار، واپس شیلف یا خراب، رقم واپس۔',
      'بڑی رعایت اور قیمت تبدیل Settings میں جو رول ہے اس کی ضرورت ( اکثر سپروائیذر PIN)۔',
      'ہر void، واپسی اور override آڈٹ لاگ میں نام اور رول کے ساتھ محفوظ ہے۔'
    ]
  },
  {
    id: 'stock',
    title: '۷. اسٹاک اور اسٹاک گنتی',
    steps: [
      'Stock → levels: بارکوڈ اسکین کر کے اس چیز کا Adjust کھولیں (وجہ کے ساتھ اضافہ/کمی)۔',
      'Low stock: جو چیزیں re-order لیول پر یا نیچے ہیں — سپلائر کے لیے فہرست۔',
      'Near expiry: بیچ والی چیزیں جن کی تاریخ قریب ہے۔',
      'Stock take: شیٹ کھولیں، شیلف اسکین کریں، جو نظر آئے لکھیں۔ پیک بارکوڈ پیک میں گنتا ہے (۱۰ کارٹن × ۲۴ = ۲۴۰)۔',
      'ختم ہونے پر Apply — فرق ایڈجسٹمنٹ بن کر نام کے ساتھ لگتا ہے۔ Cancel شیٹ چھوڑ دیتا ہے۔'
    ]
  },
  {
    id: 'parties',
    title: '۸. گاہک، سپلائر، آفرز، اخراجات',
    steps: [
      'Customers: لوگ شامل کریں، کریڈٹ حد، بقایا دیکھیں۔ لیجر سے ادائیگی انوائس کو ادا شدہ کرتی ہے۔',
      'Suppliers: شامل کریں، آپ کا بقایا دیکھیں، ادائیگی درج کریں۔',
      'Offers: منیجر قواعد لگاتا ہے؛ کیشیئر دیکھ سکتا ہے لائن سستی کیوں ہوئی۔',
      'Expenses: کرایہ وغیرہ Manage lists کی کیٹگری کے ساتھ درج کریں۔'
    ]
  },
  {
    id: 'reports',
    title: '۹. رپورٹس اور کھاتہ',
    steps: [
      'Reports: سیلز، منافع، ٹیکس، لییکج (رعایت/void)، آئٹم وائز — Excel ایکسپورٹ دستیاب۔',
      'Books: ٹرائل بیلنس۔ ہر فروخت/خریداری کے بعد کھاتہ متوازن رہتا ہے — یہ بنایا گیا ہے۔',
      'مہینہ بند (Settings → Close the month) رپورٹ کے بعد — صرف مالک۔ کھولنا بھی صرف مالک۔'
    ]
  },
  {
    id: 'backup',
    title: '۱۰. بیک اپ — دکان کے پیسے محفوظ',
    steps: [
      'Overview یا Settings → Backup: ایک کلک پر تصدیق شدہ کاپی بنتی ہے۔',
      'بیک اپ USB پر رکھیں، صرف اسی کمپیوٹر پر نہیں۔ خراب ڈسک پر بیک اپ بیک اپ نہیں۔',
      'Restore پورا ڈیٹا بدل دیتا ہے — صرف مالک، اور صرف قابلِ اعتماد بیک اپ سے۔',
      'ایپ یاد دلا سکتی ہے جب بیک اپ دیر سے ہو (Settings میں reminder)۔'
    ]
  },
  {
    id: 'settings',
    title: '۱۱. Settings، زبان، اپڈیٹ، لائسنس',
    steps: [
      'Settings لیبل اور قواعد بدلتے ہیں (ٹیکس، رعایت حد، اسکینر، زبان)۔ پرانی رقم تبدیل نہیں کرتے۔',
      'زبان: انگریزی یا اردو (اردو کے لیے دائیں سے بائیں)۔',
      'Updates: خاموش ڈاؤن لوڈ؛ بند کرتے وقت انسٹال — فروخت کے بیچ میں نہیں۔',
      'Licence: Settings → Licence سے تجدید۔ ختم ہونے پر read-only رہیں جب تک نئی کلید نہ لگے۔',
      'یہ گائیڈ صرف مالک کو دکھتی ہے — کیشیئر کو Sell، Shift اور Returns سکھائیں۔'
    ]
  }
]

export const USAGE_GUIDE: Record<Lang, GuideSection[]> = {
  en: EN,
  ur: UR
}
