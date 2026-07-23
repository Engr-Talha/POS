import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
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
  Clock,
  CreditCard,
  FileX2,
  Hash,
  Layers,
  Package,
  PackagePlus,
  Plus,
  Save,
  Search,
  ShoppingCart,
  Trash2,
  TriangleAlert,
  Truck,
  Undo2,
  User as UserIcon,
  X
} from 'lucide-react'
import type { Role } from '@shared/rbac'
import { roleCan } from '@shared/rbac'
import type { ProductListItem } from '@shared/catalog'
import type {
  CreatePurchaseInput,
  PurchaseDetail,
  PurchaseLineInput,
  PurchaseListItem,
  PurchasePaymentInput
} from '@shared/purchases'
import { formatMoney } from '@shared/money'
import { formatCost } from '@shared/cost'
import { formatQty } from '@shared/qty'
import { Paginator } from '../../components/Paginator'
import { CostInput, LookupCodeSelect, MoneyInput, QtyInput, useLookupList } from './ProductForm'
import { PurchaseReturnHistory, PurchaseReturnModal } from './PurchaseReturn'

/**
 * PURCHASES — a goods-received note (GRN). The mirror of a sale, pointing the other way: a sale takes
 * stock OUT and brings money IN; a purchase brings stock IN at a real landed cost and either pays for
 * it now or owes the supplier the rest.
 *
 * TWO views: the paginated HISTORY (with a drill-in drawer), and NEW PURCHASE — pick a supplier, add
 * lines (product, quantity, 4-dp unit COST, and for a batch-tracked item a batch number + expiry),
 * enter any recoverable input tax, and record the tenders paid now. Whatever is left unpaid is shown as
 * "owed to supplier" — it is the payable (grandTotal − paidTotal), and MAIN computes it; the renderer
 * only PREDICTS it.
 *
 * THE RENDERER SENDS INTENT; MAIN DECIDES THE MONEY. A line says WHAT was received, HOW MANY and at
 * WHAT COST — main freezes each line's value from the stock movement it creates, re-averages the
 * weighted cost, computes the payable and posts one balanced journal. `create` is gated
 * 'purchase.manage' (a manager) in MAIN; the reads are 'purchase.view' and keep working on an expired
 * licence. The nav entry that reaches this screen is gated on 'purchase.view'.
 *
 * THREE INTEGER SCALES LIVE HERE AND ARE NOT INTERCHANGEABLE (CLAUDE.md §4): money is 2-dp minor units
 * (formatMoney), COST is 4-dp ten-thousandths (formatCost, the CostInput), quantity is 3-dp thousandths
 * (formatQty, the QtyInput). `unitCost` sits one field from `lineTotal` and they are a hundred times
 * apart. Nothing here is ever a float.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Money for the LIVE preview. The authoritative figures come back from create();
// this only predicts what MAIN will freeze, using MAIN's own integer arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 2-dp money value of one purchase line, in minor units — the exact figure `stock.record` freezes
 * onto the movement in MAIN (`movementValueMinor`), replicated so the preview cannot drift from it:
 *
 *   cost₄dp = round_half_up(qty_m × unit_cost / 1000)     // 4-dp cost units, BigInt multiply
 *   minor   = round(cost₄dp / 100)                        // 4-dp cost → 2-dp money
 *
 * BigInt for the multiply: 10,000 units of a Rs 100,000 item overflows a float's exact-integer range,
 * and past that point two different totals silently compare equal — the failure integer money exists to
 * prevent. `subtotalNet` is Σ of these per-line values (sum-of-rounded), exactly as the service sums
 * the frozen line totals — never one multiply over the whole cart.
 */
function purchaseLineMinor(qtyM: number, unitCost: number): number {
  if (qtyM <= 0 || unitCost <= 0) return 0
  const scale = 1000n
  const raw = BigInt(qtyM) * BigInt(unitCost)
  const cost4dp = Number((raw * 2n + scale) / (scale * 2n)) // floor(raw/scale + 1/2) — round half up
  return Math.round(cost4dp / 100)
}

/** Today's date as YYYY-MM-DD in the machine's local time — the received-date default. */
function todayIso(): string {
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** An empty box means "not given" for a nullable column — `.nullish()` is what zod expects there. */
function orNull(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

// ═════════════════════════════════════════════════════════════════════════════
// The screen — history / new purchase
// ═════════════════════════════════════════════════════════════════════════════

// `seed` is a just-cancelled bill whose items pre-fill a fresh New Purchase — the "re-enter" half of
// "Correct this invoice". A seeded purchase is still a BRAND-NEW purchase (its own id); the voided one
// stays voided. Same reverse-then-re-enter shape as the sale-side correction.
type View = { mode: 'list' } | { mode: 'new'; seed?: PurchaseDetail }

export function Purchases({
  readOnly,
  currencySymbol,
  userRole
}: {
  readOnly: boolean
  currencySymbol: string
  userRole: Role
}): React.JSX.Element {
  const [view, setView] = useState<View>({ mode: 'list' })
  const canManage = roleCan(userRole, 'purchase.manage')
  // Sending goods back is its own permission — a manager's, like the purchase it reverses. Enforced in
  // MAIN; hiding the button here is a courtesy, not a control (CLAUDE.md §4).
  const canReturn = roleCan(userRole, 'purchaseReturn.manage')
  // Cancelling a wrongly-keyed bill is its own permission too — a manager's, like the purchase it
  // undoes. Enforced in MAIN; hiding the button here is a courtesy, not a control (CLAUDE.md §4).
  const canVoid = roleCan(userRole, 'purchase.void')

  // Bumped when a return commits, so the returns-to-supplier history re-pulls even though it is mounted
  // on the other tab — the drawer that recorded it lives over on this one.
  const [returnsKey, setReturnsKey] = useState(0)

  if (view.mode === 'new') {
    return (
      <NewPurchase
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        seed={view.seed}
        onClose={() => setView({ mode: 'list' })}
      />
    )
  }

  return (
    <Tabs defaultValue="purchases" keepMounted={false}>
      <Tabs.List mb="lg">
        <Tabs.Tab value="purchases" leftSection={<ShoppingCart size={15} />}>
          Purchases
        </Tabs.Tab>
        <Tabs.Tab value="returns" leftSection={<Undo2 size={15} />}>
          Returns to supplier
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="purchases">
        <PurchaseList
          readOnly={readOnly}
          currencySymbol={currencySymbol}
          canManage={canManage}
          canReturn={canReturn}
          canVoid={canVoid}
          onNew={() => setView({ mode: 'new' })}
          onCorrect={(seed) => setView({ mode: 'new', seed })}
          onReturned={() => setReturnsKey((key) => key + 1)}
        />
      </Tabs.Panel>

      <Tabs.Panel value="returns">
        <PurchaseReturnHistory reloadKey={returnsKey} currencySymbol={currencySymbol} />
      </Tabs.Panel>
    </Tabs>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The history list
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 25

function PurchaseList({
  readOnly,
  currencySymbol,
  canManage,
  canReturn,
  canVoid,
  onNew,
  onCorrect,
  onReturned
}: {
  readOnly: boolean
  currencySymbol: string
  canManage: boolean
  canReturn: boolean
  canVoid: boolean
  onNew: () => void
  /** A bill was just cancelled to correct it — open a fresh New Purchase pre-filled from its items. */
  onCorrect: (seed: PurchaseDetail) => void
  /** A committed return is money and stock moving — the returns history reloads with it. */
  onReturned: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<PurchaseListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Any filter change puts us back on page 1 — page 5 of a different result set is nonsense.
  useEffect(() => {
    setPage(1)
  }, [supplierId, from, to])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.purchases.list({
      page,
      pageSize,
      supplierId: supplierId ?? undefined,
      from: from === '' ? undefined : from,
      to: to === '' ? undefined : to
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, pageSize, supplierId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = supplierId !== null || from !== '' || to !== ''

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Purchases</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Every delivery you have booked in. Open one to see its lines and how it was paid. The unpaid
            part of a bill is what you still owe that supplier.
          </Text>
        </div>

        <Tooltip
          label={
            readOnly
              ? 'Your licence has expired — new purchases are paused'
              : 'Only a manager can record a purchase'
          }
          disabled={canManage && !readOnly}
        >
          <Button
            leftSection={<PackagePlus size={16} />}
            disabled={readOnly || !canManage}
            onClick={onNew}
          >
            New purchase
          </Button>
        </Tooltip>
      </Group>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <div style={{ flex: 1, minWidth: 260 }}>
            <SupplierPicker
              label="Supplier"
              placeholder="All suppliers"
              value={supplierId}
              onChange={(id) => setSupplierId(id)}
              clearable
            />
          </div>
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
        </Group>
      </Card>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The purchases could not be loaded">
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
            <ShoppingCart size={32} opacity={0.5} />
            <Text fw={600}>{filtered ? 'Nothing matches that' : 'No purchases yet'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              {filtered
                ? 'Try a different supplier or date range, or clear the filters above.'
                : 'Book in your first delivery with New purchase — it brings stock in at its landed cost.'}
            </Text>
            {!filtered && canManage && (
              <Button mt="sm" leftSection={<PackagePlus size={16} />} disabled={readOnly} onClick={onNew}>
                New purchase
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={900}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Supplier</Table.Th>
                    <Table.Th>Bill no.</Table.Th>
                    <Table.Th ta="right">Items</Table.Th>
                    <Table.Th ta="right">Total</Table.Th>
                    <Table.Th ta="right">Paid</Table.Th>
                    <Table.Th ta="right">Owed</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => {
                    // A CANCELLED bill is not owed and was never really received, so it must LOOK
                    // different at a glance — otherwise the shopkeeper cancels a purchase and the list
                    // reads exactly as it did before. Struck through, dimmed, with a badge, exactly as a
                    // voided sale reads in Sales History. Never strike the badge itself.
                    const voided = row.status === 'voided'
                    const struck = voided ? { textDecoration: 'line-through' as const } : undefined
                    const owed = voided ? 0 : (row.payableRemaining ?? row.grandTotal - row.paidTotal)
                    return (
                      <Table.Tr
                        key={row.id}
                        style={{ cursor: 'pointer', opacity: voided ? 0.6 : undefined }}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <Table.Td>
                          <Text size="sm" style={struck}>
                            {new Date(row.at).toLocaleDateString()}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c={row.supplierName ? undefined : 'dimmed'} style={struck}>
                            {row.supplierName ?? '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <Text
                              size="sm"
                              ff="monospace"
                              c={row.supplierInvoiceNo ? undefined : 'dimmed'}
                              style={struck}
                            >
                              {row.supplierInvoiceNo ?? '—'}
                            </Text>
                            {voided && (
                              <Badge size="xs" variant="light" color="red">
                                Cancelled
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text size="sm" c={row.lineCount ? undefined : 'dimmed'} style={struck}>
                            {row.lineCount ?? '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text size="sm" fw={600} style={struck}>
                            {formatMoney(row.grandTotal, { symbol: currencySymbol })}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text size="sm" c="dimmed" style={struck}>
                            {formatMoney(row.paidTotal, { symbol: currencySymbol })}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          {voided ? (
                            <Text size="sm" c="dimmed">
                              —
                            </Text>
                          ) : owed > 0 ? (
                            <Text size="sm" fw={600} c="var(--mantine-color-red-text)">
                              {formatMoney(owed, { symbol: currencySymbol })}
                            </Text>
                          ) : (
                            <Text size="sm" c="dimmed">
                              Settled
                            </Text>
                          )}
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
              unit="purchase"
            />
          </>
        )}
      </Card>

      <PurchaseDetailDrawer
        purchaseId={selectedId}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        canReturn={canReturn}
        canVoid={canVoid}
        onReturned={onReturned}
        // A cancellation changes this bill's row in the list behind the drawer — its status, and the
        // "owed" the shop no longer owes. Re-pull the page so the shopkeeper SEES it land.
        onVoided={() => void load()}
        // "Correct this invoice": the bill was just cancelled; hand its items to a fresh New Purchase to
        // re-enter. Close the drawer first so we are not stacking a form behind an open drawer.
        onCorrect={(seed) => {
          setSelectedId(null)
          onCorrect(seed)
        }}
        onClose={() => setSelectedId(null)}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The detail drawer — the GRN's frozen lines and its payments.
// ─────────────────────────────────────────────────────────────────────────────

function PurchaseDetailDrawer({
  purchaseId,
  readOnly,
  currencySymbol,
  canReturn,
  canVoid,
  onReturned,
  onVoided,
  onCorrect,
  onClose
}: {
  purchaseId: number | null
  readOnly: boolean
  currencySymbol: string
  canReturn: boolean
  canVoid: boolean
  /** A committed return changes this bill's returnable quantities — the history reloads with it. */
  onReturned: () => void
  /** A cancelled bill changes its own row in the list behind us — status, and what is owed. */
  onVoided: () => void
  /** A cancelled bill being CORRECTED — re-enter its items as a fresh purchase. Carries the loaded bill. */
  onCorrect: (seed: PurchaseDetail) => void
  onClose: () => void
}): React.JSX.Element {
  const [purchase, setPurchase] = useState<PurchaseDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [returning, setReturning] = useState(false)
  const [voiding, setVoiding] = useState(false)

  // Bumped after a return commits, to re-pull this bill. The lines themselves never change — a purchase
  // is frozen — but re-reading keeps the drawer honest if anything else about it moves.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (purchaseId === null) {
      setPurchase(null)
      setError(null)
      return
    }

    let cancelled = false
    setPurchase(null)
    setError(null)

    void (async () => {
      const result = await window.pos.purchases.get({ id: purchaseId })
      if (cancelled) return
      if (result.ok) setPurchase(result.data)
      else setError(result.error.userMessage)
    })()

    return () => {
      cancelled = true
    }
  }, [purchaseId, reloadKey])

  // A CANCELLED bill owes nothing: voidPurchase contra-posted the Payable, so the supplier ledger and
  // GL Payable both say zero. Showing grandTotal − paidTotal here would contradict both, in red.
  const owed =
    purchase && purchase.status !== 'voided' ? purchase.grandTotal - purchase.paidTotal : 0

  return (
    <Drawer
      opened={purchaseId !== null}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        <Group gap="sm">
          <Package size={20} />
          <Text fw={650} size="lg">
            {purchase?.supplierInvoiceNo ? `Bill ${purchase.supplierInvoiceNo}` : 'Purchase'}
          </Text>
        </Group>
      }
    >
      {error ? (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The purchase could not be opened">
          {error}
        </Alert>
      ) : !purchase ? (
        <Stack gap={10}>
          <Skeleton height={20} width="60%" />
          <Skeleton height={16} width="40%" />
          <Skeleton height={120} mt="md" />
          <Skeleton height={80} mt="md" />
        </Stack>
      ) : (
        <Stack gap="lg">
          {/* ── CANCELLED, said plainly and FIRST ─────────────────────────── */}
          {/* The stock came back off and the bill is no longer owed. The document keeps its number and
              every line, so without this banner the drawer reads like a live purchase. Mirrors the
              voided-sale banner in Sales History. */}
          {purchase.status === 'voided' && (
            <Alert color="red" variant="light" icon={<CircleAlert size={16} />} title="Cancelled">
              <Text size="sm">
                Cancelled
                {purchase.voidedAt ? ` on ${new Date(purchase.voidedAt).toLocaleString()}` : ''}
                {purchase.voidReasonCode ? ` — reason: ${purchase.voidReasonCode}` : ''}. The stock was
                taken back off and this bill is no longer owed. It keeps its number and its lines.
              </Text>
            </Alert>
          )}

          {/* ── The heading facts ────────────────────────────────────────── */}
          <Stack gap={6}>
            <Group gap={8} wrap="nowrap">
              <Truck size={15} opacity={0.7} />
              <Text size="sm">{purchase.supplierName ?? 'Supplier'}</Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <Clock size={15} opacity={0.7} />
              <Text size="sm">{new Date(purchase.at).toLocaleString()}</Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <UserIcon size={15} opacity={0.7} />
              <Text size="sm" c="dimmed">
                {purchase.userName ? `Received by ${purchase.userName}` : 'Received'}
              </Text>
            </Group>
            {purchase.notes && (
              <Group gap={8} wrap="nowrap" align="flex-start">
                <Hash size={15} opacity={0.7} style={{ marginTop: 2 }} />
                <Text size="sm" c="dimmed">
                  {purchase.notes}
                </Text>
              </Group>
            )}
          </Stack>

          {/* ── Lines ────────────────────────────────────────────────────── */}
          <div>
            <Text fw={600} size="sm" mb={6}>
              Items received
            </Text>
            <Table.ScrollContainer minWidth={460}>
              <Table withTableBorder verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Item</Table.Th>
                    <Table.Th ta="right">Qty</Table.Th>
                    <Table.Th ta="right">Unit cost</Table.Th>
                    <Table.Th ta="right">Total</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {purchase.lines.map((line) => (
                    <Table.Tr key={line.id}>
                      <Table.Td>
                        <Text size="sm">{line.nameSnapshot}</Text>
                        {line.batchId !== null && (
                          <Badge size="xs" variant="light" color="grape" mt={2} leftSection={<Layers size={10} />}>
                            batch
                          </Badge>
                        )}
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
                        <Text size="sm">{formatCost(line.unitCost, { symbol: currencySymbol })}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {formatMoney(line.lineTotal, { symbol: currencySymbol })}
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
            <TotalRow label="Subtotal" value={purchase.subtotalNet} currencySymbol={currencySymbol} />
            {purchase.taxTotal > 0 && (
              <TotalRow label="Input tax" value={purchase.taxTotal} currencySymbol={currencySymbol} />
            )}
            <Divider my={4} />
            <TotalRow label="Grand total" value={purchase.grandTotal} currencySymbol={currencySymbol} strong />
            <TotalRow label="Paid" value={purchase.paidTotal} currencySymbol={currencySymbol} dimmed />
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={600} c={owed > 0 ? 'red' : 'dimmed'}>
                Owed to supplier
              </Text>
              <Text size="sm" fw={600} c={owed > 0 ? 'red' : 'dimmed'}>
                {owed > 0 ? formatMoney(owed, { symbol: currencySymbol }) : 'Settled'}
              </Text>
            </Group>
          </Stack>

          {/* ── Payments ─────────────────────────────────────────────────── */}
          {purchase.payments.length > 0 && (
            <div>
              <Text fw={600} size="sm" mb={6}>
                Paid with
              </Text>
              <Stack gap={4}>
                {purchase.payments.map((payment) => (
                  <Group key={payment.id} justify="space-between" wrap="nowrap">
                    <Text size="sm">
                      {purchase.paymentMethodLabels?.[payment.methodLookupId] ?? 'Payment'}
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

          {/* ── Send goods back ──────────────────────────────────────────── */}
          {/* The flow lives HERE, on the bill the goods arrived on — that is where the shopkeeper
              already is, and the purchase carries the supplier, the frozen costs and the tax pool.
              Gated 'purchaseReturn.manage' + assertWritable in MAIN; this button is the courtesy. */}
          <Divider />
          <Group justify="space-between" align="center" wrap="nowrap">
            <Text size="xs" c="dimmed" maw={320}>
              Something wrong with this delivery? Send it back — the goods leave at the cost they came in
              at, and the credit comes off what you owe.
            </Text>
            <Tooltip
              label={
                readOnly
                  ? 'Your licence has expired — returns are paused'
                  : 'Only a manager can send goods back'
              }
              disabled={canReturn && !readOnly}
            >
              <Button
                variant="light"
                leftSection={<Undo2 size={16} />}
                disabled={readOnly || !canReturn}
                onClick={() => setReturning(true)}
              >
                Return to supplier
              </Button>
            </Tooltip>
          </Group>

          {/* ── Correct a wrongly-keyed bill ─────────────────────────────── */}
          {/* The OTHER thing that can be wrong with a delivery: not the goods, the typing. Hidden once
              the bill is already cancelled — there is nothing left to correct. Gated 'purchase.void' +
              assertWritable in MAIN; this button is the courtesy. */}
          {purchase.status !== 'voided' && (
            <>
              <Divider />
              <Group justify="space-between" align="center" wrap="nowrap">
                <Text size="xs" c="dimmed" maw={320}>
                  Keyed this bill wrong? Cancel it — the stock comes back off and the bill is no longer
                  owed. The cancelled bill is kept for the record, then you enter it again correctly.
                </Text>
                <Tooltip
                  label={
                    readOnly
                      ? 'Your licence has expired — corrections are paused'
                      : 'Only a manager can correct an invoice'
                  }
                  disabled={canVoid && !readOnly}
                >
                  <Button
                    variant="light"
                    color="red"
                    leftSection={<FileX2 size={16} />}
                    disabled={readOnly || !canVoid}
                    onClick={() => setVoiding(true)}
                  >
                    Correct this invoice
                  </Button>
                </Tooltip>
              </Group>
            </>
          )}
        </Stack>
      )}

      <PurchaseReturnModal
        purchaseId={purchaseId}
        opened={returning}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        onClose={() => setReturning(false)}
        onDone={() => {
          setReloadKey((key) => key + 1)
          onReturned()
        }}
      />

      <VoidPurchaseModal
        purchase={purchase}
        opened={voiding}
        currencySymbol={currencySymbol}
        onClose={() => setVoiding(false)}
        onDone={() => {
          setVoiding(false)
          onVoided()
          // REVERSE, then RE-ENTER. The wrong bill is now cancelled; hand its items to a fresh New
          // Purchase so the manager fixes the price/qty and records the corrected bill — the whole
          // point of "Correct this invoice". Mirrors the sale-side flow. `purchase` is the bill we just
          // cancelled, loaded in this drawer.
          if (purchase) onCorrect(purchase)
        }}
      />
    </Drawer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// "Correct this invoice" — the confirmation, because a cancellation cannot be undone.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MAIN owns every refusal here, and every refusal it sends is a SENTENCE THE SHOPKEEPER CAN ACT ON —
 * "already paid … record a return to the supplier instead", "goods already returned against it", "less
 * than zero in stock". Those sentences ARE the feature, so `result.error.userMessage` goes on screen
 * verbatim. Replacing them with "Something went wrong" would throw away the only thing that tells the
 * shopkeeper what to do next.
 *
 * THE NEGATIVE-STOCK CONFIRM. Reversing a delivery that has since been partly SOLD drives the shelf
 * below zero. On the shop's default `selling.negativeStock: 'warn'` main refuses the FIRST attempt and
 * explains, exactly as the Sell screen warns before a negative-stock sale; we show that refusal and
 * offer a confirm that re-sends with `acceptNegativeStock: true`. It is never set unconditionally —
 * that would silently defeat a guard the owner asked for. On 'block' the flag cannot rescue it and main
 * refuses again, correctly; the message says so and the confirm is not offered a second time.
 */
function VoidPurchaseModal({
  purchase,
  opened,
  currencySymbol,
  onClose,
  onDone
}: {
  purchase: PurchaseDetail | null
  opened: boolean
  currencySymbol: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** Main has warned that the shelf will go negative and is waiting to be told to go ahead anyway. */
  const [negativeWarning, setNegativeWarning] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A fresh open is a fresh decision — never inherit the last bill's reason or a stale warning.
  useEffect(() => {
    if (!opened) return
    setReasonCode(null)
    setReasonText('')
    setError(null)
    setNegativeWarning(null)
    setBusy(false)
  }, [opened])

  async function submit(acceptNegativeStock: boolean): Promise<void> {
    if (purchase === null || reasonCode === null || busy) return

    setBusy(true)
    setError(null)

    const result = await window.pos.purchases.void({
      id: purchase.id,
      reasonCode,
      reasonText: reasonText.trim() === '' ? null : reasonText.trim(),
      // ONLY once the manager has seen main's warning and pressed the confirm. Sending it on the first
      // attempt would defeat the guard the owner's own setting asked for.
      ...(acceptNegativeStock ? { acceptNegativeStock: true } : {})
    })

    setBusy(false)

    if (!result.ok) {
      // Main signals the not-yet-accepted negative-stock case by REFUSING with a VALIDATION error whose
      // technical line says so (services/purchases.ts assertReversalStockPolicy). The 'block' policy
      // throws a different technical line and is NOT offered a confirm — it is a refusal, not a warning.
      const technical = result.error.technical ?? ''
      if (technical.includes('negative-stock warning not yet accepted')) {
        setNegativeWarning(result.error.userMessage)
        return
      }
      // Every other refusal — paid, has returns, already cancelled, locked month — verbatim.
      setError(result.error.userMessage)
      setNegativeWarning(null)
      return
    }

    notifications.show({
      color: 'green',
      title: 'Invoice cancelled',
      message: `${purchase.supplierInvoiceNo ? `Bill ${purchase.supplierInvoiceNo}` : 'The bill'} has been cancelled. The stock has come back off and it is no longer owed — you can enter it again correctly now.`
    })

    onDone()
  }

  return (
    <Modal
      opened={opened && purchase !== null}
      onClose={busy ? () => {} : onClose}
      title={
        <Group gap="sm">
          <FileX2 size={18} />
          <Text fw={650}>Correct this invoice</Text>
        </Group>
      }
      centered
      size="lg"
    >
      {purchase === null ? null : (
        <Stack gap="md">
          {/* WHICH bill. A manager with three deliveries open must not cancel the wrong one. */}
          <Card withBorder padding="md">
            <Stack gap={6}>
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm" c="dimmed">
                  Supplier
                </Text>
                <Text size="sm" fw={600}>
                  {purchase.supplierName ?? 'Supplier'}
                </Text>
              </Group>
              {purchase.supplierInvoiceNo ? (
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" c="dimmed">
                    Bill number
                  </Text>
                  <Text size="sm" fw={600}>
                    {purchase.supplierInvoiceNo}
                  </Text>
                </Group>
              ) : null}
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm" c="dimmed">
                  Total
                </Text>
                <Text size="sm" fw={700}>
                  {formatMoney(purchase.grandTotal, { symbol: currencySymbol })}
                </Text>
              </Group>
            </Stack>
          </Card>

          {/* WHAT WILL HAPPEN, in the plainest words we have. */}
          <Alert color="orange" variant="light" icon={<TriangleAlert size={18} />}>
            <Text size="sm">
              This bill will be cancelled. Everything on it comes back off your stock, and you will no
              longer owe this supplier for it. The cancelled bill is kept for the record — it keeps its
              number and all its lines — so you can enter the delivery again with the right figures.
              This cannot be undone.
            </Text>
          </Alert>

          <LookupCodeSelect
            listKey="void_reason"
            label="Reason"
            description="Why this bill is being cancelled. Add a new reason with +."
            value={reasonCode}
            onChange={(value) => {
              setReasonCode(value)
              setError(null)
            }}
            disabled={busy}
            required
          />

          <Textarea
            label="Note (optional)"
            description="Any extra detail — e.g. keyed 10 not 100."
            autosize
            minRows={1}
            maxRows={4}
            maxLength={500}
            disabled={busy}
            value={reasonText}
            onChange={(event) => setReasonText(event.currentTarget.value)}
          />

          {/* MAIN's own refusal, word for word — it is the sentence that says what to do next. */}
          {error && (
            <Alert color="red" variant="light" icon={<CircleAlert size={18} />} title="Not cancelled">
              <Text size="sm">{error}</Text>
            </Alert>
          )}

          {/* The one refusal that is really a QUESTION: main is waiting to be told to go ahead. */}
          {negativeWarning && (
            <Alert
              color="orange"
              variant="light"
              icon={<TriangleAlert size={18} />}
              title="Some of this has already been sold"
            >
              <Text size="sm">{negativeWarning}</Text>
            </Alert>
          )}

          <Group justify="flex-end" gap="sm">
            <Button variant="default" disabled={busy} onClick={onClose}>
              Keep the bill
            </Button>
            {negativeWarning ? (
              <Button
                color="red"
                leftSection={<FileX2 size={16} />}
                loading={busy}
                disabled={reasonCode === null}
                onClick={() => void submit(true)}
              >
                Cancel it anyway
              </Button>
            ) : (
              <Button
                color="red"
                leftSection={<FileX2 size={16} />}
                loading={busy}
                disabled={reasonCode === null}
                onClick={() => void submit(false)}
              >
                Cancel this invoice
              </Button>
            )}
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

// ═════════════════════════════════════════════════════════════════════════════
// New purchase / GRN
// ═════════════════════════════════════════════════════════════════════════════

type LineDraft = {
  key: number
  productId: number | null
  productName: string
  saleUomId: number | null
  trackBatches: boolean
  qtyM: number
  /** 4-dp COST — a DIFFERENT scale from money. */
  unitCost: number
  batchNo: string
  expiryDate: string
  /**
   * The item's SELLING prices, 2-dp money — NOT the cost. Prefilled from the product when it is picked
   * and editable here, because a new delivery is exactly when the shopkeeper revises them. A change
   * applies GOING FORWARD (products.update), never re-pricing a past sale. `origRetail`/`origWholesale`
   * hold the prefilled figures so submit can diff typed-vs-original and update ONLY what changed.
   */
  retailPrice: number
  wholesalePrice: number
  origRetail: number
  origWholesale: number
}

type TenderDraft = {
  key: number
  methodLookupId: number | null
  amount: number
  chequeNo: string
  chequeDate: string
  walletRef: string
}

let lineKey = 1
let tenderKey = 1

function emptyLine(): LineDraft {
  return {
    key: lineKey++,
    productId: null,
    productName: '',
    saleUomId: null,
    trackBatches: false,
    qtyM: 0,
    unitCost: 0,
    batchNo: '',
    expiryDate: '',
    retailPrice: 0,
    wholesalePrice: 0,
    origRetail: 0,
    origWholesale: 0
  }
}

/**
 * One draft line seeded from a cancelled bill's line. Carries what to re-key: product, qty, unit cost.
 * The selling prices (retail/wholesale) are prefilled fresh from the product by `pickProduct`-style
 * seeding below, so a correction shows today's prices, not a snapshot. BATCH numbers are NOT re-seeded:
 * a PurchaseLine records the batch by id, not its printed number, so the manager re-enters it — a small
 * notice says so. (Getting the wrong batch number onto restocked goods is worse than re-typing it.)
 */
function seedLineFrom(line: PurchaseDetail['lines'][number]): LineDraft {
  return {
    key: lineKey++,
    productId: line.productId,
    productName: line.nameSnapshot,
    saleUomId: null,
    trackBatches: false, // corrected below once the product detail is read
    qtyM: line.qtyM,
    unitCost: line.unitCost,
    batchNo: '',
    expiryDate: '',
    retailPrice: 0,
    wholesalePrice: 0,
    origRetail: 0,
    origWholesale: 0
  }
}

function NewPurchase({
  readOnly,
  currencySymbol,
  seed,
  onClose
}: {
  readOnly: boolean
  currencySymbol: string
  /** A just-cancelled bill to pre-fill from — the "re-enter" half of Correct this invoice. */
  seed?: PurchaseDetail
  onClose: () => void
}): React.JSX.Element {
  const [supplierId, setSupplierId] = useState<number | null>(seed?.supplierId ?? null)
  const [invoiceNo, setInvoiceNo] = useState(seed?.supplierInvoiceNo ?? '')
  // A correction is entered NOW, not back-dated onto the cancelled bill's day (which may be in a locked
  // period). The manager can change it if the goods truly arrived earlier and that month is still open.
  const [receivedDate, setReceivedDate] = useState(todayIso())
  const [notes, setNotes] = useState(seed?.notes ?? '')
  const [taxTotal, setTaxTotal] = useState(seed?.taxTotal ?? 0)
  const [lines, setLines] = useState<LineDraft[]>(() =>
    seed && seed.lines.length > 0 ? seed.lines.map(seedLineFrom) : [emptyLine()]
  )
  // Payments start EMPTY even on a correction — the corrected bill is re-tendered fresh.
  const [tenders, setTenders] = useState<TenderDraft[]>([])
  const [saving, setSaving] = useState(false)

  // Seeded lines carry qty/cost but not the product's batch flag, unit, or today's selling prices — so
  // read each seeded product's detail once, exactly as picking it by hand would, and fill those in.
  useEffect(() => {
    if (!seed) return
    let cancelled = false
    void (async () => {
      for (const line of seed.lines) {
        const result = await window.pos.products.get({ id: line.productId })
        if (cancelled || !result.ok) continue
        const p = result.data.product
        setLines((rows) =>
          rows.map((row) =>
            row.productId === line.productId
              ? {
                  ...row,
                  trackBatches: p.trackBatches,
                  saleUomId: p.saleUomId,
                  retailPrice: p.retailPrice,
                  wholesalePrice: p.wholesalePrice,
                  origRetail: p.retailPrice,
                  origWholesale: p.wholesalePrice
                }
              : row
          )
        )
      }
    })()
    return () => {
      cancelled = true
    }
    // Seed is a one-shot at mount; keying on its id avoids re-running as lines are edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id])

  // The unit labels, so a line can show "pcs" next to the quantity. Loaded once.
  const { items: uoms } = useLookupList('uom')
  const uomLabel = useMemo(
    () => new Map((uoms ?? []).map((u) => [u.id, u.label] as const)),
    [uoms]
  )

  // Payment methods, minus 'credit': a purchase is tendered with REAL money, and the amount NOT paid IS
  // the payable (MAIN refuses a credit tender anyway — this just keeps it off the menu).
  const { items: allMethods } = useLookupList('payment_method')
  const methods = useMemo(() => (allMethods ?? []).filter((m) => m.code !== 'credit'), [allMethods])
  const cashMethod = methods.find((m) => m.code === 'cash') ?? null
  const codeOf = (tender: TenderDraft): string | null =>
    methods.find((m) => m.id === tender.methodLookupId)?.code ?? null

  const setLine = (key: number, patch: Partial<LineDraft>): void =>
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  // When a product is chosen we still need its batch flag and unit, which the list row does not carry —
  // so we read the detail once. The list row DOES carry the current cost, so we seed the unit cost from
  // it right away (a sensible starting figure the receiver corrects to the real landed cost on the
  // bill), without clobbering a cost already typed on this line.
  async function pickProduct(key: number, item: ProductListItem): Promise<void> {
    setLines((rows) =>
      rows.map((row) =>
        row.key === key
          ? {
              ...row,
              productId: item.id,
              productName: item.name,
              unitCost: row.unitCost > 0 ? row.unitCost : item.costPrice,
              // A batch/expiry typed for a PREVIOUS product does not belong to this one. Clear it, or a
              // stale expiry left behind when switching to a non-batch product would hide in an
              // unrendered field and block submit forever. (Buying audit.)
              batchNo: '',
              expiryDate: ''
            }
          : row
      )
    )
    const result = await window.pos.products.get({ id: item.id })
    if (!result.ok) return
    const product = result.data.product
    // Prefill the SELLING prices (2-dp money) so the receiver can see and revise them. `orig*` remembers
    // what the product currently has, so submit updates ONLY a price the user actually changed. A
    // purchase-only pack legitimately has no retail price; that guard is on the fields' visibility below.
    setLine(key, {
      trackBatches: product.trackBatches,
      saleUomId: product.saleUomId,
      retailPrice: product.retailPrice,
      wholesalePrice: product.wholesalePrice,
      origRetail: product.retailPrice,
      origWholesale: product.wholesalePrice
    })
  }

  // ── Live totals (a PREDICTION; create() returns the authoritative frozen GRN) ──
  const subtotalNet = lines.reduce((sum, line) => sum + purchaseLineMinor(line.qtyM, line.unitCost), 0)
  const grandTotal = subtotalNet + taxTotal
  const paidTotal = tenders.reduce((sum, tender) => sum + tender.amount, 0)
  const owed = grandTotal - paidTotal

  // ── What is stopping a submit, in plain language. MAIN validates all of this too. ──
  const validLines = lines.filter((line) => line.productId !== null && line.qtyM > 0)
  const problems: string[] = []
  if (supplierId === null) problems.push('Choose a supplier.')
  if (validLines.length === 0) problems.push('Add at least one item with a quantity.')
  if (lines.some((line) => line.productId !== null && line.qtyM <= 0))
    problems.push('Every item needs a quantity greater than zero.')
  if (lines.some((line) => line.trackBatches && line.expiryDate !== '' && line.batchNo.trim() === ''))
    problems.push('An expiry date needs a batch number next to it.')
  if (tenders.some((tender) => tender.methodLookupId === null || tender.amount <= 0))
    problems.push('Give every payment a method and an amount.')
  if (paidTotal > grandTotal)
    problems.push('You cannot pay a supplier more than their bill — there is no change when buying.')

  const canSubmit = problems.length === 0 && !readOnly && !saving

  async function submit(): Promise<void> {
    if (supplierId === null || validLines.length === 0) return
    setSaving(true)

    const lineInputs: PurchaseLineInput[] = validLines.map((line) => {
      const hasBatch = line.trackBatches && line.batchNo.trim() !== ''
      return {
        productId: line.productId as number,
        qtyM: line.qtyM,
        unitCost: line.unitCost,
        // A batch number belongs ONLY to a batch-tracked product — MAIN refuses it on anything else.
        batchNo: hasBatch ? line.batchNo.trim() : null,
        // An expiry date has to travel with a batch number (the batch row is what carries it).
        expiryDate: hasBatch && line.expiryDate !== '' ? line.expiryDate : null
      }
    })

    const paymentInputs: PurchasePaymentInput[] = tenders.map((tender) => {
      const code = codeOf(tender)
      const isCheque = code === 'cheque'
      const isWallet = code === 'jazzcash' || code === 'easypaisa'
      return {
        methodLookupId: tender.methodLookupId as number,
        amount: tender.amount,
        chequeNo: isCheque && tender.chequeNo.trim() !== '' ? tender.chequeNo.trim() : null,
        chequeDate: isCheque && tender.chequeDate !== '' ? tender.chequeDate : null,
        walletRef: isWallet && tender.walletRef.trim() !== '' ? tender.walletRef.trim() : null
      }
    })

    const input: CreatePurchaseInput = {
      supplierId,
      supplierInvoiceNo: orNull(invoiceNo),
      at: receivedDate === '' ? undefined : receivedDate,
      taxTotal,
      notes: orNull(notes),
      lines: lineInputs,
      payments: paymentInputs
    }

    const result = await window.pos.purchases.create(input)

    if (!result.ok) {
      setSaving(false)
      notifications.show({
        color: 'red',
        title: 'Could not record this purchase',
        message: result.error.userMessage
      })
      return
    }

    // ── Selling-price revisions, AFTER the purchase is safely recorded ──────────────────────────────
    // The purchase is the important record; a price tweak is secondary, so it runs only once the bill is
    // in the books. We update ONLY lines whose retail/wholesale differs from what the item currently
    // carried (origRetail/origWholesale, prefilled when the product was picked), and we send ONLY the
    // price fields — never cost (that is DERIVED from this very purchase; products.update won't take it
    // anyway). A failed price update is NON-FATAL: the stock is booked in regardless, so we warn and
    // move on rather than pretend the purchase failed.
    const priceChanges = validLines.filter(
      (line) =>
        line.productId !== null &&
        (line.retailPrice !== line.origRetail || line.wholesalePrice !== line.origWholesale)
    )
    const priceFailures: string[] = []
    for (const line of priceChanges) {
      const update = await window.pos.products.update({
        id: line.productId as number,
        retailPrice: line.retailPrice,
        wholesalePrice: line.wholesalePrice
      })
      if (!update.ok) priceFailures.push(`${line.productName}: ${update.error.userMessage}`)
    }

    setSaving(false)

    if (priceFailures.length > 0) {
      notifications.show({
        color: 'orange',
        title: 'Purchase saved — but a price did not update',
        message: `The stock is booked in. These prices were left unchanged: ${priceFailures.join('; ')}`,
        autoClose: 9000
      })
    }

    const remaining = result.data.grandTotal - result.data.paidTotal
    notifications.show({
      color: 'teal',
      title: 'Purchase recorded',
      message:
        remaining > 0
          ? `Stock booked in. ${formatMoney(remaining, { symbol: currencySymbol })} now owed to the supplier.`
          : 'Stock booked in and the bill is fully paid.'
    })
    onClose()
  }

  return (
    <Stack gap="lg" maw={920}>
      <Group justify="space-between" align="flex-start">
        <Group gap="sm" align="center">
          <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onClose}>
            Back to purchases
          </Button>
          <Title order={2}>{seed ? 'Correct invoice' : 'New purchase'}</Title>
        </Group>

        <Button
          leftSection={<Save size={16} />}
          loading={saving}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {seed ? 'Record corrected purchase' : 'Record purchase'}
        </Button>
      </Group>

      {seed && (
        <Alert color="blue" variant="light" icon={<FileX2 size={18} />} title="Re-entering the cancelled bill">
          <Text size="sm">
            {seed.supplierInvoiceNo ? `Bill ${seed.supplierInvoiceNo}` : 'The bill'} has been cancelled
            and kept for the record. Its items are filled in below — fix the price, quantity or lines,
            set how it was paid, and record it as a fresh corrected purchase.
            {seed.lines.some((l) => l.batchId !== null) && (
              <>
                {' '}
                A batch-tracked item needs its <strong>batch number re-entered</strong> — it is not
                copied from the cancelled bill.
              </>
            )}
          </Text>
        </Alert>
      )}

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so new purchases are paused. You can still look at every past
          purchase and export it.
        </Alert>
      )}

      {/* ── The supplier and the bill ──────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Truck size={18} />
          <Text fw={600}>Supplier &amp; bill</Text>
        </Group>
        <Stack>
          <Group grow align="flex-start">
            <SupplierPicker
              label="Supplier"
              placeholder="Search by name or phone…"
              value={supplierId}
              onChange={setSupplierId}
              required
              disabled={readOnly}
            />
            <TextInput
              label="Supplier's bill number"
              description="As written on their invoice. Optional."
              disabled={readOnly}
              value={invoiceNo}
              onChange={(event) => setInvoiceNo(event.currentTarget.value)}
            />
          </Group>
          <Group grow align="flex-start">
            <TextInput
              label="Received on"
              type="date"
              description="The day the goods came in."
              disabled={readOnly}
              value={receivedDate}
              onChange={(event) => setReceivedDate(event.currentTarget.value)}
            />
            <div />
          </Group>
        </Stack>
      </Card>

      {/* ── The lines ──────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap="sm">
            <Package size={18} />
            <Text fw={600}>Items received</Text>
          </Group>
          <Text size="sm" c="dimmed">
            {formatQty(validLines.reduce((n, l) => n + l.qtyM, 0))} units on {validLines.length}{' '}
            {validLines.length === 1 ? 'line' : 'lines'}
          </Text>
        </Group>

        <Stack gap="sm">
          {lines.map((line, index) => {
            const lineTotal = purchaseLineMinor(line.qtyM, line.unitCost)
            const unit = line.saleUomId !== null ? uomLabel.get(line.saleUomId) : undefined
            return (
              <Card withBorder padding="sm" radius="sm" key={line.key}>
                <Stack gap={8}>
                  <Group gap={8} align="flex-end" wrap="nowrap">
                    <div style={{ flex: 1 }}>
                      <ProductPicker
                        label={index === 0 ? 'Item' : undefined}
                        value={line.productId}
                        onPick={(item) => void pickProduct(line.key, item)}
                        disabled={readOnly}
                      />
                    </div>
                    <Tooltip label="Remove this line" disabled={lines.length === 1}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size={36}
                        aria-label="Remove this line"
                        disabled={lines.length === 1}
                        onClick={() => setLines((rows) => rows.filter((row) => row.key !== line.key))}
                      >
                        <X size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>

                  {line.productId !== null && (
                    <>
                      <Group gap={8} align="flex-start" grow>
                        <QtyInput
                          label="Quantity"
                          description={unit ? `In ${unit}` : '1 piece = 1, half a kg = 0.5'}
                          value={line.qtyM}
                          onChange={(value) => setLine(line.key, { qtyM: value })}
                          disabled={readOnly}
                          required
                        />
                        <CostInput
                          label="Unit cost"
                          description="What ONE cost you, to 4 decimals. Re-averages this item's cost."
                          leftSection={<Text size="sm">{currencySymbol}</Text>}
                          value={line.unitCost}
                          onChange={(value) => setLine(line.key, { unitCost: value })}
                          disabled={readOnly}
                        />
                      </Group>

                      {/* The SELLING prices, prefilled from the item and editable right here — a new
                          delivery is exactly when they get revised. These are money (2-dp), NOT the
                          cost above; a change applies going forward and never touches a past sale. */}
                      <Group gap={8} align="flex-start" grow>
                        <MoneyInput
                          label="Retail price"
                          description="What you sell ONE for. Changing it updates the item going forward — past sales are untouched."
                          leftSection={<Text size="sm">{currencySymbol}</Text>}
                          value={line.retailPrice}
                          onChange={(value) => setLine(line.key, { retailPrice: value })}
                          disabled={readOnly}
                        />
                        <MoneyInput
                          label="Wholesale price"
                          description="The bulk / trade price. Changing it updates the item going forward — past sales are untouched."
                          leftSection={<Text size="sm">{currencySymbol}</Text>}
                          value={line.wholesalePrice}
                          onChange={(value) => setLine(line.key, { wholesalePrice: value })}
                          disabled={readOnly}
                        />
                      </Group>

                      {line.trackBatches && (
                        <Group gap={8} align="flex-start" grow>
                          <TextInput
                            label="Batch number"
                            description="This item is batch-tracked."
                            value={line.batchNo}
                            disabled={readOnly}
                            onChange={(event) => setLine(line.key, { batchNo: event.currentTarget.value })}
                          />
                          <TextInput
                            label="Expiry date"
                            type="date"
                            description="Optional. Needs a batch number."
                            value={line.expiryDate}
                            disabled={readOnly}
                            error={
                              line.expiryDate !== '' && line.batchNo.trim() === ''
                                ? 'Enter a batch number too.'
                                : undefined
                            }
                            onChange={(event) =>
                              setLine(line.key, { expiryDate: event.currentTarget.value })
                            }
                          />
                        </Group>
                      )}

                      <Group justify="flex-end">
                        <Text size="sm" c="dimmed">
                          Line total{' '}
                          <Text span fw={600} c="var(--mantine-color-text)">
                            {formatMoney(lineTotal, { symbol: currencySymbol })}
                          </Text>
                        </Text>
                      </Group>
                    </>
                  )}
                </Stack>
              </Card>
            )
          })}

          <Button
            variant="default"
            size="xs"
            w="fit-content"
            leftSection={<Plus size={16} />}
            disabled={readOnly}
            onClick={() => setLines((rows) => [...rows, emptyLine()])}
          >
            Add another item
          </Button>
        </Stack>
      </Card>

      {/* ── Tax & notes ────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group grow align="flex-start">
          <MoneyInput
            label="Input tax (recoverable)"
            description="Sales tax on this bill you can reclaim. Leave at 0 if you cannot — fold it into the unit cost instead."
            leftSection={<Text size="sm">{currencySymbol}</Text>}
            value={taxTotal}
            onChange={setTaxTotal}
            disabled={readOnly}
          />
          <Textarea
            label="Notes"
            description="Anything to remember about this delivery."
            autosize
            minRows={1}
            disabled={readOnly}
            value={notes}
            onChange={(event) => setNotes(event.currentTarget.value)}
          />
        </Group>
      </Card>

      {/* ── How it was paid ────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <CreditCard size={18} />
          <Text fw={600}>Payment</Text>
        </Group>

        {/* The bill total and what is still owed, big and clear. */}
        <Card withBorder padding="md" mb="md" bg="var(--mantine-color-default-hover)">
          <Group justify="space-between" align="center">
            <Stack gap={0}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Bill total
              </Text>
              <Text fw={700} size="xl">
                {formatMoney(grandTotal, { symbol: currencySymbol })}
              </Text>
              <Text size="xs" c="dimmed">
                {formatMoney(subtotalNet, { symbol: currencySymbol })} goods
                {taxTotal > 0 ? ` + ${formatMoney(taxTotal, { symbol: currencySymbol })} tax` : ''}
              </Text>
            </Stack>

            <Stack gap={0} align="flex-end">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                {owed > 0 ? 'Owed to supplier' : owed < 0 ? 'Overpaid' : 'Paid in full'}
              </Text>
              <Text fw={800} c={owed > 0 ? 'red' : owed < 0 ? 'orange' : 'teal'} style={{ fontSize: 34, lineHeight: 1.1 }}>
                {formatMoney(Math.abs(owed), { symbol: currencySymbol })}
              </Text>
            </Stack>
          </Group>
        </Card>

        <Stack gap={8}>
          {tenders.length === 0 && (
            <Text size="sm" c="dimmed">
              No payment yet — the whole bill is on account (owed to the supplier). Add a payment for
              anything you are paying now.
            </Text>
          )}

          {tenders.map((tender) => {
            const code = codeOf(tender)
            return (
              <Card withBorder padding="sm" radius="sm" key={tender.key}>
                <Stack gap={8}>
                  <Group gap={8} align="flex-end" wrap="nowrap">
                    <Select
                      style={{ flex: 1 }}
                      label="Method"
                      placeholder={allMethods === null ? 'Loading…' : 'Choose…'}
                      data={methods.map((method) => ({ value: String(method.id), label: method.label }))}
                      value={tender.methodLookupId === null ? null : String(tender.methodLookupId)}
                      disabled={readOnly || allMethods === null}
                      onChange={(next) =>
                        setTenders((rows) =>
                          rows.map((row) =>
                            row.key === tender.key
                              ? { ...row, methodLookupId: next === null ? null : Number(next) }
                              : row
                          )
                        )
                      }
                      allowDeselect={false}
                    />
                    <div style={{ width: 160 }}>
                      <MoneyInput
                        label="Amount"
                        leftSection={<Text size="sm">{currencySymbol}</Text>}
                        value={tender.amount}
                        disabled={readOnly}
                        onChange={(next) =>
                          setTenders((rows) =>
                            rows.map((row) => (row.key === tender.key ? { ...row, amount: next } : row))
                          )
                        }
                      />
                    </div>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size={36}
                      aria-label="Remove this payment"
                      disabled={readOnly}
                      onClick={() => setTenders((rows) => rows.filter((row) => row.key !== tender.key))}
                    >
                      <Trash2 size={16} />
                    </ActionIcon>
                  </Group>

                  {code === 'cheque' && (
                    <Group gap={8} grow>
                      <TextInput
                        label="Cheque number"
                        value={tender.chequeNo}
                        disabled={readOnly}
                        onChange={(event) =>
                          setTenders((rows) =>
                            rows.map((row) =>
                              row.key === tender.key ? { ...row, chequeNo: event.currentTarget.value } : row
                            )
                          )
                        }
                      />
                      <TextInput
                        label="Cheque date"
                        type="date"
                        value={tender.chequeDate}
                        disabled={readOnly}
                        onChange={(event) =>
                          setTenders((rows) =>
                            rows.map((row) =>
                              row.key === tender.key ? { ...row, chequeDate: event.currentTarget.value } : row
                            )
                          )
                        }
                      />
                    </Group>
                  )}

                  {(code === 'jazzcash' || code === 'easypaisa') && (
                    <TextInput
                      label="Transaction reference"
                      value={tender.walletRef}
                      disabled={readOnly}
                      onChange={(event) =>
                        setTenders((rows) =>
                          rows.map((row) =>
                            row.key === tender.key ? { ...row, walletRef: event.currentTarget.value } : row
                          )
                        )
                      }
                    />
                  )}
                </Stack>
              </Card>
            )
          })}

          <Group gap={8}>
            <Button
              variant="default"
              size="xs"
              leftSection={<Plus size={16} />}
              disabled={readOnly || methods.length === 0}
              onClick={() =>
                setTenders((rows) => [
                  ...rows,
                  {
                    key: tenderKey++,
                    methodLookupId: cashMethod?.id ?? methods[0]?.id ?? null,
                    // Whatever is still owed — the common case is paying the remainder.
                    amount: Math.max(0, grandTotal - paidTotal),
                    chequeNo: '',
                    chequeDate: '',
                    walletRef: ''
                  }
                ])
              }
            >
              Add a payment
            </Button>

            {cashMethod !== null && grandTotal > 0 && (
              <Button
                variant="subtle"
                size="xs"
                disabled={readOnly}
                onClick={() =>
                  setTenders([
                    {
                      key: tenderKey++,
                      methodLookupId: cashMethod.id,
                      amount: grandTotal,
                      chequeNo: '',
                      chequeDate: '',
                      walletRef: ''
                    }
                  ])
                }
              >
                Paid in full (cash)
              </Button>
            )}
          </Group>
        </Stack>
      </Card>

      {/* ── What is stopping a submit ──────────────────────────────────────── */}
      {!readOnly && problems.length > 0 && (
        <Alert color="gray" icon={<CircleAlert size={18} />} variant="light">
          <Text size="sm" fw={600} mb={4}>
            Before you can record this purchase:
          </Text>
          <Stack gap={2}>
            {problems.map((problem) => (
              <Text size="sm" key={problem}>
                • {problem}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Group justify="flex-end">
        <Button variant="default" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          leftSection={<Save size={16} />}
          loading={saving}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          Record purchase
        </Button>
      </Group>
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Pickers — searchable, server-filtered selects over paginated tables (100k+ rows)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A searchable supplier picker. The suppliers table is paginated (assume 100k+), so it never loads them
 * all — it fetches a page as you type. The currently-selected supplier is always kept in the option
 * list so its name still shows after the search box is cleared.
 */
function SupplierPicker({
  label,
  placeholder,
  value,
  onChange,
  required,
  disabled,
  clearable = false
}: {
  label?: string
  placeholder?: string
  value: number | null
  onChange: (value: number | null) => void
  required?: boolean
  disabled?: boolean
  clearable?: boolean
}): React.JSX.Element {
  const [rows, setRows] = useState<Array<{ id: number; name: string; phone: string | null }>>([])
  const [selected, setSelected] = useState<{ id: number; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  // Add a brand-new supplier without leaving a half-entered goods-received note — the same inline
  // quick-create every other party picker in the app offers (a new delivery is exactly where you meet a
  // new supplier). Name-only, like the product form; the full record can be filled in later. (Buying audit.)
  async function createFromSearch(): Promise<void> {
    const name = search.trim()
    if (name === '') return
    setCreating(true)
    const result = await window.pos.suppliers.create({ name })
    setCreating(false)
    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not add the supplier', message: result.error.userMessage })
      return
    }
    const created = result.data
    setSelected({ id: created.id, name: created.name })
    setRows((prev) => [{ id: created.id, name: created.name, phone: created.phone }, ...prev])
    setSearch('')
    onChange(created.id)
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const result = await window.pos.suppliers.list({
        page: 1,
        pageSize: 20,
        search: debounced === '' ? undefined : debounced
      })
      if (cancelled) return
      setLoading(false)
      if (result.ok) {
        setRows(result.data.rows.map((s) => ({ id: s.id, name: s.name, phone: s.phone })))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [debounced])

  // If we hold a value but have never resolved its name (e.g. set from outside), fetch it once.
  useEffect(() => {
    if (value === null) {
      setSelected(null)
      return
    }
    if (selected?.id === value) return
    const known = rows.find((r) => r.id === value)
    if (known) {
      setSelected({ id: known.id, name: known.name })
      return
    }
    let cancelled = false
    void (async () => {
      const result = await window.pos.suppliers.get({ id: value })
      if (cancelled) return
      if (result.ok) setSelected({ id: result.data.id, name: result.data.name })
    })()
    return () => {
      cancelled = true
    }
  }, [value, rows, selected])

  const data = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>()
    for (const row of rows) {
      map.set(String(row.id), {
        value: String(row.id),
        label: row.phone ? `${row.name} · ${row.phone}` : row.name
      })
    }
    if (selected && !map.has(String(selected.id))) {
      map.set(String(selected.id), { value: String(selected.id), label: selected.name })
    }
    return [...map.values()]
  }, [rows, selected])

  const canCreate = search.trim() !== '' && !disabled

  return (
    <Group gap="xs" wrap="nowrap" align="flex-end">
      <Select
        style={{ flex: 1 }}
        label={label}
        placeholder={placeholder}
        leftSection={<Search size={16} />}
        data={data}
        value={value === null ? null : String(value)}
        searchable
        clearable={clearable}
        required={required}
        disabled={disabled}
        nothingFoundMessage={
          loading ? 'Searching…' : canCreate ? 'No match — press + to add this supplier' : 'No supplier matches that'
        }
        // The list is already filtered by the server — show every result rather than filter it again.
        filter={({ options }) => options}
        onSearchChange={setSearch}
        onChange={(next) => {
          if (next === null) {
            setSelected(null)
            onChange(null)
            return
          }
          const id = Number(next)
          const found = rows.find((r) => r.id === id)
          if (found) setSelected({ id: found.id, name: found.name })
          onChange(id)
        }}
      />
      <Tooltip label={canCreate ? `Add "${search.trim()}" as a new supplier` : 'Type a name, then add'}>
        <ActionIcon
          variant="light"
          size="lg"
          disabled={!canCreate}
          loading={creating}
          onClick={() => void createFromSearch()}
          aria-label="Add a new supplier"
        >
          <Plus size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

/**
 * A searchable product picker for a purchase line. Only STOCKED items appear — a non-inventory item (a
 * service, a bag charge) has no stock and cannot be received (MAIN refuses it). Hands the whole chosen
 * row up so the caller has its name and current cost without a second query.
 */
function ProductPicker({
  label,
  value,
  onPick,
  disabled
}: {
  label?: string
  value: number | null
  onPick: (item: ProductListItem) => void
  disabled?: boolean
}): React.JSX.Element {
  const [rows, setRows] = useState<ProductListItem[]>([])
  const [selected, setSelected] = useState<{ id: number; label: string } | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const result = await window.pos.products.list({
        page: 1,
        pageSize: 20,
        search: debounced === '' ? undefined : debounced,
        itemType: 'inventory'
      })
      if (cancelled) return
      setLoading(false)
      if (result.ok) setRows(result.data.rows)
    })()
    return () => {
      cancelled = true
    }
  }, [debounced])

  const data = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>()
    for (const row of rows) {
      map.set(String(row.id), { value: String(row.id), label: `${row.name} · ${row.sku}` })
    }
    if (selected && !map.has(String(selected.id))) {
      map.set(String(selected.id), { value: String(selected.id), label: selected.label })
    }
    return [...map.values()]
  }, [rows, selected])

  return (
    <Select
      label={label}
      placeholder="Search item by name, code or barcode…"
      leftSection={<Search size={16} />}
      data={data}
      value={value === null ? null : String(value)}
      searchable
      disabled={disabled}
      nothingFoundMessage={loading ? 'Searching…' : 'No stocked item matches that'}
      filter={({ options }) => options}
      onSearchChange={setSearch}
      onChange={(next) => {
        if (next === null) return
        const id = Number(next)
        const found = rows.find((r) => r.id === id)
        if (found) {
          setSelected({ id: found.id, label: `${found.name} · ${found.sku}` })
          onPick(found)
        }
      }}
    />
  )
}
