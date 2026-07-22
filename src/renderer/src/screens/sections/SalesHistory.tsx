import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Drawer,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  CircleAlert,
  Clock,
  FileX2,
  Hash,
  Printer,
  Receipt,
  ReceiptText,
  Search,
  TriangleAlert,
  User as UserIcon
} from 'lucide-react'
import type { SaleDetail, SaleListItem, SaleStatus } from '@shared/sales'
import { formatMoney } from '@shared/money'
import { formatQty } from '@shared/qty'
import { Paginator } from '../../components/Paginator'
import { LookupCodeSelect } from './ProductForm'

/**
 * SALES HISTORY — every sale the shop ever rang up, paginated and searchable.
 *
 * This is a READ-ONLY screen. Nothing here changes the books, so there is no assertWritable concern:
 * even a shop whose licence has lapsed can still look up every sale it made and reprint a receipt
 * (CLAUDE.md §6). `sales.list` is gated `report.view` in MAIN — this is a manager's view of the whole
 * shop's takings — while the detail lookup and the reprint sit on `sale.create`, the cashier's gate,
 * because a cashier holding a customer's receipt must be able to find that sale and print it again.
 *
 * A VOIDED sale is NOT deleted and NOT renumbered: it keeps its invoice number forever and shows here,
 * struck through, so the book can be audited. (PLAN.md §1.)
 */

/** The status filter. 'all' is a sentinel that maps to "no filter" — the list then shows every status. */
const STATUS_FILTER: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'voided', label: 'Voided' },
  { value: 'held', label: 'Held' },
  { value: 'quote', label: 'Quotes' }
]

const STATUS_BADGE: Record<SaleStatus, { color: string; label: string }> = {
  completed: { color: 'teal', label: 'Completed' },
  voided: { color: 'red', label: 'Voided' },
  held: { color: 'gray', label: 'Held' },
  quote: { color: 'grape', label: 'Quote' }
}

export function SalesHistory({
  currencySymbol,
  onCorrectInvoice
}: {
  currencySymbol: string
  /**
   * "Correct this invoice" succeeded (the sale is now voided). Home takes the just-voided sale id, seeds
   * the Sell screen's cart from its lines and switches to Sell so the cashier rings the corrected invoice.
   */
  onCorrectInvoice: (saleId: number) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<SaleListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('all')

  // The sale open in the detail drawer, by id. Null = the drawer is closed.
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // A scanner fills a whole invoice number in a few milliseconds; a human types a name letter by
  // letter. Debouncing keeps us from firing a query per keystroke while still feeling instant.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  // Any filter change puts us back on page 1 — page 5 of a different result set is nonsense.
  useEffect(() => {
    setPage(1)
  }, [debounced, status])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.sales.list({
      page,
      pageSize,
      search: debounced === '' ? undefined : debounced,
      status: status === 'all' ? undefined : (status as SaleStatus)
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, pageSize, debounced, status])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = debounced !== '' || status !== 'all'

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Sales</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Every sale you have rung up. Search by invoice number or customer, open a sale to see its
          lines, and reprint a receipt — every reprint is stamped <strong>DUPLICATE</strong>.
        </Text>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <TextInput
            style={{ flex: 1, minWidth: 260 }}
            label="Search"
            placeholder="Invoice number or customer name…"
            leftSection={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />

          <Select
            label="Status"
            w={190}
            data={STATUS_FILTER}
            value={status}
            allowDeselect={false}
            onChange={(value) => setStatus(value ?? 'all')}
          />
        </Group>
      </Card>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The sales could not be loaded">
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
            <Receipt size={32} opacity={0.5} />
            <Text fw={600}>{filtered ? 'Nothing matches that' : 'No sales yet'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              {filtered
                ? 'Try a different search, or change the status filter above.'
                : 'Sales you complete on the Sell screen will appear here.'}
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={860}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Invoice</Table.Th>
                    <Table.Th>Date &amp; time</Table.Th>
                    <Table.Th>Customer</Table.Th>
                    <Table.Th>Cashier</Table.Th>
                    <Table.Th ta="right">Total</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => {
                    const voided = row.status === 'voided'
                    // A voided line keeps its number but is struck through — never on the badges,
                    // which would look like a mistake, only on the sale's own text.
                    const struck = voided ? { textDecoration: 'line-through' as const } : undefined
                    const badge = STATUS_BADGE[row.status]

                    return (
                      <Table.Tr
                        key={row.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <Table.Td>
                          {row.invoiceNo ? (
                            <Text ff="monospace" size="sm" style={struck}>
                              {row.invoiceNo}
                            </Text>
                          ) : (
                            <Text size="sm" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm" style={struck}>
                            {new Date(row.at).toLocaleString()}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm" c={row.customerName ? undefined : 'dimmed'} style={struck}>
                            {row.customerName ?? 'Walk-in'}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm" c={row.cashierName ? undefined : 'dimmed'} style={struck}>
                            {row.cashierName ?? '—'}
                          </Text>
                        </Table.Td>

                        <Table.Td ta="right">
                          <Text size="sm" fw={600} style={struck}>
                            {formatMoney(row.grandTotal, { symbol: currencySymbol })}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <Badge size="sm" variant="light" color={badge.color}>
                              {badge.label}
                            </Badge>
                            {row.hadNegativeStock && (
                              <Tooltip label="Sold below zero stock — allowed, but flagged">
                                <Badge
                                  size="xs"
                                  color="red"
                                  variant="light"
                                  leftSection={<TriangleAlert size={10} />}
                                >
                                  below zero
                                </Badge>
                              </Tooltip>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    )
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            <Paginator
              page={page}
              pageSize={pageSize}
              total={total}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          </>
        )}
      </Card>

      <SaleDetailDrawer
        saleId={selectedId}
        currencySymbol={currencySymbol}
        onCorrectInvoice={(saleId) => {
          setSelectedId(null)
          onCorrectInvoice(saleId)
        }}
        onClose={() => setSelectedId(null)}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The detail drawer — the sale's frozen lines, its payments, and a reprint button.
// ─────────────────────────────────────────────────────────────────────────────

function SaleDetailDrawer({
  saleId,
  currencySymbol,
  onCorrectInvoice,
  onClose
}: {
  saleId: number | null
  currencySymbol: string
  /** Fired after the wrong sale is voided; the parent seeds the Sell cart from its lines. */
  onCorrectInvoice: (saleId: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [sale, setSale] = useState<SaleDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const [correcting, setCorrecting] = useState(false)

  useEffect(() => {
    if (saleId === null) {
      setSale(null)
      setError(null)
      return
    }

    let cancelled = false
    setSale(null)
    setError(null)

    void (async () => {
      const result = await window.pos.sales.get({ id: saleId })
      if (cancelled) return
      if (result.ok) setSale(result.data)
      else setError(result.error.userMessage)
    })()

    return () => {
      cancelled = true
    }
  }, [saleId])

  async function reprint(): Promise<void> {
    if (saleId === null) return
    setPrinting(true)
    // Every print the renderer can ask for is a REPRINT: main stamps it DUPLICATE and writes the
    // audit row itself. A failed print is not an error — the sale is untouched. (shared/ipc.ts.)
    const result = await window.pos.printing.printReceipt({ id: saleId })
    setPrinting(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not reprint',
        message: result.error.userMessage
      })
      return
    }

    if (result.data.printed) {
      notifications.show({
        color: 'teal',
        icon: <Printer size={18} />,
        title: 'Receipt reprinted (DUPLICATE)',
        message: 'A duplicate copy was sent to the printer.'
      })
    } else {
      notifications.show({
        color: 'orange',
        icon: <TriangleAlert size={18} />,
        title: 'The receipt did not print',
        message: result.data.problem ?? 'Check the printer and try again.',
        autoClose: 7000
      })
    }
  }

  const badge = sale ? STATUS_BADGE[sale.status] : null
  // A receipt only exists for a sale that actually happened — held carts and quotes have no number
  // and nothing to reprint.
  const canReprint = sale !== null && (sale.status === 'completed' || sale.status === 'voided')

  return (
    <Drawer
      opened={saleId !== null}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        <Group gap="sm">
          <ReceiptText size={20} />
          <Text fw={650} size="lg">
            {sale?.invoiceNo ?? 'Sale'}
          </Text>
          {badge && (
            <Badge variant="light" color={badge.color}>
              {badge.label}
            </Badge>
          )}
        </Group>
      }
    >
      {error ? (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The sale could not be opened">
          {error}
        </Alert>
      ) : !sale ? (
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
              <Clock size={15} opacity={0.7} />
              <Text size="sm">{new Date(sale.at).toLocaleString()}</Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <UserIcon size={15} opacity={0.7} />
              <Text size="sm">
                {sale.customerName ?? 'Walk-in'}
                {sale.cashierName ? (
                  <Text span c="dimmed">
                    {' '}
                    · sold by {sale.cashierName}
                  </Text>
                ) : null}
              </Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <Hash size={15} opacity={0.7} />
              <Text size="sm" c="dimmed">
                {sale.priceTier === 'retail'
                  ? 'Retail price'
                  : sale.priceTier === 'wholesale'
                    ? 'Wholesale price'
                    : 'Customer price'}
              </Text>
            </Group>
          </Stack>

          {sale.hadNegativeStock && (
            <Alert color="red" variant="light" icon={<TriangleAlert size={16} />} p="xs">
              <Text size="sm">This sale went out against stock the shop did not have.</Text>
            </Alert>
          )}

          {sale.status === 'voided' && (
            <Alert color="red" variant="light" icon={<CircleAlert size={16} />} title="Voided">
              <Text size="sm">
                Cancelled{sale.voidedAt ? ` on ${new Date(sale.voidedAt).toLocaleString()}` : ''}
                {sale.voidReasonCode ? ` — reason: ${sale.voidReasonCode}` : ''}. The sale keeps its
                invoice number.
              </Text>
            </Alert>
          )}

          {/* ── Lines ────────────────────────────────────────────────────── */}
          <div>
            <Text fw={600} size="sm" mb={6}>
              Items
            </Text>
            <Table.ScrollContainer minWidth={420}>
              <Table withTableBorder verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Item</Table.Th>
                    <Table.Th ta="right">Qty</Table.Th>
                    <Table.Th ta="right">Price</Table.Th>
                    <Table.Th ta="right">Tax</Table.Th>
                    <Table.Th ta="right">Total</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {sale.lines.map((line) => (
                    <Table.Tr key={line.id}>
                      <Table.Td>
                        <Text size="sm">{line.nameSnapshot}</Text>
                        {line.nameOtherLang && (
                          <Text size="xs" c="dimmed" dir="auto">
                            {line.nameOtherLang}
                          </Text>
                        )}
                        <Group gap={6} mt={2}>
                          {line.isOpenItem && (
                            <Badge size="xs" variant="light" color="grape">
                              open item
                            </Badge>
                          )}
                          {line.priceOverrideByUserId !== null && (
                            <Badge size="xs" variant="light" color="orange">
                              price override
                            </Badge>
                          )}
                          {line.lineDiscount > 0 && (
                            <Text size="xs" c="dimmed">
                              less {formatMoney(line.lineDiscount, { symbol: currencySymbol })}
                            </Text>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">
                          {formatQty(line.qtyM)}
                          {line.uom ? (
                            <Text span c="dimmed" size="xs">
                              {' '}
                              {line.uom}
                            </Text>
                          ) : null}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">{formatMoney(line.unitPrice, { symbol: currencySymbol })}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c={line.taxAmount === 0 ? 'dimmed' : undefined}>
                          {formatMoney(line.taxAmount, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {formatMoney(line.gross, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </div>

          {/* ── Totals ───────────────────────────────────────────────────── */}
          <Stack gap={4}>
            <TotalRow label="Subtotal" value={sale.subtotalNet} currencySymbol={currencySymbol} />
            {sale.cartDiscount > 0 && (
              <TotalRow
                label="Cart discount"
                value={-sale.cartDiscount}
                currencySymbol={currencySymbol}
              />
            )}
            <TotalRow label="Tax" value={sale.taxTotal} currencySymbol={currencySymbol} />
            <Divider my={4} />
            <TotalRow label="Grand total" value={sale.grandTotal} currencySymbol={currencySymbol} strong />
            <TotalRow label="Paid" value={sale.paidTotal} currencySymbol={currencySymbol} dimmed />
            {sale.changeDue > 0 && (
              <TotalRow label="Change" value={sale.changeDue} currencySymbol={currencySymbol} dimmed />
            )}
          </Stack>

          {/* ── Payments ─────────────────────────────────────────────────── */}
          {sale.payments.length > 0 && (
            <div>
              <Text fw={600} size="sm" mb={6}>
                Payment
              </Text>
              <Stack gap={4}>
                {sale.payments.map((payment) => (
                  <Group key={payment.id} justify="space-between" wrap="nowrap">
                    <Text size="sm">
                      {sale.paymentMethodLabels?.[payment.methodLookupId] ?? 'Payment'}
                      {payment.chequeNo ? (
                        <Text span c="dimmed" size="xs">
                          {' '}
                          · cheque {payment.chequeNo}
                        </Text>
                      ) : null}
                      {payment.walletRef ? (
                        <Text span c="dimmed" size="xs">
                          {' '}
                          · ref {payment.walletRef}
                        </Text>
                      ) : null}
                    </Text>
                    <Text size="sm">{formatMoney(payment.amount, { symbol: currencySymbol })}</Text>
                  </Group>
                ))}
              </Stack>
            </div>
          )}

          {/* ── Correct this invoice ─────────────────────────────────────── */}
          {/* Only a COMPLETED sale can be corrected. Reverse + re-enter: this cancels the wrong invoice
              (kept for the record, stock back on the shelf) and re-rings its lines as a NEW one, so the
              books are never silently rewritten. A sale WITH RETURNS against it cannot be voided — the
              two would double-reverse — so we say why instead of offering a dead-end button. A voided
              sale has nothing to correct. */}
          {sale.status === 'completed' && (
            <>
              <Divider />
              {sale.hasReturns ? (
                <Alert color="gray" variant="light" icon={<CircleAlert size={16} />} p="xs">
                  <Text size="sm">
                    This invoice has goods returned against it, so it cannot be corrected here. Reverse
                    or settle those returns first.
                  </Text>
                </Alert>
              ) : (
                <Group justify="space-between" align="center" wrap="nowrap">
                  <Text size="xs" c="dimmed" maw={340}>
                    Keyed something wrong? Correct it — the old invoice is cancelled and kept for the
                    record, its stock comes back, and you re-ring it fixed as a new invoice.
                  </Text>
                  <Button
                    color="red"
                    variant="light"
                    leftSection={<FileX2 size={16} />}
                    onClick={() => setCorrecting(true)}
                  >
                    Correct this invoice
                  </Button>
                </Group>
              )}
            </>
          )}

          {/* ── Reprint ──────────────────────────────────────────────────── */}
          {canReprint && (
            <>
              <Divider />
              <Group justify="flex-end">
                <Button
                  variant="default"
                  leftSection={<Printer size={16} />}
                  loading={printing}
                  onClick={() => void reprint()}
                >
                  Reprint (DUPLICATE)
                </Button>
              </Group>
            </>
          )}
        </Stack>
      )}

      <CorrectInvoiceModal
        sale={sale}
        opened={correcting}
        currencySymbol={currencySymbol}
        onClose={() => setCorrecting(false)}
        onVoided={(voidedId) => {
          setCorrecting(false)
          onCorrectInvoice(voidedId)
        }}
      />
    </Drawer>
  )
}

/**
 * "Correct this invoice" — the confirmation, because cancelling a sale cannot be undone.
 *
 * The REASON IS INTERNAL. It goes on the `sale.void` audit row (who, role, when, why) and NOWHERE near
 * the customer's paper — the corrected invoice they get looks like any other sale. Main owns every
 * refusal (already cancelled, has returns, a closed shift) and each is a sentence the shopkeeper can
 * act on, so `result.error.userMessage` goes on screen verbatim.
 *
 * There is no negative-stock confirm here, unlike the purchase side: cancelling a SALE puts stock BACK
 * on the shelf, which can never drive it below zero. So `sales.void` never asks — and this modal never
 * offers an "anyway".
 */
function CorrectInvoiceModal({
  sale,
  opened,
  currencySymbol,
  onClose,
  onVoided
}: {
  sale: SaleDetail | null
  opened: boolean
  currencySymbol: string
  onClose: () => void
  onVoided: (voidedSaleId: number) => void
}): React.JSX.Element {
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A fresh open is a fresh decision — never inherit the last invoice's reason or a stale error.
  useEffect(() => {
    if (!opened) return
    setReasonCode(null)
    setReasonText('')
    setError(null)
    setBusy(false)
  }, [opened])

  async function submit(): Promise<void> {
    if (sale === null || reasonCode === null || busy) return

    setBusy(true)
    setError(null)

    const result = await window.pos.sales.void({
      id: sale.id,
      reasonCode,
      reasonText: reasonText.trim() === '' ? null : reasonText.trim()
    })

    setBusy(false)

    if (!result.ok) {
      // Every refusal — already cancelled, has returns, a closed shift, needs a supervisor — verbatim.
      setError(result.error.userMessage)
      return
    }

    notifications.show({
      color: 'teal',
      title: 'Invoice cancelled — now enter the correction',
      message: `${sale.invoiceNo ?? 'The sale'} has been cancelled and kept for the record. Fix the items and take payment to create the corrected invoice.`
    })

    onVoided(sale.id)
  }

  return (
    <Modal
      opened={opened && sale !== null}
      onClose={busy ? () => {} : onClose}
      title={
        <Group gap="sm">
          <FileX2 size={18} />
          <Text fw={650}>Correct this invoice</Text>
        </Group>
      }
    >
      {sale && (
        <Stack gap="md">
          <Alert color="red" variant="light" icon={<CircleAlert size={18} />}>
            <Text size="sm">
              {sale.invoiceNo ?? 'This sale'}
              {sale.customerName ? ` — ${sale.customerName}` : ''}, total{' '}
              {formatMoney(sale.grandTotal, { symbol: currencySymbol })}, will be cancelled. Its stock
              comes back on the shelf and it is kept for the record with its number. You will then re-ring
              its items so you can fix them and take payment for the corrected invoice. This cannot be
              undone.
            </Text>
          </Alert>

          <LookupCodeSelect
            listKey="void_reason"
            label="Reason"
            description="Why this invoice is being corrected. This is for your records — it is never printed on the customer's receipt. Add a new reason with +."
            value={reasonCode}
            onChange={setReasonCode}
            required
          />

          <Textarea
            label="Note (optional)"
            description="Any extra detail — e.g. rang 2 not 1."
            autosize
            minRows={2}
            value={reasonText}
            onChange={(event) => setReasonText(event.currentTarget.value)}
          />

          {error && (
            <Alert color="red" variant="light" icon={<CircleAlert size={18} />} title="Not corrected">
              {error}
            </Alert>
          )}

          <Group justify="flex-end" gap="sm">
            <Button variant="default" disabled={busy} onClick={onClose}>
              Keep the invoice
            </Button>
            <Button
              color="red"
              leftSection={<FileX2 size={16} />}
              loading={busy}
              disabled={reasonCode === null}
              onClick={() => void submit()}
            >
              Cancel &amp; correct
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}

function TotalRow({
  label,
  value,
  currencySymbol,
  strong,
  dimmed
}: {
  label: string
  value: number
  currencySymbol: string
  strong?: boolean
  dimmed?: boolean
}): React.JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" fw={strong ? 700 : 400} c={dimmed ? 'dimmed' : undefined}>
        {label}
      </Text>
      <Text size={strong ? 'md' : 'sm'} fw={strong ? 700 : 400} c={dimmed ? 'dimmed' : undefined}>
        {formatMoney(value, { symbol: currencySymbol })}
      </Text>
    </Group>
  )
}
