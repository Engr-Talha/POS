import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { ArrowLeft, CircleAlert, Save, Search, Truck, TriangleAlert } from 'lucide-react'
import type { Role } from '@shared/rbac'
import { roleCan } from '@shared/rbac'
import type {
  Supplier,
  SupplierInput,
  SupplierWithBalance,
  UpdateSupplierInput
} from '@shared/suppliers'
import { Paginator } from '../../components/Paginator'
import { LookupSelect, useLookupList } from './ProductForm'
import { SupplierBalanceText, SupplierLedger } from './SupplierLedger'

/**
 * SUPPLIERS — who the shop buys from, and who it owes money to (the BUYING mirror of Customers).
 *
 * This screen is three views wearing one hat, exactly like Customers: the LIST, the supplier FORM
 * (add / edit), and a single supplier's LEDGER (the statement + payments, in its own file). A row opens
 * the ledger; "New supplier" and "Edit" open the form.
 *
 * WHO CAN DO WHAT — the UI mirrors the gates MAIN actually enforces (CLAUDE.md §4; the UI is a
 * courtesy, never the control). The whole buying side is a MANAGER's job (§4 roles): reading the
 * list-with-balances and a supplier's ledger is `supplier.view`, adding/editing a supplier is
 * `supplier.manage`, and paying one down is `supplier.pay` — all a manager's. The nav entry that
 * reaches this screen is gated on `supplier.view`, so everyone here is a manager or above.
 *
 * THERE IS NO BALANCE FIELD ON THE FORM, and there never will be. What the shop owes a supplier is
 * DERIVED from the ledger (opening payable + purchase payables − payments), the same way stock is
 * derived from movements. The balance shown against each row and atop the ledger is read, never typed.
 */

type View =
  | { mode: 'list' }
  | { mode: 'ledger'; supplierId: number }
  /** null = a brand-new supplier. */
  | { mode: 'form'; supplierId: number | null }

export function Suppliers({
  readOnly,
  currencySymbol,
  userRole
}: {
  readOnly: boolean
  currencySymbol: string
  userRole: Role
}): React.JSX.Element {
  const [view, setView] = useState<View>({ mode: 'list' })

  const canManage = roleCan(userRole, 'supplier.manage')
  const canPay = roleCan(userRole, 'supplier.pay')

  if (view.mode === 'form') {
    const editingId = view.supplierId
    return (
      <SupplierForm
        supplierId={editingId}
        readOnly={readOnly}
        // Cancel goes back where you came from: the list for a new supplier, that supplier's ledger
        // for an edit.
        onClose={() =>
          setView(editingId === null ? { mode: 'list' } : { mode: 'ledger', supplierId: editingId })
        }
        // After a save, land on the supplier you just created or edited — their ledger.
        onSaved={(id) => setView({ mode: 'ledger', supplierId: id })}
      />
    )
  }

  if (view.mode === 'ledger') {
    return (
      <SupplierLedger
        supplierId={view.supplierId}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        canManage={canManage}
        canPay={canPay}
        onBack={() => setView({ mode: 'list' })}
        onEdit={() => setView({ mode: 'form', supplierId: view.supplierId })}
      />
    )
  }

  return (
    <SupplierList
      readOnly={readOnly}
      currencySymbol={currencySymbol}
      canManage={canManage}
      onOpen={(id) => setView({ mode: 'ledger', supplierId: id })}
      onNew={() => setView({ mode: 'form', supplierId: null })}
    />
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The list
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 25

function SupplierList({
  readOnly,
  currencySymbol,
  canManage,
  onOpen,
  onNew
}: {
  readOnly: boolean
  currencySymbol: string
  canManage: boolean
  onOpen: (supplierId: number) => void
  onNew: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<SupplierWithBalance[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)

  // The supplier_type labels, so the row can show "Distributor" instead of a lookup id. Loaded once.
  const { items: types } = useLookupList('supplier_type')
  const typeLabel = useMemo(
    () => new Map((types ?? []).map((t) => [t.id, t.label] as const)),
    [types]
  )

  // A human types a name letter by letter; debouncing keeps us from firing a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  // A changed filter puts us back on page 1 — page 5 of a different result set is nonsense. (The pager
  // resets the page itself when the rows-per-page changes, so that is deliberately not a dependency.)
  useEffect(() => {
    setPage(1)
  }, [debounced, includeInactive])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    // listWithBalances is gated `supplier.view` in MAIN and computes the balance only for the rows on
    // THIS page — a shop with 100k suppliers still costs one page of work.
    const result = await window.pos.supplierLedger.listWithBalances({
      page,
      pageSize,
      search: debounced === '' ? undefined : debounced,
      includeInactive: includeInactive || undefined
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, pageSize, debounced, includeInactive])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = debounced !== '' || includeInactive

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Suppliers</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Everyone the shop buys from. Search by name or phone. A red balance is money you still owe;
            a green one is an advance the supplier is holding for you.
          </Text>
        </div>

        <Tooltip
          label={
            readOnly
              ? 'Your licence has expired — suppliers cannot be added'
              : 'Only a manager can add suppliers'
          }
          disabled={canManage && !readOnly}
        >
          <Button leftSection={<Truck size={16} />} disabled={readOnly || !canManage} onClick={onNew}>
            New supplier
          </Button>
        </Tooltip>
      </Group>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <TextInput
            style={{ flex: 1, minWidth: 260 }}
            label="Search"
            placeholder="Name or phone number…"
            leftSection={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          <Switch
            label="Show retired suppliers"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.currentTarget.checked)}
            pb={8}
          />
        </Group>
      </Card>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The suppliers could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      {/* ── List ───────────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        {!rows ? (
          <Stack gap={10}>
            <Skeleton height={34} />
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <Truck size={32} opacity={0.5} />
            <Text fw={600}>{filtered ? 'Nothing matches that' : 'No suppliers yet'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              {filtered
                ? 'Try a different search, or clear the filter above.'
                : 'Add your first supplier, then record a delivery from them on the Purchases screen.'}
            </Text>
            {!filtered && canManage && (
              <Button mt="sm" leftSection={<Truck size={16} />} disabled={readOnly} onClick={onNew}>
                New supplier
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Phone</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th ta="right">Balance owed</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(row.id)}>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" fw={500}>
                            {row.name}
                          </Text>
                          {!row.isActive && (
                            <Badge size="xs" variant="light" color="gray">
                              retired
                            </Badge>
                          )}
                        </Group>
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" ff="monospace" c={row.phone ? undefined : 'dimmed'}>
                          {row.phone ?? '—'}
                        </Text>
                      </Table.Td>

                      <Table.Td>
                        {row.typeLookupId !== null && typeLabel.has(row.typeLookupId) ? (
                          <Badge size="sm" variant="light" color="gray">
                            {typeLabel.get(row.typeLookupId)}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>

                      <Table.Td ta="right">
                        <SupplierBalanceText balance={row.balance} currencySymbol={currencySymbol} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            <Paginator
              page={page}
              pageSize={pageSize}
              total={total}
              onPage={setPage}
              onPageSize={setPageSize}
              unit="supplier"
            />
          </>
        )}
      </Card>
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The form — add / edit a supplier
// ═════════════════════════════════════════════════════════════════════════════

type FormState = {
  name: string
  phone: string
  address: string
  typeLookupId: number | null
  isActive: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  phone: '',
  address: '',
  typeLookupId: null,
  isActive: true
}

function toForm(supplier: Supplier): FormState {
  return {
    name: supplier.name,
    phone: supplier.phone ?? '',
    address: supplier.address ?? '',
    typeLookupId: supplier.typeLookupId,
    isActive: supplier.isActive
  }
}

/** An empty box means "cleared" for a nullable column — `.nullish()` is what zod expects there. */
function orNull(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

function SupplierForm({
  supplierId,
  readOnly,
  onClose,
  onSaved
}: {
  /** null = a brand-new supplier. */
  supplierId: number | null
  readOnly: boolean
  onClose: () => void
  onSaved: (supplierId: number) => void
}): React.JSX.Element {
  const editing = supplierId !== null

  const [before, setBefore] = useState<Supplier | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (supplierId === null) {
      setBefore(null)
      setForm(EMPTY_FORM)
      return
    }
    setLoadError(null)
    const result = await window.pos.suppliers.get({ id: supplierId })
    if (!result.ok) {
      setLoadError(result.error.userMessage)
      return
    }
    setBefore(result.data)
    setForm(toForm(result.data))
  }, [supplierId])

  useEffect(() => {
    void load()
  }, [load])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((current) => ({ ...current, [key]: value }))

  const canSave = form.name.trim() !== ''

  async function save(): Promise<void> {
    if (!canSave) return
    setSaving(true)

    if (!editing) {
      const input: SupplierInput = {
        name: form.name.trim(),
        phone: orNull(form.phone),
        address: orNull(form.address),
        typeLookupId: form.typeLookupId
      }

      const result = await window.pos.suppliers.create(input)
      setSaving(false)

      if (!result.ok) {
        notifications.show({
          color: 'red',
          title: 'Could not save this supplier',
          message: result.error.userMessage
        })
        return
      }

      notifications.show({
        color: 'teal',
        title: 'Supplier saved',
        message: `${result.data.name} is on your supplier list.`
      })
      onSaved(result.data.id)
      return
    }

    // EDIT: send ONLY what changed. Posting the whole object back is how a field the form never
    // loaded gets wiped (CLAUDE.md trap #18).
    const original = before
    if (!original) {
      setSaving(false)
      return
    }

    const patch: UpdateSupplierInput = { id: original.id }
    const put = <K extends keyof UpdateSupplierInput>(key: K, value: UpdateSupplierInput[K]): void => {
      patch[key] = value
    }

    if (form.name.trim() !== original.name) put('name', form.name.trim())
    if (orNull(form.phone) !== original.phone) put('phone', orNull(form.phone))
    if (orNull(form.address) !== original.address) put('address', orNull(form.address))
    if (form.typeLookupId !== original.typeLookupId) put('typeLookupId', form.typeLookupId)
    if (form.isActive !== original.isActive) put('isActive', form.isActive)

    if (Object.keys(patch).length === 1) {
      setSaving(false)
      notifications.show({
        color: 'gray',
        title: 'Nothing to save',
        message: 'No changes were made.'
      })
      return
    }

    const result = await window.pos.suppliers.update(patch)
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not save this supplier',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({ color: 'teal', title: 'Saved', message: result.data.name })
    onSaved(result.data.id)
  }

  if (loadError) {
    return (
      <Stack gap="lg">
        <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onClose} w="fit-content">
          Back to suppliers
        </Button>
        <Alert color="red" icon={<CircleAlert size={18} />} title="This supplier could not be opened">
          {loadError}
        </Alert>
      </Stack>
    )
  }

  if (editing && !before) {
    return (
      <Stack gap="lg">
        <Skeleton height={36} width={160} />
        <Skeleton height={30} width={280} />
        <Skeleton height={260} />
      </Stack>
    )
  }

  return (
    <Stack gap="lg" maw={760}>
      <Group justify="space-between" align="flex-start">
        <Group gap="sm" align="center">
          <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onClose}>
            {editing ? 'Back to statement' : 'Back to suppliers'}
          </Button>
          <Title order={2}>{editing ? form.name || 'Supplier' : 'New supplier'}</Title>
          {editing && !form.isActive && (
            <Badge color="gray" variant="light">
              Retired
            </Badge>
          )}
        </Group>

        <Button
          leftSection={<Save size={16} />}
          loading={saving}
          disabled={readOnly || !canSave}
          onClick={() => void save()}
        >
          {editing ? 'Save changes' : 'Create supplier'}
        </Button>
      </Group>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so suppliers cannot be changed. You can still look at everything and
          export it.
        </Alert>
      )}

      <Card withBorder padding="lg">
        <Text fw={600} mb="md">
          Who they are
        </Text>
        <Stack>
          <Group grow align="flex-start">
            <TextInput
              label="Name"
              description="The distributor or wholesaler you buy from. Not unique — the phone number tells two apart."
              required
              disabled={readOnly}
              value={form.name}
              onChange={(event) => set('name', event.currentTarget.value)}
            />
            <TextInput
              label="Phone"
              disabled={readOnly}
              value={form.phone}
              onChange={(event) => set('phone', event.currentTarget.value)}
            />
          </Group>

          <LookupSelect
            listKey="supplier_type"
            label="Type"
            placeholder="Choose a type…"
            value={form.typeLookupId}
            onChange={(value) => set('typeLookupId', value)}
            disabled={readOnly}
          />

          <Textarea
            label="Address"
            autosize
            minRows={2}
            disabled={readOnly}
            value={form.address}
            onChange={(event) => set('address', event.currentTarget.value)}
          />

          {editing && (
            <Switch
              label="Active"
              description="Switch off to retire the supplier. They are never deleted — last year's purchase still points at them, and you can still pay off an old bill."
              checked={form.isActive}
              disabled={readOnly}
              onChange={(event) => set('isActive', event.currentTarget.checked)}
            />
          )}
        </Stack>
      </Card>
    </Stack>
  )
}
