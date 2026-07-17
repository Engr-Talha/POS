import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  SegmentedControl,
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
  Ban,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  ClipboardList,
  Plus,
  ScanLine,
  Search,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type {
  StockTakeDetail,
  StockTakeLineRow,
  StockTakeRow,
  StockTakeStatus
} from '@shared/stock-take'
import { formatMoney } from '@shared/money'
import { formatQty, parseQty } from '@shared/qty'
import { Paginator } from '../../components/Paginator'

/**
 * THE STOCK TAKE — the counting sheet. The shop counts its shelves; the books are corrected to match.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * THIS SCREEN NEVER COMPUTES A VARIANCE. NOT ONCE. (CLAUDE.md §4, and the preload comment.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * Look at what `setCount` sends: `{ stockTakeId, productId, countedQtyM }`. WHICH product, and HOW MANY
 * were on the shelf. That is all it is allowed to say. MAIN reads what the books expected AT THAT
 * INSTANT, reads the carried 4-dp cost, subtracts, values the difference and freezes all four onto the
 * line — then hands them back. Every `expectedQtyM`, `varianceQtyM` and `varianceValueMinor` rendered
 * below arrived in that response; none of it is arithmetic done here.
 *
 * That is not ceremony. A renderer that could name the expected figure could name its own variance —
 * which is to say it could count 8 tins against books that say 10 and report a variance of zero. It
 * could hide a theft. So it does not get to know what the books expect until after it has committed to
 * a count, and it never gets to do the subtraction.
 *
 * ── THE COUNT IS SAVED THE MOMENT IT IS KEYED ───────────────────────────────────────────────────────
 * Every count is one `setCount` round-trip, and the sheet re-renders from what main returns. There is no
 * local draft of the numbers: a draft would be a second opinion about what the sheet says, and the two
 * would drift the first time a call failed. Re-counting the same product UPDATES the line and re-freezes
 * what the books expect — a correction, not a second opinion (migration 0019's UNIQUE index enforces it).
 *
 * ── A NEGATIVE VARIANCE IS THE NUMBER THE OWNER OPENED THIS SCREEN FOR ──────────────────────────────
 * Stock missing. It is rendered red, with its money value, and the sheet's total is called out before
 * Apply. Everything else is bookkeeping; this is the one that means something.
 *
 * ── AN APPLIED SHEET IS HISTORY, AND READS AS HISTORY ───────────────────────────────────────────────
 * The service refuses to apply twice ('applied' is terminal) and refuses to be counted into. So an
 * applied or cancelled sheet renders READ-ONLY: no count boxes, no Apply, no Remove. Offering a button
 * that main will refuse is how a shopkeeper learns not to trust the screen.
 *
 * ── KEYBOARD-FIRST: A SCANNER IN ONE HAND ───────────────────────────────────────────────────────────
 * The counter holds a scanner and stands at a shelf. Scan → the item is found and the quantity box takes
 * focus; type the count, press Enter → it is saved and focus returns to the scan box for the next item.
 * Their hands never leave the scanner and the number pad.
 *
 * Writes are 'stockTake.manage' (manager) + assertWritable() in MAIN; reads are 'stockTake.view'
 * (supervisor). Hiding a button here is a courtesy — MAIN is the boundary.
 */

const PAGE_SIZE = 25

/** The four states, in the shopkeeper's own words — never the raw enum on screen. */
const STATUS_LABEL: Record<StockTakeStatus, string> = {
  open: 'Counting',
  counted: 'Ready to apply',
  applied: 'Applied',
  cancelled: 'Cancelled'
}

const STATUS_COLOR: Record<StockTakeStatus, string> = {
  open: 'blue',
  counted: 'orange',
  applied: 'teal',
  cancelled: 'gray'
}

/** A sheet that has been applied or cancelled is history — the service refuses to change it. */
function isFinished(status: StockTakeStatus): boolean {
  return status === 'applied' || status === 'cancelled'
}

export function StockTake({
  readOnly,
  currencySymbol
}: {
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [rows, setRows] = useState<StockTakeRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState<'all' | StockTakeStatus>('all')

  /** The sheet open in the counting drawer. Null = the list. */
  const [openSheetId, setOpenSheetId] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)

  // A changed filter puts us back on page 1 — page 5 of a different result set is nonsense.
  useEffect(() => {
    setPage(1)
  }, [statusFilter])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.stockTake.list({
      page,
      pageSize,
      status: statusFilter === 'all' ? undefined : statusFilter
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, pageSize, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  async function startSheet(): Promise<void> {
    if (readOnly || starting) return
    setStarting(true)

    // No date and no user: MAIN stamps the sheet from its own clock and the session. A caller who
    // could name the date could date a sheet into a month it never counted (shared/stock-take.ts).
    const result = await window.pos.stockTake.create({})
    setStarting(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The stock take could not be started',
        message: result.error.userMessage
      })
      return
    }

    // Straight to the shelf — a counter who pressed "Start counting" wants the scan box, not a list.
    setOpenSheetId(result.data.id)
    void load()
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Stock take</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Count what is really on your shelves and correct the books to match. Scan an item, key what
            you can see, and the difference against what the books expect appears beside it. Nothing
            changes until you apply the sheet.
          </Text>
        </div>

        <Tooltip label="Your licence has expired — a stock take cannot be started" disabled={!readOnly}>
          <Button
            leftSection={<Plus size={16} />}
            disabled={readOnly}
            loading={starting}
            onClick={() => void startSheet()}
          >
            Start counting
          </Button>
        </Tooltip>
      </Group>

      {/* ── Filter ───────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <div>
            <Text size="sm" fw={500} mb={6}>
              Show
            </Text>
            <SegmentedControl
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as 'all' | StockTakeStatus)}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Counting', value: 'open' },
                { label: 'Ready to apply', value: 'counted' },
                { label: 'Applied', value: 'applied' },
                { label: 'Cancelled', value: 'cancelled' }
              ]}
            />
          </div>
        </Group>
      </Card>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The stock takes could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      {/* ── The sheets ───────────────────────────────────────────────────────── */}
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
            <ClipboardList size={32} opacity={0.5} />
            <Text fw={600}>No stock takes yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={480}>
              A stock take is how you find out what has really gone missing. Count after close, when
              nothing is selling, and apply the sheet — the corrections post themselves.
            </Text>
            {!readOnly && (
              <Button mt="sm" leftSection={<Plus size={16} />} onClick={() => void startSheet()}>
                Start counting
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={900}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Started</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Counted by</Table.Th>
                    <Table.Th ta="right">Items counted</Table.Th>
                    <Table.Th ta="right">Differences</Table.Th>
                    <Table.Th ta="right">Worth</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Text size="sm">{new Date(row.at).toLocaleDateString()}</Text>
                        {row.note && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {row.note}
                          </Text>
                        )}
                      </Table.Td>

                      <Table.Td>
                        <Badge size="sm" variant="light" color={STATUS_COLOR[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" c={row.userName ? undefined : 'dimmed'}>
                          {row.userName ?? '—'}
                        </Text>
                      </Table.Td>

                      <Table.Td ta="right">
                        <Text size="sm">{row.lineCount}</Text>
                      </Table.Td>

                      <Table.Td ta="right">
                        <Text
                          size="sm"
                          fw={row.varianceLineCount > 0 ? 600 : 400}
                          c={row.varianceLineCount > 0 ? undefined : 'dimmed'}
                        >
                          {row.varianceLineCount > 0 ? row.varianceLineCount : '—'}
                        </Text>
                      </Table.Td>

                      <Table.Td ta="right">
                        <VarianceMoney
                          minor={row.varianceValueMinor}
                          currencySymbol={currencySymbol}
                        />
                      </Table.Td>

                      <Table.Td>
                        <Group gap={6} wrap="nowrap" justify="flex-end">
                          <Button
                            size="compact-sm"
                            variant={isFinished(row.status) ? 'default' : 'light'}
                            onClick={() => setOpenSheetId(row.id)}
                          >
                            {isFinished(row.status) ? 'View' : 'Open'}
                          </Button>
                        </Group>
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
              unit="stock take"
              units="stock takes"
            />
          </>
        )}
      </Card>

      <SheetModal
        stockTakeId={openSheetId}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        onClose={() => setOpenSheetId(null)}
        onChanged={() => void load()}
      />
    </Stack>
  )
}

/**
 * A VARIANCE, IN MONEY, SIGNED. Negative = the shop is missing stock, and that is the number the owner
 * actually opened this screen for — so it is red and it carries its sign. Zero is not "0.00": it is
 * "matched", because "we counted it and the books were right" is a finding, and the most common one.
 *
 * The figure is MAIN's own (`stock.movementValueMinor`, the one place a quantity times a cost becomes
 * money in this app). Nothing here multiplies anything.
 */
function VarianceMoney({
  minor,
  currencySymbol,
  size = 'sm'
}: {
  minor: number
  currencySymbol: string
  size?: string
}): React.JSX.Element {
  if (minor === 0) {
    return (
      <Text size={size} c="dimmed">
        Matched
      </Text>
    )
  }

  const short = minor < 0
  return (
    <Text size={size} fw={600} c={short ? 'red' : 'teal'}>
      {short ? '−' : '+'}
      {formatMoney(Math.abs(minor), { symbol: currencySymbol })}
    </Text>
  )
}

/** The same, for a quantity in thousandths. Signed, red when short. */
function VarianceQty({ qtyM }: { qtyM: number }): React.JSX.Element {
  if (qtyM === 0) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    )
  }

  const short = qtyM < 0
  return (
    <Text size="sm" fw={600} c={short ? 'red' : 'teal'}>
      {short ? '−' : '+'}
      {formatQty(Math.abs(qtyM))}
    </Text>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SHEET — scan, count, see the variance, apply.
// ═════════════════════════════════════════════════════════════════════════════

function SheetModal({
  stockTakeId,
  readOnly,
  currencySymbol,
  onClose,
  onChanged
}: {
  stockTakeId: number | null
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  /** Fired whenever the sheet changes, so the list behind can re-pull. */
  onChanged: () => void
}): React.JSX.Element {
  const [sheet, setSheet] = useState<StockTakeDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [confirming, setConfirming] = useState<'apply' | 'cancel' | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (stockTakeId === null) return
    setLoadError(null)

    const result = await window.pos.stockTake.get({ stockTakeId })
    if (result.ok) setSheet(result.data)
    else setLoadError(result.error.userMessage)
  }, [stockTakeId])

  useEffect(() => {
    if (stockTakeId === null) {
      setSheet(null)
      return
    }
    setSheet(null)
    setConfirming(null)
    void load()
  }, [stockTakeId, load])

  const finished = sheet != null && isFinished(sheet.status)
  // Read-only covers three different reasons, and they are not the same thing: the licence expired,
  // the sheet is history, or it has not loaded yet. Main refuses all three regardless.
  const canCount = sheet != null && !finished && !readOnly

  return (
    <Modal
      opened={stockTakeId !== null}
      onClose={onClose}
      size="90%"
      title={
        <Group gap="sm">
          <ClipboardCheck size={20} />
          <Text fw={650} size="lg">
            Stock take{sheet ? ` #${sheet.id}` : ''}
          </Text>
          {sheet && (
            <Badge size="sm" variant="light" color={STATUS_COLOR[sheet.status]}>
              {STATUS_LABEL[sheet.status]}
            </Badge>
          )}
        </Group>
      }
    >
      {loadError ? (
        <Alert color="red" icon={<CircleAlert size={18} />} title="This stock take could not be opened">
          {loadError}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      ) : !sheet ? (
        <Stack gap={10}>
          <Skeleton height={18} width="40%" />
          <Skeleton height={80} mt="sm" />
          <Skeleton height={200} mt="sm" />
        </Stack>
      ) : (
        <Stack gap="lg">
          {/* ── An applied sheet is HISTORY and says so ─────────────────────── */}
          {sheet.status === 'applied' && (
            <Alert color="teal" variant="light" icon={<CircleCheck size={18} />}>
              <Text size="sm">
                This sheet was applied
                {sheet.appliedAt ? ` on ${new Date(sheet.appliedAt).toLocaleString()}` : ''}
                {sheet.appliedByName ? ` by ${sheet.appliedByName}` : ''}. The corrections are in the
                books and it cannot be changed or applied again — start a new one to make further
                corrections.
              </Text>
            </Alert>
          )}

          {sheet.status === 'cancelled' && (
            <Alert color="gray" variant="light" icon={<Ban size={18} />}>
              <Text size="sm">
                This sheet was cancelled, so it cannot be changed or applied. It is kept exactly as it
                was counted — an abandoned sheet is still a record of what was found.
              </Text>
            </Alert>
          )}

          {/* ── Scan and count ─────────────────────────────────────────────── */}
          {canCount && (
            <CountBox
              stockTakeId={sheet.id}
              onCounted={(detail) => {
                setSheet(detail)
                onChanged()
              }}
            />
          )}

          {/* ── The lines ──────────────────────────────────────────────────── */}
          <LineTable
            sheet={sheet}
            canCount={canCount}
            currencySymbol={currencySymbol}
            onChanged={(detail) => {
              setSheet(detail)
              onChanged()
            }}
          />

          {/* ── The total, and the buttons ─────────────────────────────────── */}
          <SheetFooter
            sheet={sheet}
            finished={finished}
            readOnly={readOnly}
            currencySymbol={currencySymbol}
            onApply={() => setConfirming('apply')}
            onCancelSheet={() => setConfirming('cancel')}
          />
        </Stack>
      )}

      <ConfirmSheetModal
        sheet={confirming !== null ? sheet : null}
        action={confirming}
        currencySymbol={currencySymbol}
        onClose={() => setConfirming(null)}
        onDone={() => {
          setConfirming(null)
          void load()
          onChanged()
        }}
      />
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOT PATH: scan → count → Enter → next.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SCAN AN ITEM AND KEY WHAT IS ON THE SHELF.
 *
 * The counter has a scanner in one hand and is standing at a shelf. The flow is built around that and
 * nothing else: scan (the scanner types the barcode and presses Enter for them) → the item is resolved
 * and the QUANTITY box takes focus → they type what they can see → Enter → saved, and focus snaps back
 * to the scan box for the next item. Two keystrokes and a scan per item, hands never leaving the
 * scanner and the number pad.
 *
 * `catalog.findByBarcode` is the resolver, not `sales.scan`: this is a COUNT, not a sale. A carton with
 * no selling price is perfectly countable — `sales.scan` would refuse it outright, and rightly (it must
 * never be sold), but refusing to let the shop count a carton it can see on the shelf would be absurd.
 *
 * WHAT THIS BOX DOES NOT DO: look up what the books expect. It cannot, and it must not — see the file
 * header. It sends the count and renders whatever main says the variance turned out to be.
 */
function CountBox({
  stockTakeId,
  onCounted
}: {
  stockTakeId: number
  onCounted: (detail: StockTakeDetail) => void
}): React.JSX.Element {
  const [barcode, setBarcode] = useState('')
  const [searching, setSearching] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  /** The item the scan resolved, waiting for its count. */
  const [found, setFound] = useState<{ productId: number; name: string; sku: string } | null>(null)
  const [qtyText, setQtyText] = useState('')
  const [saving, setSaving] = useState(false)

  const scanRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)

  // The scan box owns the focus the moment the sheet opens — the counter's first act is always a scan.
  useEffect(() => {
    scanRef.current?.focus()
  }, [])

  function backToScan(): void {
    setFound(null)
    setQtyText('')
    setBarcode('')
    setScanError(null)
    scanRef.current?.focus()
  }

  async function resolve(): Promise<void> {
    const code = barcode.trim()
    if (code === '' || searching) return

    setSearching(true)
    setScanError(null)

    const result = await window.pos.catalog.findByBarcode({ barcode: code })
    setSearching(false)

    if (!result.ok) {
      setScanError(result.error.userMessage)
      return
    }

    // An unknown barcode is `{ ok: true, data: null }` — an everyday event, not a fault. A plain
    // sentence, and the box stays focused so they can try the next one.
    if (result.data === null) {
      setScanError(`Nothing found for “${code}”. Try searching by name instead.`)
      return
    }

    setFound({
      productId: result.data.product.id,
      name: result.data.product.name,
      sku: result.data.product.sku
    })
    setBarcode('')
    setScanError(null)
    // The quantity box is the next thing they touch. Give it the focus without them reaching for a
    // mouse — the whole point of this screen.
    setTimeout(() => qtyRef.current?.focus(), 0)
  }

  async function saveCount(): Promise<void> {
    if (!found || saving) return

    // Through parseQty, like every quantity in the app — an integer number of thousandths, or a
    // refusal. Never a float (CLAUDE.md §4). Zero is legal and meaningful: "the shelf was empty" is a
    // finding, and often the most important one on the sheet.
    const countedQtyM = parseQty(qtyText)
    if (countedQtyM == null) {
      setScanError('Enter the quantity you counted, like 12 or 1.5. Enter 0 if the shelf is empty.')
      qtyRef.current?.focus()
      return
    }

    setSaving(true)

    // INTENT ONLY. Note what is NOT here: expectedQtyM, varianceQtyM, unitCost, a timestamp, or a
    // user. MAIN reads what the books expect at this instant, freezes the cost, does the subtraction
    // and stamps the counter from the session. (shared/stock-take.ts.)
    const result = await window.pos.stockTake.setCount({
      stockTakeId,
      productId: found.productId,
      countedQtyM
    })

    if (!result.ok) {
      setSaving(false)
      setScanError(result.error.userMessage)
      notifications.show({
        color: 'red',
        title: 'That count was not saved',
        message: result.error.userMessage
      })
      return
    }

    // Re-read the whole sheet so the totals and the lines come from MAIN together. setCount returns
    // the one line; the sheet's variance total is main's own sum, and we do not add it up here.
    const detail = await window.pos.stockTake.get({ stockTakeId })
    setSaving(false)

    if (detail.ok) onCounted(detail.data)

    // The finding, spoken back — so a counter who is not looking at the table still hears that two
    // tins are missing. MAIN's frozen figures, never a number worked out here.
    const line = result.data
    notifications.show({
      color: line.varianceQtyM === 0 ? 'teal' : line.varianceQtyM < 0 ? 'red' : 'orange',
      icon: line.varianceQtyM === 0 ? <CircleCheck size={18} /> : <TriangleAlert size={18} />,
      title: line.nameSnapshot,
      message:
        line.varianceQtyM === 0
          ? `Counted ${formatQty(line.countedQtyM)} — matches the books.`
          : `Counted ${formatQty(line.countedQtyM)}, books say ${formatQty(line.expectedQtyM)} — ${
              line.varianceQtyM < 0 ? 'short' : 'over'
            } by ${formatQty(Math.abs(line.varianceQtyM))}.`,
      autoClose: 4000
    })

    backToScan()
  }

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group gap="sm">
          <ScanLine size={18} />
          <Text fw={600} size="sm">
            Scan an item, then key what is on the shelf
          </Text>
        </Group>

        {!found ? (
          <>
            <Group align="flex-end" gap="sm" wrap="wrap">
              <TextInput
                ref={scanRef}
                label="Barcode"
                description="Scan it, or type it and press Enter."
                placeholder="Scan or type a barcode…"
                leftSection={<ScanLine size={15} />}
                rightSection={searching ? <Loader size={14} /> : undefined}
                value={barcode}
                onChange={(event) => setBarcode(event.currentTarget.value)}
                onKeyDown={(event) => {
                  // The scanner presses Enter for them. So does a person typing.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void resolve()
                  }
                }}
                style={{ flex: 1, minWidth: 280 }}
              />

              <ProductSearchButton
                onPicked={(product) => {
                  setFound(product)
                  setScanError(null)
                  setTimeout(() => qtyRef.current?.focus(), 0)
                }}
              />
            </Group>

            {scanError && (
              <Alert color="orange" variant="light" icon={<CircleAlert size={16} />} p="xs">
                <Text size="sm">{scanError}</Text>
              </Alert>
            )}
          </>
        ) : (
          <>
            <Group align="flex-end" gap="sm" wrap="wrap">
              <div style={{ flex: 1, minWidth: 240 }}>
                <Text size="xs" c="dimmed">
                  Counting
                </Text>
                <Text fw={600}>{found.name}</Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  {found.sku}
                </Text>
              </div>

              <TextInput
                ref={qtyRef}
                label="Counted on the shelf"
                description="What you can actually see. 0 if the shelf is empty."
                placeholder="0"
                value={qtyText}
                onChange={(event) => setQtyText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void saveCount()
                  }
                  // Escape abandons this item and goes back to the scanner — the counter picked up
                  // the wrong tin and does not want to reach for a mouse to say so.
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    backToScan()
                  }
                }}
                style={{ width: 190 }}
              />

              <Button loading={saving} onClick={() => void saveCount()}>
                Save count
              </Button>
              <Button variant="default" disabled={saving} onClick={backToScan}>
                Cancel
              </Button>
            </Group>

            {scanError && (
              <Alert color="orange" variant="light" icon={<CircleAlert size={16} />} p="xs">
                <Text size="sm">{scanError}</Text>
              </Alert>
            )}

            <Text size="xs" c="dimmed">
              Press Enter to save and scan the next item. Press Escape to pick a different item.
            </Text>
          </>
        )}
      </Stack>
    </Card>
  )
}

/**
 * NOT EVERYTHING HAS A BARCODE ON IT. Loose vegetables, a torn label, a bin of screws. The counter
 * needs to find those by name, so the scan box has a search beside it.
 *
 * `products.list` is paginated and indexed (CLAUDE.md §4 — assume 100k+ rows), so this asks for one
 * page of matches as they type rather than pulling the catalog into a dropdown.
 */
function ProductSearchButton({
  onPicked
}: {
  onPicked: (product: { productId: number; name: string; sku: string }) => void
}): React.JSX.Element {
  const [opened, setOpened] = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Array<{ id: number; name: string; sku: string }> | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setSearch('')
      setResults(null)
      setError(null)
    }
  }, [opened])

  // Search as they type, debounced — a 100k-row catalog stays quiet.
  useEffect(() => {
    const term = search.trim()
    if (term === '') {
      setResults(null)
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        const result = await window.pos.products.list({ page: 1, pageSize: 20, search: term })
        if (cancelled) return
        setLoading(false)
        if (!result.ok) {
          setError(result.error.userMessage)
          setResults([])
          return
        }
        setError(null)
        setResults(result.data.rows.map((row) => ({ id: row.id, name: row.name, sku: row.sku })))
      })()
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search])

  return (
    <>
      <Button variant="default" leftSection={<Search size={16} />} onClick={() => setOpened(true)}>
        Find by name
      </Button>

      <Modal opened={opened} onClose={() => setOpened(false)} title="Find an item" centered size="lg">
        <Stack>
          <TextInput
            data-autofocus
            label="Search"
            placeholder="Type a name or stock code…"
            leftSection={<Search size={15} />}
            rightSection={loading ? <Loader size={14} /> : undefined}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />

          {error && (
            <Alert color="red" icon={<CircleAlert size={16} />} p="xs">
              <Text size="sm">{error}</Text>
            </Alert>
          )}

          {results === null ? (
            <Text size="sm" c="dimmed">
              Type to search your items.
            </Text>
          ) : results.length === 0 ? (
            <Text size="sm" c="dimmed">
              No items match “{search.trim()}”.
            </Text>
          ) : (
            <Stack gap={4}>
              {results.map((row) => (
                <Button
                  key={row.id}
                  variant="subtle"
                  justify="space-between"
                  rightSection={
                    <Text size="xs" c="dimmed" ff="monospace">
                      {row.sku}
                    </Text>
                  }
                  onClick={() => {
                    onPicked({ productId: row.id, name: row.name, sku: row.sku })
                    setOpened(false)
                  }}
                >
                  <Text size="sm">{row.name}</Text>
                </Button>
              ))}
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The counted lines. EVERY FIGURE HERE CAME FROM MAIN.
// ─────────────────────────────────────────────────────────────────────────────

function LineTable({
  sheet,
  canCount,
  currencySymbol,
  onChanged
}: {
  sheet: StockTakeDetail
  canCount: boolean
  currencySymbol: string
  onChanged: (detail: StockTakeDetail) => void
}): React.JSX.Element {
  const [removing, setRemoving] = useState<number | null>(null)

  async function removeLine(line: StockTakeLineRow): Promise<void> {
    setRemoving(line.productId)
    const result = await window.pos.stockTake.removeLine({
      stockTakeId: sheet.id,
      productId: line.productId
    })
    setRemoving(null)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That line was not removed',
        message: result.error.userMessage
      })
      return
    }

    onChanged(result.data)
  }

  if (sheet.lines.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Stack align="center" gap="xs" py="xl">
          <ClipboardList size={32} opacity={0.5} />
          <Text fw={600}>Nothing counted yet</Text>
          <Text size="sm" c="dimmed" ta="center" maw={460}>
            {canCount
              ? 'Scan an item above and key what is on the shelf. Every item you count appears here with the difference against the books.'
              : 'This sheet has no counted items on it.'}
          </Text>
        </Stack>
      </Card>
    )
  }

  return (
    <Card withBorder padding="lg">
      <Table.ScrollContainer minWidth={900}>
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th ta="right">Counted</Table.Th>
              {/* Both of these are FROZEN, and both came from main at the instant of counting. The
                  renderer has no idea what the books expect until main tells it. */}
              <Table.Th ta="right">Books say</Table.Th>
              <Table.Th ta="right">Difference</Table.Th>
              <Table.Th ta="right">Worth</Table.Th>
              <Table.Th>Counted by</Table.Th>
              {canCount && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sheet.lines.map((line) => (
              <Table.Tr key={line.id}>
                <Table.Td>
                  {/* The name is the SNAPSHOT taken at counting time — a rename must not rewrite
                      the sheet (migration 0019). */}
                  <Text size="sm">{line.nameSnapshot}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {line.sku}
                  </Text>
                </Table.Td>

                <Table.Td ta="right">
                  <Text size="sm" fw={600}>
                    {formatQty(line.countedQtyM)}
                  </Text>
                </Table.Td>

                <Table.Td ta="right">
                  <Text size="sm" c="dimmed">
                    {formatQty(line.expectedQtyM)}
                  </Text>
                </Table.Td>

                <Table.Td ta="right">
                  <VarianceQty qtyM={line.varianceQtyM} />
                </Table.Td>

                <Table.Td ta="right">
                  <VarianceMoney minor={line.varianceValueMinor} currencySymbol={currencySymbol} />
                </Table.Td>

                <Table.Td>
                  <Text size="sm" c={line.countedByName ? undefined : 'dimmed'}>
                    {line.countedByName ?? '—'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {new Date(line.countedAt).toLocaleTimeString()}
                  </Text>
                </Table.Td>

                {canCount && (
                  <Table.Td>
                    <Group gap={6} wrap="nowrap" justify="flex-end">
                      <Tooltip label="Take this line off the sheet">
                        <Button
                          size="compact-sm"
                          variant="subtle"
                          color="red"
                          leftSection={<Trash2 size={13} />}
                          loading={removing === line.productId}
                          onClick={() => void removeLine(line)}
                        >
                          Remove
                        </Button>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The total, and what can be done with the sheet.
// ─────────────────────────────────────────────────────────────────────────────

function SheetFooter({
  sheet,
  finished,
  readOnly,
  currencySymbol,
  onApply,
  onCancelSheet
}: {
  sheet: StockTakeDetail
  finished: boolean
  readOnly: boolean
  currencySymbol: string
  onApply: () => void
  onCancelSheet: () => void
}): React.JSX.Element {
  const nothingCounted = sheet.lines.length === 0
  const canApply = !finished && !readOnly && !nothingCounted

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" align="center" wrap="wrap" gap="md">
        <div>
          <Text size="sm" c="dimmed">
            {finished ? 'What the differences were worth' : 'What the differences are worth'}
          </Text>
          {/* MAIN's own sum of each line at its own frozen cost. The screen adds nothing up. */}
          <VarianceMoney
            minor={sheet.varianceValueMinor}
            currencySymbol={currencySymbol}
            size="xl"
          />
          <Text size="xs" c="dimmed" mt={2}>
            {sheet.varianceLineCount === 0
              ? `${sheet.lineCount} counted, all matching the books.`
              : `${sheet.varianceLineCount} of ${sheet.lineCount} counted ${
                  sheet.varianceLineCount === 1 ? 'item disagrees' : 'items disagree'
                } with the books.`}
            {sheet.varianceValueMinor < 0 && ' A minus figure means stock is missing.'}
          </Text>
        </div>

        {!finished && (
          <Group gap="sm" wrap="nowrap">
            <Tooltip
              label="Your licence has expired — a stock take cannot be cancelled"
              disabled={!readOnly}
            >
              <Button
                variant="default"
                color="red"
                leftSection={<Ban size={16} />}
                disabled={readOnly}
                onClick={onCancelSheet}
              >
                Cancel this sheet
              </Button>
            </Tooltip>

            <Tooltip
              label={
                readOnly
                  ? 'Your licence has expired — a stock take cannot be applied'
                  : 'Count at least one item first'
              }
              disabled={canApply}
            >
              <Button
                leftSection={<ClipboardCheck size={16} />}
                disabled={!canApply}
                onClick={onApply}
              >
                Apply the sheet
              </Button>
            </Tooltip>
          </Group>
        )}
      </Group>
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Apply / cancel — the two acts that finish a sheet.
// ═════════════════════════════════════════════════════════════════════════════

function ConfirmSheetModal({
  sheet,
  action,
  currencySymbol,
  onClose,
  onDone
}: {
  sheet: StockTakeDetail | null
  action: 'apply' | 'cancel' | null
  currencySymbol: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (action) {
      setWorking(false)
      setError(null)
      setReason('')
    }
  }, [action])

  async function apply(): Promise<void> {
    if (!sheet) return
    setWorking(true)
    setError(null)

    const result = await window.pos.stockTake.apply({ stockTakeId: sheet.id })
    setWorking(false)

    if (!result.ok) {
      setError(result.error.userMessage)
      notifications.show({
        color: 'red',
        title: 'The stock take was not applied',
        message: result.error.userMessage
      })
      return
    }

    // MAIN's frozen result — how many movements actually posted (a matching line posts NOTHING) and
    // what the corrections moved. Never a figure this screen predicted.
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Stock take applied',
      message:
        result.data.movementsPosted === 0
          ? 'Everything counted matched the books, so nothing needed correcting.'
          : `${result.data.movementsPosted} ${
              result.data.movementsPosted === 1 ? 'correction' : 'corrections'
            } posted — ${formatMoney(Math.abs(result.data.varianceValueMinor), {
              symbol: currencySymbol
            })} ${result.data.varianceValueMinor < 0 ? 'written off' : 'added back'}.`,
      autoClose: 8000
    })

    onDone()
  }

  async function cancelSheet(): Promise<void> {
    if (!sheet) return
    setWorking(true)
    setError(null)

    const result = await window.pos.stockTake.cancel({
      stockTakeId: sheet.id,
      reason: reason.trim() === '' ? null : reason.trim()
    })
    setWorking(false)

    if (!result.ok) {
      setError(result.error.userMessage)
      notifications.show({
        color: 'red',
        title: 'The stock take was not cancelled',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Stock take cancelled',
      message: 'Nothing was posted. The sheet is kept exactly as it was counted.'
    })

    onDone()
  }

  const applying = action === 'apply'
  const short = (sheet?.varianceValueMinor ?? 0) < 0

  return (
    <Modal
      opened={action !== null && sheet !== null}
      onClose={onClose}
      centered
      size="lg"
      title={
        <Group gap="sm">
          {applying ? <ClipboardCheck size={20} /> : <Ban size={20} />}
          <Text fw={650}>{applying ? 'Apply this stock take?' : 'Cancel this stock take?'}</Text>
        </Group>
      }
    >
      <Stack>
        {error && (
          <Alert color="red" icon={<CircleAlert size={18} />}>
            {error}
          </Alert>
        )}

        {applying ? (
          <>
            <Text size="sm">
              Your books will be corrected to match what you counted. Every item that disagrees gets a
              stock correction posted against it; every item that matched posts nothing at all.
            </Text>

            {sheet != null && sheet.varianceLineCount > 0 ? (
              <Alert
                color={short ? 'red' : 'orange'}
                variant="light"
                icon={<TriangleAlert size={18} />}
              >
                <Text size="sm" fw={600} mb={4}>
                  {sheet.varianceLineCount}{' '}
                  {sheet.varianceLineCount === 1 ? 'item disagrees' : 'items disagree'} with the
                  books, worth{' '}
                  {formatMoney(Math.abs(sheet.varianceValueMinor), { symbol: currencySymbol })}{' '}
                  {short ? 'missing' : 'extra'}.
                </Text>
                <Text size="sm">
                  {short
                    ? 'That money will be written off — it is stock the shop has paid for and no longer has.'
                    : 'That stock will be added back to the books.'}
                </Text>
              </Alert>
            ) : (
              <Alert color="teal" variant="light" icon={<CircleCheck size={18} />}>
                <Text size="sm">
                  Everything you counted matches the books, so nothing will be corrected. The sheet is
                  still worth keeping — it is the record that you checked.
                </Text>
              </Alert>
            )}

            <Text size="sm" c="dimmed">
              This cannot be undone and a sheet can only be applied once. Your name and the total are
              written to the audit log.
            </Text>
          </>
        ) : (
          <>
            <Text size="sm">
              Nothing will be posted and your books will not change. The sheet is kept exactly as it
              was counted — it is not deleted, because what you found is worth keeping.
            </Text>

            <Textarea
              label="Why (optional)"
              description="A note to yourself about why this count was abandoned."
              autosize
              minRows={2}
              maxRows={4}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose} disabled={working}>
            {applying ? 'Cancel' : 'Keep counting'}
          </Button>
          <Button
            color={applying ? undefined : 'red'}
            leftSection={applying ? <ClipboardCheck size={16} /> : <Ban size={16} />}
            loading={working}
            onClick={() => void (applying ? apply() : cancelSheet())}
          >
            {applying ? 'Apply the sheet' : 'Cancel this sheet'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
