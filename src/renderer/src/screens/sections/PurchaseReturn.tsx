import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  SegmentedControl,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  CircleAlert,
  CircleCheck,
  Layers,
  PackageX,
  Truck,
  Undo2
} from 'lucide-react'
import type {
  CreatePurchaseReturnInput,
  PurchaseReturnListItem,
  PurchaseReturnSettlement,
  ReturnablePurchase,
  ReturnablePurchaseLine
} from '@shared/purchase-returns'
import { formatMoney } from '@shared/money'
import { formatCost } from '@shared/cost'
import { formatQty } from '@shared/qty'
import { Paginator } from '../../components/Paginator'
import { LookupCodeSelect, LookupSelect, QtyInput } from './ProductForm'

/**
 * RETURN TO SUPPLIER — goods going BACK to where they came from, and the credit that follows.
 *
 * `Returns.tsx` reflected: a customer return takes stock IN and pays money OUT; this sends stock BACK OUT
 * and either lowers what the shop OWES ('supplier_credit') or brings a refund IN ('refund').
 *
 * IT LIVES ON THE PURCHASE, not on a screen of its own, because that is where the shopkeeper already is:
 * they open the bill the goods arrived on, see what is left returnable per line, and send some back. The
 * purchase IS the context — it carries the supplier, the frozen costs and the tax pool.
 *
 * ── THIS SCREEN DOES NOT DECIDE THE MONEY (CLAUDE.md §4) ────────────────────────────────────────────
 *
 * It sends INTENT — WHICH purchase line, and HOW MANY. It never sends a cost or a total. `estLineValue`
 * below is a PREVIEW so the manager can see roughly what a return is worth before committing; it is never
 * sent anywhere, and the figures shown after the return exists are MAIN's own frozen ones. Main copies
 * the purchase line's frozen 4-dp unit_cost, records the negative movement at THAT cost, and reads the
 * movement's own frozen value back as the line total — so goods leave at the cost they CAME IN AT (buy
 * 10 @ Rs 60 then 10 @ Rs 80 and send one of the FIRST tins back → Inventory falls by Rs 60, not the
 * Rs 70 average). The input tax rides back pro-rata, remainder-on-last.
 *
 * Gated 'purchaseReturn.manage' in MAIN, plus assertWritable — a manager's job, like the purchase it
 * reverses. The button below hiding itself is a courtesy, not the control.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The PREVIEW only. The authoritative figures come back from create().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PREVIEW of what sending `qtyM` of a line back is worth, scaled from the purchase line's own FROZEN
 * total, the same shape `Returns.tsx` uses (`estLineRefund`). It is an ESTIMATE and is labelled as one:
 * main recomputes it from the frozen 4-dp cost via the stock movement, and the two can differ by a paisa
 * of rounding on a partial line. Never sent anywhere — it exists so the manager is not choosing blind.
 */
function estLineValue(line: ReturnablePurchaseLine, qtyM: number): number {
  if (qtyM <= 0 || line.receivedQtyM <= 0) return 0
  return Math.round((line.lineTotal * qtyM) / line.receivedQtyM)
}

export function PurchaseReturnModal({
  purchaseId,
  opened,
  readOnly,
  currencySymbol,
  onClose,
  onDone
}: {
  purchaseId: number | null
  opened: boolean
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  /** Fired after a return is committed, so the purchase detail and the history can reload. */
  onDone: () => void
}): React.JSX.Element {
  const [purchase, setPurchase] = useState<ReturnablePurchase | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Chosen quantities, keyed by purchaseLineId. Absent = 0 = not going back.
  const [qty, setQty] = useState<Record<number, number>>({})

  const [settlement, setSettlement] = useState<PurchaseReturnSettlement>('supplier_credit')
  const [refundMethodId, setRefundMethodId] = useState<number | null>(null)
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const money = useCallback(
    (minor: number) => formatMoney(minor, { symbol: currencySymbol }),
    [currencySymbol]
  )

  // Look the bill up every time the modal opens — "already returned" moves whenever anyone sends
  // something back, so a cached copy would offer quantities that no longer exist.
  useEffect(() => {
    if (!opened || purchaseId === null) return

    let cancelled = false
    setPurchase(null)
    setLoadError(null)
    // Every choice starts from scratch. 'supplier_credit' is the default because it is the common case:
    // the credit comes off what the shop owes. A refund means real money actually came back, which is
    // the deliberate opt-in — and it forces the manager to CHOOSE the tender it arrived through.
    setQty({})
    setSettlement('supplier_credit')
    setRefundMethodId(null)
    setReasonCode(null)
    setReasonText('')
    setSubmitError(null)

    void (async () => {
      const result = await window.pos.purchaseReturns.returnableLines({ purchaseId })
      if (cancelled) return
      if (result.ok) setPurchase(result.data)
      else setLoadError(result.error.userMessage)
    })()

    return () => {
      cancelled = true
    }
  }, [opened, purchaseId])

  const setQtyFor = (line: ReturnablePurchaseLine, value: number): void =>
    setQty((current) => ({
      ...current,
      // Never let them ask for more than remains returnable — main refuses it anyway, but clamping here
      // means they never type a number that is quietly rejected on submit.
      [line.purchaseLineId]: Math.max(0, Math.min(value, line.returnableQtyM))
    }))

  const chosenLines: CreatePurchaseReturnInput['lines'] = useMemo(() => {
    if (!purchase) return []
    return purchase.lines
      .filter((line) => (qty[line.purchaseLineId] ?? 0) > 0)
      .map((line) => ({
        purchaseLineId: line.purchaseLineId,
        qtyM: qty[line.purchaseLineId] ?? 0
      }))
  }, [purchase, qty])

  // The goods' value only. The input tax rides back on top of this, pro-rata — main works that out, so
  // the estimate shown is deliberately of the NET, and labelled as excluding tax.
  const estNet = useMemo(
    () =>
      purchase
        ? purchase.lines.reduce(
            (sum, line) => sum + estLineValue(line, qty[line.purchaseLineId] ?? 0),
            0
          )
        : 0,
    [purchase, qty]
  )

  const nothingLeft = purchase != null && purchase.lines.every((line) => line.returnableQtyM <= 0)

  const canSubmit =
    !readOnly &&
    purchase != null &&
    chosenLines.length > 0 &&
    reasonCode != null &&
    (settlement !== 'refund' || refundMethodId != null)

  async function submit(): Promise<void> {
    if (!purchase || !canSubmit || submitting) return
    setSubmitting(true)
    setSubmitError(null)

    // INTENT ONLY. Note what is NOT here: unitCost, lineTotal, subtotalNet, taxTotal, grandTotal, a
    // timestamp, or a user id. Main reads the frozen cost off the original purchase line, apportions the
    // tax, stamps its own clock and takes the actor from the session. (shared/purchase-returns.ts.)
    const payload: CreatePurchaseReturnInput = {
      purchaseId: purchase.purchaseId,
      lines: chosenLines,
      settlement,
      refundMethodLookupId: settlement === 'refund' ? refundMethodId : null,
      reasonCode: reasonCode!,
      reasonText: reasonText.trim() === '' ? null : reasonText.trim(),
      notes: null
    }

    const result = await window.pos.purchaseReturns.create(payload)
    setSubmitting(false)

    if (!result.ok) {
      setSubmitError(result.error.userMessage)
      notifications.show({
        color: 'red',
        title: 'The goods could not be sent back',
        message: result.error.userMessage
      })
      return
    }

    // MAIN's frozen grand total — never the estimate this screen showed while choosing.
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Goods sent back',
      message: `${money(result.data.grandTotal)} ${
        result.data.settlement === 'supplier_credit'
          ? 'taken off what you owe'
          : 'refunded by the supplier'
      }.`,
      autoClose: 6000
    })

    onDone()
    onClose()
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      title={
        <Group gap="sm">
          <Undo2 size={20} />
          <Text fw={650} size="lg">
            Return to supplier
          </Text>
        </Group>
      }
    >
      {loadError ? (
        <Alert color="red" icon={<CircleAlert size={18} />} title="This bill could not be opened">
          {loadError}
        </Alert>
      ) : !purchase ? (
        <Stack gap={10}>
          <Skeleton height={18} width="50%" />
          <Skeleton height={140} mt="sm" />
          <Skeleton height={90} mt="sm" />
        </Stack>
      ) : (
        <Stack gap="lg">
          {/* ── Which bill ───────────────────────────────────────────────── */}
          <Group gap={8} wrap="nowrap">
            <Truck size={15} opacity={0.7} />
            <Text size="sm">
              {purchase.supplierName ?? 'Supplier'}
              {purchase.supplierInvoiceNo ? (
                <Text span c="dimmed" size="sm">
                  {' '}
                  · bill {purchase.supplierInvoiceNo}
                </Text>
              ) : null}
              <Text span c="dimmed" size="sm">
                {' '}
                · {new Date(purchase.at).toLocaleDateString()}
              </Text>
            </Text>
          </Group>

          {nothingLeft ? (
            <Stack align="center" gap="xs" py="xl">
              <PackageX size={32} opacity={0.5} />
              <Text fw={600}>Everything has already gone back</Text>
              <Text size="sm" c="dimmed" ta="center" maw={420}>
                Every line on this bill has been fully returned. There is nothing left to send back.
              </Text>
            </Stack>
          ) : (
            <>
              {/* ── The lines ────────────────────────────────────────────── */}
              <div>
                <Text fw={600} size="sm" mb={6}>
                  What is going back
                </Text>
                <Table.ScrollContainer minWidth={720}>
                  <Table withTableBorder verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Item</Table.Th>
                        <Table.Th ta="right">Received</Table.Th>
                        <Table.Th ta="right">Already back</Table.Th>
                        <Table.Th ta="right">Can go back</Table.Th>
                        <Table.Th ta="right">Unit cost</Table.Th>
                        <Table.Th style={{ width: 150 }}>Send back</Table.Th>
                        <Table.Th ta="right">Est. value</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {purchase.lines.map((line) => {
                        const exhausted = line.returnableQtyM <= 0
                        const chosen = qty[line.purchaseLineId] ?? 0
                        return (
                          <Table.Tr key={line.purchaseLineId} opacity={exhausted ? 0.55 : 1}>
                            <Table.Td>
                              <Text size="sm">{line.nameSnapshot}</Text>
                              {line.batchId !== null && (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="grape"
                                  mt={2}
                                  leftSection={<Layers size={10} />}
                                >
                                  batch
                                </Badge>
                              )}
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="sm" c="dimmed">
                                {formatQty(line.receivedQtyM)}
                                {line.uom ? (
                                  <Text span size="xs" c="dimmed">
                                    {' '}
                                    {line.uom}
                                  </Text>
                                ) : null}
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="sm" c={line.alreadyReturnedQtyM > 0 ? undefined : 'dimmed'}>
                                {line.alreadyReturnedQtyM > 0
                                  ? formatQty(line.alreadyReturnedQtyM)
                                  : '—'}
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="sm" fw={600} c={exhausted ? 'dimmed' : undefined}>
                                {formatQty(line.returnableQtyM)}
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">
                              {/* 4-dp COST — a DIFFERENT scale from money. What it leaves at. */}
                              <Text size="sm">
                                {formatCost(line.unitCost, { symbol: currencySymbol })}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              {exhausted ? (
                                <Text size="xs" c="dimmed">
                                  All sent back
                                </Text>
                              ) : (
                                <Group gap={4} wrap="nowrap">
                                  <QtyInput
                                    value={chosen}
                                    onChange={(value) => setQtyFor(line, value)}
                                    disabled={readOnly}
                                    placeholder="0"
                                  />
                                  <Tooltip label="Send the whole remaining quantity back">
                                    <Button
                                      size="compact-xs"
                                      variant="subtle"
                                      disabled={readOnly}
                                      onClick={() => setQtyFor(line, line.returnableQtyM)}
                                    >
                                      All
                                    </Button>
                                  </Tooltip>
                                </Group>
                              )}
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="sm" c={chosen > 0 ? undefined : 'dimmed'} fw={chosen > 0 ? 600 : 400}>
                                {chosen > 0 ? money(estLineValue(line, chosen)) : '—'}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        )
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </div>

              {/* ── Why, and how it settles ──────────────────────────────── */}
              <Card withBorder padding="lg">
                <Stack gap="md">
                  <Text fw={600} size="sm">
                    Why, and how it is settled
                  </Text>

                  <LookupCodeSelect
                    listKey="purchase_return_reason"
                    label="Reason"
                    description="Why the goods are going back. Add a new reason with +."
                    value={reasonCode}
                    onChange={setReasonCode}
                    disabled={readOnly}
                    required
                  />

                  <Textarea
                    label="Note (optional)"
                    description="Any extra detail — e.g. what was wrong with the delivery."
                    autosize
                    minRows={1}
                    maxRows={4}
                    maxLength={500}
                    disabled={readOnly}
                    value={reasonText}
                    onChange={(event) => setReasonText(event.currentTarget.value)}
                  />

                  <div>
                    <Text size="sm" fw={500} mb={6}>
                      Settlement
                    </Text>
                    <SegmentedControl
                      fullWidth
                      value={settlement}
                      onChange={(value) => setSettlement(value as PurchaseReturnSettlement)}
                      disabled={readOnly}
                      data={[
                        { value: 'supplier_credit', label: 'Take it off what we owe' },
                        { value: 'refund', label: 'They refunded us' }
                      ]}
                    />
                  </div>

                  {settlement === 'refund' ? (
                    <LookupSelect
                      listKey="payment_method"
                      label="How they paid it back"
                      description="The tender the refund money came back through — cash, bank or a wallet."
                      placeholder="Choose how the refund arrived…"
                      value={refundMethodId}
                      onChange={setRefundMethodId}
                      disabled={readOnly}
                      clearable={false}
                      required
                    />
                  ) : (
                    <Alert color="grape" variant="light" icon={<Truck size={16} />}>
                      <Text size="sm">
                        The credit will come off what you owe{' '}
                        <strong>{purchase.supplierName ?? 'this supplier'}</strong> — it will show on
                        their statement and lower their balance.
                      </Text>
                    </Alert>
                  )}
                </Stack>
              </Card>

              {/* ── The estimate, and the button ─────────────────────────── */}
              <Divider />

              {submitError && (
                <Alert color="red" icon={<CircleAlert size={18} />} title="The return was not recorded">
                  {submitError}
                </Alert>
              )}

              <Group justify="space-between" align="center" wrap="nowrap">
                <div>
                  <Text size="sm" c="dimmed">
                    Estimated value of the goods
                  </Text>
                  <Text size="xl" fw={700}>
                    {money(estNet)}
                  </Text>
                  <Text size="xs" c="dimmed" mt={2}>
                    {purchase.taxTotal > 0
                      ? 'Before input tax. The tax goes back with the goods — the exact figure is worked out when you send them back.'
                      : 'The exact figure is worked out when you send them back.'}
                  </Text>
                </div>

                <Group gap="sm" wrap="nowrap">
                  <Button variant="default" onClick={onClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Tooltip
                    label={
                      readOnly
                        ? 'Your licence has expired — returns are paused'
                        : chosenLines.length === 0
                          ? 'Choose how many of at least one item are going back'
                          : reasonCode == null
                            ? 'Choose a reason'
                            : 'Choose how the supplier paid the refund'
                    }
                    disabled={canSubmit}
                  >
                    <Button
                      leftSection={<Undo2 size={16} />}
                      disabled={!canSubmit}
                      loading={submitting}
                      onClick={() => void submit()}
                    >
                      Send back
                    </Button>
                  </Tooltip>
                </Group>
              </Group>
            </>
          )}
        </Stack>
      )}
    </Modal>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// THE RETURNS-TO-SUPPLIER HISTORY
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 25

/** The two settlements, in the shopkeeper's own words — never the raw enum on screen. */
const SETTLEMENT_LABEL: Record<PurchaseReturnSettlement, string> = {
  supplier_credit: 'Off what we owe',
  refund: 'Refunded'
}

const SETTLEMENT_COLOR: Record<PurchaseReturnSettlement, string> = {
  supplier_credit: 'grape',
  refund: 'blue'
}

/**
 * EVERYTHING THE SHOP HAS EVER SENT BACK — paginated over an index, newest first (CLAUDE.md §4: assume
 * years of trading, never an unbounded SELECT *). Every figure is MAIN's own frozen grand total.
 *
 * A READ ('purchase.view' in MAIN), so it keeps working on an expired licence — the shop can still see
 * and export what it sent back, it just cannot send more until it renews (CLAUDE.md §6).
 */
export function PurchaseReturnHistory({
  reloadKey,
  currencySymbol
}: {
  /** Bumped by the purchase drawer when a return commits, so this list re-pulls. */
  reloadKey: number
  currencySymbol: string
}): React.JSX.Element {
  const [rows, setRows] = useState<PurchaseReturnListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.purchaseReturns.list({ page, pageSize })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, pageSize])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  return (
    <Stack gap="lg">
      <div>
        <Text fw={650} size="lg">
          Returns to supplier
        </Text>
        <Text c="dimmed" size="sm" mt={4}>
          Everything you have sent back. Goods leave at the cost they came in at. A credit comes off what
          you owe that supplier and shows on their statement; a refund came back as real money. To send
          something back, open the bill it arrived on under Purchases.
        </Text>
      </div>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The returns could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      <Card withBorder padding="lg">
        {!rows ? (
          <Stack gap={10}>
            <Skeleton height={34} />
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <Undo2 size={32} opacity={0.5} />
            <Text fw={600}>Nothing sent back yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={460}>
              When a delivery is damaged, short or wrong, open its bill under Purchases and use Return to
              supplier. It will appear here.
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={860}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Supplier</Table.Th>
                    <Table.Th>Bill no.</Table.Th>
                    <Table.Th ta="right">Items</Table.Th>
                    <Table.Th>Settled</Table.Th>
                    <Table.Th>By</Table.Th>
                    <Table.Th ta="right">Value</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Text size="sm">{new Date(row.at).toLocaleDateString()}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={row.supplierName ? undefined : 'dimmed'}>
                          {row.supplierName ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace" c={row.purchaseInvoiceNo ? undefined : 'dimmed'}>
                          {row.purchaseInvoiceNo ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c={row.lineCount ? undefined : 'dimmed'}>
                          {row.lineCount ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={SETTLEMENT_COLOR[row.settlement]}>
                          {SETTLEMENT_LABEL[row.settlement]}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={row.userName ? undefined : 'dimmed'}>
                          {row.userName ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {formatMoney(row.grandTotal, { symbol: currencySymbol })}
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
              unit="return"
            />
          </>
        )}
      </Card>
    </Stack>
  )
}
