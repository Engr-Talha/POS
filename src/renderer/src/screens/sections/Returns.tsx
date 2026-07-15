import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Drawer,
  Group,
  Modal,
  PasswordInput,
  SegmentedControl,
  Skeleton,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Clock,
  Minus,
  PackageCheck,
  PackageX,
  Receipt,
  ReceiptText,
  Search,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  User as UserIcon,
  Wallet
} from 'lucide-react'
import type {
  CreateReturnInput,
  ReturnableLine,
  ReturnableSale,
  ReturnDetail,
  ReturnListItem,
  Settlement
} from '@shared/returns'
import type { SaleListItem } from '@shared/sales'
import { type Role, roleCan } from '@shared/rbac'
import { formatMoney } from '@shared/money'
import { formatQty } from '@shared/qty'
import { Paginator } from '../../components/Paginator'
import { LookupCodeSelect, LookupSelect, QtyInput, useLookupList } from './ProductForm'

/**
 * RETURNS & REFUNDS — goods coming BACK, and the money that goes back with them.
 *
 * The inverse of a sale, and it obeys the same disciplines. THE RENDERER SENDS INTENT, MAIN DECIDES
 * THE MONEY (shared/returns.ts): a return line says WHICH sale line came back and HOW MANY — never what
 * to refund. Main reads the FROZEN net/tax/cost off the original sale line, scales it, and freezes the
 * result. Every money figure this screen shows BEFORE submit is therefore an ESTIMATE for the cashier's
 * eye; the authoritative numbers come back on the `ReturnDetail` and are what the summary displays.
 *
 * WHO CAN DO WHAT — the UI mirrors the gates MAIN actually enforces (CLAUDE.md §4; the UI is a courtesy,
 * never the control):
 *   - looking a sale up (returnableLines) and reading a return (get) is `sale.create` — a cashier's gate.
 *   - PROCESSING a return (create) is `sale.refund` — a SUPERVISOR action, and main's handler requires
 *     the SIGNED-IN user to hold it. So the nav entry that reaches this screen is gated `sale.refund`:
 *     everyone here can already complete the headline action, and nobody is greeted with a red refusal.
 *     The supervisor-PIN prompt below is still wired for a sub-supervisor actor (the shared contract and
 *     service support `approverPin`); it simply does not fire while the nav gate keeps cashiers out.
 *   - the RETURNS HISTORY (list) and the recent-sales picker are `report.view` — a manager's view. A
 *     supervisor sees the process flow but not those, so both are shown only to managers and owners.
 */

const SETTLEMENT_LABEL: Record<Settlement, string> = {
  refund: 'Refund',
  customer_credit: 'Customer account',
  exchange: 'Exchange'
}

const SETTLEMENT_COLOR: Record<Settlement, string> = {
  refund: 'blue',
  customer_credit: 'grape',
  exchange: 'gray'
}

const PAGE_SIZE = 25

/**
 * An ESTIMATE of what returning `qtyM` of a line is worth, scaled from the sale line's frozen gross.
 * Main does the exact remainder-on-last arithmetic; this is only so the cashier sees a number while
 * choosing. It is never sent anywhere — the refund total this screen trusts is the one main returns.
 */
function estLineRefund(line: ReturnableLine, qtyM: number): number {
  if (qtyM <= 0 || line.soldQtyM <= 0) return 0
  return Math.round((line.gross * qtyM) / line.soldQtyM)
}

export function Returns({
  userRole,
  readOnly,
  currencySymbol
}: {
  userRole: Role
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [tab, setTab] = useState<string | null>('process')

  // Browsing the whole shop's returns, and the recent-sales shortcut, are a manager's report — the
  // same `report.view` gate main puts on `returns:list` and `sale:list`. A supervisor still processes
  // returns by looking a sale up; they just do not get the history browse.
  const canViewHistory = roleCan(userRole, 'report.view')

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Returns &amp; refunds</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Bring goods back against a completed sale. Look the sale up, choose what is coming back and how
          much, then refund it or put it on the customer&apos;s account. The refund is worked out from the
          original sale — never re-priced here.
        </Text>
      </div>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="process" leftSection={<Undo2 size={16} />}>
            Process a return
          </Tabs.Tab>
          {canViewHistory && (
            <Tabs.Tab value="history" leftSection={<ReceiptText size={16} />}>
              Returns history
            </Tabs.Tab>
          )}
        </Tabs.List>

        <Tabs.Panel value="process" pt="lg">
          <ProcessReturn
            userRole={userRole}
            readOnly={readOnly}
            currencySymbol={currencySymbol}
            canPickRecent={canViewHistory}
          />
        </Tabs.Panel>

        {canViewHistory && (
          <Tabs.Panel value="history" pt="lg">
            <ReturnsHistory currencySymbol={currencySymbol} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// PROCESS A RETURN — find the sale, pick the lines, settle it.
// ═════════════════════════════════════════════════════════════════════════════

function ProcessReturn({
  userRole,
  readOnly,
  currencySymbol,
  canPickRecent
}: {
  userRole: Role
  readOnly: boolean
  currencySymbol: string
  canPickRecent: boolean
}): React.JSX.Element {
  const money = (value: number): string => formatMoney(value, { symbol: currencySymbol })

  // The sale being returned against, once looked up. Null = still on the find step.
  const [sale, setSale] = useState<ReturnableSale | null>(null)
  const [ref, setRef] = useState('')
  const [finding, setFinding] = useState(false)
  const [findError, setFindError] = useState<string | null>(null)

  // The chosen quantities and restock flags, keyed by saleLineId. Absent = 0 / restock (the default).
  const [qty, setQty] = useState<Record<number, number>>({})
  const [damaged, setDamaged] = useState<Record<number, boolean>>({})

  const [settlement, setSettlement] = useState<Settlement>('refund')
  const [refundMethodId, setRefundMethodId] = useState<number | null>(null)
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // The supervisor-approval prompt. True while we wait for a supervisor's PIN. The PIN never leaves the
  // modal except as the argument to submit() — it is not stored, logged, or put in this component's state.
  const [pinOpen, setPinOpen] = useState(false)

  // The frozen return main gave back. Non-null = the settle step is done and we show the summary.
  const [done, setDone] = useState<ReturnDetail | null>(null)

  const loadSale = useCallback(async (lookup: number | string): Promise<void> => {
    setFinding(true)
    setFindError(null)
    const result = await window.pos.returns.returnableLines({ ref: lookup })
    setFinding(false)

    if (!result.ok) {
      setFindError(result.error.userMessage)
      return
    }
    // A fresh sale starts every choice from scratch. Default to 'refund' — money back is the canonical
    // return, and it is the safe default: it forces the cashier to CHOOSE a payment method rather than
    // silently crediting an account. Putting it on the customer's udhaar is a deliberate opt-in.
    setSale(result.data)
    setQty({})
    setDamaged({})
    setSettlement('refund')
    setRefundMethodId(null)
    setReasonCode(null)
    setReasonText('')
    setSubmitError(null)
  }, [])

  function find(): void {
    const trimmed = ref.trim()
    if (trimmed === '') return
    // Pass the invoice number as typed — main dispatches a numeric string to an invoice-number lookup,
    // never to sale-row N, so "123" finds invoice "123". (shared/ipc.ts ReturnableLinesInput.)
    void loadSale(trimmed)
  }

  function reset(): void {
    setSale(null)
    setDone(null)
    setRef('')
    setFindError(null)
    setQty({})
    setDamaged({})
    setSubmitError(null)
  }

  const setQtyFor = (line: ReturnableLine, value: number): void =>
    setQty((current) => ({
      ...current,
      // Never let the cashier ask for more than remains returnable — main refuses it, but clamping
      // here means they never type a number that is quietly rejected later.
      [line.saleLineId]: Math.max(0, Math.min(value, line.returnableQtyM))
    }))

  const chosenLines: CreateReturnInput['lines'] = useMemo(() => {
    if (!sale) return []
    return sale.lines
      .filter((line) => (qty[line.saleLineId] ?? 0) > 0)
      .map((line) => ({
        saleLineId: line.saleLineId,
        qtyM: qty[line.saleLineId] ?? 0,
        // "Damaged" means it does NOT go back on the sellable shelf, so the shop eats the cost.
        restocked: !(damaged[line.saleLineId] ?? false)
      }))
  }, [sale, qty, damaged])

  const estTotal = useMemo(
    () =>
      sale
        ? sale.lines.reduce((sum, line) => sum + estLineRefund(line, qty[line.saleLineId] ?? 0), 0)
        : 0,
    [sale, qty]
  )

  const canSubmit =
    !readOnly &&
    sale != null &&
    chosenLines.length > 0 &&
    reasonCode != null &&
    (settlement !== 'refund' || refundMethodId != null)

  async function submit(approverPin: string | null): Promise<void> {
    if (!sale || !canSubmit) return
    setSubmitting(true)
    setSubmitError(null)

    // INTENT ONLY. Note what is NOT here: net, tax, gross, unitCost, a timestamp, or who approved it.
    // Main reads the frozen figures off the original sale, stamps the clock and derives the approver.
    const payload: CreateReturnInput = {
      saleId: sale.saleId,
      lines: chosenLines,
      settlement,
      refundMethodLookupId: settlement === 'refund' ? refundMethodId : null,
      reasonCode: reasonCode!,
      reasonText: reasonText.trim() === '' ? null : reasonText.trim(),
      // The supervisor's PIN, present only when a sub-supervisor actor needed one to approve. Main
      // verifies it and derives WHO approved — we never send a user id. (shared/returns.ts.)
      approverPin,
      notes: null
    }

    const result = await window.pos.returns.create(payload)
    setSubmitting(false)

    if (!result.ok) {
      setSubmitError(result.error.userMessage)
      notifications.show({
        color: 'red',
        title: 'The return could not be processed',
        message: result.error.userMessage
      })
      return
    }

    setDone(result.data)
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Return processed',
      message: `${money(result.data.grandTotal)} ${
        result.data.settlement === 'refund' ? 'refunded' : 'credited to the account'
      }.`,
      autoClose: 6000
    })
  }

  function attemptSubmit(): void {
    if (!canSubmit || submitting) return
    // A supervisor (or above) authorises their own; anyone below is asked for a supervisor's PIN. The
    // service re-checks the role in main regardless — this is the courtesy, not the control.
    if (roleCan(userRole, 'sale.refund')) {
      void submit(null)
    } else {
      setPinOpen(true)
    }
  }

  // ── The summary, once it is done ─────────────────────────────────────────────
  if (done) {
    return <RefundSummary detail={done} currencySymbol={currencySymbol} onAnother={reset} />
  }

  // ── The builder, once a sale is loaded ───────────────────────────────────────
  if (sale) {
    // Only a COMPLETED sale can be returned — main refuses anything else. `returnableLines` hands back
    // the sale whatever its status, so we say so here rather than letting the cashier build a return
    // that submit would reject. (services/returns.ts createReturn.)
    if (sale.status !== 'completed') {
      return (
        <Stack gap="lg">
          <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={reset} w="fit-content">
            Look up a different sale
          </Button>
          <Alert
            color="orange"
            icon={<TriangleAlert size={18} />}
            title="Nothing can be returned against this sale"
          >
            {sale.status === 'voided'
              ? `${sale.invoiceNo ?? 'This sale'} was cancelled, so there is nothing to return against it.`
              : 'Only a completed sale can be returned. A parked cart or a saved quote is not a sale yet.'}
          </Alert>
        </Stack>
      )
    }

    const returnable = sale.lines.filter((line) => line.returnableQtyM > 0)
    const nothingLeft = returnable.length === 0

    return (
      <>
        <Stack gap="lg">
          <Group justify="space-between" align="center">
            <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={reset}>
              Look up a different sale
            </Button>
            {returnable.length > 0 && !readOnly && (
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() =>
                    setQty(() => {
                      const next: Record<number, number> = {}
                      for (const line of returnable) next[line.saleLineId] = line.returnableQtyM
                      return next
                    })
                  }
                >
                  Return everything
                </Button>
                <Button size="xs" variant="subtle" color="gray" onClick={() => setQty({})}>
                  Clear
                </Button>
              </Group>
            )}
          </Group>

          {readOnly && (
            <Alert color="orange" icon={<TriangleAlert size={18} />}>
              Your licence has expired, so no new return can be processed. You can still look sales up and
              browse past returns.
            </Alert>
          )}

          {/* ── The sale being returned against ──────────────────────────────── */}
          <Card withBorder padding="lg">
            <Group justify="space-between" wrap="wrap" gap="md">
              <Stack gap={6}>
                <Group gap={8} wrap="nowrap">
                  <ReceiptText size={18} />
                  <Text fw={650} size="lg">
                    {sale.invoiceNo ?? `Sale #${sale.saleId}`}
                  </Text>
                  <Badge variant="light" color="teal">
                    Completed
                  </Badge>
                </Group>
                <Group gap={8} wrap="nowrap">
                  <Clock size={14} opacity={0.7} />
                  <Text size="sm" c="dimmed">
                    {new Date(sale.at).toLocaleString()}
                  </Text>
                </Group>
              </Stack>
              <Group gap={8} wrap="nowrap">
                <UserIcon size={15} opacity={0.7} />
                <Text size="sm" c={sale.customerName ? undefined : 'dimmed'}>
                  {sale.customerName ?? 'Walk-in customer'}
                </Text>
              </Group>
            </Group>
          </Card>

          {/* ── The lines ────────────────────────────────────────────────────── */}
          {nothingLeft ? (
            <Card withBorder padding="lg">
              <Stack align="center" gap="xs" py="lg">
                <PackageCheck size={32} opacity={0.5} />
                <Text fw={600}>Everything on this sale has already come back</Text>
                <Text size="sm" c="dimmed" ta="center" maw={420}>
                  Every line has been fully returned. There is nothing left to refund against{' '}
                  {sale.invoiceNo ?? `sale #${sale.saleId}`}.
                </Text>
              </Stack>
            </Card>
          ) : (
            <Card withBorder padding="lg">
              <Text fw={600} size="sm" mb="sm">
                What is coming back?
              </Text>
              <Table.ScrollContainer minWidth={940}>
                <Table verticalSpacing="sm" withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Item</Table.Th>
                      <Table.Th ta="right">Sold</Table.Th>
                      <Table.Th ta="right">Already back</Table.Th>
                      <Table.Th ta="right">Returnable</Table.Th>
                      <Table.Th>Return qty</Table.Th>
                      <Table.Th>Condition</Table.Th>
                      <Table.Th ta="right">Est. refund</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {sale.lines.map((line) => {
                      const chosen = qty[line.saleLineId] ?? 0
                      const isDamaged = damaged[line.saleLineId] ?? false
                      const exhausted = line.returnableQtyM <= 0

                      return (
                        <Table.Tr key={line.saleLineId} opacity={exhausted ? 0.55 : 1}>
                          <Table.Td>
                            <Text size="sm">{line.nameSnapshot}</Text>
                            <Group gap={6} mt={2}>
                              {line.isOpenItem && (
                                <Badge size="xs" variant="light" color="grape">
                                  open item
                                </Badge>
                              )}
                              {exhausted && (
                                <Badge size="xs" variant="light" color="gray">
                                  fully returned
                                </Badge>
                              )}
                            </Group>
                          </Table.Td>

                          <Table.Td ta="right">
                            <Qty value={line.soldQtyM} uom={line.uom} />
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm" c={line.alreadyReturnedQtyM > 0 ? undefined : 'dimmed'}>
                              {formatQty(line.alreadyReturnedQtyM)}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm" fw={600}>
                              {formatQty(line.returnableQtyM)}
                            </Text>
                          </Table.Td>

                          <Table.Td>
                            {exhausted ? (
                              <Text size="sm" c="dimmed">
                                —
                              </Text>
                            ) : (
                              <Group gap={6} wrap="nowrap" align="flex-end">
                                <div style={{ width: 110 }}>
                                  <QtyInput
                                    value={chosen}
                                    onChange={(value) => setQtyFor(line, value)}
                                    disabled={readOnly}
                                  />
                                </div>
                                <Tooltip label="Return the whole returnable quantity">
                                  <Button
                                    size="xs"
                                    variant="light"
                                    disabled={readOnly}
                                    onClick={() => setQtyFor(line, line.returnableQtyM)}
                                  >
                                    Full
                                  </Button>
                                </Tooltip>
                              </Group>
                            )}
                          </Table.Td>

                          <Table.Td>
                            {exhausted ? (
                              <Text size="sm" c="dimmed">
                                —
                              </Text>
                            ) : (
                              <Tooltip
                                label={
                                  isDamaged
                                    ? 'Damaged — the shop keeps the cost, it does not go back on the shelf'
                                    : 'Good — goes back on the sellable shelf'
                                }
                              >
                                <Switch
                                  size="sm"
                                  color="red"
                                  checked={isDamaged}
                                  disabled={readOnly || chosen <= 0}
                                  onChange={(event) =>
                                    setDamaged((current) => ({
                                      ...current,
                                      [line.saleLineId]: event.currentTarget.checked
                                    }))
                                  }
                                  thumbIcon={
                                    isDamaged ? (
                                      <PackageX size={12} color="var(--mantine-color-red-6)" />
                                    ) : (
                                      <PackageCheck size={12} color="var(--mantine-color-teal-6)" />
                                    )
                                  }
                                  label={
                                    <Text size="xs" c={isDamaged ? 'red' : 'dimmed'}>
                                      {isDamaged ? 'Damaged' : 'Restock'}
                                    </Text>
                                  }
                                />
                              </Tooltip>
                            )}
                          </Table.Td>

                          <Table.Td ta="right">
                            <Text
                              size="sm"
                              c={chosen > 0 ? undefined : 'dimmed'}
                              fw={chosen > 0 ? 600 : 400}
                            >
                              {money(estLineRefund(line, chosen))}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      )
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          )}

          {/* ── Reason & settlement ──────────────────────────────────────────── */}
          {!nothingLeft && (
            <Card withBorder padding="lg">
              <Stack gap="md">
                <Text fw={600} size="sm">
                  Why, and how it is settled
                </Text>

                <LookupCodeSelect
                  listKey="refund_reason"
                  label="Reason"
                  description="Why the goods came back. Add a new reason with +."
                  value={reasonCode}
                  onChange={setReasonCode}
                  disabled={readOnly}
                  required
                />

                <Textarea
                  label="Note (optional)"
                  description="Any extra detail — e.g. what was wrong with the item."
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
                    onChange={(value) => setSettlement(value as Settlement)}
                    disabled={readOnly}
                    data={[
                      { value: 'refund', label: 'Refund the money' },
                      {
                        value: 'customer_credit',
                        label: 'Apply to customer account',
                        disabled: sale.customerId == null
                      }
                    ]}
                  />
                  {sale.customerId == null && (
                    <Text size="xs" c="dimmed" mt={6}>
                      This was a walk-in sale with no customer, so it can only be refunded.
                    </Text>
                  )}
                </div>

                {settlement === 'refund' ? (
                  <LookupSelect
                    listKey="payment_method"
                    label="Payment method"
                    description="The tender the refund money goes back out through."
                    placeholder="Choose how the refund is paid…"
                    value={refundMethodId}
                    onChange={setRefundMethodId}
                    disabled={readOnly}
                    clearable={false}
                    required
                  />
                ) : (
                  <Alert color="grape" variant="light" icon={<Wallet size={16} />}>
                    <Text size="sm">
                      {money(estTotal)} (estimated) will be taken off{' '}
                      <strong>{sale.customerName ?? 'the customer'}</strong>&apos;s udhaar balance instead
                      of being paid out.
                    </Text>
                  </Alert>
                )}
              </Stack>
            </Card>
          )}

          {/* ── The total & the button ───────────────────────────────────────── */}
          {!nothingLeft && (
            <Card withBorder padding="lg">
              <Group justify="space-between" align="center" wrap="wrap" gap="md">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                    Estimated refund
                  </Text>
                  <Text size="xl" fw={700}>
                    {money(estTotal)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    The exact amount is worked out from the original sale when you submit.
                  </Text>
                </Stack>

                <Button
                  size="md"
                  leftSection={<Undo2 size={18} />}
                  loading={submitting}
                  disabled={!canSubmit}
                  onClick={attemptSubmit}
                >
                  {settlement === 'refund' ? 'Refund' : 'Credit'} {money(estTotal)}
                </Button>
              </Group>

              {submitError && (
                <Alert color="red" icon={<CircleAlert size={16} />} mt="md">
                  {submitError}
                </Alert>
              )}
            </Card>
          )}
        </Stack>

        <SupervisorPinModal
          opened={pinOpen}
          onCancel={() => setPinOpen(false)}
          onApprove={(pin) => {
            setPinOpen(false)
            void submit(pin)
          }}
        />
      </>
    )
  }

  // ── The find step ────────────────────────────────────────────────────────────
  return (
    <Stack gap="lg">
      <Card withBorder padding="lg">
        <Text fw={600} size="sm" mb="sm">
          Find the sale
        </Text>
        <Group align="flex-end" gap="sm" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            label="Invoice number"
            description="The number printed on the customer's receipt. A barcode scanner types it for you."
            placeholder="e.g. INV-2026-000123"
            leftSection={<Search size={16} />}
            value={ref}
            onChange={(event) => setRef(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find()
            }}
          />
          <Button
            leftSection={<Search size={16} />}
            loading={finding}
            disabled={ref.trim() === ''}
            onClick={find}
          >
            Find sale
          </Button>
        </Group>

        {findError && (
          <Alert
            color="red"
            icon={<CircleAlert size={16} />}
            mt="md"
            title="That sale could not be opened"
          >
            {findError}
          </Alert>
        )}
      </Card>

      {canPickRecent && (
        <RecentSales currencySymbol={currencySymbol} onPick={(saleId) => void loadSale(saleId)} />
      )}
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A small quantity cell with its unit — used wherever a qty and its uom sit together.
// ─────────────────────────────────────────────────────────────────────────────

function Qty({ value, uom }: { value: number; uom: string | null }): React.JSX.Element {
  return (
    <Text size="sm">
      {formatQty(value)}
      {uom ? (
        <Text span c="dimmed" size="xs">
          {' '}
          {uom}
        </Text>
      ) : null}
    </Text>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent completed sales — a shortcut so the desk does not have to type a number.
// Manager-gated (`report.view`, same as `sale:list`); a refusal just hides it.
// ─────────────────────────────────────────────────────────────────────────────

function RecentSales({
  currencySymbol,
  onPick
}: {
  currencySymbol: string
  onPick: (saleId: number) => void
}): React.JSX.Element | null {
  const [rows, setRows] = useState<SaleListItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.pos.sales.list({ page: 1, pageSize: 6, status: 'completed' })
      if (cancelled) return
      if (result.ok) setRows(result.data.rows)
      else setFailed(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // A refusal (a role that cannot read the sales report) is not an error — just show nothing.
  if (failed) return null

  return (
    <Card withBorder padding="lg">
      <Group gap="sm" mb="sm">
        <Receipt size={16} />
        <Text fw={600} size="sm">
          Recent sales
        </Text>
      </Group>

      {!rows ? (
        <Stack gap={8}>
          <Skeleton height={20} />
          <Skeleton height={20} width="90%" />
          <Skeleton height={20} width="80%" />
        </Stack>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No completed sales yet.
        </Text>
      ) : (
        <Table highlightOnHover>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => onPick(row.id)}>
                <Table.Td>
                  <Text ff="monospace" size="sm">
                    {row.invoiceNo ?? `#${row.id}`}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {new Date(row.at).toLocaleString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c={row.customerName ? undefined : 'dimmed'}>
                    {row.customerName ?? 'Walk-in'}
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
      )}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The supervisor-PIN prompt — the same act, and the same shape, as the Sell screen's.
// We send the PIN, never a user id: a claimed id is not proof anyone was here. (CLAUDE.md §4)
// ─────────────────────────────────────────────────────────────────────────────

function SupervisorPinModal({
  opened,
  onCancel,
  onApprove
}: {
  opened: boolean
  onCancel: () => void
  onApprove: (pin: string) => void
}): React.JSX.Element {
  const [pin, setPin] = useState('')

  function close(): void {
    setPin('')
    onCancel()
  }

  return (
    <Modal opened={opened} onClose={close} title="Supervisor approval needed" centered size="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const value = pin
          setPin('')
          onApprove(value)
        }}
      >
        <Stack gap="md">
          <Group gap={8} wrap="nowrap">
            <ShieldCheck size={18} />
            <Text size="sm">
              Processing a return needs a supervisor. Ask one to enter their own PIN to approve it.
            </Text>
          </Group>
          <PasswordInput
            label="Supervisor PIN"
            description="A supervisor must enter their own PIN to approve this."
            value={pin}
            onChange={(event) => setPin(event.currentTarget.value)}
            data-autofocus
            autoFocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pin.trim().length < 4}>
              Approve
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The refund summary — the FROZEN return main gave back, shown after a successful submit.
// ─────────────────────────────────────────────────────────────────────────────

function RefundSummary({
  detail,
  currencySymbol,
  onAnother
}: {
  detail: ReturnDetail
  currencySymbol: string
  onAnother: () => void
}): React.JSX.Element {
  const money = (value: number): string => formatMoney(value, { symbol: currencySymbol })

  return (
    <Stack gap="lg" maw={720}>
      <Alert color="teal" icon={<CircleCheck size={18} />} title="Return processed">
        <Text size="sm">
          {money(detail.grandTotal)}{' '}
          {detail.settlement === 'refund'
            ? `was refunded${detail.refundMethodLabel ? ` by ${detail.refundMethodLabel}` : ''}.`
            : "was credited to the customer's account."}{' '}
          These figures are frozen from the original sale.
        </Text>
      </Alert>

      <Card withBorder padding="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap={8} wrap="nowrap">
              <Undo2 size={18} />
              <Text fw={650} size="lg">
                Return #{detail.id}
              </Text>
              <Badge variant="light" color={SETTLEMENT_COLOR[detail.settlement]}>
                {SETTLEMENT_LABEL[detail.settlement]}
              </Badge>
            </Group>
            <Group gap={8} wrap="nowrap">
              <ReceiptText size={14} opacity={0.7} />
              <Text size="sm" c="dimmed">
                Against {detail.saleInvoiceNo ?? `sale #${detail.saleId}`}
              </Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <Clock size={14} opacity={0.7} />
              <Text size="sm" c="dimmed">
                {new Date(detail.at).toLocaleString()}
              </Text>
            </Group>
          </Stack>

          <Stack gap={2} align="flex-end">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              {detail.settlement === 'refund' ? 'Refunded' : 'Credited'}
            </Text>
            <Text size="xl" fw={700}>
              {money(detail.grandTotal)}
            </Text>
          </Stack>
        </Group>

        <Divider my="md" />

        <ReturnLinesTable detail={detail} currencySymbol={currencySymbol} />

        <Stack gap={4} mt="md" ml="auto" maw={320}>
          <SummaryRow label="Subtotal" value={detail.subtotalNet} money={money} />
          <SummaryRow label="Tax" value={detail.taxTotal} money={money} />
          <Divider my={2} />
          <SummaryRow label="Total" value={detail.grandTotal} money={money} strong />
        </Stack>
      </Card>

      <Group>
        <Button leftSection={<Undo2 size={16} />} onClick={onAnother}>
          Process another return
        </Button>
      </Group>
    </Stack>
  )
}

function SummaryRow({
  label,
  value,
  money,
  strong
}: {
  label: string
  value: number
  money: (value: number) => string
  strong?: boolean
}): React.JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" fw={strong ? 700 : 400}>
        {label}
      </Text>
      <Text size={strong ? 'md' : 'sm'} fw={strong ? 700 : 400}>
        {money(value)}
      </Text>
    </Group>
  )
}

/** The frozen lines of a return — shared by the summary and the history drawer. */
function ReturnLinesTable({
  detail,
  currencySymbol
}: {
  detail: ReturnDetail
  currencySymbol: string
}): React.JSX.Element {
  const money = (value: number): string => formatMoney(value, { symbol: currencySymbol })

  return (
    <Table.ScrollContainer minWidth={480}>
      <Table withTableBorder verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th>Condition</Table.Th>
            <Table.Th ta="right">Tax</Table.Th>
            <Table.Th ta="right">Total</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {detail.lines.map((line) => (
            <Table.Tr key={line.id}>
              <Table.Td>
                <Text size="sm">{line.nameSnapshot}</Text>
              </Table.Td>
              <Table.Td ta="right">
                <Qty value={line.qtyM} uom={line.uom} />
              </Table.Td>
              <Table.Td>
                {line.restocked ? (
                  <Badge size="xs" variant="light" color="teal" leftSection={<PackageCheck size={10} />}>
                    restocked
                  </Badge>
                ) : line.stockable ? (
                  <Badge size="xs" variant="light" color="red" leftSection={<PackageX size={10} />}>
                    damaged
                  </Badge>
                ) : (
                  <Badge size="xs" variant="light" color="gray" leftSection={<Minus size={10} />}>
                    not stocked
                  </Badge>
                )}
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm" c={line.taxAmount === 0 ? 'dimmed' : undefined}>
                  {money(line.taxAmount)}
                </Text>
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm" fw={600}>
                  {money(line.gross)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// RETURNS HISTORY — every return the shop has made, paginated, with a drill-in.
// ═════════════════════════════════════════════════════════════════════════════

function ReturnsHistory({ currencySymbol }: { currencySymbol: string }): React.JSX.Element {
  const [rows, setRows] = useState<ReturnListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  // The return open in the detail drawer, by id. Null = the drawer is closed.
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // The refund_reason labels, so a row shows "Faulty" instead of a bare code. Loaded once.
  const { items: reasons } = useLookupList('refund_reason')
  const reasonLabel = useMemo(
    () => new Map((reasons ?? []).map((reason) => [reason.code, reason.label] as const)),
    [reasons]
  )

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.returns.list({ page, pageSize })

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
  }, [load])

  return (
    <Stack gap="lg">
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
            <Skeleton height={30} />
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <Undo2 size={32} opacity={0.5} />
            <Text fw={600}>No returns yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              Returns you process appear here — every one, with the reason it came back and how it was
              settled.
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={820}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Return</Table.Th>
                    <Table.Th>Date &amp; time</Table.Th>
                    <Table.Th>Against sale</Table.Th>
                    <Table.Th>Reason</Table.Th>
                    <Table.Th>Settled</Table.Th>
                    <Table.Th ta="right">Amount</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr
                      key={row.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <Table.Td>
                        <Text ff="monospace" size="sm">
                          #{row.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{new Date(row.at).toLocaleString()}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={row.saleInvoiceNo ? undefined : 'dimmed'} ff="monospace">
                          {row.saleInvoiceNo ?? `#${row.saleId}`}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{reasonLabel.get(row.reasonCode) ?? row.reasonCode}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={SETTLEMENT_COLOR[row.settlement]}>
                          {SETTLEMENT_LABEL[row.settlement]}
                        </Badge>
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

      <ReturnDetailDrawer
        returnId={selectedId}
        currencySymbol={currencySymbol}
        onClose={() => setSelectedId(null)}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The detail drawer — one return's frozen lines, its reason, and who approved it.
// ─────────────────────────────────────────────────────────────────────────────

function ReturnDetailDrawer({
  returnId,
  currencySymbol,
  onClose
}: {
  returnId: number | null
  currencySymbol: string
  onClose: () => void
}): React.JSX.Element {
  const money = (value: number): string => formatMoney(value, { symbol: currencySymbol })

  const [detail, setDetail] = useState<ReturnDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { items: reasons } = useLookupList('refund_reason')
  const reasonLabel = useMemo(
    () => new Map((reasons ?? []).map((reason) => [reason.code, reason.label] as const)),
    [reasons]
  )

  useEffect(() => {
    if (returnId === null) {
      setDetail(null)
      setError(null)
      return
    }

    let cancelled = false
    setDetail(null)
    setError(null)

    void (async () => {
      const result = await window.pos.returns.get({ id: returnId })
      if (cancelled) return
      if (result.ok) setDetail(result.data)
      else setError(result.error.userMessage)
    })()

    return () => {
      cancelled = true
    }
  }, [returnId])

  return (
    <Drawer
      opened={returnId !== null}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        <Group gap="sm">
          <Undo2 size={20} />
          <Text fw={650} size="lg">
            {detail ? `Return #${detail.id}` : 'Return'}
          </Text>
          {detail && (
            <Badge variant="light" color={SETTLEMENT_COLOR[detail.settlement]}>
              {SETTLEMENT_LABEL[detail.settlement]}
            </Badge>
          )}
        </Group>
      }
    >
      {error ? (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The return could not be opened">
          {error}
        </Alert>
      ) : !detail ? (
        <Stack gap={10}>
          <Skeleton height={20} width="60%" />
          <Skeleton height={16} width="40%" />
          <Skeleton height={120} mt="md" />
          <Skeleton height={80} mt="md" />
        </Stack>
      ) : (
        <Stack gap="lg">
          {/* ── The heading facts ────────────────────────────────────────── */}
          <Stack gap={6}>
            <Group gap={8} wrap="nowrap">
              <ReceiptText size={15} opacity={0.7} />
              <Text size="sm">
                Against {detail.saleInvoiceNo ?? `sale #${detail.saleId}`}
              </Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <Clock size={15} opacity={0.7} />
              <Text size="sm">{new Date(detail.at).toLocaleString()}</Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <UserIcon size={15} opacity={0.7} />
              <Text size="sm">
                {detail.cashierName ? `Processed by ${detail.cashierName}` : 'Processed'}
                <Text span c="dimmed">
                  {' '}
                  · approved by a {detail.approvedByRole}
                </Text>
              </Text>
            </Group>
          </Stack>

          {/* ── Reason ───────────────────────────────────────────────────── */}
          <Alert variant="light" color="gray" icon={<CircleAlert size={16} />} p="xs">
            <Text size="sm" fw={500}>
              {reasonLabel.get(detail.reasonCode) ?? detail.reasonCode}
            </Text>
            {detail.reasonText && (
              <Text size="sm" c="dimmed" mt={2}>
                {detail.reasonText}
              </Text>
            )}
          </Alert>

          {/* ── How it was settled ───────────────────────────────────────── */}
          <Group gap={8} wrap="nowrap">
            <Wallet size={15} opacity={0.7} />
            <Text size="sm">
              {detail.settlement === 'refund'
                ? `Refunded${detail.refundMethodLabel ? ` by ${detail.refundMethodLabel}` : ''}`
                : detail.settlement === 'customer_credit'
                  ? "Credited to the customer's account"
                  : 'Applied to an exchange'}
            </Text>
          </Group>

          {/* ── Lines ────────────────────────────────────────────────────── */}
          <div>
            <Text fw={600} size="sm" mb={6}>
              Items returned
            </Text>
            <ReturnLinesTable detail={detail} currencySymbol={currencySymbol} />
          </div>

          {/* ── Totals ───────────────────────────────────────────────────── */}
          <Stack gap={4}>
            <SummaryRow label="Subtotal" value={detail.subtotalNet} money={money} />
            <SummaryRow label="Tax" value={detail.taxTotal} money={money} />
            <Divider my={4} />
            <SummaryRow label="Total" value={detail.grandTotal} money={money} strong />
          </Stack>
        </Stack>
      )}
    </Drawer>
  )
}
