import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  SegmentedControl,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { CircleAlert, CircleCheck, HandCoins, Plus, Save, TriangleAlert } from 'lucide-react'
import type { ExpenseListItem } from '@shared/expenses'
import { formatMoney } from '@shared/money'
import { Paginator } from '../../components/Paginator'
import { LookupSelect, MoneyInput } from './ProductForm'

/**
 * EXPENSES — the shop's money going OUT on the NON-STOCK cost of running the place: rent, wages, bills,
 * transport, repairs. A purchase brings stock IN (Purchases); an expense buys none, so it lands straight
 * in the Profit & Loss. It is paid NOW from cash or bank, and MAIN posts ONE balanced journal for it.
 *
 * This screen is a paginated, filterable LIST plus a "Record expense" modal. The list is filtered by a
 * date range (Today / This month / This year / a custom range) and, optionally, by category — and it
 * shows the TOTAL spent across the WHOLE filtered range (`totalMinor`), not just the page on screen.
 *
 * WHAT THE RENDERER SENDS IS INTENT, NEVER ACCOUNTS. The form says WHAT it was for (a live
 * `expense_category` lookup), HOW MUCH, and HOW it was paid (a `payment_method` lookup) — MAIN maps the
 * category to an expense account and the method to Cash/Bank so money can never be posted to the wrong
 * place, and stamps WHO recorded it from the session. There is no category typed as free text and no
 * ledger account here, because there is no hardcoded dropdown anywhere in this app (CLAUDE.md §4).
 *
 * RECORDING is `expense.manage` + writable in MAIN — an expired-licence shop cannot book a new expense
 * until it renews, so "Record expense" is disabled in read-only mode. READING keeps working on an
 * expired licence (they can still see and export what they spent). MAIN is the boundary; disabling the
 * button is a courtesy, not a control.
 */

// ── Dates: local YYYY-MM-DD, the shape the service's `IsoDate` validates. `toISOString()` is UTC and
//    can land a day off, so we build the string from the machine's local parts. (Same as Reports.) ──
function fmtIso(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}
function todayIso(): string {
  return fmtIso(new Date())
}
function monthStartIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function yearStartIso(): string {
  return `${new Date().getFullYear()}-01-01`
}

type Preset = 'today' | 'month' | 'year' | 'custom'

const PRESETS: Array<{ label: string; value: Preset }> = [
  { label: 'Today', value: 'today' },
  { label: 'This month', value: 'month' },
  { label: 'This year', value: 'year' },
  { label: 'Custom', value: 'custom' }
]

const PAGE_SIZE = 25

/** An empty box means "cleared" for a nullable column — `.nullish()` is what the schema expects there. */
function orNull(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

export function Expenses({
  readOnly,
  currencySymbol
}: {
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [rows, setRows] = useState<ExpenseListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [totalMinor, setTotalMinor] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  const [preset, setPreset] = useState<Preset>('month')
  const [from, setFrom] = useState<string>(monthStartIso())
  const [to, setTo] = useState<string>(todayIso())
  const [categoryLookupId, setCategoryLookupId] = useState<number | null>(null)

  const [recording, setRecording] = useState(false)

  // A custom range typed backwards is a mistake, not a query — say so and don't fire it.
  const rangeInvalid = from !== '' && to !== '' && from > to

  function applyPreset(next: Preset): void {
    setPreset(next)
    // Custom keeps whatever dates are already in the two boxes so the shop can edit from there.
    if (next === 'custom') return
    const end = todayIso()
    const start = next === 'today' ? end : next === 'month' ? monthStartIso() : yearStartIso()
    setFrom(start)
    setTo(end)
  }

  // A changed filter puts us back on page 1 — page 5 of a different result set is nonsense. (The pager
  // resets the page itself when the rows-per-page changes, so that is deliberately not here.)
  useEffect(() => {
    setPage(1)
  }, [from, to, categoryLookupId])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    // A backwards range returns nothing by definition — show the empty range, not a scary error.
    if (from !== '' && to !== '' && from > to) {
      setRows([])
      setTotal(0)
      setTotalMinor(0)
      return
    }

    // The list carries `totalMinor` and the row count for the WHOLE filtered range — the summary above
    // is honest about every expense in the range, not just this page.
    const result = await window.pos.expenses.list({
      page,
      pageSize,
      from: from === '' ? undefined : from,
      to: to === '' ? undefined : to,
      categoryLookupId: categoryLookupId ?? undefined
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      setTotalMinor(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
    setTotalMinor(result.data.totalMinor)
  }, [page, pageSize, from, to, categoryLookupId])

  useEffect(() => {
    void load()
  }, [load])

  const rangeText =
    preset === 'today'
      ? 'today'
      : preset === 'month'
        ? 'this month'
        : preset === 'year'
          ? 'this year'
          : from && to
            ? `${from} to ${to}`
            : 'the selected range'

  const hasCategoryFilter = categoryLookupId !== null

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Expenses</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Money that goes out on running the shop — rent, bills, wages, transport, repairs — that does
            not buy stock. Filter by date and category; the total updates with your filter.
          </Text>
        </div>

        <Tooltip
          label="Your licence has expired — expenses cannot be recorded"
          disabled={!readOnly}
        >
          <Button leftSection={<Plus size={16} />} disabled={readOnly} onClick={() => setRecording(true)}>
            Record expense
          </Button>
        </Tooltip>
      </Group>

      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <div>
            <Text size="sm" fw={500} mb={6}>
              Period
            </Text>
            <SegmentedControl
              value={preset}
              onChange={(value) => applyPreset(value as Preset)}
              data={PRESETS}
            />
          </div>

          {preset === 'custom' && (
            <>
              <TextInput
                label="From"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.currentTarget.value)}
              />
              <TextInput
                label="To"
                type="date"
                value={to}
                onChange={(event) => setTo(event.currentTarget.value)}
              />
            </>
          )}

          <div style={{ minWidth: 240 }}>
            <LookupSelect
              listKey="expense_category"
              label="Category"
              placeholder="All categories"
              value={categoryLookupId}
              onChange={setCategoryLookupId}
              // A filter narrows what already exists; adding a new category is a job for the form.
              allowAdd={false}
            />
          </div>
        </Group>

        {rangeInvalid && (
          <Alert mt="md" color="orange" icon={<TriangleAlert size={16} />} p="xs">
            The “from” date is after the “to” date.
          </Alert>
        )}
      </Card>

      {/* ── Total across the filtered range ──────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Group gap="sm" align="center" wrap="nowrap">
            <HandCoins size={22} />
            <div>
              <Text size="sm" c="dimmed">
                Total spent {rangeText}
                {hasCategoryFilter ? ' in this category' : ''}
              </Text>
              {rows === null ? (
                <Skeleton height={28} width={150} mt={4} />
              ) : (
                <Text size="xl" fw={700}>
                  {formatMoney(totalMinor, { symbol: currencySymbol })}
                </Text>
              )}
            </div>
          </Group>
          {rows !== null && (
            <Text size="sm" c="dimmed">
              {total.toLocaleString('en-US')} {total === 1 ? 'expense' : 'expenses'}
            </Text>
          )}
        </Group>
      </Card>

      {/* ── Error ────────────────────────────────────────────────────────────── */}
      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The expenses could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      {/* ── List ─────────────────────────────────────────────────────────────── */}
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
            <HandCoins size={32} opacity={0.5} />
            <Text fw={600}>
              {hasCategoryFilter ? 'No expenses in this category' : 'No expenses in this range'}
            </Text>
            <Text size="sm" c="dimmed" ta="center" maw={460}>
              {hasCategoryFilter
                ? 'Try a different category or a wider date range, or record an expense.'
                : 'Try a wider date range, or record your shop’s running costs — rent, bills, wages, transport.'}
            </Text>
            {!readOnly && (
              <Button mt="sm" leftSection={<Plus size={16} />} onClick={() => setRecording(true)}>
                Record expense
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Payee</Table.Th>
                    <Table.Th>Method</Table.Th>
                    <Table.Th ta="right">Amount</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Text size="sm">{new Date(row.at).toLocaleDateString()}</Text>
                      </Table.Td>

                      <Table.Td>
                        {row.categoryLabel ? (
                          <Badge size="sm" variant="light" color="gray">
                            {row.categoryLabel}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" c={row.payee ? undefined : 'dimmed'}>
                          {row.payee ?? '—'}
                        </Text>
                        {row.note && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {row.note}
                          </Text>
                        )}
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" c={row.methodLabel ? undefined : 'dimmed'}>
                          {row.methodLabel ?? '—'}
                        </Text>
                      </Table.Td>

                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {formatMoney(row.amount, { symbol: currencySymbol })}
                        </Text>
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
              unit="expense"
            />
          </>
        )}
      </Card>

      <RecordExpenseModal
        opened={recording}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        onClose={() => setRecording(false)}
        onRecorded={() => {
          setRecording(false)
          void load()
        }}
      />
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The "Record expense" modal
// ═════════════════════════════════════════════════════════════════════════════

function RecordExpenseModal({
  opened,
  readOnly,
  currencySymbol,
  onClose,
  onRecorded
}: {
  opened: boolean
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  onRecorded: () => void
}): React.JSX.Element {
  const [categoryLookupId, setCategoryLookupId] = useState<number | null>(null)
  const [methodLookupId, setMethodLookupId] = useState<number | null>(null)
  /** 2-dp money, integer minor units. The canonical value is ALWAYS this integer. */
  const [amount, setAmount] = useState(0)
  const [payee, setPayee] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // A fresh box every time it opens — a stale category from last time is a wrong entry waiting to happen.
  useEffect(() => {
    if (!opened) return
    setCategoryLookupId(null)
    setMethodLookupId(null)
    setAmount(0)
    setPayee('')
    setNote('')
    setSaving(false)
  }, [opened])

  const canSave = categoryLookupId !== null && methodLookupId !== null && amount > 0

  async function save(): Promise<void> {
    // The guard also narrows the two ids to `number` for the call below (they are const this render).
    if (readOnly || categoryLookupId === null || methodLookupId === null || amount <= 0) return
    setSaving(true)

    // Send ONLY the editable fields. `userId` is never sent — MAIN stamps who recorded it from the
    // session, and MAIN decides the accounts from the category and method codes. (CLAUDE.md §4.)
    const result = await window.pos.expenses.create({
      categoryLookupId,
      amount,
      methodLookupId,
      payee: orNull(payee),
      note: orNull(note)
    })
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not record this expense',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Expense recorded',
      message: `${formatMoney(result.data.amount, { symbol: currencySymbol })}${
        result.data.categoryLabel ? ` — ${result.data.categoryLabel}` : ''
      }`
    })
    onRecorded()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Record an expense" centered size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          A running cost of the shop that does not buy stock. It is paid now from cash, bank or a wallet
          and posts one balanced entry to your books.
        </Text>

        <LookupSelect
          listKey="expense_category"
          label="Category"
          description="What the money was for. Add a new one with + if it is missing."
          placeholder="What was it for?"
          value={categoryLookupId}
          onChange={setCategoryLookupId}
          required
          disabled={readOnly}
        />

        <Group grow align="flex-start">
          <MoneyInput
            label="Amount"
            description="How much went out."
            required
            leftSection={<Text size="sm">{currencySymbol}</Text>}
            value={amount}
            onChange={setAmount}
            disabled={readOnly}
          />
          <LookupSelect
            listKey="payment_method"
            label="Paid with"
            description="Cash, bank or wallet — how it was paid."
            placeholder="How was it paid?"
            value={methodLookupId}
            onChange={setMethodLookupId}
            required
            disabled={readOnly}
          />
        </Group>

        <TextInput
          label="Payee"
          description="Who it was paid to — the landlord, the electricity company. Optional."
          value={payee}
          onChange={(event) => setPayee(event.currentTarget.value)}
          disabled={readOnly}
        />

        <Textarea
          label="Note"
          description="Anything you want to remember about this expense. Optional."
          autosize
          minRows={2}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          disabled={readOnly}
        />

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Save size={16} />}
            loading={saving}
            disabled={readOnly || !canSave}
            onClick={() => void save()}
          >
            Record expense
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
