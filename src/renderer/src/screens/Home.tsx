import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  BarChart3,
  Store,
  Sun,
  Moon,
  LogOut,
  Save,
  FolderOpen,
  ShieldAlert,
  Clock,
  ScrollText,
  LayoutDashboard,
  ListChecks,
  Settings as SettingsIcon,
  Scale,
  ScanLine,
  CircleCheck,
  Package,
  Boxes,
  ClipboardList,
  ReceiptText,
  UsersRound,
  BookUser,
  Undo2,
  Wallet,
  Truck,
  ShoppingCart,
  HandCoins,
  BadgePercent,
  ClipboardCheck
} from 'lucide-react'
import type { AppState } from '@shared/app-state'
import type { AuditEntry } from '@shared/types'
import type { Permission } from '@shared/rbac'
import { ROLE_LABEL, roleCan } from '@shared/rbac'
import { LicenseBanner } from '../components/LicenseBanner'
import { Books } from './sections/Books'
import { Customers } from './sections/Customers'
import { Expenses } from './sections/Expenses'
import { Lists } from './sections/Lists'
import { OpeningSetup } from './sections/OpeningSetup'
import { Products } from './sections/Products'
import { Promotions } from './sections/Promotions'
import { Purchases } from './sections/Purchases'
import { Reports } from './sections/Reports'
import { Returns } from './sections/Returns'
import { SalesHistory } from './sections/SalesHistory'
import { Sell } from './sections/Sell'
import { Suppliers } from './sections/Suppliers'
import { SettingsSection } from './sections/SettingsSection'
import { Shifts } from './sections/Shifts'
import { Stock } from './sections/Stock'
import { StockTake } from './sections/StockTake'
import { Users } from './sections/Users'

type Section =
  | 'sell'
  | 'overview'
  | 'products'
  | 'stock'
  | 'stockTake'
  | 'sales'
  | 'returns'
  | 'purchases'
  | 'expenses'
  | 'promotions'
  | 'shifts'
  | 'opening'
  | 'books'
  | 'reports'
  | 'customers'
  | 'suppliers'
  | 'lists'
  | 'users'
  | 'settings'

/**
 * `permission` hides an entry the user could not use anyway. That is a COURTESY, not a control —
 * main refuses the call whether or not the button was ever drawn (CLAUDE.md §4). Opening setup is
 * Owner-only, and a nav item that greets a cashier with a red refusal is worse than no nav item.
 *
 * SELL IS FIRST, AND IT IS WHERE THE APP OPENS. A cashier signs in with a queue already forming; the
 * screen they need is the one that is already in front of them. Everything else on this list is
 * something a shopkeeper does between customers.
 */
const NAV: Array<{ key: Section; label: string; icon: typeof Store; permission?: Permission }> = [
  { key: 'sell', label: 'Sell', icon: ScanLine, permission: 'sale.create' },
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'products', label: 'Items', icon: Package },
  { key: 'stock', label: 'Stock', icon: Boxes },
  // Beside Stock, because it IS stock — the counting sheet that corrects it. 'stockTake.view' is the
  // supervisor's READ: a cashier who cannot open a sheet has no use for the nav item. The writes are
  // 'stockTake.manage' and are enforced in MAIN regardless of what this list draws.
  { key: 'stockTake', label: 'Stock take', icon: ClipboardCheck, permission: 'stockTake.view' },
  { key: 'sales', label: 'Sales', icon: ReceiptText, permission: 'report.view' },
  { key: 'returns', label: 'Returns', icon: Undo2, permission: 'sale.refund' },
  { key: 'purchases', label: 'Purchases', icon: ShoppingCart, permission: 'purchase.view' },
  { key: 'expenses', label: 'Expenses', icon: HandCoins, permission: 'expense.manage' },
  { key: 'promotions', label: 'Offers', icon: BadgePercent, permission: 'promotion.manage' },
  { key: 'shifts', label: 'Shift', icon: Wallet, permission: 'shift.manage' },
  { key: 'opening', label: 'Opening setup', icon: ClipboardList, permission: 'settings.manage' },
  { key: 'books', label: 'Books', icon: Scale },
  { key: 'reports', label: 'Reports', icon: BarChart3, permission: 'report.view' },
  { key: 'customers', label: 'Customers', icon: BookUser, permission: 'report.view' },
  { key: 'suppliers', label: 'Suppliers', icon: Truck, permission: 'supplier.view' },
  { key: 'lists', label: 'Manage lists', icon: ListChecks },
  { key: 'users', label: 'Staff', icon: UsersRound, permission: 'user.manage' },
  { key: 'settings', label: 'Settings', icon: SettingsIcon }
]

/**
 * PLAIN FLEX LAYOUT — NOT Mantine `AppShell`, which rendered a BLANK SCREEN in the packaged build
 * while working perfectly in dev (trap #9). A header div, a nav div and a content div cannot break.
 */
export function Home({
  state,
  onStateChange
}: {
  state: AppState
  onStateChange: (state: AppState) => void
}): React.JSX.Element {
  const { setColorScheme } = useMantineColorScheme()
  const dark = useComputedColorScheme('light') === 'dark'

  // THE TILL IS THE APP. It is what the shop opens in the morning and what it stares at all day.
  const [section, setSection] = useState<Section>('sell')
  const [version, setVersion] = useState<string | null>(null)
  const [currencySymbol, setCurrencySymbol] = useState('Rs')

  const user = state.session?.user

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [info, settings] = await Promise.all([
        window.pos.system.getInfo(),
        window.pos.settings.getAll()
      ])
      if (cancelled) return
      if (info.ok) setVersion(info.data.appVersion)
      if (settings.ok) setCurrencySymbol((settings.data['currency.symbol'] as string) ?? 'Rs')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function signOut(): Promise<void> {
    const result = await window.pos.auth.signOut()
    if (result.ok) onStateChange(result.data)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          height: 56,
          flexShrink: 0,
          borderBottom: '1px solid var(--mantine-color-default-border)'
        }}
      >
        <Store size={22} />
        <Text fw={650} size="lg">
          Insha POS
        </Text>

        {version ? (
          <Badge variant="light" size="sm">
            v{version}
          </Badge>
        ) : (
          <Skeleton height={20} width={52} radius="xl" />
        )}

        {state.readOnly && (
          <Badge color="orange" variant="filled" size="sm" leftSection={<ShieldAlert size={12} />}>
            READ-ONLY
          </Badge>
        )}

        <div style={{ flex: 1 }} />

        <ActionIcon
          variant="default"
          size="lg"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setColorScheme(dark ? 'light' : 'dark')}
        >
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </ActionIcon>

        {user && (
          <Menu position="bottom-end">
            <Menu.Target>
              <Button variant="default" size="sm">
                {user.fullName}
                <Badge ml={8} size="xs" variant="light">
                  {ROLE_LABEL[user.role]}
                </Badge>
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<LogOut size={14} />} onClick={() => void signOut()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Nav ──────────────────────────────────────────────────────────── */}
        <nav
          style={{
            width: 210,
            flexShrink: 0,
            padding: 12,
            borderRight: '1px solid var(--mantine-color-default-border)',
            overflowY: 'auto'
          }}
        >
          <Stack gap={4}>
            {NAV.filter(
              (item) => !item.permission || (user != null && roleCan(user.role, item.permission))
            ).map((item) => {
              const Icon = item.icon
              const active = section === item.key
              return (
                <UnstyledButton
                  key={item.key}
                  onClick={() => setSection(item.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    fontWeight: active ? 600 : 400,
                    background: active ? 'var(--mantine-color-default-hover)' : 'transparent'
                  }}
                >
                  <Icon size={17} />
                  <Text size="sm">{item.label}</Text>
                </UnstyledButton>
              )
            })}
          </Stack>
        </nav>

        {/* ── Content ──────────────────────────────────────────────────────── */}
        {/*
          The Sell screen manages its OWN height — the cart scrolls inside its card so the totals and the
          Pay button never leave the screen, and the barcode field never scrolls out from under the
          cashier. Every other section is an ordinary scrolling page.
        */}
        <main
          style={
            section === 'sell'
              ? { flex: 1, overflow: 'hidden', padding: 16 }
              : { flex: 1, overflowY: 'auto', padding: 24 }
          }
        >
          {/* Sell stays MOUNTED for the whole session, and is only HIDDEN when another screen is
              showing. A customer asks "how much is the 5kg bag?", the cashier clicks Products to
              check, comes back — and the half-built cart, the selected customer and the discounts are
              all still there. Unmounting it (the old `section === 'sell' && …`) threw the cart away
              the moment he looked at anything else. */}
          {user && (
            <div
              style={{
                display: section === 'sell' ? 'flex' : 'none',
                flex: 1,
                minHeight: 0,
                overflow: 'hidden'
              }}
            >
              <Sell readOnly={state.readOnly} userRole={user.role} />
            </div>
          )}
          {section === 'overview' && (
            <Overview state={state} onSignOutNeeded={onStateChange} />
          )}
          {section === 'products' && (
            <Products readOnly={state.readOnly} currencySymbol={currencySymbol} />
          )}
          {section === 'stock' && (
            <Stock readOnly={state.readOnly} currencySymbol={currencySymbol} />
          )}
          {section === 'stockTake' && (
            <StockTake readOnly={state.readOnly} currencySymbol={currencySymbol} />
          )}
          {section === 'sales' && <SalesHistory currencySymbol={currencySymbol} />}
          {section === 'returns' && user && (
            <Returns
              userRole={user.role}
              readOnly={state.readOnly}
              currencySymbol={currencySymbol}
            />
          )}
          {section === 'purchases' && user && (
            <Purchases
              readOnly={state.readOnly}
              currencySymbol={currencySymbol}
              userRole={user.role}
            />
          )}
          {section === 'expenses' && (
            <Expenses readOnly={state.readOnly} currencySymbol={currencySymbol} />
          )}
          {section === 'promotions' && (
            <Promotions readOnly={state.readOnly} currencySymbol={currencySymbol} />
          )}
          {section === 'shifts' && user && (
            <Shifts
              userRole={user.role}
              readOnly={state.readOnly}
              currencySymbol={currencySymbol}
            />
          )}
          {section === 'opening' && (
            <OpeningSetup readOnly={state.readOnly} currencySymbol={currencySymbol} />
          )}
          {section === 'books' && <Books currencySymbol={currencySymbol} />}
          {section === 'reports' && <Reports currencySymbol={currencySymbol} />}
          {section === 'customers' && (
            <Customers
              readOnly={state.readOnly}
              currencySymbol={currencySymbol}
              isOwner={state.session?.user.role === 'owner'}
            />
          )}
          {section === 'suppliers' && user && (
            <Suppliers
              readOnly={state.readOnly}
              currencySymbol={currencySymbol}
              userRole={user.role}
            />
          )}
          {section === 'lists' && <Lists readOnly={state.readOnly} />}
          {section === 'users' && (
            <Users currentUser={state.session?.user ?? null} readOnly={state.readOnly} />
          )}
          {section === 'settings' && (
            <SettingsSection
              readOnly={state.readOnly}
              isOwner={state.session?.user.role === 'owner'}
            />
          )}
        </main>
      </div>
    </div>
  )
}

function Overview({
  state
}: {
  state: AppState
  onSignOutNeeded: (state: AppState) => void
}): React.JSX.Element {
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [backingUp, setBackingUp] = useState(false)

  async function loadAudit(): Promise<void> {
    const result = await window.pos.audit.list({ page: 1, pageSize: 10 })
    // A Cashier may not read the audit log. That is a refusal, not an error — show an empty list
    // rather than shouting at someone about a screen they were shown.
    setAudit(result.ok ? result.data.rows : [])
  }

  useEffect(() => {
    void loadAudit()
  }, [])

  async function runBackup(): Promise<void> {
    setBackingUp(true)
    const result = await window.pos.backup.run()
    setBackingUp(false)

    if (result.ok) {
      notifications.show({
        color: 'teal',
        icon: <CircleCheck size={18} />,
        title: 'Backup saved and verified',
        message: result.data.path,
        autoClose: 6000
      })
      void loadAudit()
    } else {
      notifications.show({
        color: 'red',
        title: 'Backup failed',
        message: result.error.userMessage
      })
    }
  }

  async function chooseFolder(): Promise<void> {
    const result = await window.pos.backup.chooseFolder()
    if (result.ok && result.data) {
      notifications.show({ title: 'Backup folder set', message: result.data })
    }
  }

  return (
    <Stack gap="lg" maw={860}>
      <LicenseBanner license={state.license} />

      <div>
        <Title order={2}>Overview</Title>
        <Text c="dimmed" size="sm" mt={4}>
          The foundation is in: database, backup, users and roles, audit log, licence, and the
          double-entry ledger. Products and the sell screen come next.
        </Text>
      </div>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="xs">
          <Save size={18} />
          <Text fw={600}>Backup</Text>
        </Group>

        <Text size="sm" c="dimmed" mb="md">
          One click. The backup is written and then <strong>opened and verified</strong> — an
          unchecked backup is a rumour. Save it to a USB drive: a backup on the same failing disk is
          not a backup.
          {state.readOnly && ' Backups keep working even though the licence has expired.'}
        </Text>

        <Group>
          <Button
            leftSection={<Save size={16} />}
            loading={backingUp}
            onClick={() => void runBackup()}
          >
            Back up now
          </Button>
          <Button
            variant="default"
            leftSection={<FolderOpen size={16} />}
            onClick={() => void chooseFolder()}
          >
            Choose folder
          </Button>
        </Group>
      </Card>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="xs">
          <ScrollText size={18} />
          <Text fw={600}>Audit log</Text>
        </Group>

        <Text size="sm" c="dimmed" mb="md">
          Who did what, and when — with the role they held <em>at the time</em>. Append-only.
        </Text>

        {!audit ? (
          <Stack gap={8}>
            <Skeleton height={14} />
            <Skeleton height={14} width="80%" />
          </Stack>
        ) : audit.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing recorded yet.
          </Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Who</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Action</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {audit.map((entry) => (
                <Table.Tr key={entry.id}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Clock size={13} />
                      <Text size="sm">{new Date(entry.at).toLocaleString()}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>{entry.userName}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light">
                      {entry.userRole}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text ff="monospace" size="sm">
                      {entry.action}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}
