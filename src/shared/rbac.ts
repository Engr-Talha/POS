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
  'drawer.no_sale': 'supervisor', // physically kicking the till open with no sale is a theft vector

  // Shifts / cash drawer — running the till is a CASHIER's job. Opening/closing a shift and recording a
  // drawer movement (a no-sale, a pay-in/out, a drop) are all `shift.manage`: the control is the audit
  // log and the Z-report variance, NOT a block. A no-sale and a pay-out are theft vectors and are
  // heavily audited, but a cashier may still do them — that is real shop workflow. Reading the shift
  // history and a historical Z-report is a supervisory/reporting act, so `shift.view` is a manager's.
  'shift.manage': 'cashier',
  'shift.view': 'manager',

  // Catalog & stock
  'product.manage': 'manager',
  'stock.adjust': 'manager',
  'stock.take.approve': 'manager',

  // Buying — the mirror of selling. The Manager role owns products and purchases (§4 roles), so the
  // supplier record, the goods-received note and paying a supplier down are all a manager's job; a
  // cashier neither buys stock nor settles supplier accounts.
  'purchase.manage': 'manager', // create a purchase / GRN
  'purchase.view': 'manager', // read the purchase history
  // Sending goods BACK to the supplier moves stock off the shelf and money off the bill, so it sits
  // with the rest of buying: a manager's job, never a cashier's. (The customer-facing refund is
  // `sale.refund` — a supervisor's — because it happens at the till, in front of the customer.)
  'purchaseReturn.manage': 'manager', // send goods back to a supplier
  'supplier.manage': 'manager', // add / edit / retire a supplier
  'supplier.pay': 'manager', // pay down what the shop owes a supplier
  'supplier.view': 'manager', // read the supplier ledger / balances

  // Money — recording an expense is a manager act, like a purchase (§4 roles); reading the expense
  // history is a manager's too. A cashier neither books the shop's running costs nor reviews them.
  'expense.manage': 'manager',
  'expense.view': 'manager',
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
