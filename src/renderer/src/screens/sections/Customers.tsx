import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
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
import { ArrowLeft, CircleAlert, Save, Search, TriangleAlert, UserPlus, Users } from 'lucide-react'
import type { CustomerWithBalance } from '@shared/ipc'
import {
  CUSTOMER_PRICE_TIERS,
  type CreateCustomerInput,
  type Customer,
  type CustomerPriceTier,
  type UpdateCustomerInput
} from '@shared/customers'
import { Paginator } from '../../components/Paginator'
import { LookupSelect, MoneyInput, useLookupList } from './ProductForm'
import { BalanceText, CustomerLedger } from './CustomerLedger'

/**
 * CUSTOMERS — the parties the shop keeps a running udhaar account with (Phase 7).
 *
 * This screen is three views wearing one hat, exactly like the Items screen: the LIST, the customer
 * FORM (add / edit), and a single customer's LEDGER (the statement + repayments, in its own file). A
 * row opens the ledger; "New customer" and "Edit" open the form.
 *
 * WHO CAN DO WHAT — the UI mirrors the gates MAIN actually enforces (CLAUDE.md §4; the UI is a
 * courtesy, never the control):
 *   - viewing the list-with-balances, a customer's ledger and their balance is `report.view` (manager).
 *     The nav entry that reaches this screen is gated on that, so everyone here is a manager or above.
 *   - RECORDING A PAYMENT is `sale.create` (a manager has it) — the counter takes udhaar back.
 *   - ADDING / EDITING a customer is `settings.manage` (owner). So "New customer" and "Edit" are
 *     owner-only here; a manager sees them disabled rather than a red refusal after the click.
 *
 * THERE IS NO BALANCE FIELD ON THE FORM, and there never will be. What a customer owes is DERIVED from
 * the ledger (opening + credit sales − payments), the same way stock is derived from movements. The
 * balance shown against each row and atop the ledger is read, never typed. `creditLimit` is a different
 * thing entirely — how much udhaar they are ALLOWED to run up.
 */

type View =
  | { mode: 'list' }
  | { mode: 'ledger'; customerId: number }
  /** null = a brand-new customer. */
  | { mode: 'form'; customerId: number | null }

export function Customers({
  readOnly,
  currencySymbol,
  isOwner
}: {
  readOnly: boolean
  currencySymbol: string
  isOwner: boolean
}): React.JSX.Element {
  const [view, setView] = useState<View>({ mode: 'list' })

  // Adding and editing a customer is owner-only in MAIN; reflect that in the buttons.
  const canManage = isOwner

  if (view.mode === 'form') {
    const editingId = view.customerId
    return (
      <CustomerForm
        customerId={editingId}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        // Cancel goes back where you came from: the list for a new customer, that customer's ledger
        // for an edit.
        onClose={() =>
          setView(editingId === null ? { mode: 'list' } : { mode: 'ledger', customerId: editingId })
        }
        // After a save, land on the customer you just created or edited — their ledger.
        onSaved={(id) => setView({ mode: 'ledger', customerId: id })}
      />
    )
  }

  if (view.mode === 'ledger') {
    return (
      <CustomerLedger
        customerId={view.customerId}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        canManage={canManage}
        onBack={() => setView({ mode: 'list' })}
        onEdit={() => setView({ mode: 'form', customerId: view.customerId })}
      />
    )
  }

  return (
    <CustomerList
      readOnly={readOnly}
      currencySymbol={currencySymbol}
      canManage={canManage}
      onOpen={(id) => setView({ mode: 'ledger', customerId: id })}
      onNew={() => setView({ mode: 'form', customerId: null })}
    />
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The list
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 25

function CustomerList({
  readOnly,
  currencySymbol,
  canManage,
  onOpen,
  onNew
}: {
  readOnly: boolean
  currencySymbol: string
  canManage: boolean
  onOpen: (customerId: number) => void
  onNew: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<CustomerWithBalance[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)

  // The customer_type labels, so the row can show "Wholesale" instead of a lookup id. Loaded once.
  const { items: types } = useLookupList('customer_type')
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

    // listWithBalances is gated `report.view` in MAIN and computes the balance only for the rows on
    // THIS page — a shop with 100k customers still costs one page of work.
    const result = await window.pos.customers.listWithBalances({
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
          <Title order={2}>Customers</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Everyone the shop keeps an account with. Search by name or phone. A red balance is udhaar
            they owe you; a green one is credit they are holding.
          </Text>
        </div>

        <Tooltip
          label={
            readOnly
              ? 'Your licence has expired — customers cannot be added'
              : 'Only the owner can add customers'
          }
          disabled={canManage && !readOnly}
        >
          <Button
            leftSection={<UserPlus size={16} />}
            disabled={readOnly || !canManage}
            onClick={onNew}
          >
            New customer
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
            label="Show retired customers"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.currentTarget.checked)}
            pb={8}
          />
        </Group>
      </Card>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The customers could not be loaded">
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
            <Users size={32} opacity={0.5} />
            <Text fw={600}>{filtered ? 'Nothing matches that' : 'No customers yet'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              {filtered
                ? 'Try a different search, or clear the filter above.'
                : 'Add your first customer, or take a credit sale on the Sell screen and the customer is created there.'}
            </Text>
            {!filtered && canManage && (
              <Button
                mt="sm"
                leftSection={<UserPlus size={16} />}
                disabled={readOnly}
                onClick={onNew}
              >
                New customer
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={820}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Shop / business</Table.Th>
                    <Table.Th>Phone</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th ta="right">Udhaar balance</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr
                      key={row.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onOpen(row.id)}
                    >
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
                        <Text size="sm" c={row.businessName ? undefined : 'dimmed'}>
                          {row.businessName ?? '—'}
                        </Text>
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
                        <BalanceText balance={row.balance} currencySymbol={currencySymbol} />
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
              unit="customer"
            />
          </>
        )}
      </Card>
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The form — add / edit a customer
// ═════════════════════════════════════════════════════════════════════════════

type FormState = {
  name: string
  businessName: string
  phone: string
  address: string
  typeLookupId: number | null
  taxNumber: string
  /** 2-dp money, integer minor units. How much udhaar they may run up. A LIMIT, not a balance. */
  creditLimit: number
  /** null = fall back to the shop default. */
  priceTier: CustomerPriceTier | null
  notes: string
  isActive: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  businessName: '',
  phone: '',
  address: '',
  typeLookupId: null,
  taxNumber: '',
  creditLimit: 0,
  priceTier: null,
  notes: '',
  isActive: true
}

function toForm(customer: Customer): FormState {
  return {
    name: customer.name,
    businessName: customer.businessName ?? '',
    phone: customer.phone ?? '',
    address: customer.address ?? '',
    typeLookupId: customer.typeLookupId,
    taxNumber: customer.taxNumber ?? '',
    creditLimit: customer.creditLimit,
    priceTier: customer.priceTier,
    notes: customer.notes ?? '',
    isActive: customer.isActive
  }
}

/** An empty box means "cleared" for a nullable column — `.nullish()` is what zod expects there. */
function orNull(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

const PRICE_TIER_OPTIONS: Array<{ value: CustomerPriceTier; label: string }> = CUSTOMER_PRICE_TIERS.map(
  (tier) => ({ value: tier, label: tier === 'retail' ? 'Retail' : 'Wholesale' })
)

function CustomerForm({
  customerId,
  readOnly,
  currencySymbol,
  onClose,
  onSaved
}: {
  /** null = a brand-new customer. */
  customerId: number | null
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  onSaved: (customerId: number) => void
}): React.JSX.Element {
  const editing = customerId !== null

  const [before, setBefore] = useState<Customer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (customerId === null) {
      setBefore(null)
      setForm(EMPTY_FORM)
      return
    }
    setLoadError(null)
    const result = await window.pos.customers.get({ id: customerId })
    if (!result.ok) {
      setLoadError(result.error.userMessage)
      return
    }
    setBefore(result.data)
    setForm(toForm(result.data))
  }, [customerId])

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
      const input: CreateCustomerInput = {
        name: form.name.trim(),
        phone: orNull(form.phone),
        address: orNull(form.address),
        typeLookupId: form.typeLookupId,
        creditLimit: form.creditLimit,
        businessName: orNull(form.businessName),
        taxNumber: orNull(form.taxNumber),
        notes: orNull(form.notes),
        priceTier: form.priceTier
      }

      const result = await window.pos.customers.create(input)
      setSaving(false)

      if (!result.ok) {
        notifications.show({
          color: 'red',
          title: 'Could not save this customer',
          message: result.error.userMessage
        })
        return
      }

      notifications.show({
        color: 'teal',
        title: 'Customer saved',
        message: `${result.data.name} is on your customer list.`
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

    const patch: UpdateCustomerInput = { id: original.id }
    const put = <K extends keyof UpdateCustomerInput>(key: K, value: UpdateCustomerInput[K]): void => {
      patch[key] = value
    }

    if (form.name.trim() !== original.name) put('name', form.name.trim())
    if (orNull(form.phone) !== original.phone) put('phone', orNull(form.phone))
    if (orNull(form.address) !== original.address) put('address', orNull(form.address))
    if (form.typeLookupId !== original.typeLookupId) put('typeLookupId', form.typeLookupId)
    if (form.creditLimit !== original.creditLimit) put('creditLimit', form.creditLimit)
    if (orNull(form.businessName) !== original.businessName)
      put('businessName', orNull(form.businessName))
    if (orNull(form.taxNumber) !== original.taxNumber) put('taxNumber', orNull(form.taxNumber))
    if (orNull(form.notes) !== original.notes) put('notes', orNull(form.notes))
    if (form.priceTier !== original.priceTier) put('priceTier', form.priceTier)
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

    const result = await window.pos.customers.update(patch)
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not save this customer',
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
          Back to customers
        </Button>
        <Alert color="red" icon={<CircleAlert size={18} />} title="This customer could not be opened">
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
        <Skeleton height={320} />
      </Stack>
    )
  }

  return (
    <Stack gap="lg" maw={760}>
      <Group justify="space-between" align="flex-start">
        <Group gap="sm" align="center">
          <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onClose}>
            {editing ? 'Back to statement' : 'Back to customers'}
          </Button>
          <Title order={2}>{editing ? form.name || 'Customer' : 'New customer'}</Title>
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
          {editing ? 'Save changes' : 'Create customer'}
        </Button>
      </Group>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so customers cannot be changed. You can still look at everything and
          export it.
        </Alert>
      )}

      {/* Identity */}
      <Card withBorder padding="lg">
        <Text fw={600} mb="md">
          Who they are
        </Text>
        <Stack>
          <Group grow align="flex-start">
            <TextInput
              label="Name"
              description="The person you deal with. Not unique — the phone number tells two people apart."
              required
              disabled={readOnly}
              value={form.name}
              onChange={(event) => set('name', event.currentTarget.value)}
            />
            <TextInput
              label="Shop / business name"
              description="Printed on their tax invoice, for a wholesale or business account."
              disabled={readOnly}
              value={form.businessName}
              onChange={(event) => set('businessName', event.currentTarget.value)}
            />
          </Group>

          <Group grow align="flex-start">
            <TextInput
              label="Phone"
              disabled={readOnly}
              value={form.phone}
              onChange={(event) => set('phone', event.currentTarget.value)}
            />
            <LookupSelect
              listKey="customer_type"
              label="Type"
              placeholder="Choose a type…"
              value={form.typeLookupId}
              onChange={(value) => set('typeLookupId', value)}
              disabled={readOnly}
            />
          </Group>

          <Textarea
            label="Address"
            autosize
            minRows={2}
            disabled={readOnly}
            value={form.address}
            onChange={(event) => set('address', event.currentTarget.value)}
          />
        </Stack>
      </Card>

      {/* Account terms */}
      <Card withBorder padding="lg">
        <Text fw={600} mb="md">
          Account
        </Text>
        <Stack>
          <Group grow align="flex-start">
            <TextInput
              label="Tax number (NTN / STRN)"
              description="For a sales-tax invoice to a registered buyer."
              disabled={readOnly}
              value={form.taxNumber}
              onChange={(event) => set('taxNumber', event.currentTarget.value)}
            />
            <MoneyInput
              label="Credit limit"
              description="How much udhaar they may run up. A limit, not a balance."
              leftSection={<Text size="sm">{currencySymbol}</Text>}
              disabled={readOnly}
              value={form.creditLimit}
              onChange={(value) => set('creditLimit', value)}
            />
          </Group>

          <Select
            label="Default price tier"
            description="Which price this customer is billed at. Leave blank to use the shop default."
            placeholder="Shop default"
            data={PRICE_TIER_OPTIONS}
            value={form.priceTier}
            disabled={readOnly}
            clearable
            onChange={(value) => set('priceTier', (value as CustomerPriceTier | null) ?? null)}
            maw={320}
          />

          <Textarea
            label="Notes"
            description="Anything you want to remember about this customer."
            autosize
            minRows={2}
            disabled={readOnly}
            value={form.notes}
            onChange={(event) => set('notes', event.currentTarget.value)}
          />

          {editing && (
            <Switch
              label="Active"
              description="Switch off to retire the customer. They are never deleted — last year's credit sale still points at them, and they can still pay off an old debt."
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
