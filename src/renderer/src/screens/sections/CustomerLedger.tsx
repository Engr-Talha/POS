import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
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
import {
  ArrowLeft,
  Building2,
  CircleAlert,
  HandCoins,
  Hash,
  MapPin,
  Pencil,
  Phone,
  StickyNote,
  TriangleAlert
} from 'lucide-react'
import type {
  Customer,
  CustomerLedgerKind,
  CustomerLedgerPage,
  CustomerLedgerRow
} from '@shared/customers'
import { formatMoney } from '@shared/money'
import { Paginator } from '../../components/Paginator'
import { LookupSelect, MoneyInput, useLookupList } from './ProductForm'

/**
 * ONE CUSTOMER'S UDHAAR ACCOUNT — the profile, the running balance BIG at the top, and their STATEMENT:
 * a paginated, oldest-first list of every opening balance, credit sale and payment, with a running
 * balance down the right the way a bank statement reads.
 *
 * THE BALANCE IS DERIVED, RECOMPUTED ON READ. `customers.ledger` returns the current `balance` and the
 * `creditLimit` on the page itself (CLAUDE.md §4). It is correct no matter which screen recorded a
 * payment — the exact bug this codebase is strict about (a payment taken on "the other screen" that this
 * one never learns about) cannot happen, because "Record payment" here and the credit-limit check on the
 * Sell screen read and write the very same three tables (CLAUDE.md trap #17). After a payment we simply
 * re-read, and the balance and the statement both move.
 *
 * A READ-ONLY licence still opens this screen and still reprints/exports — only NEW money movements are
 * paused, so "Record payment" is what a lapsed licence disables, nothing else (CLAUDE.md §6).
 */

// ═════════════════════════════════════════════════════════════════════════════
// Shared: the udhaar balance, coloured the way a shopkeeper reads it
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A balance, coloured: RED when the customer owes the shop, GREEN when the shop owes them (they paid in
 * advance — allowed), muted when square. Positive = owed to the shop. Exported because the Customers
 * list shows the same figure against every row, and there must be one way to colour it.
 */
export function BalanceText({
  balance,
  currencySymbol,
  size = 'sm',
  fw = 600,
  withBadge = true
}: {
  balance: number
  currencySymbol: string
  size?: string
  fw?: number
  /** Show the "in credit" pill next to a negative balance. Off for dense table cells. */
  withBadge?: boolean
}): React.JSX.Element {
  if (balance === 0) {
    return (
      <Text size={size} c="dimmed">
        Settled
      </Text>
    )
  }
  if (balance > 0) {
    return (
      <Text size={size} fw={fw} c="red">
        {formatMoney(balance, { symbol: currencySymbol })}
      </Text>
    )
  }
  return (
    <Group gap={6} wrap="nowrap" justify="flex-end">
      <Text size={size} fw={fw} c="teal">
        {formatMoney(-balance, { symbol: currencySymbol })}
      </Text>
      {withBadge ? (
        <Badge size="xs" variant="light" color="teal">
          in credit
        </Badge>
      ) : (
        <Text size="xs" c="teal">
          cr
        </Text>
      )}
    </Group>
  )
}

const KIND_BADGE: Record<CustomerLedgerKind, { color: string; label: string }> = {
  opening: { color: 'gray', label: 'Opening' },
  sale: { color: 'blue', label: 'Credit sale' },
  payment: { color: 'teal', label: 'Payment' }
}

const PAGE_SIZE = 50

// ═════════════════════════════════════════════════════════════════════════════
// The screen
// ═════════════════════════════════════════════════════════════════════════════

export function CustomerLedger({
  customerId,
  readOnly,
  currencySymbol,
  canManage,
  onBack,
  onEdit
}: {
  customerId: number
  readOnly: boolean
  currencySymbol: string
  /** Owner — may edit the customer record (create/edit is `settings.manage` in MAIN). */
  canManage: boolean
  onBack: () => void
  onEdit: () => void
}): React.JSX.Element {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [customerError, setCustomerError] = useState<string | null>(null)

  const [ledger, setLedger] = useState<CustomerLedgerPage | null>(null)
  const [ledgerError, setLedgerError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [refresh, setRefresh] = useState(0)
  const [paying, setPaying] = useState(false)

  const { items: types } = useLookupList('customer_type')
  const typeLabel = useMemo(() => {
    if (customer?.typeLookupId == null) return null
    return (types ?? []).find((t) => t.id === customer.typeLookupId)?.label ?? null
  }, [types, customer])

  // The profile — loaded once per customer. `get` is gated `sale.create` in MAIN, which a manager has.
  useEffect(() => {
    let cancelled = false
    setCustomer(null)
    setCustomerError(null)
    void (async () => {
      const result = await window.pos.customers.get({ id: customerId })
      if (cancelled) return
      if (result.ok) setCustomer(result.data)
      else setCustomerError(result.error.userMessage)
    })()
    return () => {
      cancelled = true
    }
  }, [customerId])

  // One page of the statement. `refresh` is bumped after a payment to force a re-read (it is an effect
  // dependency, not a callback one, so no lint complains about an unused arg).
  const loadLedger = useCallback(async (): Promise<void> => {
    setLedger(null)
    setLedgerError(null)
    const result = await window.pos.customers.ledger({ customerId, page, pageSize })
    if (result.ok) setLedger(result.data)
    else setLedgerError(result.error.userMessage)
  }, [customerId, page, pageSize])

  useEffect(() => {
    void loadLedger()
  }, [loadLedger, refresh])

  function afterPayment(): void {
    // The statement is oldest-first, so a new payment lands on the LAST page — jump there so the
    // shopkeeper sees it. The big balance up top re-reads and moves regardless of which page we are on.
    const newTotal = (ledger?.total ?? 0) + 1
    setPage(Math.max(1, Math.ceil(newTotal / pageSize)))
    setRefresh((current) => current + 1)
  }

  const balance = ledger?.balance ?? 0
  const creditLimit = ledger?.creditLimit ?? customer?.creditLimit ?? 0
  const overLimit = ledger !== null && creditLimit > 0 && balance > creditLimit

  if (customerError) {
    return (
      <Stack gap="lg">
        <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onBack} w="fit-content">
          Back to customers
        </Button>
        <Alert color="red" icon={<CircleAlert size={18} />} title="This customer could not be opened">
          {customerError}
        </Alert>
      </Stack>
    )
  }

  return (
    <Stack gap="lg">
      <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onBack} w="fit-content">
        Back to customers
      </Button>

      {/* ── Profile + the running balance, BIG ─────────────────────────────── */}
      <Card withBorder padding="lg">
        {!customer ? (
          <Stack gap={10}>
            <Skeleton height={28} width={260} />
            <Skeleton height={16} width={180} />
            <Skeleton height={16} width={220} />
          </Stack>
        ) : (
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xl">
            {/* Identity */}
            <Stack gap={8} style={{ flex: 1, minWidth: 260 }}>
              <Group gap="sm" align="center">
                <Title order={2}>{customer.name}</Title>
                {!customer.isActive && (
                  <Badge color="gray" variant="light">
                    Retired
                  </Badge>
                )}
                {typeLabel && (
                  <Badge color="gray" variant="light">
                    {typeLabel}
                  </Badge>
                )}
              </Group>

              {customer.businessName && (
                <Group gap={6} wrap="nowrap">
                  <Building2 size={15} opacity={0.7} />
                  <Text size="sm">{customer.businessName}</Text>
                </Group>
              )}

              <Group gap="lg" wrap="wrap">
                {customer.phone && (
                  <Group gap={6} wrap="nowrap">
                    <Phone size={15} opacity={0.7} />
                    <Text size="sm" ff="monospace">
                      {customer.phone}
                    </Text>
                  </Group>
                )}
                {customer.taxNumber && (
                  <Group gap={6} wrap="nowrap">
                    <Hash size={15} opacity={0.7} />
                    <Text size="sm">{customer.taxNumber}</Text>
                  </Group>
                )}
              </Group>

              {customer.address && (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <MapPin size={15} opacity={0.7} style={{ marginTop: 2 }} />
                  <Text size="sm" c="dimmed">
                    {customer.address}
                  </Text>
                </Group>
              )}

              {customer.notes && (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <StickyNote size={15} opacity={0.7} style={{ marginTop: 2 }} />
                  <Text size="sm" c="dimmed">
                    {customer.notes}
                  </Text>
                </Group>
              )}
            </Stack>

            {/* The balance + actions */}
            <Stack gap="xs" align="flex-end">
              <Text size="sm" c="dimmed">
                {balance > 0 ? 'Owes the shop' : balance < 0 ? 'Holding credit' : 'Balance'}
              </Text>
              {!ledger ? (
                <Skeleton height={34} width={140} />
              ) : (
                <BalanceText balance={balance} currencySymbol={currencySymbol} size="2rem" fw={700} />
              )}
              {creditLimit > 0 && (
                <Text size="xs" c="dimmed">
                  Credit limit {formatMoney(creditLimit, { symbol: currencySymbol })}
                </Text>
              )}

              <Group gap="xs" mt="sm">
                {canManage && (
                  <Tooltip label="Your licence has expired" disabled={!readOnly}>
                    <Button
                      variant="default"
                      leftSection={<Pencil size={16} />}
                      disabled={readOnly}
                      onClick={onEdit}
                    >
                      Edit
                    </Button>
                  </Tooltip>
                )}
                <Tooltip
                  label="Your licence has expired — new payments are paused"
                  disabled={!readOnly}
                >
                  <Button
                    leftSection={<HandCoins size={16} />}
                    disabled={readOnly}
                    onClick={() => setPaying(true)}
                  >
                    Record payment
                  </Button>
                </Tooltip>
              </Group>
            </Stack>
          </Group>
        )}
      </Card>

      {overLimit && (
        <Alert color="orange" icon={<TriangleAlert size={18} />} title="Over their credit limit">
          They owe {formatMoney(balance, { symbol: currencySymbol })}, above the limit of{' '}
          {formatMoney(creditLimit, { symbol: currencySymbol })}. New credit sales may be blocked at the
          till, depending on your settings.
        </Alert>
      )}

      {/* ── The statement ──────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Text fw={600} mb="md">
          Statement
        </Text>

        {ledgerError ? (
          <Alert color="red" icon={<CircleAlert size={18} />} title="The statement could not be loaded">
            {ledgerError}
            <Group mt="sm">
              <Button size="xs" variant="default" onClick={() => void loadLedger()}>
                Try again
              </Button>
            </Group>
          </Alert>
        ) : !ledger ? (
          <Stack gap={10}>
            <Skeleton height={34} />
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
          </Stack>
        ) : ledger.rows.length === 0 ? (
          <Stack align="center" gap="xs" py="xl">
            <HandCoins size={32} opacity={0.5} />
            <Text fw={600}>Nothing on this account yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              No opening balance, credit sales or payments. A credit (udhaar) sale on the Sell screen, or
              an advance payment recorded here, will show up on this statement.
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={720}>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Detail</Table.Th>
                    <Table.Th ta="right">Charge</Table.Th>
                    <Table.Th ta="right">Payment</Table.Th>
                    <Table.Th ta="right">Balance</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {ledger.rows.map((row) => (
                    <StatementRow
                      key={`${row.kind}-${row.refId}`}
                      row={row}
                      currencySymbol={currencySymbol}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            <Paginator
              page={page}
              pageSize={pageSize}
              total={ledger.total}
              onPage={setPage}
              onPageSize={setPageSize}
              unit="entry"
              units="entries"
            />
          </>
        )}
      </Card>

      <RecordPaymentModal
        opened={paying}
        onClose={() => setPaying(false)}
        customerId={customerId}
        currencySymbol={currencySymbol}
        balance={balance}
        onRecorded={afterPayment}
      />
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// One statement row
// ═════════════════════════════════════════════════════════════════════════════

function StatementRow({
  row,
  currencySymbol
}: {
  row: CustomerLedgerRow
  currencySymbol: string
}): React.JSX.Element {
  const badge = KIND_BADGE[row.kind]
  const balanceColor = row.balanceAfter > 0 ? 'red' : row.balanceAfter < 0 ? 'teal' : 'dimmed'

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm">{new Date(row.at).toLocaleDateString()}</Text>
      </Table.Td>
      <Table.Td>
        <Group gap={8} wrap="nowrap">
          <Badge size="xs" variant="light" color={badge.color}>
            {badge.label}
          </Badge>
          <Text size="sm">{row.description}</Text>
        </Group>
      </Table.Td>
      <Table.Td ta="right">
        {row.charge > 0 ? (
          <Text size="sm">{formatMoney(row.charge, { symbol: currencySymbol })}</Text>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td ta="right">
        {row.payment > 0 ? (
          <Text size="sm" c="teal">
            {formatMoney(row.payment, { symbol: currencySymbol })}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm" fw={600} c={balanceColor}>
          {row.balanceAfter < 0
            ? `${formatMoney(-row.balanceAfter, { symbol: currencySymbol })} cr`
            : formatMoney(row.balanceAfter, { symbol: currencySymbol })}
        </Text>
      </Table.Td>
    </Table.Tr>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Record a payment — udhaar paid back
// ═════════════════════════════════════════════════════════════════════════════

function RecordPaymentModal({
  opened,
  onClose,
  customerId,
  currencySymbol,
  balance,
  onRecorded
}: {
  opened: boolean
  onClose: () => void
  customerId: number
  currencySymbol: string
  /** The current balance, so we can offer "pay the full balance" when they owe something. */
  balance: number
  onRecorded: () => void
}): React.JSX.Element {
  const [amount, setAmount] = useState(0)
  const [methodId, setMethodId] = useState<number | null>(null)
  const [chequeNo, setChequeNo] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Loaded so we can read the SELECTED method's code — the cheque fields appear only for a cheque. The
  // list is tiny; the LookupSelect below owns the actual control (and its inline "+ add new").
  const { items: methods } = useLookupList('payment_method')
  const selectedCode = methods?.find((m) => m.id === methodId)?.code ?? null
  const isCheque = selectedCode === 'cheque'

  // A fresh form each time it opens — a stale amount from last time is a real-money mistake.
  useEffect(() => {
    if (!opened) return
    setAmount(0)
    setMethodId(null)
    setChequeNo('')
    setChequeDate('')
    setNote('')
    setBusy(false)
  }, [opened])

  const canSubmit = amount > 0 && methodId !== null && !busy

  async function submit(): Promise<void> {
    if (amount <= 0 || methodId === null) return
    setBusy(true)

    // Cheque number/date belong to a cheque only — a cash payment sends null even if the fields hold
    // leftover text. `userId` and `at` are stamped by MAIN, never sent from here (CLAUDE.md §4).
    const result = await window.pos.customers.recordPayment({
      customerId,
      amount,
      methodLookupId: methodId,
      chequeNo: isCheque && chequeNo.trim() !== '' ? chequeNo.trim() : null,
      chequeDate: isCheque && chequeDate !== '' ? chequeDate : null,
      note: note.trim() === '' ? null : note.trim()
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Payment not recorded',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      title: 'Payment recorded',
      message: `${formatMoney(result.data.amount, { symbol: currencySymbol })} received.`
    })
    onClose()
    onRecorded()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Record a payment" centered>
      <Stack>
        <MoneyInput
          label="Amount received"
          description="Money the customer is paying towards their udhaar."
          leftSection={<Text size="sm">{currencySymbol}</Text>}
          value={amount}
          onChange={setAmount}
          required
          autoFocus
        />

        {balance > 0 && (
          <Button
            variant="subtle"
            size="xs"
            w="fit-content"
            onClick={() => setAmount(balance)}
          >
            Pay the full balance ({formatMoney(balance, { symbol: currencySymbol })})
          </Button>
        )}

        <LookupSelect
          listKey="payment_method"
          label="How are they paying?"
          placeholder="Choose a method…"
          value={methodId}
          onChange={setMethodId}
          required
          clearable={false}
        />

        {isCheque && (
          <Group grow align="flex-start">
            <TextInput
              label="Cheque number"
              value={chequeNo}
              onChange={(event) => setChequeNo(event.currentTarget.value)}
            />
            <TextInput
              label="Cheque date"
              type="date"
              value={chequeDate}
              onChange={(event) => setChequeDate(event.currentTarget.value)}
            />
          </Group>
        )}

        <Textarea
          label="Note (optional)"
          autosize
          minRows={2}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        <Text size="xs" c="dimmed">
          Paying more than they owe is allowed — the extra becomes credit the shop holds for them. A
          split settlement (part cash, part cheque) is two separate payments.
        </Text>

        <Divider />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            leftSection={<HandCoins size={16} />}
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            Record payment
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
