import { it } from 'vitest'
import { Workbook, type Worksheet } from 'exceljs'
import { makeTestDb } from '../db/testkit'
import * as products from './products'
import { buildTemplate } from './excel-template'
import type { User } from '@shared/types'

it('render the template so a human can look at it', async () => {
  const t = makeTestDb({ withSeed: true })
  const now = new Date().toISOString()
  const id = Number(t.db.prepare(`INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at) VALUES ('i','Insha','owner','x',1,?,?)`).run(now, now).lastInsertRowid)
  const actor: User = { id, username: 'i', fullName: 'Insha', role: 'owner', hasPin: false, isActive: true }
  const uom = t.db.prepare("SELECT id FROM lookups WHERE list_key='uom' AND code='pcs'").pluck().get() as number

  for (const [sku, name] of [['OIL-5L', 'Cooking Oil 5L'], ['007', 'James Bond Cola'], ['SUGAR', 'Sugar 1kg']]) {
    products.create(t.db, actor, { sku: sku as string, name: name as string, saleUomId: uom }, new Date())
  }

  const wb = new Workbook()
  await wb.xlsx.load((await buildTemplate(t.db)) as never)

  for (const sheet of wb.worksheets) {
    console.log('\n' + '='.repeat(100))
    console.log('SHEET: ' + sheet.name + `   (frozen: ${JSON.stringify(sheet.views[0])})`)
    console.log('='.repeat(100))
    const dump = (s: Worksheet): void => {
      s.eachRow({ includeEmpty: false }, (row, n) => {
        const cells: string[] = []
        row.eachCell({ includeEmpty: true }, (cell, c) => {
          const fmt = s.getColumn(c).numFmt === '@' ? '·' : ' '
          cells.push(`${String(cell.value ?? '')}${fmt}`)
        })
        if (s.name === 'Instructions') console.log(String(row.getCell(1).value ?? ''))
        else console.log(String(n).padStart(3) + ' | ' + cells.join(' | '))
      })
    }
    dump(sheet)
  }
  t.cleanup()
})
