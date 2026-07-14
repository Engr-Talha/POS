/**
 * ROLES AND PERMISSIONS.
 *
 * This file is shared so the UI can grey out a button the user cannot use. That is a COURTESY.
 * THE UI IS NOT A SECURITY BOUNDARY (CLAUDE.md §4). The check that actually matters runs in the
 * main process, inside the service, and it runs whether or not the button was hidden.
 */

export const ROLES = ['cashier', 'supervisor', 'manager', 'owner'] as const
export type Role = (typeof ROLES)[number]

/**
 * Roles are a ladder: an Owner can do anything a Manager can, and so on down.
 * Higher number = more power.
 */
export const ROLE_RANK: Record<Role, number> = {
  cashier: 1,
  supervisor: 2,
  manager: 3,
  owner: 4
}

export const ROLE_LABEL: Record<Role, string> = {
  cashier: 'Cashier',
  supervisor: 'Supervisor',
  manager: 'Manager',
  owner: 'Owner'
}

/**
 * Every guarded action in the app, and the LOWEST role allowed to do it.
 *
 * Adding an action here is how a feature becomes permission-checked. If an action is not in this
 * list, the service must not guard on it by inventing a string — add it here first.
 */
export const PERMISSIONS = {
  // Selling
  'sale.create': 'cashier',
  'sale.void': 'supervisor',
  'sale.refund': 'supervisor',
  'sale.discount.over_threshold': 'supervisor',
  'sale.price_override': 'supervisor',
  'sale.negative_stock': 'cashier', // allowed, but warned + flagged + audited
  'drawer.no_sale': 'supervisor', // opening the till with no sale is a classic theft vector

  // Catalog & stock
  'product.manage': 'manager',
  'stock.adjust': 'manager',
  'stock.take.approve': 'manager',
  'purchase.manage': 'manager',

  // Money
  'expense.manage': 'manager',
  'report.view': 'manager',

  // Administration
  'user.manage': 'owner',
  'settings.manage': 'owner',
  'lookups.manage': 'manager',
  'period.unlock': 'owner',
  'license.activate': 'owner',
  'backup.run': 'manager',
  'backup.restore': 'owner', // restore OVERWRITES the shop's data — owner only
  'audit.view': 'manager'
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[PERMISSIONS[permission]]
}
