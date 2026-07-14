/**
 * DEV ONLY — furnish the dev database with a shop that can actually be sold from.
 *
 * Maintainer script. NOT shipped in the installer. It uses the REAL services, so whatever it puts in
 * the books is posted exactly as the app would post it — the trial balance still balances afterwards.
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/dev-seed-till.ts
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/main/db'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'
import { hashSecret } from '../src/main/security/password'
import * as catalog from '../src/main/services/catalog'
import * as stock from '../src/main/services/stock'
import * as ledger from '../src/main/services/ledger'
import { ONE_UNIT } from '../src/shared/qty'
import type { User } from '../src/shared/types'

const DB_PATH = join(homedir(), 'Library/Application Support/Insha POS/pos.db')

const db = openDatabase(DB_PATH)

const { applied, alreadyAt } = runMigrations(db)
console.log(`migrations: applied [${applied.join(', ') || 'none'}], now at ${alreadyAt}`)
seed(db)

const owner = db
  .prepare("SELECT id, username, full_name, role FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")
  .get() as { id: number; username: string; full_name: string; role: User['role'] }

if (owner == null) throw new Error('No owner yet — launch the app once and create one first.')

// OPT-IN, and never by accident: this overwrites a real person's password.
//   npx tsx --tsconfig tsconfig.node.json scripts/dev-seed-till.ts --reset-password sell1234
const resetTo = process.argv.indexOf('--reset-password')
if (resetTo !== -1) {
  const password = process.argv[resetTo + 1]
  if (!password) throw new Error('--reset-password needs a password after it')
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(password), owner.id)
  console.log(`password of "${owner.username}" reset to: ${password}`)
}

const actor: User = {
  id: owner.id,
  username: owner.username,
  fullName: owner.full_name,
  role: owner.role,
  hasPin: false,
  isActive: true
}

function lookupId(listKey: string, code: string): number {
  return db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number
}

type Spec = {
  sku: string
  name: string
  urdu?: string
  barcode: string
  retail: number
  taxBp?: number
  mode?: 'inclusive' | 'exclusive'
  weighted?: boolean
  uom?: string
  qty?: number
  cost?: number
  itemType?: 'inventory' | 'non_inventory'
}

/** A believable Pakistani kiryana shelf: tinned goods, a weighed staple, and a service with no shelf. */
const SHELF: Spec[] = [
  { sku: 'TEA-500', name: 'Tapal Danedar Tea 500g', urdu: 'تپال دانے دار چائے', barcode: '8964000101018', retail: 105_000, cost: 780_000, qty: 40 },
  { sku: 'OIL-5L', name: 'Dalda Cooking Oil 5L', urdu: 'ڈالڈا کوکنگ آئل', barcode: '8964000202025', retail: 289_900, cost: 2_400_000, qty: 12 },
  { sku: 'MILK-1L', name: 'Olpers Milk 1L', urdu: 'اولپرز دودھ', barcode: '8964000303032', retail: 28_000, cost: 220_000, qty: 60, mode: 'inclusive' },
  { sku: 'SUGAR', name: 'Sugar (loose)', urdu: 'چینی', barcode: '2000000000015', retail: 16_500, cost: 130_000, qty: 250, weighted: true, uom: 'kg' },
  { sku: 'SOAP', name: 'Lifebuoy Soap', urdu: 'لائف بوائے صابن', barcode: '8964000404049', retail: 12_000, cost: 90_000, qty: 3 }, // deliberately THIN — 3 on the shelf
  { sku: 'BAG', name: 'Shopping Bag', barcode: '2000000000022', retail: 500, itemType: 'non_inventory' } // no shelf at all
]

const now = new Date().toISOString()

for (const item of SHELF) {
  const existing = db.prepare('SELECT id FROM products WHERE sku = ?').pluck().get(item.sku) as
    | number
    | undefined
  if (existing != null) {
    console.log(`  = ${item.sku} already there`)
    continue
  }

  const productId = Number(
    db
      .prepare(
        `INSERT INTO products
           (sku, name, name_other_lang, sale_uom_id, cost_price, retail_price, wholesale_price,
            tax_rate_bp, price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches,
            track_serials, min_stock_m, is_active, created_at, updated_at)
         VALUES (@sku, @name, @urdu, @uomId, 0, @retail, @wholesale, @taxBp, @mode, 0, @itemType,
                 @weighted, 0, 0, @minStock, 1, @now, @now)`
      )
      .run({
        sku: item.sku,
        name: item.name,
        urdu: item.urdu ?? null,
        uomId: lookupId('uom', item.uom ?? 'pcs'),
        retail: item.retail,
        wholesale: Math.round(item.retail * 0.92), // a wholesale column, so the tier switch has something to show
        taxBp: item.taxBp ?? 1700,
        mode: item.mode ?? 'exclusive',
        itemType: item.itemType ?? 'inventory',
        weighted: item.weighted ? 1 : 0,
        minStock: 5 * ONE_UNIT,
        now
      }).lastInsertRowid
  )

  catalog.addBarcode(db, { productId, barcode: item.barcode })

  if ((item.itemType ?? 'inventory') === 'inventory' && item.qty) {
    // Through the REAL service: appends a movement, freezes its cost and value, posts a balanced journal.
    stock.adjust(db, actor, {
      productId,
      type: 'opening',
      qtyM: item.qty * ONE_UNIT,
      unitCost: item.cost ?? 100_000,
      reasonCode: 'data_entry'
    })
  }

  console.log(`  + ${item.sku.padEnd(9)} ${item.barcode}  ${item.name}`)
}

// A carton of milk: bought by the outer, sold by the piece. One scan sells 12.
const milkId = db.prepare('SELECT id FROM products WHERE sku = ?').pluck().get('MILK-1L') as number
const hasPack = db.prepare('SELECT id FROM product_packs WHERE product_id = ?').pluck().get(milkId)
if (hasPack == null) {
  catalog.savePack(db, {
    productId: milkId,
    uomId: lookupId('uom', 'carton'),
    packSize: 12 * ONE_UNIT,
    cost: 2_600_000,
    retailPrice: 320_000, // Rs 3,200 the carton — NOT 12 x Rs 280
    wholesalePrice: 300_000,
    barcode: '8964000303049'
  })
  console.log('  + CARTON    8964000303049  Olpers Milk — carton of 12')
}

// A customer, so udhaar (credit) can actually be taken at the till.
const hasCustomer = db.prepare('SELECT id FROM customers WHERE name = ?').pluck().get('Muhammad Rashid')
if (hasCustomer == null) {
  db.prepare(
    `INSERT INTO customers (name, phone, credit_limit, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run('Muhammad Rashid', '0300-1234567', 500_000, now, now)
  console.log('  + CUSTOMER  Muhammad Rashid (credit limit Rs 5,000)')
}

const tb = ledger.trialBalance(db)
console.log(`\ntrial balance balanced: ${tb.balanced} (Dr ${tb.grossDebit} / Cr ${tb.grossCredit})`)
console.log("Launch the app and sign in as the owner to sell from this shelf.")
