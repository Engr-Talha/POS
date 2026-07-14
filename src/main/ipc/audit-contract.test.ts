import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as products from '../services/products'
import * as stock from '../services/stock'
import * as catalog from '../services/catalog'
import type { User } from '@shared/types'

/**
 * TEMPORARY — proves the audit contract the IPC layer relies on:
 * products.* and stock.adjust audit THEMSELVES, so the handlers must not log a second row.
 */

let t: TestDb
let owner: User

function auditRows(action: string): number {
  return t.db.prepare('SELECT COUNT(*) FROM audit_log WHERE action = ?').pluck().get(action) as number
}

function uom(): number {
  return t.db.prepare("SELECT id FROM lookups WHERE list_key = 'uom' LIMIT 1").pluck().get() as number
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  const info = t.db
    .prepare(
      "INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at) VALUES ('o','Owner','owner','x',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')"
    )
    .run()
  owner = {
    id: Number(info.lastInsertRowid),
    username: 'o',
    fullName: 'Owner',
    role: 'owner',
    isActive: true
  } as User
})

afterEach(() => t.cleanup())

describe('the audit contract the IPC layer depends on', () => {
  it('products.create writes EXACTLY ONE product.create audit row (service audits itself)', () => {
    products.create(t.db, owner, { sku: 'A1', name: 'Tin of Beans', saleUomId: uom() })
    expect(auditRows('product.create')).toBe(1)
  })

  it('products.update raises a SEPARATE product.price_change when a price moves', () => {
    const p = products.create(t.db, owner, { sku: 'A2', name: 'Rice', saleUomId: uom() })
    products.update(t.db, owner, { id: p.product.id, retailPrice: 399900 })
    expect(auditRows('product.update')).toBe(1)
    expect(auditRows('product.price_change')).toBe(1)
  })

  it('stock.adjust writes its own audit row AND the movement — one door, one record', () => {
    const p = products.create(t.db, owner, { sku: 'A3', name: 'Ghee', saleUomId: uom() })
    const reason = t.db
      .prepare("SELECT code FROM lookups WHERE list_key = 'adjustment_reason' AND is_active = 1 LIMIT 1")
      .pluck()
      .get() as string

    stock.adjust(t.db, owner, {
      productId: p.product.id,
      type: 'opening',
      qtyM: 24_000,
      unitCost: 21_850_000,
      reasonCode: reason,
      batchId: null,
      note: null
    })

    expect(auditRows('stock.opening')).toBe(1)
    // and the balance is DERIVED, not stored
    expect(stock.onHand(t.db, p.product.id)).toBe(24_000)
  })

  it('catalog.* does NOT audit — which is why the handlers must (and do)', () => {
    const p = products.create(t.db, owner, { sku: 'A4', name: 'Soap', saleUomId: uom() })
    catalog.addBarcode(t.db, { productId: p.product.id, barcode: 'BC-1' })
    expect(auditRows('product.barcode_add')).toBe(0) // service is silent -> IPC handler logs it
  })
})
