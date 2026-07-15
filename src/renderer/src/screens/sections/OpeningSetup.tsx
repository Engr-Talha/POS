import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Stepper,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  ArrowLeft,
  ArrowRight,
  BookLock,
  Boxes,
  CalendarDays,
  CircleAlert,
  CircleCheck,
  Download,
  FileSpreadsheet,
  HandCoins,
  Info,
  Landmark,
  ListChecks,
  Lock,
  PackageOpen,
  Pencil,
  Plus,
  Tags,
  Trash2,
  TriangleAlert,
  Truck,
  Upload,
  Users,
  Wallet
} from 'lucide-react'
import type { ProductListItem, Supplier } from '@shared/catalog'
import type {
  ImportError,
  ImportLookupList,
  ImportPartyRow,
  ImportPreview,
  ImportStockRow,
  OpeningWizardState
} from '@shared/ipc'
import type { Customer, OpeningPayable, OpeningReceivable, OpeningStockLine } from '@shared/opening'
import { formatMoney } from '@shared/money'
import { formatCost } from '@shared/cost'
import { formatQty } from '@shared/qty'
import { CostInput, LookupSelect, MoneyInput, QtyInput } from './ProductForm'
import { Paginator } from '../../components/Paginator'

/**
 * THE OPENING SETUP WIZARD — the shopkeeper's first hour with this app.
 *
 * It captures what the shop ALREADY HAS on the day it starts: stock on the shelf, cash in the till,
 * money in the bank, udhaar customers owe it, and dues it owes suppliers. Without it the books
 * believe the shop began with nothing, and the first tin sold — a tin bought last year — shows 100%
 * profit, because as far as the ledger knows it cost nothing.
 *
 * NOTHING ON THIS SCREEN TOUCHES THE BOOKS UNTIL "Save to the books" ON THE LAST STEP. Everything
 * before that is a worksheet the owner can edit, re-edit and leave half-finished overnight. The
 * commit posts it all in ONE transaction, balanced against Opening Balance Equity.
 *
 * THREE INTEGER SCALES LIVE ON THIS SCREEN AND THEY ARE NOT INTERCHANGEABLE:
 *   money  2 dp  minor units      cash, bank, udhaar, dues, every total   MoneyInput / formatMoney
 *   cost   4 dp  ten-thousandths  what one unit of stock COST            CostInput  / formatCost
 *   qty_m  3 dp  thousandths      how many are on the shelf              QtyInput   / formatQty
 * A quantity times a cost is neither of those things until main converts it back down. The line
 * values and the totals shown here are computed in MAIN and sent down — this screen never multiplies
 * a quantity by a cost, so it cannot promise a figure the journal does not post.
 */

const DEFAULT_PAGE_SIZE = 25

type StepProps = {
  wizard: OpeningWizardState
  currencySymbol: string
  /** The licence has expired: everything is visible, nothing is saveable. */
  readOnly: boolean
  /** Re-read the summary in main after a change, so every running total on screen stays true. */
  onChanged: () => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Root — decides between the wizard and the locked view, and owns the summary
// ─────────────────────────────────────────────────────────────────────────────

export function OpeningSetup({
  readOnly,
  currencySymbol
}: {
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [wizard, setWizard] = useState<OpeningWizardState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await window.pos.opening.getSummary()
    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }
    setError(null)
    setWizard(result.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error && !wizard) {
    return (
      <Stack gap="lg" maw={900}>
        <Header />
        <Alert color="red" icon={<CircleAlert size={18} />} title="This screen could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      </Stack>
    )
  }

  if (!wizard) {
    return (
      <Stack gap="lg" maw={900}>
        <Header />
        <Skeleton height={70} />
        <Skeleton height={220} />
        <Skeleton height={160} />
      </Stack>
    )
  }

  // The freeze rule, decided in MAIN and sent down. The UI is not the boundary — main refuses the
  // write regardless — but a wizard that cannot see the rule lets the owner type for an hour and
  // only THEN be told no.
  if (!wizard.canEdit) {
    return <Locked wizard={wizard} currencySymbol={currencySymbol} />
  }

  return <Wizard wizard={wizard} currencySymbol={currencySymbol} readOnly={readOnly} onChanged={load} />
}

function Header(): React.JSX.Element {
  return (
    <div>
      <Title order={2}>Opening setup</Title>
      <Text c="dimmed" size="sm" mt={4}>
        What your shop already has, on the day you start using this app.
      </Text>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The locked view — committed, or frozen because the shop has started trading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Locked is not the same as broken, and it is never just a greyed-out form with no explanation. Two
 * different things bring the owner here, and they need two different answers:
 *
 *   COMMITTED  — they did it. The figures below are in the books. This is a receipt.
 *   TRADED     — the shop started selling before the opening balances were saved. That door is now
 *                shut: posting a backdated opening balance behind real sales would re-seed the cost
 *                those sales were already costed against, and the profit reports the owner has been
 *                reading would quietly change underneath them. So we say so, plainly, and point at
 *                the honest route — a stock adjustment, which carries a name and a reason.
 */
function Locked({
  wizard,
  currencySymbol
}: {
  wizard: OpeningWizardState
  currencySymbol: string
}): React.JSX.Element {
  const committed = wizard.status === 'committed'

  return (
    <Stack gap="lg" maw={900}>
      <Header />

      {committed ? (
        <Alert
          color="teal"
          icon={<CircleCheck size={18} />}
          title="Your opening balances are in the books"
        >
          <Text size="sm">
            They were saved on{' '}
            <strong>
              {wizard.committedAt ? new Date(wizard.committedAt).toLocaleString() : '—'}
            </strong>
            , as at <strong>{wizard.goLiveDate}</strong>. Every figure below is posted, balanced
            against Opening Balance Equity, and your reports count from there.
          </Text>
          <Text size="sm" mt="sm">
            Opening balances are entered once and cannot be changed. To correct a stock figure, use{' '}
            <strong>Stock → Adjust</strong> — that records what changed, who changed it and why,
            instead of quietly rewriting history.
          </Text>
        </Alert>
      ) : (
        <Alert
          color="orange"
          icon={<Lock size={18} />}
          title="Opening balances are locked — this shop has already started trading"
        >
          <Text size="sm">
            A sale or a purchase has already been recorded, so the opening balances can no longer be
            saved to the books. This is deliberate: posting a starting balance <em>behind</em> real
            sales would change the cost those sales were already valued at, and the profit figures
            you have already read would quietly move.
          </Text>
          <Text size="sm" mt="sm">
            Nothing is lost. Anything you typed below is still here, and it was never posted. To get
            your stock right from here, use <strong>Stock → Adjust</strong>: it does the same job —
            it moves the stock and posts the matching entry to the books — but it does it with your
            name, the date and a reason against it.
          </Text>
        </Alert>
      )}

      <SummaryCard wizard={wizard} currencySymbol={currencySymbol} title="Opening balances" />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The wizard
// ─────────────────────────────────────────────────────────────────────────────

const STEP_COUNT = 6

function Wizard({
  wizard,
  currencySymbol,
  readOnly,
  onChanged
}: StepProps): React.JSX.Element {
  const [step, setStep] = useState(0)

  // Bumped by an import, and used as the Stepper's key, so every step below REMOUNTS and re-reads.
  //
  // This is not cosmetic. An import REWRITES the three draft lists underneath these steps, and each
  // step reads its rows once, on mount. StepCash goes further: it SEEDS ITS TWO FIELDS from the
  // summary. Without the remount the owner imports 900 items, still sees the old list, and — worse —
  // a stale Cash step still holding yesterday's figure would write it straight back over the one he
  // just imported the moment he pressed Save. The steps must be told the ground moved.
  const [draftVersion, setDraftVersion] = useState(0)

  const steps: StepProps = { wizard, currencySymbol, readOnly, onChanged }

  async function afterImport(): Promise<void> {
    await onChanged()
    setDraftVersion((current) => current + 1)
  }

  return (
    <Stack gap="lg" maw={980}>
      <Header />

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so nothing here can be saved. You can still see everything you
          have entered, and back it up.
        </Alert>
      )}

      <ImportFromExcel
        wizard={wizard}
        currencySymbol={currencySymbol}
        readOnly={readOnly}
        onImported={afterImport}
      />

      <Stepper key={draftVersion} active={step} onStepClick={setStep} allowNextStepsSelect size="sm">
        <Stepper.Step label="Start" description="The date" icon={<CalendarDays size={15} />}>
          <StepIntro {...steps} />
        </Stepper.Step>

        <Stepper.Step label="Stock" description="On the shelf" icon={<Boxes size={15} />}>
          <StepStock {...steps} />
        </Stepper.Step>

        <Stepper.Step label="Cash & bank" description="In hand" icon={<Wallet size={15} />}>
          <StepCash {...steps} />
        </Stepper.Step>

        <Stepper.Step label="Udhaar" description="Owed to you" icon={<Users size={15} />}>
          <StepReceivables {...steps} />
        </Stepper.Step>

        <Stepper.Step label="Supplier dues" description="You owe" icon={<Truck size={15} />}>
          <StepPayables {...steps} />
        </Stepper.Step>

        <Stepper.Step label="Review" description="Save to books" icon={<BookLock size={15} />}>
          <StepReview {...steps} />
        </Stepper.Step>
      </Stepper>

      <Group justify="space-between">
        <Button
          variant="default"
          leftSection={<ArrowLeft size={16} />}
          disabled={step === 0}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
        >
          Back
        </Button>

        <Button
          variant={step === STEP_COUNT - 1 ? 'default' : 'filled'}
          rightSection={<ArrowRight size={16} />}
          disabled={step === STEP_COUNT - 1}
          onClick={() => setStep((current) => Math.min(STEP_COUNT - 1, current + 1))}
        >
          Next
        </Button>
      </Group>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — what this is, and the date it is all AS AT
// ─────────────────────────────────────────────────────────────────────────────

function StepIntro({ wizard, readOnly, onChanged }: StepProps): React.JSX.Element {
  const [date, setDate] = useState(wizard.goLiveDate)
  const [saving, setSaving] = useState(false)

  async function saveDate(next: string): Promise<void> {
    if (next === '' || next === wizard.goLiveDate) return

    setSaving(true)
    // ONLY the field this step edited. A whole object posted back with `openingBank: 0` because this
    // step never loaded it is exactly how a bank balance gets wiped. (CLAUDE.md trap #18.)
    const result = await window.pos.opening.setCashAndBank({ goLiveDate: next })
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The date could not be saved',
        message: result.error.userMessage
      })
      setDate(wizard.goLiveDate)
      return
    }

    await onChanged()
  }

  return (
    <Stack gap="lg" pt="lg">
      <Card withBorder padding="lg">
        <Group gap="sm" mb="xs">
          <Info size={18} />
          <Text fw={600}>Why this matters</Text>
        </Group>

        <Text size="sm" c="dimmed">
          Your shop did not start today. There is stock on the shelves you already paid for, money in
          the till, customers who owe you udhaar, and suppliers you still have to pay. This app knows
          none of it yet.
        </Text>

        <Text size="sm" c="dimmed" mt="sm">
          If you skip this, the very first tin you sell will look like <strong>pure profit</strong> —
          because as far as the books are concerned, it cost you nothing. Your profit, your stock
          value and your balance sheet would all be wrong from day one.
        </Text>

        <Text size="sm" c="dimmed" mt="sm">
          So: walk through these five steps, enter what you already have, and check it on the last
          one. Nothing is saved to your books until you press the button on that final page — until
          then this is just a worksheet, and you can come back to it as often as you like.
        </Text>
      </Card>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="xs">
          <CalendarDays size={18} />
          <Text fw={600}>The date these figures are as at</Text>
        </Group>

        <Text size="sm" c="dimmed" mb="md">
          Usually the day you start using the app. Every opening entry is dated to this day, so your
          reports begin from here. Count your stock and your till on this date.
        </Text>

        <TextInput
          type="date"
          label="Opening date"
          w={240}
          value={date}
          disabled={readOnly || saving}
          onChange={(event) => setDate(event.currentTarget.value)}
          onBlur={(event) => void saveDate(event.currentTarget.value)}
        />
      </Card>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — opening stock
// ─────────────────────────────────────────────────────────────────────────────

/** What the add/edit form on the stock step is holding. */
type StockDraft = {
  /** Present = we are editing that line. Absent = adding a new one. */
  id: number | null
  product: ProductListItem | null
  /** Does the picked product track batches? Only then are batch + expiry offered at all. */
  trackBatches: boolean
  qtyM: number
  unitCost: number
  batchNo: string
  expiryDate: string
}

const EMPTY_STOCK_DRAFT: StockDraft = {
  id: null,
  product: null,
  trackBatches: false,
  qtyM: 0,
  unitCost: 0,
  batchNo: '',
  expiryDate: ''
}

function StepStock({ wizard, currencySymbol, readOnly, onChanged }: StepProps): React.JSX.Element {
  const [rows, setRows] = useState<OpeningStockLine[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState<StockDraft>(EMPTY_STOCK_DRAFT)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.opening.listStockLines({ page, pageSize })
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

  /** Picking a product tells us whether to offer a batch at all — that lives on the product. */
  async function pickProduct(product: ProductListItem | null): Promise<void> {
    if (!product) {
      setDraft((current) => ({ ...current, product: null, trackBatches: false }))
      return
    }

    // The list row does not carry `trackBatches`, so we ask for the detail. It also gives us the
    // item's current average cost, which is a sensible first guess at what the shelf stock cost.
    const detail = await window.pos.products.get({ id: product.id })
    const trackBatches = detail.ok ? detail.data.product.trackBatches : false

    setDraft((current) => ({
      ...current,
      product,
      trackBatches,
      // Only ever a SUGGESTION, and only into an empty field — never over something already typed.
      unitCost: current.unitCost === 0 ? product.costPrice : current.unitCost,
      batchNo: trackBatches ? current.batchNo : '',
      expiryDate: trackBatches ? current.expiryDate : ''
    }))
  }

  async function save(): Promise<void> {
    if (!draft.product || draft.qtyM <= 0) return

    setSaving(true)

    const batchNo = draft.trackBatches && draft.batchNo.trim() !== '' ? draft.batchNo.trim() : null
    // An expiry date has to belong to a BATCH — that is the row that carries it. Derived from
    // `batchNo`, never from the draft field, so an expiry typed and then abandoned (the owner cleared
    // the batch number afterwards) cannot travel on its own and earn a refusal from main.
    const expiryDate = batchNo !== null && draft.expiryDate !== '' ? draft.expiryDate : null

    const line = {
      productId: draft.product.id,
      qtyM: draft.qtyM,
      unitCost: draft.unitCost,
      batchNo,
      expiryDate
    }

    const result =
      draft.id === null
        ? await window.pos.opening.addStockLine(line)
        : await window.pos.opening.updateStockLine({ ...line, id: draft.id })

    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: draft.id === null ? 'That line could not be added' : 'That line could not be changed',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: draft.id === null ? 'Added to the stock sheet' : 'Line changed',
      message: `${draft.product.name} — ${formatQty(draft.qtyM)}`,
      autoClose: 2500
    })

    setDraft(EMPTY_STOCK_DRAFT)
    await onChanged()
    void load()
  }

  async function edit(line: OpeningStockLine): Promise<void> {
    // The table row does not carry the whole product, so re-fetch it: we need `trackBatches` to know
    // whether to show the batch fields, and the picker needs a row to display.
    const detail = await window.pos.products.get({ id: line.productId })
    if (!detail.ok) {
      notifications.show({
        color: 'red',
        title: 'That item could not be loaded',
        message: detail.error.userMessage
      })
      return
    }

    const product = detail.data.product
    setDraft({
      id: line.id,
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        nameOtherLang: product.nameOtherLang,
        categoryId: product.categoryId,
        brandId: product.brandId,
        itemType: product.itemType,
        costPrice: product.costPrice,
        retailPrice: product.retailPrice,
        wholesalePrice: product.wholesalePrice,
        minStockM: product.minStockM,
        isActive: product.isActive,
        onHandM: detail.data.stock.onHandM,
        isBelowReorder: detail.data.stock.isBelowReorder,
        primaryBarcode: null,
        categoryLabel: null,
        brandLabel: null
      },
      trackBatches: product.trackBatches,
      qtyM: line.qtyM,
      unitCost: line.unitCost,
      batchNo: line.batchNo ?? '',
      expiryDate: line.expiryDate ?? ''
    })
  }

  async function remove(line: OpeningStockLine): Promise<void> {
    const result = await window.pos.opening.removeStockLine({ id: line.id })
    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That line could not be removed',
        message: result.error.userMessage
      })
      return
    }

    // Removing the last row on page 2 would otherwise leave the owner staring at "nothing here yet"
    // while 25 lines sit on page 1. Step back a page instead; the page change reloads the list.
    const wasLastOnPage = rows?.length === 1 && page > 1

    if (draft.id === line.id) setDraft(EMPTY_STOCK_DRAFT)
    await onChanged()

    if (wasLastOnPage) setPage(page - 1)
    else void load()
  }

  const editing = draft.id !== null

  return (
    <Stack gap="lg" pt="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        Count what is on your shelves and enter it here — <strong>how many</strong>, and{' '}
        <strong>what one of them cost you</strong> (not what you sell it for). Cost is what makes
        every profit report you ever run correct.
      </Alert>

      {/* ── Add / edit a line ────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Plus size={18} />
          <Text fw={600}>{editing ? 'Change this line' : 'Add an item'}</Text>
          {editing && (
            <Badge variant="light" color="blue">
              editing
            </Badge>
          )}
        </Group>

        <Stack gap="md">
          <ProductPicker
            value={draft.product}
            disabled={readOnly || saving}
            onChange={(product) => void pickProduct(product)}
          />

          <Group grow align="flex-start">
            <QtyInput
              label="How many do you have?"
              description="1 piece = 1, half a kilo = 0.5"
              value={draft.qtyM}
              disabled={readOnly || saving}
              required
              onChange={(qtyM) => setDraft((current) => ({ ...current, qtyM }))}
            />

            <CostInput
              label="What did ONE cost you?"
              description="Your cost, not your selling price. 4 decimal places."
              leftSection={<Text size="sm">{currencySymbol}</Text>}
              value={draft.unitCost}
              disabled={readOnly || saving}
              onChange={(unitCost) => setDraft((current) => ({ ...current, unitCost }))}
            />
          </Group>

          {/* Batch + expiry are OFFERED, never forced, and ONLY for an item set to track batches.
              The owner is not made to invent a batch number for a tin of beans. */}
          {draft.trackBatches && (
            <>
              <Divider
                label="This item tracks batches — you may add one (optional)"
                labelPosition="left"
              />
              <Group grow align="flex-start">
                <TextInput
                  label="Batch number"
                  placeholder="Optional"
                  value={draft.batchNo}
                  disabled={readOnly || saving}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, batchNo: event.currentTarget.value }))
                  }
                />
                <TextInput
                  type="date"
                  label="Expires on"
                  description="Needs a batch number too"
                  value={draft.expiryDate}
                  disabled={readOnly || saving || draft.batchNo.trim() === ''}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, expiryDate: event.currentTarget.value }))
                  }
                />
              </Group>
            </>
          )}

          <Group justify="flex-end">
            {editing && (
              <Button variant="default" disabled={saving} onClick={() => setDraft(EMPTY_STOCK_DRAFT)}>
                Cancel
              </Button>
            )}
            <Button
              leftSection={editing ? <CircleCheck size={16} /> : <Plus size={16} />}
              loading={saving}
              disabled={readOnly || !draft.product || draft.qtyM <= 0}
              onClick={() => void save()}
            >
              {editing ? 'Save this line' : 'Add to the list'}
            </Button>
          </Group>
        </Stack>
      </Card>

      {/* ── The stock sheet so far ───────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>Opening stock</Text>
          <Text size="sm">
            {total} {total === 1 ? 'line' : 'lines'} ·{' '}
            <strong>{formatMoney(wizard.stockValueMinor, { symbol: currencySymbol })}</strong> in
            total
          </Text>
        </Group>

        {error && (
          <Alert color="red" icon={<CircleAlert size={18} />} mb="md">
            {error}
            <Group mt="sm">
              <Button size="xs" variant="default" onClick={() => void load()}>
                Try again
              </Button>
            </Group>
          </Alert>
        )}

        {!rows ? (
          <Stack gap={10}>
            <Skeleton height={34} />
            <Skeleton height={30} />
            <Skeleton height={30} />
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <PackageOpen size={32} opacity={0.5} />
            <Text fw={600}>Nothing on the sheet yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={460}>
              Add the stock that is on your shelves right now, one item at a time. If you genuinely
              opened with no stock, leave this empty and move on.
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={820}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Stock code</Table.Th>
                    <Table.Th>Item</Table.Th>
                    <Table.Th>Batch</Table.Th>
                    <Table.Th ta="right">Quantity</Table.Th>
                    <Table.Th ta="right">Cost each</Table.Th>
                    <Table.Th ta="right">Value</Table.Th>
                    <Table.Th w={90} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Text ff="monospace" size="sm">
                          {row.productSku ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{row.productName ?? `Item #${row.productId}`}</Text>
                      </Table.Td>
                      <Table.Td>
                        {row.batchNo ? (
                          <div>
                            <Text ff="monospace" size="sm">
                              {row.batchNo}
                            </Text>
                            {row.expiryDate && (
                              <Text size="xs" c="dimmed">
                                expires {row.expiryDate}
                              </Text>
                            )}
                          </div>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {formatQty(row.qtyM)}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">
                          {formatCost(row.unitCost, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        {/* Computed in MAIN, per line, rounded exactly as the journal will round it. */}
                        <Text size="sm">
                          {formatMoney(row.lineValueMinor ?? 0, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap" justify="flex-end">
                          <Tooltip label="Change this line">
                            <ActionIcon
                              variant="subtle"
                              disabled={readOnly}
                              aria-label={`Change ${row.productName ?? 'line'}`}
                              onClick={() => void edit(row)}
                            >
                              <Pencil size={15} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Take this line off the list">
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              disabled={readOnly}
                              aria-label={`Remove ${row.productName ?? 'line'}`}
                              onClick={() => void remove(row)}
                            >
                              <Trash2 size={15} />
                            </ActionIcon>
                          </Tooltip>
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
              unit="item"
            />
          </>
        )}
      </Card>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — cash in the till, money in the bank
// ─────────────────────────────────────────────────────────────────────────────

function StepCash({ wizard, currencySymbol, readOnly, onChanged }: StepProps): React.JSX.Element {
  const [cash, setCash] = useState(wizard.openingCashMinor)
  const [bank, setBank] = useState(wizard.openingBankMinor)
  const [saving, setSaving] = useState(false)

  const dirty = cash !== wizard.openingCashMinor || bank !== wizard.openingBankMinor

  async function save(): Promise<void> {
    setSaving(true)
    // BOTH fields are on this step, both were loaded with their real values, and both are being
    // edited here — so sending both is not the trap. The trap is posting back a field the form never
    // loaded. The go-live date is NOT sent: this step never showed it.
    const result = await window.pos.opening.setCashAndBank({
      openingCash: cash,
      openingBank: bank
    })
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That could not be saved',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Saved',
      message: 'Cash and bank',
      autoClose: 2500
    })
    await onChanged()
  }

  return (
    <Stack gap="lg" pt="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        The money you already have on the day you start. Count the till; take the bank figure from
        your statement.
      </Alert>

      <Card withBorder padding="lg">
        <Stack gap="md">
          <Group grow align="flex-start">
            <MoneyInput
              label="Cash in the till"
              description="Notes and coins in the drawer"
              leftSection={<Wallet size={15} />}
              value={cash}
              disabled={readOnly || saving}
              onChange={setCash}
            />

            <MoneyInput
              label="Money in the bank"
              description="Your bank balance on that day"
              leftSection={<Landmark size={15} />}
              value={bank}
              disabled={readOnly || saving}
              onChange={setBank}
            />
          </Group>

          <Text size="sm" c="dimmed">
            Both amounts are in {currencySymbol}, to 2 decimal places. If you have no bank account,
            leave the bank at 0.
          </Text>

          <Group justify="flex-end">
            <Button
              leftSection={<CircleCheck size={16} />}
              loading={saving}
              disabled={readOnly || !dirty}
              onClick={() => void save()}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — customer udhaar (opening receivables)
// ─────────────────────────────────────────────────────────────────────────────

function StepReceivables({
  wizard,
  currencySymbol,
  readOnly,
  onChanged
}: StepProps): React.JSX.Element {
  const [rows, setRows] = useState<OpeningReceivable[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [customer, setCustomer] = useState<Party | null>(null)
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.opening.listReceivables({ page, pageSize })
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

  const searchCustomers = useCallback(async (term: string): Promise<Party[]> => {
    const result = await window.pos.customers.list({
      page: 1,
      pageSize: 20,
      search: term === '' ? undefined : term
    })
    if (!result.ok) return []
    return result.data.rows.map((row) => ({ id: row.id, name: row.name, phone: row.phone }))
  }, [])

  function reset(): void {
    setEditingId(null)
    setCustomer(null)
    setAmount(0)
    setNote('')
  }

  async function save(): Promise<void> {
    if (!customer || amount <= 0) return

    setSaving(true)
    const body = {
      customerId: customer.id,
      amount,
      note: note.trim() === '' ? null : note.trim()
    }

    const result =
      editingId === null
        ? await window.pos.opening.addReceivable(body)
        : await window.pos.opening.updateReceivable({ ...body, id: editingId })

    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That could not be saved',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: editingId === null ? 'Added' : 'Changed',
      message: `${customer.name} — ${formatMoney(amount, { symbol: currencySymbol })}`,
      autoClose: 2500
    })

    reset()
    await onChanged()
    void load()
  }

  async function remove(row: OpeningReceivable): Promise<void> {
    const result = await window.pos.opening.removeReceivable({ id: row.id })
    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That could not be removed',
        message: result.error.userMessage
      })
      return
    }

    // Don't strand the owner on a page that no longer has any rows on it.
    const wasLastOnPage = rows?.length === 1 && page > 1

    if (editingId === row.id) reset()
    await onChanged()

    if (wasLastOnPage) setPage(page - 1)
    else void load()
  }


  return (
    <Stack gap="lg" pt="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        Udhaar — what your customers <strong>already owe you</strong> on the day you start. One
        amount per customer: the balance, not the old bills behind it.
      </Alert>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <HandCoins size={18} />
          {/* A Unicode apostrophe, not `&rsquo;` — an HTML entity inside a JS string is not decoded,
              and would print the entity itself on screen. */}
          <Text fw={600}>
            {editingId === null ? 'Add a customer’s udhaar' : 'Change this amount'}
          </Text>
          {editingId !== null && (
            <Badge variant="light" color="blue">
              editing
            </Badge>
          )}
        </Group>

        <Stack gap="md">
          <PartyPicker
            label="Customer"
            placeholder="Search by name or phone…"
            addLabel="Add a new customer"
            value={customer}
            disabled={readOnly || saving || editingId !== null}
            search={searchCustomers}
            onChange={setCustomer}
            onAdd={() => setAdding(true)}
          />

          <Group grow align="flex-start">
            <MoneyInput
              label="How much do they owe you?"
              leftSection={<Text size="sm">{currencySymbol}</Text>}
              value={amount}
              disabled={readOnly || saving}
              required
              onChange={setAmount}
            />

            <TextInput
              label="Note"
              placeholder="Optional — e.g. old khata"
              value={note}
              disabled={readOnly || saving}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Group>

          <Group justify="flex-end">
            {editingId !== null && (
              <Button variant="default" disabled={saving} onClick={reset}>
                Cancel
              </Button>
            )}
            <Button
              leftSection={editingId === null ? <Plus size={16} /> : <CircleCheck size={16} />}
              loading={saving}
              disabled={readOnly || !customer || amount <= 0}
              onClick={() => void save()}
            >
              {editingId === null ? 'Add to the list' : 'Save this amount'}
            </Button>
          </Group>
        </Stack>
      </Card>

      <PartyTable
        title="Customer udhaar"
        partyHeading="Customer"
        emptyTitle="No udhaar entered"
        emptyBody="If nobody owes you anything on your start date, leave this empty and move on."
        rows={
          rows?.map((row) => ({
            id: row.id,
            partyName: row.customerName ?? `Customer #${row.customerId}`,
            note: row.note,
            amount: row.amount
          })) ?? null
        }
        total={total}
        totalMinor={wizard.receivablesMinor}
        currencySymbol={currencySymbol}
        error={error}
        readOnly={readOnly}
        page={page}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={setPageSize}
        onRetry={() => void load()}
        onEdit={(id) => {
          const row = rows?.find((candidate) => candidate.id === id)
          if (!row) return
          setEditingId(row.id)
          setCustomer({
            id: row.customerId,
            name: row.customerName ?? `Customer #${row.customerId}`,
            phone: null
          })
          setAmount(row.amount)
          setNote(row.note ?? '')
        }}
        onRemove={(id) => {
          const row = rows?.find((candidate) => candidate.id === id)
          if (row) void remove(row)
        }}
      />

      <AddCustomerModal
        opened={adding}
        currencySymbol={currencySymbol}
        onClose={() => setAdding(false)}
        onAdded={(created) => {
          setCustomer({ id: created.id, name: created.name, phone: created.phone })
          setAdding(false)
        }}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — supplier dues (opening payables)
// ─────────────────────────────────────────────────────────────────────────────

function StepPayables({
  wizard,
  currencySymbol,
  readOnly,
  onChanged
}: StepProps): React.JSX.Element {
  const [rows, setRows] = useState<OpeningPayable[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [supplier, setSupplier] = useState<Party | null>(null)
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.opening.listPayables({ page, pageSize })
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

  const searchSuppliers = useCallback(async (term: string): Promise<Party[]> => {
    const result = await window.pos.catalog.listSuppliers({
      page: 1,
      pageSize: 20,
      search: term === '' ? undefined : term
    })
    if (!result.ok) return []
    return result.data.rows.map((row) => ({ id: row.id, name: row.name, phone: row.phone }))
  }, [])

  function reset(): void {
    setEditingId(null)
    setSupplier(null)
    setAmount(0)
    setNote('')
  }

  async function save(): Promise<void> {
    if (!supplier || amount <= 0) return

    setSaving(true)
    const body = {
      supplierId: supplier.id,
      amount,
      note: note.trim() === '' ? null : note.trim()
    }

    const result =
      editingId === null
        ? await window.pos.opening.addPayable(body)
        : await window.pos.opening.updatePayable({ ...body, id: editingId })

    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That could not be saved',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: editingId === null ? 'Added' : 'Changed',
      message: `${supplier.name} — ${formatMoney(amount, { symbol: currencySymbol })}`,
      autoClose: 2500
    })

    reset()
    await onChanged()
    void load()
  }

  async function remove(row: OpeningPayable): Promise<void> {
    const result = await window.pos.opening.removePayable({ id: row.id })
    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That could not be removed',
        message: result.error.userMessage
      })
      return
    }

    // Don't strand the owner on a page that no longer has any rows on it.
    const wasLastOnPage = rows?.length === 1 && page > 1

    if (editingId === row.id) reset()
    await onChanged()

    if (wasLastOnPage) setPage(page - 1)
    else void load()
  }


  return (
    <Stack gap="lg" pt="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        What you <strong>already owe your suppliers</strong> on the day you start. One amount per
        supplier.
      </Alert>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Truck size={18} />
          <Text fw={600}>
            {editingId === null ? 'Add a supplier you owe' : 'Change this amount'}
          </Text>
          {editingId !== null && (
            <Badge variant="light" color="blue">
              editing
            </Badge>
          )}
        </Group>

        <Stack gap="md">
          <PartyPicker
            label="Supplier"
            placeholder="Search by name or phone…"
            addLabel="Add a new supplier"
            value={supplier}
            disabled={readOnly || saving || editingId !== null}
            search={searchSuppliers}
            onChange={setSupplier}
            onAdd={() => setAdding(true)}
          />

          <Group grow align="flex-start">
            <MoneyInput
              label="How much do you owe them?"
              leftSection={<Text size="sm">{currencySymbol}</Text>}
              value={amount}
              disabled={readOnly || saving}
              required
              onChange={setAmount}
            />

            <TextInput
              label="Note"
              placeholder="Optional — e.g. unpaid bills"
              value={note}
              disabled={readOnly || saving}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Group>

          <Group justify="flex-end">
            {editingId !== null && (
              <Button variant="default" disabled={saving} onClick={reset}>
                Cancel
              </Button>
            )}
            <Button
              leftSection={editingId === null ? <Plus size={16} /> : <CircleCheck size={16} />}
              loading={saving}
              disabled={readOnly || !supplier || amount <= 0}
              onClick={() => void save()}
            >
              {editingId === null ? 'Add to the list' : 'Save this amount'}
            </Button>
          </Group>
        </Stack>
      </Card>

      <PartyTable
        title="Supplier dues"
        partyHeading="Supplier"
        emptyTitle="No supplier dues entered"
        emptyBody="If you owe your suppliers nothing on your start date, leave this empty and move on."
        rows={
          rows?.map((row) => ({
            id: row.id,
            partyName: row.supplierName ?? `Supplier #${row.supplierId}`,
            note: row.note,
            amount: row.amount
          })) ?? null
        }
        total={total}
        totalMinor={wizard.payablesMinor}
        currencySymbol={currencySymbol}
        error={error}
        readOnly={readOnly}
        page={page}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={setPageSize}
        onRetry={() => void load()}
        onEdit={(id) => {
          const row = rows?.find((candidate) => candidate.id === id)
          if (!row) return
          setEditingId(row.id)
          setSupplier({
            id: row.supplierId,
            name: row.supplierName ?? `Supplier #${row.supplierId}`,
            phone: null
          })
          setAmount(row.amount)
          setNote(row.note ?? '')
        }}
        onRemove={(id) => {
          const row = rows?.find((candidate) => candidate.id === id)
          if (row) void remove(row)
        }}
      />

      <AddSupplierModal
        opened={adding}
        onClose={() => setAdding(false)}
        onAdded={(created) => {
          setSupplier({ id: created.id, name: created.name, phone: created.phone })
          setAdding(false)
        }}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — review, and the one-way door
// ─────────────────────────────────────────────────────────────────────────────

function StepReview({
  wizard,
  currencySymbol,
  readOnly,
  onChanged
}: StepProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)

  const empty =
    wizard.counts.stockLines === 0 &&
    wizard.counts.receivables === 0 &&
    wizard.counts.payables === 0 &&
    wizard.openingCashMinor === 0 &&
    wizard.openingBankMinor === 0

  async function commit(): Promise<void> {
    setSaving(true)
    const result = await window.pos.opening.commit({ confirm: true })
    setSaving(false)
    setConfirming(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The opening balances could not be saved',
        message: result.error.userMessage,
        autoClose: 8000
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Your opening balances are in the books',
      message: 'Your stock, cash and balances now count from your opening date.',
      autoClose: 7000
    })

    // The committed state comes back from main. Reloading swaps this whole screen to the locked
    // view — the wizard is done, and it does not come back.
    await onChanged()
  }

  return (
    <Stack gap="lg" pt="lg">
      <SummaryCard wizard={wizard} currencySymbol={currencySymbol} title="Check every figure" />

      <Card withBorder padding="lg">
        <Group gap="sm" mb="xs">
          <BookLock size={18} />
          <Text fw={600}>What happens when you save</Text>
        </Group>

        <Text size="sm" c="dimmed">
          Every figure above is written into your books in one go, as at{' '}
          <strong>{wizard.goLiveDate}</strong>. Your stock starts at these quantities and these
          costs, your till and bank start at these amounts, and these customers and suppliers start
          with these balances. Your reports count from there.
        </Text>

        <Alert color="orange" icon={<TriangleAlert size={18} />} mt="md">
          <Text size="sm" fw={600}>
            This is done once, and it cannot be undone.
          </Text>
          <Text size="sm" mt={4}>
            Once you start selling, opening balances are locked for good — a starting balance posted
            behind real sales would change the profit you have already been shown. After this, a
            correction is a <strong>stock adjustment</strong>: it fixes the figure and keeps a record
            of who changed it and why. So check the numbers above now.
          </Text>
        </Alert>

        {empty && (
          <Alert color="yellow" icon={<TriangleAlert size={18} />} mt="md">
            You have not entered anything. If your shop really is starting with no stock, no cash and
            no balances, you can save this — but if you skipped a step, go back now.
          </Alert>
        )}

        <Group justify="flex-end" mt="lg">
          <Button
            leftSection={<BookLock size={16} />}
            color="teal"
            disabled={readOnly}
            onClick={() => setConfirming(true)}
          >
            Save to the books
          </Button>
        </Group>
      </Card>

      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Save your opening balances?"
        centered
      >
        <Stack>
          <Text size="sm">
            This writes your opening stock, cash, bank, udhaar and supplier dues into your books, as
            at <strong>{wizard.goLiveDate}</strong>.
          </Text>

          <Card withBorder padding="sm">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Opening Balance Equity
              </Text>
              <Text size="sm" fw={700}>
                {formatMoney(wizard.openingBalanceEquityMinor, { symbol: currencySymbol })}
              </Text>
            </Group>
          </Card>

          <Text size="sm" c="dimmed">
            It cannot be undone. After this, changes go through a stock adjustment, which is recorded
            with your name and a reason.
          </Text>

          <Group justify="flex-end">
            <Button variant="default" disabled={saving} onClick={() => setConfirming(false)}>
              Not yet
            </Button>
            <Button color="teal" loading={saving} onClick={() => void commit()}>
              Yes, save to the books
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The summary — the same figures the commit posts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OBE = Inventory + Cash + Bank + Receivables − Payables.
 *
 * Every figure here — including the balancing one — is computed in MAIN by the same function the
 * posting uses (`openingBalanceEquityMinor` in shared/opening.ts). This screen only formats them. It
 * does no arithmetic of its own, so it cannot promise a total the journal will not post.
 *
 * A NEGATIVE Opening Balance Equity is CORRECT, not a bug: the shop owes more than it owns. It is
 * shown plainly, and nothing here tries to "fix" it.
 */
function SummaryCard({
  wizard,
  currencySymbol,
  title
}: {
  wizard: OpeningWizardState
  currencySymbol: string
  title: string
}): React.JSX.Element {
  const rows: Array<{ label: string; hint: string; minor: number; negative?: boolean }> = [
    {
      label: 'Stock on the shelf',
      hint: `${wizard.counts.stockLines} ${wizard.counts.stockLines === 1 ? 'item' : 'items'}`,
      minor: wizard.stockValueMinor
    },
    { label: 'Cash in the till', hint: '', minor: wizard.openingCashMinor },
    { label: 'Money in the bank', hint: '', minor: wizard.openingBankMinor },
    {
      label: 'Customers owe you (udhaar)',
      hint: `${wizard.counts.receivables} ${wizard.counts.receivables === 1 ? 'customer' : 'customers'}`,
      minor: wizard.receivablesMinor
    },
    {
      label: 'You owe suppliers',
      hint: `${wizard.counts.payables} ${wizard.counts.payables === 1 ? 'supplier' : 'suppliers'}`,
      minor: wizard.payablesMinor,
      negative: true
    }
  ]

  const negativeWorth = wizard.openingBalanceEquityMinor < 0

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md">
        <Group gap="sm">
          <Boxes size={18} />
          <Text fw={600}>{title}</Text>
        </Group>
        <Badge variant="light" leftSection={<CalendarDays size={12} />}>
          as at {wizard.goLiveDate}
        </Badge>
      </Group>

      <Table>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.label}>
              <Table.Td>
                <Text size="sm">{row.label}</Text>
                {row.hint && (
                  <Text size="xs" c="dimmed">
                    {row.hint}
                  </Text>
                )}
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm" fw={500}>
                  {row.negative && row.minor > 0 ? '− ' : ''}
                  {formatMoney(row.minor, { symbol: currencySymbol })}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}

          <Table.Tr>
            <Table.Td>
              <Text size="sm" fw={700}>
                What the shop is worth on day one
              </Text>
              <Text size="xs" c="dimmed">
                Opening Balance Equity — stock + cash + bank + udhaar − supplier dues
              </Text>
            </Table.Td>
            <Table.Td ta="right">
              <Text size="md" fw={700} c={negativeWorth ? 'orange' : undefined}>
                {formatMoney(wizard.openingBalanceEquityMinor, { symbol: currencySymbol })}
              </Text>
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>

      {negativeWorth && (
        <Alert color="orange" icon={<Info size={18} />} mt="md">
          You owe more than you own on your start date. That is a real answer, not a mistake — the
          books will show it honestly, and it corrects itself as you trade.
        </Alert>
      )}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Import from Excel — the five steps above, filled in from one spreadsheet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SAME WIZARD, FILLED IN FROM A SPREADSHEET.
 *
 * A shop with 900 items is never going to type them in one at a time — and if one at a time is the
 * only way in, the opening balances simply never get entered at all, which is the exact failure this
 * screen exists to prevent. So: download a sheet that ALREADY LISTS HIS ITEMS, fill in two columns,
 * upload it back.
 *
 * THE FLOW, AND IT MUST NEVER SURPRISE HIM:
 *   1. Download the template. It already has his items in it — he adds how many, and what they cost.
 *   2. Upload the filled sheet.
 *   3. PREVIEW: what it WOULD do, and every problem in it, in plain words. NOT ONE ROW IS WRITTEN.
 *   4. Import: fills in the DRAFT, exactly as typing would have. IMPORT IS NOT COMMIT.
 *   5. He still reads the totals on the Review step and presses "Save to the books" himself.
 *
 * A FILE WITH ANY PROBLEM IN IT IS NOT IMPORTED — NOT EVEN THE GOOD ROWS. Taking 880 of 900 rows and
 * quietly dropping 20 is how a shop opens with stock it can never find and nobody ever knows why. The
 * button is disabled, it says which rows and why, and MAIN refuses the file regardless of what this
 * screen does with the button.
 *
 * THE RENDERER NEVER NAMES A FILE. Not one of these three calls takes a path: main opens the dialog,
 * main reads the bytes, main remembers the pick. All this screen can ever say is "the one you chose".
 * (CLAUDE.md §3 — the renderer has no filesystem, not even a little one.)
 *
 * ON AN EXPIRED LICENCE the template and the preview still work, and only the Import button goes.
 * Reading his own catalogue out of his own app is not something an unpaid invoice takes away from
 * him. (CLAUDE.md §6.)
 */
function ImportFromExcel({
  wizard,
  currencySymbol,
  readOnly,
  onImported
}: {
  wizard: OpeningWizardState
  currencySymbol: string
  readOnly: boolean
  onImported: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState<'template' | 'file' | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  async function downloadTemplate(): Promise<void> {
    setBusy('template')
    setError(null)

    const result = await window.pos.opening.downloadTemplate()
    setBusy(null)

    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }

    // NULL = he closed the save dialog. That is not an error and does not deserve a word.
    if (result.data === null) return

    setSavedTo(result.data)
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Your template is saved',
      message: 'Open it in Excel, fill it in, then come back here and upload it.',
      autoClose: 6000
    })
  }

  async function chooseFile(): Promise<void> {
    setBusy('file')
    setError(null)

    // WRITES NOTHING — not one row, not one lookup. It reads the file and says what WOULD happen.
    const result = await window.pos.opening.previewImport()
    setBusy(null)

    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }
    if (result.data === null) return // he closed the file picker

    setPreview(result.data)
  }

  return (
    <>
      <Card withBorder padding="lg">
        <Group gap="sm" mb="xs">
          <FileSpreadsheet size={18} />
          <Text fw={600}>Import from Excel</Text>
          <Badge variant="light">Quicker, for a lot of items</Badge>
        </Group>

        <Text size="sm" c="dimmed">
          Hundreds of items to enter? Download the sheet — <strong>it already lists every item you
          have</strong> — and fill in just two things: <strong>how many you have</strong> and{' '}
          <strong>what one of them cost you</strong>. Items you do not have yet, customers who owe you
          udhaar and suppliers you owe can all be typed straight into the sheet too.
        </Text>

        <Group mt="md" gap="sm">
          <Button
            leftSection={<Download size={16} />}
            loading={busy === 'template'}
            disabled={busy !== null}
            onClick={() => void downloadTemplate()}
          >
            Download the template
          </Button>

          <Button
            variant="default"
            leftSection={<Upload size={16} />}
            loading={busy === 'file'}
            disabled={busy !== null}
            onClick={() => void chooseFile()}
          >
            Upload the filled sheet
          </Button>
        </Group>

        {savedTo && (
          <Alert color="teal" icon={<CircleCheck size={18} />} mt="md" title="Your template is saved">
            <Text size="sm">It went here:</Text>
            <Code block mt={6}>
              {savedTo}
            </Code>
            <Text size="sm" mt="sm">
              Open it in Excel, fill in the quantities and the costs, save it, then press{' '}
              <strong>Upload the filled sheet</strong>.
            </Text>
          </Alert>
        )}

        {error && (
          <Alert color="red" icon={<CircleAlert size={18} />} mt="md" title="That did not work">
            {error}
          </Alert>
        )}

        <Text size="xs" c="dimmed" mt="md">
          You will see exactly what the file would do before any of it happens. Uploading a sheet{' '}
          <strong>replaces your opening lists — it does not add to them</strong>, so if a figure is
          wrong you simply fix the sheet and upload it again. And nothing reaches your books until you
          press “Save to the books” on the last step yourself.
        </Text>
      </Card>

      {preview && (
        <ImportPreviewModal
          preview={preview}
          wizard={wizard}
          currencySymbol={currencySymbol}
          readOnly={readOnly}
          onClose={() => setPreview(null)}
          onReupload={() => {
            setPreview(null)
            void chooseFile()
          }}
          onImported={onImported}
        />
      )}
    </>
  )
}

/**
 * WHAT THIS FILE WOULD DO — shown before it does any of it, which is the entire point of the feature.
 *
 * Every figure here came back from MAIN, computed by the same code that will do the writing and
 * rounded exactly as the journal will round it. This screen does no arithmetic of its own: it cannot
 * promise a total the import will not produce.
 */
function ImportPreviewModal({
  preview,
  wizard,
  currencySymbol,
  readOnly,
  onClose,
  onReupload,
  onImported
}: {
  preview: ImportPreview
  wizard: OpeningWizardState
  currencySymbol: string
  readOnly: boolean
  onClose: () => void
  onReupload: () => void
  onImported: () => Promise<void>
}): React.JSX.Element {
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  const problems = preview.errors.length
  const blocked = problems > 0

  // What is on his lists RIGHT NOW — because the import is about to throw every bit of it away, and
  // that includes anything he typed in by hand. Said with the actual numbers, not in the abstract.
  const onListNow =
    wizard.counts.stockLines + wizard.counts.receivables + wizard.counts.payables

  async function runImport(): Promise<void> {
    setApplying(true)
    setApplyError(null)

    const result = await window.pos.opening.applyImport()
    setApplying(false)

    if (!result.ok) {
      // The likeliest one by a mile: he fixed the sheet in Excel while this window sat open, so the
      // file main remembered is no longer the file he is looking at. Main refuses rather than guess
      // which of the two he meant — and the way out is one button.
      setApplyError(result.error.userMessage)
      return
    }

    // NULL = main had no remembered file, and he closed the picker it offered him instead.
    if (result.data === null) {
      onClose()
      return
    }

    const done = result.data
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Your sheet is on the list',
      message: `${count(done.stockLines, 'stock line', 'stock lines')}, ${count(done.receivables, 'udhaar entry', 'udhaar entries')} and ${count(done.payables, 'supplier due', 'supplier dues')}. It is NOT in your books yet — check the totals on the Review step and save it yourself.`,
      autoClose: 10000
    })

    // Refresh the wizard's figures BEFORE this window goes, so what is underneath is already true.
    await onImported()
    onClose()
  }

  return (
    <Modal
      opened
      onClose={onClose}
      fullScreen
      title={
        <Group gap="sm">
          <FileSpreadsheet size={18} />
          <Text fw={600}>What this file will do</Text>
          <Badge variant="light">{preview.fileName}</Badge>
        </Group>
      }
    >
      <Stack gap="lg" maw={1100} mx="auto" pb="xl">
        {blocked ? (
          <Alert
            color="red"
            icon={<CircleAlert size={18} />}
            title={`This file has ${count(problems, 'problem', 'problems')} in it — nothing has been imported`}
          >
            <Text size="sm">
              Nothing has been changed and nothing has been written. Fix the rows listed below{' '}
              <strong>in the sheet</strong>, save it in Excel, and upload it again.
            </Text>
            <Text size="sm" mt="sm">
              The whole file goes in, or none of it does. Importing the rows that are fine and quietly
              skipping the rest would leave you with stock you cannot account for and no way of ever
              telling which lines were dropped.
            </Text>
          </Alert>
        ) : (
          <Alert color="teal" icon={<CircleCheck size={18} />} title="This file is ready">
            <Text size="sm">
              Every row was read and every figure below is exact. Nothing has been written yet — this
              is what <strong>would</strong> happen if you press Import.
            </Text>
          </Alert>
        )}

        {blocked && <ImportProblems errors={preview.errors} />}

        <PreviewSummary
          preview={preview}
          wizard={wizard}
          currencySymbol={currencySymbol}
          blocked={blocked}
        />

        <PreviewLookups lookups={preview.lookupsToCreate} />

        <PreviewStockTable rows={preview.stock.rows} currencySymbol={currencySymbol} />

        <PreviewPartyTable
          title="Customers who owe you (udhaar)"
          heading="Customer"
          rows={preview.udhaar.rows}
          currencySymbol={currencySymbol}
        />

        <PreviewPartyTable
          title="Suppliers you owe"
          heading="Supplier"
          rows={preview.dues.rows}
          currencySymbol={currencySymbol}
        />

        {/* ── The one-way bit of an import: it REPLACES the lists ─────────────── */}
        <Card withBorder padding="lg">
          <Group gap="sm" mb="xs">
            <TriangleAlert size={18} />
            <Text fw={600}>Before you press Import</Text>
          </Group>

          {onListNow > 0 ? (
            <Alert color="orange" icon={<TriangleAlert size={18} />}>
              <Text size="sm">
                Your opening lists already have{' '}
                <strong>{count(wizard.counts.stockLines, 'stock line', 'stock lines')}</strong>,{' '}
                <strong>
                  {count(wizard.counts.receivables, 'udhaar entry', 'udhaar entries')}
                </strong>{' '}
                and{' '}
                <strong>{count(wizard.counts.payables, 'supplier due', 'supplier dues')}</strong> on
                them.
              </Text>
              <Text size="sm" mt="sm">
                Importing <strong>throws all of that away</strong> and puts this file in its place —
                including anything you typed in by hand. It does not add to it. That is what lets you
                fix a wrong figure in the sheet and upload it again without ending up with double the
                stock you have.
              </Text>
            </Alert>
          ) : (
            <Text size="sm" c="dimmed">
              This fills in your opening lists from the sheet. Upload a corrected sheet later and it{' '}
              <strong>replaces</strong> what is on them — it never adds to it, so the same file
              uploaded twice cannot double your stock.
            </Text>
          )}

          <Text size="sm" c="dimmed" mt="md">
            <strong>This does not save anything to your books.</strong> It fills in the same lists you
            would have typed in yourself, and the Review step still has the last word: you check the
            totals, and you press “Save to the books”.
          </Text>

          <Text size="xs" c="dimmed" mt="xs">
            New items, customers and suppliers from this file stay in your catalogue for good. A later
            upload replaces your opening <em>lists</em> — it does not undo your catalogue.
          </Text>

          {readOnly && (
            <Alert color="orange" icon={<TriangleAlert size={18} />} mt="md">
              Your licence has expired, so nothing can be imported. You can still download the
              template, and you can still check a file here — you just cannot fill in the lists with
              it until the licence is renewed.
            </Alert>
          )}

          {applyError && (
            <Alert
              color="red"
              icon={<CircleAlert size={18} />}
              mt="md"
              title="That could not be imported"
            >
              <Text size="sm">{applyError}</Text>
              <Group mt="sm">
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<Upload size={14} />}
                  onClick={onReupload}
                >
                  Choose the file again
                </Button>
              </Group>
            </Alert>
          )}

          <Group justify="flex-end" mt="lg">
            <Button variant="default" disabled={applying} onClick={onClose}>
              Cancel
            </Button>

            <Tooltip
              label="Fix the rows listed above in your sheet, then upload it again"
              disabled={!blocked}
            >
              {/* A disabled button inside a Tooltip needs a wrapper to still fire the hover. */}
              <div>
                <Button
                  color="teal"
                  leftSection={<ListChecks size={16} />}
                  loading={applying}
                  disabled={blocked || readOnly}
                  onClick={() => void runImport()}
                >
                  Import into my list
                </Button>
              </div>
            </Tooltip>
          </Group>
        </Card>
      </Stack>
    </Modal>
  )
}

/**
 * EVERY PROBLEM IN THE FILE, not just the first — because he has one spreadsheet open and being told
 * about one broken cell at a time is how a man gives up and types 900 rows in by hand.
 *
 * Sheet, row, column, the value that was actually in the cell, and what is wrong with it in words he
 * can act on. The row number is the one EXCEL shows him, because that is the only one he can see.
 */
function ImportProblems({ errors }: { errors: ImportError[] }): React.JSX.Element {
  const paged = usePagedRows(errors)

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="sm">
        <Group gap="sm">
          <CircleAlert size={18} />
          <Text fw={600}>What needs fixing</Text>
        </Group>
        <Text size="sm" c="dimmed">
          {count(errors.length, 'problem', 'problems')}
        </Text>
      </Group>

      <Table.ScrollContainer minWidth={860}>
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={130}>Sheet</Table.Th>
              <Table.Th w={70} ta="right">
                Row
              </Table.Th>
              <Table.Th w={150}>Column</Table.Th>
              <Table.Th w={130}>What it says</Table.Th>
              <Table.Th>What is wrong</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {paged.visible.map((problem, index) => (
              <Table.Tr key={`${problem.sheet}-${problem.row}-${problem.column}-${index}`}>
                <Table.Td>
                  <Text size="sm">{problem.sheet}</Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text size="sm" ff="monospace" fw={600}>
                    {problem.row}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{problem.column === '' ? '—' : problem.column}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace" c={problem.value === '' ? 'dimmed' : undefined}>
                    {problem.value === '' ? '(empty)' : problem.value}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{problem.message}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <PagedFooter paged={paged} total={errors.length} unit="problem" />
    </Card>
  )
}

/** The headline figures — the ones he checks against the paper in his hand before he says yes. */
function PreviewSummary({
  preview,
  wizard,
  currencySymbol,
  blocked
}: {
  preview: ImportPreview
  wizard: OpeningWizardState
  currencySymbol: string
  blocked: boolean
}): React.JSX.Element {
  const { stock, udhaar, dues } = preview
  const catalogueOnly = stock.rows.length - stock.openingLines

  const money = (minor: number): string => formatMoney(minor, { symbol: currencySymbol })

  const rows: Array<{ label: string; hint: string; value: React.ReactNode }> = [
    {
      label: 'Items',
      hint: `${count(stock.existingProducts, 'item you already have', 'items you already have')} · ${count(stock.newProducts, 'new item', 'new items')} will be created`,
      value: <Text size="sm" fw={600}>{count(stock.rows.length, 'item', 'items')}</Text>
    },
    {
      label: 'Stock value',
      hint:
        catalogueOnly > 0
          ? `${count(stock.openingLines, 'line has', 'lines have')} a quantity · ${catalogueOnly} added to the catalogue with no opening stock`
          : `${count(stock.openingLines, 'line', 'lines')} with a quantity`,
      value: (
        <Text size="sm" fw={600}>
          {money(stock.totalValueMinor)}
        </Text>
      )
    },
    {
      label: 'Customers owe you (udhaar)',
      hint: `${count(udhaar.rows.length, 'customer', 'customers')} · ${count(udhaar.newCustomers, 'new customer', 'new customers')} will be created`,
      value: (
        <Text size="sm" fw={600}>
          {money(udhaar.totalMinor)}
        </Text>
      )
    },
    {
      label: 'You owe suppliers',
      hint: `${count(dues.rows.length, 'supplier', 'suppliers')} · ${count(dues.newSuppliers, 'new supplier', 'new suppliers')} will be created`,
      value: (
        <Text size="sm" fw={600}>
          {money(dues.totalMinor)}
        </Text>
      )
    },
    {
      label: 'Cash in the till',
      hint: preview.cash === undefined ? 'The sheet left this blank' : '',
      value:
        preview.cash === undefined ? (
          <Text size="sm" c="dimmed">
            stays at {money(wizard.openingCashMinor)}
          </Text>
        ) : (
          <Text size="sm" fw={600}>
            {money(preview.cash)}
          </Text>
        )
    },
    {
      label: 'Money in the bank',
      hint: preview.bank === undefined ? 'The sheet left this blank' : '',
      value:
        preview.bank === undefined ? (
          <Text size="sm" c="dimmed">
            stays at {money(wizard.openingBankMinor)}
          </Text>
        ) : (
          <Text size="sm" fw={600}>
            {money(preview.bank)}
          </Text>
        )
    }
  ]

  return (
    <Card withBorder padding="lg">
      <Group gap="sm" mb="sm">
        <Boxes size={18} />
        <Text fw={600}>What is in this file</Text>
      </Group>

      {/* A total that quietly leaves out the broken rows is a WRONG total, and a man reading it next
          to "14 problems" will believe it is what he is getting. So it is labelled, in red, above the
          figures it applies to — not in a footnote underneath them. */}
      {blocked && (
        <Alert color="red" icon={<TriangleAlert size={18} />} mb="md">
          <Text size="sm">
            These figures <strong>leave out the rows with problems</strong> — they are not what you
            would end up with. Fix those rows and upload the sheet again to see the real totals.
          </Text>
        </Alert>
      )}

      <Table>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.label}>
              <Table.Td>
                <Text size="sm">{row.label}</Text>
                {row.hint !== '' && (
                  <Text size="xs" c="dimmed">
                    {row.hint}
                  </Text>
                )}
              </Table.Td>
              <Table.Td ta="right">{row.value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}

/** Every list in this app is lookups-driven, so a sheet naming a category the shop has never had is
 *  ADDING one — and he is told which, by name, before it appears in his dropdowns. (CLAUDE.md §4.) */
function PreviewLookups({
  lookups
}: {
  lookups: Record<ImportLookupList, string[]>
}): React.JSX.Element | null {
  const lists: Array<{ list: ImportLookupList; label: string }> = [
    { list: 'department', label: 'Departments' },
    { list: 'category', label: 'Categories' },
    { list: 'sub_category', label: 'Sub-categories' },
    { list: 'brand', label: 'Brands' },
    { list: 'location', label: 'Locations' }
  ]

  const present = lists.filter(({ list }) => lookups[list].length > 0)
  if (present.length === 0) return null

  return (
    <Card withBorder padding="lg">
      <Group gap="sm" mb="xs">
        <Tags size={18} />
        <Text fw={600}>New lists this sheet will create</Text>
      </Group>

      <Text size="sm" c="dimmed" mb="md">
        These do not exist in your shop yet, so they will be added and will appear in your dropdowns.
        If one of them is a spelling mistake, fix it in the sheet and upload it again — otherwise you
        will be left with both spellings.
      </Text>

      <Stack gap="sm">
        {present.map(({ list, label }) => (
          <div key={list}>
            <Text size="xs" c="dimmed" mb={4}>
              {label} ({lookups[list].length})
            </Text>
            <Group gap={6}>
              {lookups[list].map((name) => (
                <Badge key={name} variant="light" color="blue">
                  {name}
                </Badge>
              ))}
            </Group>
          </div>
        ))}
      </Stack>
    </Card>
  )
}

/**
 * Every stock line the file would produce.
 *
 * THREE DIFFERENT INTEGER SCALES ARE ON THIS ONE ROW and they are not interchangeable: `qtyM` is
 * thousandths, `unitCost` is ten-thousandths, `lineValueMinor` and `retailPrice` are 2-dp money. Each
 * goes through its own formatter, and this table never multiplies one by another — main already did
 * that, and rounded it exactly as the journal will.
 */
function PreviewStockTable({
  rows,
  currencySymbol
}: {
  rows: ImportStockRow[]
  currencySymbol: string
}): React.JSX.Element {
  const paged = usePagedRows(rows)

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="sm">
        <Group gap="sm">
          <PackageOpen size={18} />
          <Text fw={600}>Items</Text>
        </Group>
        <Text size="sm" c="dimmed">
          {count(rows.length, 'row', 'rows')}
        </Text>
      </Group>

      {rows.length === 0 ? (
        <Stack align="center" gap="xs" py="lg">
          <PackageOpen size={28} opacity={0.5} />
          <Text size="sm" c="dimmed" ta="center" maw={520}>
            The Stock sheet is empty. That is allowed — the file can carry only udhaar, only dues, or
            only your cash and bank.
          </Text>
        </Stack>
      ) : (
        <>
          <Table.ScrollContainer minWidth={980}>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={70} ta="right">
                    Row
                  </Table.Th>
                  <Table.Th>Stock code</Table.Th>
                  <Table.Th>Item</Table.Th>
                  <Table.Th ta="right">Quantity</Table.Th>
                  <Table.Th ta="right">Cost each</Table.Th>
                  <Table.Th ta="right">Value</Table.Th>
                  <Table.Th ta="right">Sells for</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paged.visible.map((row) => (
                  <Table.Tr key={row.row}>
                    <Table.Td ta="right">
                      <Text size="sm" ff="monospace" c="dimmed">
                        {row.row}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {row.sku}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm">{row.name}</Text>
                        {row.isNew && (
                          <Badge size="xs" variant="light" color="teal">
                            new
                          </Badge>
                        )}
                      </Group>
                      {row.qtyM === 0 && (
                        <Text size="xs" c="dimmed">
                          Added to your catalogue — no opening stock
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" fw={600} c={row.qtyM === 0 ? 'dimmed' : undefined}>
                        {formatQty(row.qtyM)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">{formatCost(row.unitCost, { symbol: currencySymbol })}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">
                        {formatMoney(row.lineValueMinor, { symbol: currencySymbol })}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      {row.retailPrice === undefined ? (
                        <Text size="sm" c="dimmed">
                          unchanged
                        </Text>
                      ) : (
                        <Text size="sm">
                          {formatMoney(row.retailPrice, { symbol: currencySymbol })}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          <PagedFooter paged={paged} total={rows.length} unit="row" />
        </>
      )}
    </Card>
  )
}

/** Udhaar and dues are the same four columns both ways, so they are the same table both ways. */
function PreviewPartyTable({
  title,
  heading,
  rows,
  currencySymbol
}: {
  title: string
  heading: string
  rows: ImportPartyRow[]
  currencySymbol: string
}): React.JSX.Element | null {
  const paged = usePagedRows(rows)

  // Nothing on the sheet, nothing to say. An empty table with a "nothing here" panel for a sheet he
  // deliberately left blank is just noise on a screen that is already long.
  if (rows.length === 0) return null

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="sm">
        <Group gap="sm">
          <Users size={18} />
          <Text fw={600}>{title}</Text>
        </Group>
        <Text size="sm" c="dimmed">
          {count(rows.length, 'row', 'rows')}
        </Text>
      </Group>

      <Table.ScrollContainer minWidth={720}>
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={70} ta="right">
                Row
              </Table.Th>
              <Table.Th>{heading}</Table.Th>
              <Table.Th>Phone</Table.Th>
              <Table.Th>Note</Table.Th>
              <Table.Th ta="right">Amount</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {paged.visible.map((row) => (
              <Table.Tr key={row.row}>
                <Table.Td ta="right">
                  <Text size="sm" ff="monospace" c="dimmed">
                    {row.row}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm">{row.name}</Text>
                    {row.isNew && (
                      <Badge size="xs" variant="light" color="teal">
                        new
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c={row.phone ? undefined : 'dimmed'}>
                    {row.phone ?? '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c={row.note ? undefined : 'dimmed'}>
                    {row.note ?? '—'}
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

      <PagedFooter paged={paged} total={rows.length} unit="row" />
    </Card>
  )
}

// ── The preview's own small parts ────────────────────────────────────────────

type Paged<T> = {
  page: number
  pageSize: number
  total: number
  visible: T[]
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void
}

/**
 * Paging for the preview tables, in the browser — the rows are already in memory, so there is nothing
 * to fetch.
 *
 * It is here because a 10,000-row sheet must not put 10,000 rows into the DOM: the window would lock
 * up for seconds and he would think the app had died, at the exact moment he is deciding whether to
 * trust it with his shop. The page is CLAMPED to the number of pages, so a shorter list after a
 * re-upload cannot strand him on a page that no longer exists.
 */
function usePagedRows<T>(rows: T[]): Paged<T> {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safe = Math.min(page, pages)
  const visible = rows.slice((safe - 1) * pageSize, safe * pageSize)

  return { page: safe, pageSize, total: rows.length, visible, setPage, setPageSize }
}

function PagedFooter<T>({
  paged,
  total,
  unit,
  units
}: {
  paged: Paged<T>
  total: number
  unit: string
  units?: string
}): React.JSX.Element | null {
  return (
    <Paginator
      page={paged.page}
      pageSize={paged.pageSize}
      total={total}
      onPage={paged.setPage}
      onPageSize={paged.setPageSize}
      unit={unit}
      units={units}
    />
  )
}

/** "1 item" / "312 items" — an "s" bolted onto every noun reads like a machine wrote it. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: the product picker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search the catalogue and pick an item. Only STOCKED items are offered — a service or a bag charge
 * has no shelf to sit on, main refuses an opening quantity for one, and a dropdown that offers a
 * choice the app will reject is a trap.
 */
function ProductPicker({
  value,
  onChange,
  disabled
}: {
  value: ProductListItem | null
  onChange: (product: ProductListItem | null) => void
  disabled?: boolean
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<ProductListItem[] | null>(null)

  // A scanner fires a whole barcode in milliseconds. Debouncing keeps us from a query per keystroke
  // while still feeling instant to someone typing a name.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const result = await window.pos.products.list({
        page: 1,
        pageSize: 20,
        search: debounced === '' ? undefined : debounced,
        itemType: 'inventory',
        sortBy: 'name',
        sortDir: 'asc'
      })
      if (cancelled) return
      setRows(result.ok ? result.data.rows : [])
    })()

    return () => {
      cancelled = true
    }
  }, [debounced])

  // The selected item must stay in the option list even when it is not in the latest search results,
  // or Mantine has a value it cannot find a label for and the field goes blank.
  const options = useMemo(() => {
    const found = rows ?? []
    const merged = value && !found.some((row) => row.id === value.id) ? [value, ...found] : found
    return merged.map((row) => ({ value: String(row.id), label: `${row.sku} — ${row.name}` }))
  }, [rows, value])

  return (
    <Select
      label="Item"
      placeholder="Search by stock code, name or barcode…"
      description="Only stocked items appear here"
      data={options}
      value={value ? String(value.id) : null}
      searchable
      clearable
      disabled={disabled}
      leftSection={<PackageOpen size={15} />}
      searchValue={search}
      onSearchChange={setSearch}
      // The server already searched — matching again in the browser would hide a barcode hit whose
      // label does not contain the digits the owner typed.
      filter={({ options: parsed }) => parsed}
      nothingFoundMessage={rows === null ? 'Searching…' : 'No stocked item matches that'}
      onChange={(next) => {
        if (next === null) {
          onChange(null)
          return
        }
        const id = Number(next)
        const picked = (rows ?? []).find((row) => row.id === id) ?? (value?.id === id ? value : null)
        onChange(picked)
      }}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: the party picker (customers and suppliers), and the two add-modals
// ─────────────────────────────────────────────────────────────────────────────

/** The little the two pickers need. Not the whole Customer/Supplier — this is a dropdown, not a form. */
type Party = { id: number; name: string; phone: string | null }

function PartyPicker({
  label,
  placeholder,
  addLabel,
  value,
  search,
  onChange,
  onAdd,
  disabled
}: {
  label: string
  placeholder: string
  addLabel: string
  value: Party | null
  search: (term: string) => Promise<Party[]>
  onChange: (party: Party | null) => void
  onAdd: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<Party[] | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 200)
    return () => clearTimeout(timer)
  }, [term])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await search(debounced)
      if (!cancelled) setRows(found)
    })()
    return () => {
      cancelled = true
    }
  }, [debounced, search])

  const options = useMemo(() => {
    const found = rows ?? []
    const merged = value && !found.some((row) => row.id === value.id) ? [value, ...found] : found
    return merged.map((row) => ({
      value: String(row.id),
      label: row.phone ? `${row.name} — ${row.phone}` : row.name
    }))
  }, [rows, value])

  return (
    <Group gap={6} align="flex-end" wrap="nowrap">
      <Select
        style={{ flex: 1 }}
        label={label}
        placeholder={placeholder}
        data={options}
        value={value ? String(value.id) : null}
        searchable
        clearable
        disabled={disabled}
        searchValue={term}
        onSearchChange={setTerm}
        filter={({ options: parsed }) => parsed}
        nothingFoundMessage={rows === null ? 'Searching…' : 'Nobody matches that — use + to add them'}
        onChange={(next) => {
          if (next === null) {
            onChange(null)
            return
          }
          const id = Number(next)
          const picked =
            (rows ?? []).find((row) => row.id === id) ?? (value?.id === id ? value : null)
          onChange(picked)
        }}
      />

      <Tooltip label={addLabel}>
        <ActionIcon variant="default" size={36} disabled={disabled} aria-label={addLabel} onClick={onAdd}>
          <Plus size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

/**
 * Add a customer without leaving the wizard. The owner is halfway through a list of forty names off
 * a paper khata — sending them to another screen to add Rashid and find their way back is how a
 * worksheet gets abandoned.
 *
 * NOTE WHAT IS ABSENT: a balance. What a customer owes is DERIVED. `creditLimit` is a different
 * thing — how much udhaar they are ALLOWED to run up.
 */
function AddCustomerModal({
  opened,
  currencySymbol,
  onClose,
  onAdded
}: {
  opened: boolean
  currencySymbol: string
  onClose: () => void
  onAdded: (customer: Customer) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [typeLookupId, setTypeLookupId] = useState<number | null>(null)
  const [creditLimit, setCreditLimit] = useState(0)
  const [busy, setBusy] = useState(false)

  function reset(): void {
    setName('')
    setPhone('')
    setAddress('')
    setTypeLookupId(null)
    setCreditLimit(0)
  }

  async function add(): Promise<void> {
    if (!name.trim()) return

    setBusy(true)
    const result = await window.pos.customers.create({
      name: name.trim(),
      phone: phone.trim() === '' ? null : phone.trim(),
      address: address.trim() === '' ? null : address.trim(),
      typeLookupId,
      creditLimit
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The customer could not be added',
        message: result.error.userMessage
      })
      return
    }

    onAdded(result.data)
    reset()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add a customer" centered>
      <Stack>
        <TextInput
          label="Name"
          placeholder="e.g. Muhammad Rashid"
          required
          data-autofocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label="Phone"
            placeholder="Optional"
            value={phone}
            onChange={(event) => setPhone(event.currentTarget.value)}
          />
          {/* From `lookups`, never a hardcoded list — with a "+" to add a type on the spot. */}
          <LookupSelect
            listKey="customer_type"
            label="Type"
            placeholder="Optional"
            value={typeLookupId}
            onChange={setTypeLookupId}
          />
        </Group>
        <TextInput
          label="Address"
          placeholder="Optional"
          value={address}
          onChange={(event) => setAddress(event.currentTarget.value)}
        />
        <MoneyInput
          label="Credit limit"
          description="How much udhaar they are allowed to run up. This is a limit, not what they owe."
          leftSection={<Text size="sm">{currencySymbol}</Text>}
          value={creditLimit}
          onChange={setCreditLimit}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void add()}>
            Add customer
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** Add a supplier without leaving the wizard. Same reasoning as the customer modal above. */
function AddSupplierModal({
  opened,
  onClose,
  onAdded
}: {
  opened: boolean
  onClose: () => void
  onAdded: (supplier: Supplier) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [typeLookupId, setTypeLookupId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  function reset(): void {
    setName('')
    setPhone('')
    setAddress('')
    setTypeLookupId(null)
  }

  async function add(): Promise<void> {
    if (!name.trim()) return

    setBusy(true)
    const result = await window.pos.catalog.createSupplier({
      name: name.trim(),
      phone: phone.trim() === '' ? null : phone.trim(),
      address: address.trim() === '' ? null : address.trim(),
      typeLookupId
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The supplier could not be added',
        message: result.error.userMessage
      })
      return
    }

    onAdded(result.data)
    reset()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add a supplier" centered>
      <Stack>
        <TextInput
          label="Name"
          placeholder="e.g. Shaheen Traders"
          required
          data-autofocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label="Phone"
            placeholder="Optional"
            value={phone}
            onChange={(event) => setPhone(event.currentTarget.value)}
          />
          <LookupSelect
            listKey="supplier_type"
            label="Type"
            placeholder="Optional"
            value={typeLookupId}
            onChange={setTypeLookupId}
          />
        </Group>
        <TextInput
          label="Address"
          placeholder="Optional"
          value={address}
          onChange={(event) => setAddress(event.currentTarget.value)}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void add()}>
            Add supplier
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: the udhaar / dues table. One shape, two steps.
// ─────────────────────────────────────────────────────────────────────────────

type PartyRow = { id: number; partyName: string; note: string | null; amount: number }

function PartyTable({
  title,
  partyHeading,
  emptyTitle,
  emptyBody,
  rows,
  total,
  totalMinor,
  currencySymbol,
  error,
  readOnly,
  page,
  pageSize,
  onPage,
  onPageSize,
  onRetry,
  onEdit,
  onRemove
}: {
  title: string
  partyHeading: string
  emptyTitle: string
  emptyBody: string
  rows: PartyRow[] | null
  total: number
  totalMinor: number
  currencySymbol: string
  error: string | null
  readOnly: boolean
  page: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (pageSize: number) => void
  onRetry: () => void
  onEdit: (id: number) => void
  onRemove: (id: number) => void
}): React.JSX.Element {
  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>{title}</Text>
        <Text size="sm">
          {total} {total === 1 ? 'entry' : 'entries'} ·{' '}
          <strong>{formatMoney(totalMinor, { symbol: currencySymbol })}</strong> in total
        </Text>
      </Group>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} mb="md">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={onRetry}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      {!rows ? (
        <Stack gap={10}>
          <Skeleton height={34} />
          <Skeleton height={30} />
          <Skeleton height={30} />
        </Stack>
      ) : rows.length === 0 && !error ? (
        <Stack align="center" gap="xs" py="xl">
          <Users size={32} opacity={0.5} />
          <Text fw={600}>{emptyTitle}</Text>
          <Text size="sm" c="dimmed" ta="center" maw={460}>
            {emptyBody}
          </Text>
        </Stack>
      ) : (
        <>
          <Table.ScrollContainer minWidth={620}>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{partyHeading}</Table.Th>
                  <Table.Th>Note</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                  <Table.Th w={90} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.id}>
                    <Table.Td>
                      <Text size="sm">{row.partyName}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c={row.note ? undefined : 'dimmed'}>
                        {row.note ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" fw={600}>
                        {formatMoney(row.amount, { symbol: currencySymbol })}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap" justify="flex-end">
                        <Tooltip label="Change this amount">
                          <ActionIcon
                            variant="subtle"
                            disabled={readOnly}
                            aria-label={`Change ${row.partyName}`}
                            onClick={() => onEdit(row.id)}
                          >
                            <Pencil size={15} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Take this off the list">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            disabled={readOnly}
                            aria-label={`Remove ${row.partyName}`}
                            onClick={() => onRemove(row.id)}
                          >
                            <Trash2 size={15} />
                          </ActionIcon>
                        </Tooltip>
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
            onPage={onPage}
            onPageSize={onPageSize}
            unit="entry"
            units="entries"
          />
        </>
      )}
    </Card>
  )
}
