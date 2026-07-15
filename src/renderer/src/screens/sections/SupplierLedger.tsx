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
import { ArrowLeft, CircleAlert, HandCoins, MapPin, Pencil, Phone } from 'lucide-react'
import type {
  Supplier,
  SupplierLedgerKind,
  SupplierLedgerPage,
  SupplierLedgerRow
} from '@shared/suppliers'
import { formatMoney } from '@shared/money'
import { Paginator } from '../../components/Paginator'
import { LookupSelect, MoneyInput, useLookupList } from './ProductForm'

/**
 * ONE SUPPLIER'S ACCOUNT — the mirror of `CustomerLedger`, reflected. Where a customer OWES the shop, a
 * supplier is OWED BY it. The profile, the running balance BIG at the top, and the STATEMENT: a
 * paginated, oldest-first list of every opening payable, purchase on account and payment, with a
 * running balance down the right the way a bank statement reads.
 *
 * THE BALANCE IS DERIVED, RECOMPUTED ON READ. `supplierLedger.ledger` returns the current `balance` on
 * the page itself (CLAUDE.md §4) — opening payable + purchase payables − payments — and it reconciles,
 * to the paisa, with GL Accounts Payable. Positive = the shop OWES the supplier. It is correct no
 * matter which screen recorded a payment (CLAUDE.md trap #17): after a payment we simply re-read, and
 * the balance and the statement both move.
 *
 * A READ-ONLY licence still opens this screen and still exports — only NEW money movements are paused,
 * so "Record payment" is what a lapsed licence disables, nothing else (CLAUDE.md §6).
 */

// ═════════════════════════════════════════════════════════════════════════════
// Shared: the payable balance, coloured the way a shopkeeper reads it
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A supplier balance, coloured: RED when the shop still OWES the supplier (an outstanding payable),
 * TEAL when the shop has paid AHEAD (an advance the supplier is holding), muted when square. Positive =
 * owed by the shop. Exported because the Suppliers list shows the same figure against every row, and
 * there must be one way to colour it.
 */
export function SupplierBalanceText({
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
  /** Show the "in advance" pill next to a negative balance. Off for dense table cells. */
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
          in advance
        </Badge>
      ) : (
        <Text size="xs" c="teal">
          adv
        </Text>
      )}
    </Group>
  )
}

const KIND_BADGE: Record<SupplierLedgerKind, { color: string; label: string }> = {
  opening: { color: 'gray', label: 'Opening' },
  purchase: { color: 'blue', label: 'Purchase' },
  payment: { color: 'teal', label: 'Payment' }
}

const PAGE_SIZE = 50

// ═════════════════════════════════════════════════════════════════════════════
// The screen
// ═════════════════════════════════════════════════════════════════════════════

export function SupplierLedger({
  supplierId,
  readOnly,
  currencySymbol,
  canManage,
  canPay,
  onBack,
  onEdit
}: {
  supplierId: number
  readOnly: boolean
  currencySymbol: string
  /** Manager — may edit the supplier record (`supplier.manage` in MAIN). */
  canManage: boolean
  /** Manager — may pay a supplier down (`supplier.pay` in MAIN). */
  canPay: boolean
  onBack: () => void
  onEdit: () => void
}): React.JSX.Element {
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [supplierError, setSupplierError] = useState<string | null>(null)

  const [ledger, setLedger] = useState<SupplierLedgerPage | null>(null)
  const [ledgerError, setLedgerError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [refresh, setRefresh] = useState(0)
  const [paying, setPaying] = useState(false)

  const { items: types } = useLookupList('supplier_type')
  const typeLabel = useMemo(() => {
    if (supplier?.typeLookupId == null) return null
    return (types ?? []).find((t) => t.id === supplier.typeLookupId)?.label ?? null
  }, [types, supplier])

  // The profile — loaded once per supplier. `get` is gated `supplier.view` in MAIN, which a manager has.
  useEffect(() => {
    let cancelled = false
    setSupplier(null)
    setSupplierError(null)
    void (async () => {
      const result = await window.pos.suppliers.get({ id: supplierId })
      if (cancelled) return
      if (result.ok) setSupplier(result.data)
      else setSupplierError(result.error.userMessage)
    })()
    return () => {
      cancelled = true
    }
  }, [supplierId])

  // One page of the statement. `refresh` is bumped after a payment to force a re-read (it is an effect
  // dependency, not a callback one, so no lint complains about an unused arg).
  const loadLedger = useCallback(async (): Promise<void> => {
    setLedger(null)
    setLedgerError(null)
    const result = await window.pos.supplierLedger.ledger({ supplierId, page, pageSize })
    if (result.ok) setLedger(result.data)
    else setLedgerError(result.error.userMessage)
  }, [supplierId, page, pageSize])

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

  if (supplierError) {
    return (
      <Stack gap="lg">
        <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onBack} w="fit-content">
          Back to suppliers
        </Button>
        <Alert color="red" icon={<CircleAlert size={18} />} title="This supplier could not be opened">
          {supplierError}
        </Alert>
      </Stack>
    )
  }

  return (
    <Stack gap="lg">
      <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onBack} w="fit-content">
        Back to suppliers
      </Button>

      {/* ── Profile + the running balance, BIG ─────────────────────────────── */}
      <Card withBorder padding="lg">
        {!supplier ? (
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
                <Title order={2}>{supplier.name}</Title>
                {!supplier.isActive && (
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

              <Group gap="lg" wrap="wrap">
                {supplier.phone && (
                  <Group gap={6} wrap="nowrap">
                    <Phone size={15} opacity={0.7} />
                    <Text size="sm" ff="monospace">
                      {supplier.phone}
                    </Text>
                  </Group>
                )}
              </Group>

              {supplier.address && (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <MapPin size={15} opacity={0.7} style={{ marginTop: 2 }} />
                  <Text size="sm" c="dimmed">
                    {supplier.address}
                  </Text>
                </Group>
              )}
            </Stack>

            {/* The balance + actions */}
            <Stack gap="xs" align="flex-end">
              <Text size="sm" c="dimmed">
                {balance > 0 ? 'You owe' : balance < 0 ? 'Paid in advance' : 'Balance'}
              </Text>
              {!ledger ? (
                <Skeleton height={34} width={140} />
              ) : (
                <SupplierBalanceText
                  balance={balance}
                  currencySymbol={currencySymbol}
                  size="2rem"
                  fw={700}
                />
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
                {canPay && (
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
                )}
              </Group>
            </Stack>
          </Group>
        )}
      </Card>

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
              No opening balance, purchases on account or payments. Receiving a delivery on the Purchases
              screen, or a payment recorded here, will show up on this statement.
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
        supplierId={supplierId}
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
  row: SupplierLedgerRow
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
            ? `${formatMoney(-row.balanceAfter, { symbol: currencySymbol })} adv`
            : formatMoney(row.balanceAfter, { symbol: currencySymbol })}
        </Text>
      </Table.Td>
    </Table.Tr>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Record a payment — a payable paid down
// ═════════════════════════════════════════════════════════════════════════════

function RecordPaymentModal({
  opened,
  onClose,
  supplierId,
  currencySymbol,
  balance,
  onRecorded
}: {
  opened: boolean
  onClose: () => void
  supplierId: number
  currencySymbol: string
  /** The current balance, so we can offer "pay the full balance" when the shop owes something. */
  balance: number
  onRecorded: () => void
}): React.JSX.Element {
  const [amount, setAmount] = useState(0)
  const [methodId, setMethodId] = useState<number | null>(null)
  const [chequeNo, setChequeNo] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [walletRef, setWalletRef] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Loaded so we can read the SELECTED method's code — the cheque/wallet fields appear only for the
  // method they belong to. The LookupSelect below owns the actual control (and its inline "+ add new").
  const { items: methods } = useLookupList('payment_method')
  const selectedCode = methods?.find((m) => m.id === methodId)?.code ?? null
  const isCheque = selectedCode === 'cheque'
  const isWallet = selectedCode === 'jazzcash' || selectedCode === 'easypaisa'

  // A fresh form each time it opens — a stale amount from last time is a real-money mistake.
  useEffect(() => {
    if (!opened) return
    setAmount(0)
    setMethodId(null)
    setChequeNo('')
    setChequeDate('')
    setWalletRef('')
    setNote('')
    setBusy(false)
  }, [opened])

  const canSubmit = amount > 0 && methodId !== null && !busy

  async function submit(): Promise<void> {
    if (amount <= 0 || methodId === null) return
    setBusy(true)

    // Cheque number/date and the wallet reference belong to their own method only — a cash payment
    // sends null even if the fields hold leftover text. `userId` and `at` are stamped by MAIN, never
    // sent from here (CLAUDE.md §4).
    const result = await window.pos.supplierLedger.recordPayment({
      supplierId,
      amount,
      methodLookupId: methodId,
      chequeNo: isCheque && chequeNo.trim() !== '' ? chequeNo.trim() : null,
      chequeDate: isCheque && chequeDate !== '' ? chequeDate : null,
      walletRef: isWallet && walletRef.trim() !== '' ? walletRef.trim() : null,
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
      message: `${formatMoney(result.data.amount, { symbol: currencySymbol })} paid.`
    })
    onClose()
    onRecorded()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Record a payment" centered>
      <Stack>
        <MoneyInput
          label="Amount paid"
          description="Money the shop is paying towards what it owes this supplier."
          leftSection={<Text size="sm">{currencySymbol}</Text>}
          value={amount}
          onChange={setAmount}
          required
          autoFocus
        />

        {balance > 0 && (
          <Button variant="subtle" size="xs" w="fit-content" onClick={() => setAmount(balance)}>
            Pay the full balance ({formatMoney(balance, { symbol: currencySymbol })})
          </Button>
        )}

        <LookupSelect
          listKey="payment_method"
          label="How are you paying?"
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

        {isWallet && (
          <TextInput
            label="Transaction reference"
            value={walletRef}
            onChange={(event) => setWalletRef(event.currentTarget.value)}
          />
        )}

        <Textarea
          label="Note (optional)"
          autosize
          minRows={2}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        <Text size="xs" c="dimmed">
          Paying more than you owe is allowed — the extra becomes an advance the supplier holds for you.
          A split settlement (part cash, part cheque) is two separate payments.
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
