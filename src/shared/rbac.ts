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

  // Stock take — the counting sheet. A manager's job, exactly like the `stock.adjust` it is a batch of
  // (§4 roles: the Manager owns products and stock). Opening a sheet and keying counts are the same
  // permission as applying it, deliberately: a sheet nobody may apply is a sheet nobody will finish, and
  // the control here is not a second role — it is the AUDIT LOG plus the variance total, which is what
  // the leakage report reads. A big variance is a theft signal, and `stockTake.apply` records who signed
  // it off with the money against it.
  'stockTake.manage': 'manager',
  // READING a sheet back. A supervisor may look at what was counted — and at the variance, which is the
  // whole point of the sheet — without being able to post the correction. (This is the Phase-0
  // 'stock.take.approve' placeholder, renamed now that it is real: it never guarded an approval step,
  // and a permission whose name lies about what it does is worse than no permission at all.)
  'stockTake.view': 'supervisor',

  // Buying — the mirror of selling. The Manager role owns products and purchases (§4 roles), so the
  // supplier record, the goods-received note and paying a supplier down are all a manager's job; a
  // cashier neither buys stock nor settles supplier accounts.
  'purchase.manage': 'manager', // create a purchase / GRN
  'purchase.view': 'manager', // read the purchase history
  // CORRECTING A KEYING MISTAKE ON A BILL. Same role as creating one, deliberately: the manager who
  // keys a delivery at 3pm is the one who spots at 3.05pm that they typed 100 for 10, and a correction
  // nobody present may make is a correction that never happens — the shop just lives with wrong stock.
  // The control here is not a higher role, it is that NOTHING IS ERASED: the void posts a contra, keeps
  // the document and its number, demands a reason from the owner's list, and writes an audit row with a
  // name on it. (A sale void is a supervisor's because it happens at the till in front of a customer
  // with cash in the drawer; a purchase void is back-office paperwork against a supplier's bill.)
  'purchase.void': 'manager', // reverse a wrongly-keyed purchase with a contra
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

  // Loyalty — points are a LIABILITY (migration 0017), so moving one BY HAND is the owner's call and
  // nobody else's: an adjust writes off, or invents, money the shop owes its customers, and it is the
  // one loyalty path with no sale behind it to justify the number. Earning and redeeming are not here
  // on purpose — they are consequences of a sale, guarded by `sale.create`, not separate acts.
  // Reading a balance is a CASHIER's: the till must be able to tell a customer what their points are
  // worth before they decide to spend them.
  'loyalty.adjust': 'owner',
  'loyalty.view': 'cashier',

  // Promotions — an offer is a standing decision to sell at less than the shelf price, so RUNNING one
  // is a manager's call, alongside products and purchases (§4 roles). It is not a supervisor's: a
  // supervisor approves ONE discount, at the till, in front of the customer; a promotion discounts
  // every matching line for as long as it runs, unattended. Creating, editing and switching one off are
  // all `promotion.manage` and all audited — an offer that quietly went live is money leaving the shop.
  // Reading them is a CASHIER's: the till must be able to show the customer why a line rang up cheaper.
  'promotion.manage': 'manager',
  'promotion.view': 'cashier',

  // Administration
  'user.manage': 'owner',
  'settings.manage': 'owner',
  'lookups.manage': 'manager',

  // CLOSING AND REOPENING THE MONTH — the owner's, and nobody else's (§4 roles name the Owner for
  // "period unlock" explicitly). Locking freezes a month the shop has already reported on; UNLOCKING
  // reopens it, which is how books get quietly rewritten after the fact. Both are audited by name.
  //
  // ONE permission for both directions, not two. A manager who could LOCK but not unlock could freeze
  // the owner's month out from under him, and only the owner could undo it — a lock is not the safe half
  // of this pair, it is just the half that is harder to notice.
  'period.manage': 'owner',
  // The Phase-0 name, kept as an alias so nothing that already asks for it silently loses its guard.
  // Same role, same act. New code asks for 'period.manage'.
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
