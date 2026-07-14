import type { DB } from './index'
import { DEFAULT_SETTINGS } from '../services/settings'

/**
 * SEED — the lists a shop needs on day one.
 *
 * Idempotent: safe to run on every launch. It only ever INSERTs what is missing, so it can never
 * undo an owner's edits. If they rename "Cash" to "Naqad", it stays renamed.
 *
 * NO DEFAULT USER IS SEEDED. A shipped default password is a shipped back door, and this one would
 * open a shop's books. The app asks them to create the Owner account on first run.
 */

type SeedLookup = { code: string; label: string; system?: boolean }

const SEED_LOOKUPS: Record<string, SeedLookup[]> = {
  // is_system: the ledger and the sale logic branch on these codes. Renameable, not removable.
  payment_method: [
    { code: 'cash', label: 'Cash', system: true },
    { code: 'card', label: 'Card', system: true },
    { code: 'credit', label: 'Credit (Udhaar)', system: true },
    { code: 'bank', label: 'Bank Transfer', system: true },
    { code: 'cheque', label: 'Cheque', system: true },
    { code: 'jazzcash', label: 'JazzCash' },
    { code: 'easypaisa', label: 'Easypaisa' }
  ],

  uom: [
    { code: 'pcs', label: 'Pieces', system: true },
    { code: 'kg', label: 'Kilogram', system: true },
    { code: 'g', label: 'Gram' },
    { code: 'litre', label: 'Litre' },
    { code: 'box', label: 'Box' },
    { code: 'carton', label: 'Carton' },
    { code: 'dozen', label: 'Dozen' },
    { code: 'pack', label: 'Pack' }
  ],

  department: [{ code: 'products', label: 'Products' }],
  category: [{ code: 'general', label: 'General' }],
  sub_category: [],
  brand: [],
  location: [],
  favourite_group: [],

  // Reason codes. Sensitive actions REQUIRE one — that is what makes the audit log worth reading.
  void_reason: [
    { code: 'customer_changed_mind', label: 'Customer changed mind' },
    { code: 'wrong_item', label: 'Wrong item rung up' },
    { code: 'price_error', label: 'Price error' },
    { code: 'test_sale', label: 'Test sale' }
  ],
  refund_reason: [
    { code: 'damaged', label: 'Damaged / faulty' },
    { code: 'wrong_item', label: 'Wrong item' },
    { code: 'not_needed', label: 'No longer needed' },
    { code: 'expired', label: 'Expired' }
  ],
  discount_reason: [
    { code: 'regular_customer', label: 'Regular customer' },
    { code: 'bulk', label: 'Bulk purchase' },
    { code: 'damaged_packaging', label: 'Damaged packaging' },
    { code: 'near_expiry', label: 'Near expiry' },
    { code: 'manager_approval', label: 'Manager approval' }
  ],
  adjustment_reason: [
    { code: 'stock_take', label: 'Stock take correction' },
    { code: 'damage', label: 'Damaged' },
    { code: 'expired', label: 'Expired' },
    { code: 'theft', label: 'Theft / shrinkage' },
    { code: 'data_entry', label: 'Data entry correction' }
  ],

  expense_category: [
    { code: 'rent', label: 'Rent' },
    { code: 'salaries', label: 'Salaries' },
    { code: 'utilities', label: 'Utilities (bills)' },
    { code: 'transport', label: 'Transport' },
    { code: 'repairs', label: 'Repairs & maintenance' },
    { code: 'misc', label: 'Miscellaneous' }
  ],

  customer_type: [
    { code: 'walk_in', label: 'Walk-in' },
    { code: 'regular', label: 'Regular' },
    { code: 'wholesale', label: 'Wholesale' }
  ],
  supplier_type: [
    { code: 'local', label: 'Local' },
    { code: 'distributor', label: 'Distributor' },
    { code: 'importer', label: 'Importer' }
  ]
}

export function seed(db: DB, now = new Date()): void {
  const insertLookup = db.prepare(
    `INSERT INTO lookups (list_key, code, label, sort_order, is_active, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (list_key, code) DO NOTHING`
  )

  const insertSetting = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO NOTHING`
  )

  const run = db.transaction(() => {
    for (const [listKey, items] of Object.entries(SEED_LOOKUPS)) {
      items.forEach((item, index) => {
        insertLookup.run(
          listKey,
          item.code,
          item.label,
          index * 10,
          item.system ? 1 : 0,
          now.toISOString(),
          now.toISOString()
        )
      })
    }

    // ON CONFLICT DO NOTHING — never overwrite a setting the owner has already changed.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, JSON.stringify(value), now.toISOString())
    }
  })

  run()
}
