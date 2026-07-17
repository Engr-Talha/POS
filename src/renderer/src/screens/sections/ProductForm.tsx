import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  Pagination,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  ArrowLeft,
  Barcode as BarcodeIcon,
  Boxes,
  CircleAlert,
  History,
  Image as ImageIcon,
  Info,
  Layers,
  Lock,
  Package,
  Pencil,
  Plus,
  Replace,
  Save,
  Scale,
  Tags,
  Trash2,
  TriangleAlert,
  Truck
} from 'lucide-react'
import type { Lookup } from '@shared/types'
import type {
  BarcodeReplacement,
  Batch,
  CreateProductInput,
  ItemType,
  ManualMovementType,
  PriceEntryMode,
  ProductBarcode,
  ProductDetail,
  ProductPack,
  ProductSupplier,
  StockLevel,
  StockMovement,
  UpdateProductInput
} from '@shared/catalog'
import { MANUAL_MOVEMENT_TYPES } from '@shared/catalog'
// The supplier RECORD type is the canonical party contract — the picker below lists and creates
// supplier records through `window.pos.suppliers.*`, so its type comes from '@shared/suppliers' too.
import type { Supplier } from '@shared/suppliers'
import { formatMoney, parseMoney } from '@shared/money'
import { costPerUnit, costToPriceMinor, formatCost, parseCost } from '@shared/cost'
import { formatQty, ONE_UNIT, parseQty } from '@shared/qty'
import { BASIS_POINTS, priceExclusiveFromInclusive, priceInclusiveFromExclusive } from '@shared/tax'

/**
 * THE ITEM DETAIL FORM — the screen that replaces the owner's legacy one. They know that screen by
 * heart, so every field on it is here, in the order they expect.
 *
 * ONE DELIBERATE DIFFERENCE, and it is the whole point: the legacy form let you TYPE OVER THE STOCK.
 * This one does not. Stock is SUM(stock_movements.qty_m) — it is derived, it is read-only here, and
 * the only way to change it is to post a movement with a reason and your name on it. The Balance
 * quantity panel says so, kindly, and offers the honest route right next to it.
 *
 * THREE INTEGER SCALES LIVE ON THIS SCREEN AND THEY ARE NOT INTERCHANGEABLE:
 *   money  2 dp  minor units      retail, wholesale, net profit   formatMoney / parseMoney
 *   cost   4 dp  ten-thousandths  supplier price, unit cost       formatCost  / parseCost
 *   qty_m  3 dp  thousandths      re-order level, pack size       formatQty   / parseQty
 * Nothing here is ever a float. Percentages are basis points; the float in a percent input lives
 * for one expression and is rounded back to an integer before it touches anything that matters.
 *
 * This file is also the LEAF of the three catalog screens: it exports the shared inputs (lookup
 * selects, money/cost/qty fields, the stock-adjustment modal) that Products.tsx and Stock.tsx
 * import. It imports from neither of them, so there is no import cycle.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared: lookups-driven selects. NEVER a hardcoded <Select> option. (CLAUDE.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/** Load one list from `lookups`. Every dropdown in this app comes from there and nowhere else. */
export function useLookupList(listKey: string): {
  items: Lookup[] | null
  reload: () => Promise<Lookup[]>
} {
  const [items, setItems] = useState<Lookup[] | null>(null)

  const reload = useCallback(async (): Promise<Lookup[]> => {
    const result = await window.pos.lookups.list({ listKey })
    const rows = result.ok ? result.data : []
    setItems(rows)
    return rows
  }, [listKey])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, reload }
}

/** The little modal behind every "+ add new". The shop adds its own options; we never ship them. */
function AddLookupModal({
  listKey,
  title,
  opened,
  onClose,
  onAdded
}: {
  listKey: string
  title: string
  opened: boolean
  onClose: () => void
  onAdded: (lookup: Lookup) => void
}): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  async function add(): Promise<void> {
    if (!label.trim()) return
    setBusy(true)
    const result = await window.pos.lookups.add({ listKey, label })
    setBusy(false)

    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not add', message: result.error.userMessage })
      return
    }
    onAdded(result.data)
    setLabel('')
    onClose()
  }

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <Stack>
        <TextInput
          label="Name"
          placeholder="e.g. Beverages"
          data-autofocus
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <Text size="xs" c="dimmed">
          This is added to your list straight away and is available everywhere that list is used. You
          can rename it later in Settings → Manage lists.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!label.trim()} onClick={() => void add()}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** A lookups-backed select whose value is the lookup's **id**. Used for every product classifier. */
export function LookupSelect({
  listKey,
  label,
  description,
  placeholder,
  value,
  onChange,
  disabled,
  required,
  clearable = true,
  allowAdd = true,
  error
}: {
  listKey: string
  label: string
  description?: string
  placeholder?: string
  value: number | null
  onChange: (value: number | null) => void
  disabled?: boolean
  required?: boolean
  clearable?: boolean
  allowAdd?: boolean
  error?: string
}): React.JSX.Element {
  const { items, reload } = useLookupList(listKey)
  const [adding, setAdding] = useState(false)

  const data = useMemo(
    () => (items ?? []).map((item) => ({ value: String(item.id), label: item.label })),
    [items]
  )

  return (
    <>
      <Group gap={6} align="flex-end" wrap="nowrap">
        <Select
          style={{ flex: 1 }}
          label={label}
          description={description}
          placeholder={items === null ? 'Loading…' : (placeholder ?? 'Choose…')}
          data={data}
          value={value === null ? null : String(value)}
          searchable
          clearable={clearable}
          required={required}
          error={error}
          disabled={disabled || items === null}
          nothingFoundMessage="Nothing here yet — use + to add one"
          onChange={(next) => onChange(next === null ? null : Number(next))}
        />
        {allowAdd && (
          <Tooltip label={`Add a new ${label.toLowerCase()}`}>
            <ActionIcon
              variant="default"
              size={36}
              disabled={disabled}
              aria-label={`Add a new ${label.toLowerCase()}`}
              onClick={() => setAdding(true)}
            >
              <Plus size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <AddLookupModal
        listKey={listKey}
        title={`Add a new ${label.toLowerCase()}`}
        opened={adding}
        onClose={() => setAdding(false)}
        onAdded={(lookup) => {
          void reload()
          onChange(lookup.id)
        }}
      />
    </>
  )
}

/**
 * A lookups-backed select whose value is the lookup's **code** — reason codes travel as codes, not
 * ids, because `stock.adjust` checks the code against the owner's own current reason list.
 */
export function LookupCodeSelect({
  listKey,
  label,
  description,
  value,
  onChange,
  disabled,
  required,
  error
}: {
  listKey: string
  label: string
  description?: string
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  required?: boolean
  error?: string
}): React.JSX.Element {
  const { items, reload } = useLookupList(listKey)
  const [adding, setAdding] = useState(false)

  const data = useMemo(
    () => (items ?? []).map((item) => ({ value: item.code, label: item.label })),
    [items]
  )

  return (
    <>
      <Group gap={6} align="flex-end" wrap="nowrap">
        <Select
          style={{ flex: 1 }}
          label={label}
          description={description}
          placeholder={items === null ? 'Loading…' : 'Choose a reason…'}
          data={data}
          value={value}
          searchable
          required={required}
          error={error}
          disabled={disabled || items === null}
          nothingFoundMessage="Nothing here yet — use + to add one"
          onChange={onChange}
        />
        <Tooltip label="Add a new reason">
          <ActionIcon
            variant="default"
            size={36}
            disabled={disabled}
            aria-label="Add a new reason"
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <AddLookupModal
        listKey={listKey}
        title="Add a new reason"
        opened={adding}
        onClose={() => setAdding(false)}
        onAdded={(lookup) => {
          void reload()
          onChange(lookup.code)
        }}
      />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: integer-scale inputs. The canonical value is ALWAYS an integer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A text field over an integer.
 *
 * The integer is the truth; the text is a view of it. While the field has focus we never overwrite
 * what someone is mid-way through typing — and the moment it loses focus it snaps back to whatever
 * the integer now says. That is what lets the price chain rewrite six other fields live as you type
 * in one of them without any of them fighting you.
 */
function ScaledInput({
  label,
  description,
  value,
  onChange,
  parse,
  render,
  disabled,
  readOnly,
  required,
  placeholder,
  leftSection,
  rightSection,
  error,
  autoFocus
}: {
  label?: string
  description?: string
  value: number
  onChange: (value: number) => void
  parse: (text: string) => number | null
  render: (value: number) => string
  disabled?: boolean
  readOnly?: boolean
  required?: boolean
  placeholder?: string
  leftSection?: React.ReactNode
  rightSection?: React.ReactNode
  error?: string
  /** The Sell screen's payment box opens straight onto the amount — a cashier is holding a 500 note. */
  autoFocus?: boolean
}): React.JSX.Element {
  const [text, setText] = useState(() => render(value))
  const [editing, setEditing] = useState(false)
  const [bad, setBad] = useState(false)

  useEffect(() => {
    if (editing) return
    setText(render(value))
    setBad(false)
  }, [value, editing, render])

  return (
    <TextInput
      label={label}
      description={description}
      value={text}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      placeholder={placeholder}
      leftSection={leftSection}
      rightSection={rightSection}
      autoFocus={autoFocus}
      inputMode="decimal"
      error={error ?? (bad ? 'That is not a number we can use.' : undefined)}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        const next = event.currentTarget.value
        setText(next)

        if (next.trim() === '') {
          setBad(false)
          onChange(0)
          return
        }

        const parsed = parse(next)
        if (parsed === null) {
          setBad(true)
          return
        }
        setBad(false)
        onChange(parsed)
      }}
      onBlur={() => {
        setEditing(false)
        setText(render(value))
        setBad(false)
      }}
    />
  )
}

// Module-scope so their identity is stable and the effect above does not re-run every render.
const renderMoney = (value: number): string => formatMoney(value, { grouping: false })
const renderCost = (value: number): string => formatCost(value, { grouping: false })
const renderQty = (value: number): string => formatQty(value)

/** 2-dp money, integer minor units. */
export function MoneyInput(
  props: Omit<Parameters<typeof ScaledInput>[0], 'parse' | 'render'>
): React.JSX.Element {
  return <ScaledInput {...props} parse={parseMoney} render={renderMoney} />
}

/** 4-dp cost, integer ten-thousandths. A DIFFERENT SCALE from money — never mix them. */
export function CostInput(
  props: Omit<Parameters<typeof ScaledInput>[0], 'parse' | 'render'>
): React.JSX.Element {
  return <ScaledInput {...props} parse={parseCost} render={renderCost} />
}

/** Quantity in thousandths. 1 piece = 1000; 1.234 kg = 1234. */
export function QtyInput(
  props: Omit<Parameters<typeof ScaledInput>[0], 'parse' | 'render'>
): React.JSX.Element {
  return <ScaledInput {...props} parse={parseQty} render={renderQty} />
}

/** Percentages are BASIS POINTS: 17% = 1700. The value in and out of here is always that integer. */
function renderPercent(bp: number): string {
  const negative = bp < 0
  const abs = Math.abs(bp)
  const whole = Math.trunc(abs / 100)
  const fraction = abs % 100
  const body =
    fraction === 0
      ? String(whole)
      : `${whole}.${String(fraction).padStart(2, '0').replace(/0+$/, '')}`
  return negative ? `-${body}` : body
}

function parsePercent(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '')
  if (cleaned === '') return null
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return null

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [whole = '', fraction = ''] = unsigned.split('.')
  if (whole === '' && fraction === '') return null
  if (fraction.length > 2) return null

  const bp = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(bp)) return null
  return negative ? -bp : bp
}

function PercentInput(
  props: Omit<Parameters<typeof ScaledInput>[0], 'parse' | 'render'>
): React.JSX.Element {
  return (
    <ScaledInput
      {...props}
      parse={parsePercent}
      render={renderPercent}
      rightSection={props.rightSection ?? <Text size="sm">%</Text>}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The price chain — pure integer arithmetic, all of it derived, none of it stored as truth.
// ─────────────────────────────────────────────────────────────────────────────

/** Supplier price less the discount. 4-dp cost in, 4-dp cost out. */
function costAfterDiscount(supplierPrice: number, discountBp: number): number {
  return Math.round((supplierPrice * (BASIS_POINTS - discountBp)) / BASIS_POINTS)
}

/** Mark-up over cost, in basis points. Null when there is no cost to mark up. */
function markupBp(costMinor: number, priceMinor: number): number | null {
  if (costMinor <= 0) return null
  return Math.round(((priceMinor - costMinor) * BASIS_POINTS) / costMinor)
}

/** The inverse: the price that produces this mark-up. Never below zero. */
function priceFromMarkup(costMinor: number, bp: number): number {
  return Math.max(0, Math.round((costMinor * (BASIS_POINTS + bp)) / BASIS_POINTS))
}

// ─────────────────────────────────────────────────────────────────────────────
// The stock-adjustment modal — THE ONLY WAY STOCK EVER CHANGES BY HAND.
// Lives here (not in Stock.tsx) so the product form can use it without an import cycle.
// ─────────────────────────────────────────────────────────────────────────────

const MOVEMENT_LABEL: Record<ManualMovementType, string> = {
  opening: 'Opening stock',
  adjustment: 'Adjustment',
  damage: 'Damage / waste',
  stock_take: 'Stock take'
}

export function AdjustStockModal({
  opened,
  onClose,
  product,
  onDone
}: {
  opened: boolean
  onClose: () => void
  /** The item being adjusted. Null while the modal is closed. */
  product: { id: number; name: string; sku: string; onHandM: number } | null
  onDone: () => void
}): React.JSX.Element {
  const [type, setType] = useState<ManualMovementType>('adjustment')
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [qtyM, setQtyM] = useState(0)
  const [unitCost, setUnitCost] = useState(0)
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // A fresh item gets a fresh form. Opening stock is the common case on a brand-new product.
  useEffect(() => {
    if (!opened || !product) return
    setType(product.onHandM === 0 ? 'opening' : 'adjustment')
    setDirection('in')
    setQtyM(0)
    setUnitCost(0)
    setReasonCode(null)
    setNote('')
  }, [opened, product])

  // The modal is only ever opened with an item in hand; this keeps the hooks above unconditional.
  if (!product) return <></>

  const signed = direction === 'in' ? qtyM : -qtyM
  const resulting = product.onHandM + signed

  async function submit(): Promise<void> {
    if (!product || qtyM === 0 || !reasonCode) return

    setBusy(true)
    const result = await window.pos.stock.adjust({
      productId: product.id,
      type,
      qtyM: direction === 'in' ? qtyM : -qtyM,
      // Opening stock is the one movement whose cost we know and nothing else does. For everything
      // else the service applies the product's own weighted-average cost, which is the honest figure.
      unitCost: type === 'opening' ? unitCost : undefined,
      reasonCode,
      note: note.trim() === '' ? null : note.trim()
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Stock was not changed',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      title: 'Stock movement posted',
      message: `${product.name} is now ${formatQty(result.data.onHandM)} on hand.`
    })
    onDone()
    onClose()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Change stock" centered size="lg">
      <Stack>
        <Card withBorder padding="sm" radius="sm">
          <Text fw={600}>{product.name}</Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {product.sku}
          </Text>
          <Text size="sm" mt={4}>
            On hand now: <strong>{formatQty(product.onHandM)}</strong>
          </Text>
        </Card>

        <Alert color="blue" icon={<Info size={18} />} p="xs">
          <Text size="xs">
            Stock is never typed in — it is the sum of every movement ever posted. This adds one more
            movement, with your name and your reason on it, and the balance re-adds itself.
          </Text>
        </Alert>

        <Select
          label="Kind of movement"
          data={MANUAL_MOVEMENT_TYPES.map((value) => ({
            value,
            label: MOVEMENT_LABEL[value]
          }))}
          value={type}
          allowDeselect={false}
          onChange={(value) => value && setType(value as ManualMovementType)}
        />

        <div>
          <Text size="sm" fw={500} mb={4}>
            Direction
          </Text>
          <SegmentedControl
            fullWidth
            value={direction}
            onChange={(value) => setDirection(value as 'in' | 'out')}
            data={[
              { value: 'in', label: 'Add to stock' },
              { value: 'out', label: 'Take out of stock' }
            ]}
          />
        </div>

        <Group grow align="flex-start">
          <QtyInput
            label="Quantity"
            description="1 piece = 1, half a kilo = 0.5"
            value={qtyM}
            onChange={setQtyM}
            required
          />
          {type === 'opening' && (
            <CostInput
              label="Cost per unit"
              description="What one of these cost you. 4 decimal places."
              value={unitCost}
              onChange={setUnitCost}
            />
          )}
        </Group>

        <LookupCodeSelect
          listKey="adjustment_reason"
          label="Reason"
          description="An unexplained stock change is a red flag. This one is recorded against your name."
          value={reasonCode}
          onChange={setReasonCode}
          required
        />

        <TextInput
          label="Note (optional)"
          placeholder="Anything the next person should know"
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        {qtyM > 0 && (
          <Alert
            color={resulting < 0 ? 'orange' : 'gray'}
            icon={resulting < 0 ? <TriangleAlert size={18} /> : <Info size={18} />}
            p="xs"
          >
            <Text size="sm">
              After this: <strong>{formatQty(resulting)}</strong> on hand.
              {resulting < 0 && ' That is below zero — allowed, but it will be flagged.'}
            </Text>
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={qtyM === 0 || !reasonCode}
            leftSection={<Save size={16} />}
            onClick={() => void submit()}
          >
            Post movement
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The form itself
// ─────────────────────────────────────────────────────────────────────────────

type FormState = {
  sku: string
  name: string
  nameOtherLang: string

  departmentId: number | null
  categoryId: number | null
  subCategoryId: number | null
  brandId: number | null
  locationId: number | null
  favouriteGroupId: number | null

  saleUomId: number | null
  sizeVolume: string

  /** 4-dp cost of ONE base unit. This is what `products.cost_price` holds. */
  costPrice: number
  /** 2-dp money, in whichever tax mode the product is set to. */
  retailPrice: number
  wholesalePrice: number

  taxRateBp: number
  priceEntryMode: PriceEntryMode
  isTaxExempt: boolean

  itemType: ItemType
  trackBatches: boolean
  trackSerials: boolean
  isWeighted: boolean

  minStockM: number
  imagePath: string
  isActive: boolean
}

const EMPTY_FORM: FormState = {
  sku: '',
  name: '',
  nameOtherLang: '',
  departmentId: null,
  categoryId: null,
  subCategoryId: null,
  brandId: null,
  locationId: null,
  favouriteGroupId: null,
  saleUomId: null,
  sizeVolume: '',
  costPrice: 0,
  retailPrice: 0,
  wholesalePrice: 0,
  taxRateBp: 0,
  priceEntryMode: 'exclusive',
  isTaxExempt: false,
  itemType: 'inventory',
  trackBatches: false,
  trackSerials: false,
  isWeighted: false,
  minStockM: 0,
  imagePath: '',
  isActive: true
}

function toForm(product: ProductDetail['product']): FormState {
  return {
    sku: product.sku,
    name: product.name,
    nameOtherLang: product.nameOtherLang ?? '',
    departmentId: product.departmentId,
    categoryId: product.categoryId,
    subCategoryId: product.subCategoryId,
    brandId: product.brandId,
    locationId: product.locationId,
    favouriteGroupId: product.favouriteGroupId,
    saleUomId: product.saleUomId,
    sizeVolume: product.sizeVolume ?? '',
    costPrice: product.costPrice,
    retailPrice: product.retailPrice,
    wholesalePrice: product.wholesalePrice,
    taxRateBp: product.taxRateBp,
    priceEntryMode: product.priceEntryMode,
    isTaxExempt: product.isTaxExempt,
    itemType: product.itemType,
    trackBatches: product.trackBatches,
    trackSerials: product.trackSerials,
    isWeighted: product.isWeighted,
    minStockM: product.minStockM,
    imagePath: product.imagePath ?? '',
    isActive: product.isActive
  }
}

/** Empty string means "cleared" for a nullable column — `.nullish()` is what zod expects there. */
function orNull(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

export function ProductForm({
  productId,
  readOnly,
  currencySymbol,
  onClose,
  onSaved
}: {
  /** Null = a brand-new item. */
  productId: number | null
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  /**
   * "This item was saved" — NOT "close the form". Saving keeps you where you are: a freshly created
   * item stays open so you can go straight to its barcodes and its opening stock, which is exactly
   * the moment you need them. The only way out is Back to items.
   */
  onSaved: (productId: number) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<string | null>('details')
  const [adjusting, setAdjusting] = useState(false)

  // The price chain's own inputs. NONE of these are columns — supplier price and discount are stored
  // per supplier (Suppliers tab), and the pack size is stored per packing (Packings tab). Here they
  // are a calculator whose one output, UNIT COST, is the thing that gets saved.
  const [supplierPrice, setSupplierPrice] = useState(0)
  const [discountBp, setDiscountBp] = useState(0)
  const [unitsPerPack, setUnitsPerPack] = useState(1)

  // Only a barcode typed on a NEW product goes in with the create call — once the item exists,
  // barcodes are their own tab with their own endpoints.
  const [newBarcode, setNewBarcode] = useState('')

  const editing = productId !== null

  const load = useCallback(async (): Promise<void> => {
    if (productId === null) {
      setDetail(null)
      setForm(EMPTY_FORM)
      return
    }

    setLoadError(null)
    const result = await window.pos.products.get({ id: productId })
    if (!result.ok) {
      setLoadError(result.error.userMessage)
      return
    }

    setDetail(result.data)
    setForm(toForm(result.data.product))

    // Seed the calculator from the preferred supplier, so the chain shows the real numbers this
    // shop actually buys at rather than zeros.
    const preferred =
      result.data.suppliers.find((row) => row.isPreferred) ?? result.data.suppliers[0] ?? null
    setSupplierPrice(preferred?.supplierPrice ?? 0)
    setDiscountBp(preferred?.discountBp ?? 0)
  }, [productId])

  useEffect(() => {
    void load()
  }, [load])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((current) => ({ ...current, [key]: value }))

  // ── The price chain, live ──────────────────────────────────────────────────
  const effectiveRateBp = form.isTaxExempt ? 0 : form.taxRateBp
  const packCost = costAfterDiscount(supplierPrice, discountBp)
  const unitCostMinor = costToPriceMinor(form.costPrice)

  const retailExcl =
    form.priceEntryMode === 'exclusive'
      ? form.retailPrice
      : priceExclusiveFromInclusive(form.retailPrice, effectiveRateBp)
  const retailIncl =
    form.priceEntryMode === 'exclusive'
      ? priceInclusiveFromExclusive(form.retailPrice, effectiveRateBp)
      : form.retailPrice

  const wholesaleExcl =
    form.priceEntryMode === 'exclusive'
      ? form.wholesalePrice
      : priceExclusiveFromInclusive(form.wholesalePrice, effectiveRateBp)
  const wholesaleIncl =
    form.priceEntryMode === 'exclusive'
      ? priceInclusiveFromExclusive(form.wholesalePrice, effectiveRateBp)
      : form.wholesalePrice

  /** The stored price is whichever side matches the product's tax mode. The other is a view of it. */
  const setRetailFromExcl = (excl: number): void =>
    set(
      'retailPrice',
      form.priceEntryMode === 'exclusive' ? excl : priceInclusiveFromExclusive(excl, effectiveRateBp)
    )
  const setRetailFromIncl = (incl: number): void =>
    set(
      'retailPrice',
      form.priceEntryMode === 'inclusive' ? incl : priceExclusiveFromInclusive(incl, effectiveRateBp)
    )
  const setWholesaleFromExcl = (excl: number): void =>
    set(
      'wholesalePrice',
      form.priceEntryMode === 'exclusive' ? excl : priceInclusiveFromExclusive(excl, effectiveRateBp)
    )
  const setWholesaleFromIncl = (incl: number): void =>
    set(
      'wholesalePrice',
      form.priceEntryMode === 'inclusive' ? incl : priceExclusiveFromInclusive(incl, effectiveRateBp)
    )

  /** Touching any calculator input re-divides the pack cost down to one unit. */
  const recomputeUnitCost = (price: number, discount: number, units: number): void => {
    const safeUnits = units > 0 ? units : 1
    set('costPrice', costPerUnit(costAfterDiscount(price, discount), safeUnits))
  }

  const retailProfitBp = markupBp(unitCostMinor, retailExcl)
  const wholesaleMarginBp = markupBp(unitCostMinor, wholesaleExcl)
  const netProfitMinor = retailExcl - unitCostMinor

  // ── Save ───────────────────────────────────────────────────────────────────
  const canSave = form.sku.trim() !== '' && form.name.trim() !== '' && form.saleUomId !== null

  async function save(): Promise<void> {
    // Pulled out of `form` so the null check survives into both branches below — every item is sold
    // in SOME unit, and every qty_m in the app is measured in it.
    const saleUomId = form.saleUomId
    if (!canSave || saleUomId === null) return
    setSaving(true)

    if (!editing) {
      const input: CreateProductInput = {
        sku: form.sku.trim(),
        name: form.name.trim(),
        nameOtherLang: orNull(form.nameOtherLang),
        departmentId: form.departmentId,
        categoryId: form.categoryId,
        subCategoryId: form.subCategoryId,
        brandId: form.brandId,
        locationId: form.locationId,
        favouriteGroupId: form.favouriteGroupId,
        saleUomId,
        sizeVolume: orNull(form.sizeVolume),
        costPrice: form.costPrice,
        retailPrice: form.retailPrice,
        wholesalePrice: form.wholesalePrice,
        taxRateBp: form.taxRateBp,
        priceEntryMode: form.priceEntryMode,
        isTaxExempt: form.isTaxExempt,
        itemType: form.itemType,
        trackBatches: form.trackBatches,
        trackSerials: form.trackSerials,
        isWeighted: form.isWeighted,
        minStockM: form.minStockM,
        imagePath: orNull(form.imagePath),
        variantGroupId: null,
        attributes: null,
        barcodes: newBarcode.trim() === '' ? undefined : [newBarcode.trim()]
      }

      const result = await window.pos.products.create(input)
      setSaving(false)

      if (!result.ok) {
        notifications.show({
          color: 'red',
          title: 'Could not save this item',
          message: result.error.userMessage
        })
        return
      }

      notifications.show({
        color: 'teal',
        title: 'Item saved',
        message: `${result.data.product.name} is in your catalogue. Its stock is zero until you post an opening movement.`
      })
      // Hand the new id up: the parent re-points this form at the saved item, so the barcode,
      // packing, supplier and batch tabs unlock in place instead of dumping us back on the list.
      onSaved(result.data.product.id)
      return
    }

    // EDIT: send ONLY what changed. Posting the whole object back is how a field the form never
    // loaded gets wiped (trap #18). Packs, barcodes and suppliers are grids with their own
    // endpoints — they are never part of this payload.
    const before = detail?.product
    if (!before) {
      setSaving(false)
      return
    }

    const patch: UpdateProductInput = { id: before.id }
    const put = <K extends keyof UpdateProductInput>(key: K, value: UpdateProductInput[K]): void => {
      patch[key] = value
    }

    if (form.sku.trim() !== before.sku) put('sku', form.sku.trim())
    if (form.name.trim() !== before.name) put('name', form.name.trim())
    if (orNull(form.nameOtherLang) !== before.nameOtherLang)
      put('nameOtherLang', orNull(form.nameOtherLang))
    if (form.departmentId !== before.departmentId) put('departmentId', form.departmentId)
    if (form.categoryId !== before.categoryId) put('categoryId', form.categoryId)
    if (form.subCategoryId !== before.subCategoryId) put('subCategoryId', form.subCategoryId)
    if (form.brandId !== before.brandId) put('brandId', form.brandId)
    if (form.locationId !== before.locationId) put('locationId', form.locationId)
    if (form.favouriteGroupId !== before.favouriteGroupId)
      put('favouriteGroupId', form.favouriteGroupId)
    if (saleUomId !== before.saleUomId) put('saleUomId', saleUomId)
    if (orNull(form.sizeVolume) !== before.sizeVolume) put('sizeVolume', orNull(form.sizeVolume))
    // costPrice is NOT sent. It is the weighted average of what the shop actually PAID — derived
    // from stock movements, not a field you type. The form still SHOWS the price chain live (supplier
    // price → discount → cost → unit cost) because that is how the shopkeeper thinks, but on an
    // existing item that figure is a preview of what the NEXT purchase will cost, not an instruction
    // to revalue stock already on the shelf. Sending it used to silently rewrite the cost of existing
    // stock with no movement and no journal behind it.
    if (form.retailPrice !== before.retailPrice) put('retailPrice', form.retailPrice)
    if (form.wholesalePrice !== before.wholesalePrice) put('wholesalePrice', form.wholesalePrice)
    if (form.taxRateBp !== before.taxRateBp) put('taxRateBp', form.taxRateBp)
    if (form.priceEntryMode !== before.priceEntryMode) put('priceEntryMode', form.priceEntryMode)
    if (form.isTaxExempt !== before.isTaxExempt) put('isTaxExempt', form.isTaxExempt)
    if (form.itemType !== before.itemType) put('itemType', form.itemType)
    if (form.trackBatches !== before.trackBatches) put('trackBatches', form.trackBatches)
    if (form.trackSerials !== before.trackSerials) put('trackSerials', form.trackSerials)
    if (form.isWeighted !== before.isWeighted) put('isWeighted', form.isWeighted)
    if (form.minStockM !== before.minStockM) put('minStockM', form.minStockM)
    if (orNull(form.imagePath) !== before.imagePath) put('imagePath', orNull(form.imagePath))
    if (form.isActive !== before.isActive) put('isActive', form.isActive)

    if (Object.keys(patch).length === 1) {
      setSaving(false)
      notifications.show({ color: 'gray', title: 'Nothing to save', message: 'No changes were made.' })
      return
    }

    const result = await window.pos.products.update(patch)
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not save this item',
        message: result.error.userMessage
      })
      return
    }

    setDetail(result.data)
    setForm(toForm(result.data.product))
    notifications.show({ color: 'teal', title: 'Saved', message: result.data.product.name })
    onSaved(result.data.product.id)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <Stack gap="lg">
        <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onClose} w="fit-content">
          Back to items
        </Button>
        <Alert color="red" icon={<CircleAlert size={18} />} title="This item could not be opened">
          {loadError}
        </Alert>
      </Stack>
    )
  }

  if (editing && !detail) {
    return (
      <Stack gap="lg">
        <Skeleton height={36} width={140} />
        <Skeleton height={30} width={280} />
        <Skeleton height={340} />
      </Stack>
    )
  }

  const stock: StockLevel | null = detail?.stock ?? null

  return (
    <Stack gap="lg">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <Group justify="space-between" align="flex-start">
        <Group gap="sm" align="center">
          <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={onClose}>
            Back to items
          </Button>
          <div>
            <Title order={2}>{editing ? form.name || 'Item detail' : 'New item'}</Title>
            {editing && (
              <Text size="sm" c="dimmed" ff="monospace">
                {form.sku}
              </Text>
            )}
          </div>
          {editing && !form.isActive && (
            <Badge color="gray" variant="light">
              Not active
            </Badge>
          )}
        </Group>

        <Button
          leftSection={<Save size={16} />}
          loading={saving}
          disabled={readOnly || !canSave}
          onClick={() => void save()}
        >
          {editing ? 'Save changes' : 'Create item'}
        </Button>
      </Group>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so items cannot be changed. You can still look at everything and
          export it.
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="details" leftSection={<Package size={15} />}>
            Item detail
          </Tabs.Tab>
          <Tabs.Tab value="barcodes" leftSection={<BarcodeIcon size={15} />} disabled={!editing}>
            Barcodes
          </Tabs.Tab>
          <Tabs.Tab value="packs" leftSection={<Boxes size={15} />} disabled={!editing}>
            Alternate packings
          </Tabs.Tab>
          <Tabs.Tab value="suppliers" leftSection={<Truck size={15} />} disabled={!editing}>
            Suppliers
          </Tabs.Tab>
          <Tabs.Tab value="batches" leftSection={<Layers size={15} />} disabled={!editing}>
            Batches
          </Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<History size={15} />} disabled={!editing}>
            History
          </Tabs.Tab>
        </Tabs.List>

        {/* ── ITEM DETAIL ───────────────────────────────────────────────────── */}
        <Tabs.Panel value="details" pt="lg">
          <Stack gap="lg" maw={980}>
            {!editing && (
              <Alert color="blue" icon={<Info size={18} />}>
                Barcodes, packings, suppliers and batches open once the item is created — they hang
                off it. Fill in the detail below and press <strong>Create item</strong> first.
              </Alert>
            )}

            {/* Identity */}
            <Card withBorder padding="lg">
              <Group gap="sm" mb="md">
                <Package size={18} />
                <Text fw={600}>Item</Text>
              </Group>

              <Stack>
                <Group grow align="flex-start">
                  <TextInput
                    label="Stock code"
                    description="Your own code for this item. Must be unique."
                    placeholder="e.g. TEA-500"
                    required
                    disabled={readOnly}
                    value={form.sku}
                    onChange={(event) => set('sku', event.currentTarget.value)}
                  />
                  <TextInput
                    label="Item name"
                    required
                    disabled={readOnly}
                    value={form.name}
                    onChange={(event) => set('name', event.currentTarget.value)}
                  />
                </Group>

                <TextInput
                  label="Other language name (Urdu)"
                  description="Printed on the receipt underneath the English name."
                  dir="auto"
                  disabled={readOnly}
                  value={form.nameOtherLang}
                  onChange={(event) => set('nameOtherLang', event.currentTarget.value)}
                />

                {!editing && (
                  <TextInput
                    label="Barcode"
                    description="Scan it here. You can add more barcodes once the item is created."
                    leftSection={<BarcodeIcon size={16} />}
                    disabled={readOnly}
                    value={newBarcode}
                    onChange={(event) => setNewBarcode(event.currentTarget.value)}
                  />
                )}
              </Stack>
            </Card>

            {/* Classification — every one of these is lookups-driven. */}
            <Card withBorder padding="lg">
              <Group gap="sm" mb="xs">
                <Tags size={18} />
                <Text fw={600}>Classification</Text>
              </Group>
              <Text size="xs" c="dimmed" mb="md">
                Every one of these lists is yours. Use <strong>+</strong> to add an option without
                leaving this screen — none of them are built into the app.
              </Text>

              <Stack>
                <Group grow align="flex-start">
                  <LookupSelect
                    listKey="department"
                    label="Department"
                    value={form.departmentId}
                    onChange={(value) => set('departmentId', value)}
                    disabled={readOnly}
                  />
                  <LookupSelect
                    listKey="category"
                    label="Category"
                    value={form.categoryId}
                    onChange={(value) => set('categoryId', value)}
                    disabled={readOnly}
                  />
                </Group>

                <Group grow align="flex-start">
                  <LookupSelect
                    listKey="sub_category"
                    label="Sub-category"
                    value={form.subCategoryId}
                    onChange={(value) => set('subCategoryId', value)}
                    disabled={readOnly}
                  />
                  <LookupSelect
                    listKey="brand"
                    label="Brand"
                    value={form.brandId}
                    onChange={(value) => set('brandId', value)}
                    disabled={readOnly}
                  />
                </Group>

                <Group grow align="flex-start">
                  <LookupSelect
                    listKey="location"
                    label="Location"
                    description="Aisle or shelf"
                    value={form.locationId}
                    onChange={(value) => set('locationId', value)}
                    disabled={readOnly}
                  />
                  <LookupSelect
                    listKey="favourite_group"
                    label="Favourites"
                    description="Quick-pick tiles on the Sell screen"
                    value={form.favouriteGroupId}
                    onChange={(value) => set('favouriteGroupId', value)}
                    disabled={readOnly}
                  />
                </Group>

                <Divider my={4} />

                <Group grow align="flex-start">
                  <LookupSelect
                    listKey="uom"
                    label="Selling unit"
                    description="The unit you sell ONE of. Every quantity in the app is in this unit."
                    value={form.saleUomId}
                    onChange={(value) => set('saleUomId', value)}
                    disabled={readOnly}
                    required
                    clearable={false}
                    error={form.saleUomId === null ? 'Every item is sold in some unit.' : undefined}
                  />
                  <TextInput
                    label="Size / volume"
                    description="Free text, e.g. 1.5 L or 250 g"
                    disabled={readOnly}
                    value={form.sizeVolume}
                    onChange={(event) => set('sizeVolume', event.currentTarget.value)}
                  />
                </Group>
              </Stack>
            </Card>

            {/* THE PRICE CHAIN */}
            <Card withBorder padding="lg">
              <Group gap="sm" mb="xs">
                <Scale size={18} />
                <Text fw={600}>Price chain</Text>
              </Group>
              <Text size="xs" c="dimmed" mb="md">
                Supplier price → discount → cost price → unit cost → retail and wholesale. Everything
                recalculates as you type. Only <strong>unit cost</strong> and the two{' '}
                <strong>prices</strong> are saved — the percentages and the net profit are worked out
                fresh every time, so they can never go stale.
              </Text>

              <Stack>
                <Group grow align="flex-start">
                  <CostInput
                    label="Supplier price"
                    description="What the supplier charges for one pack. 4 decimal places."
                    leftSection={<Text size="sm">{currencySymbol}</Text>}
                    disabled={readOnly}
                    value={supplierPrice}
                    onChange={(value) => {
                      setSupplierPrice(value)
                      recomputeUnitCost(value, discountBp, unitsPerPack)
                    }}
                  />
                  <PercentInput
                    label="Discount"
                    description="Off the supplier price"
                    disabled={readOnly}
                    value={discountBp}
                    onChange={(value) => {
                      const clamped = Math.min(Math.max(value, 0), BASIS_POINTS)
                      setDiscountBp(clamped)
                      recomputeUnitCost(supplierPrice, clamped, unitsPerPack)
                    }}
                  />
                </Group>

                <Group grow align="flex-start">
                  <TextInput
                    label="Cost price (per pack)"
                    description="Supplier price less the discount"
                    readOnly
                    variant="filled"
                    leftSection={<Text size="sm">{currencySymbol}</Text>}
                    rightSection={<Lock size={14} />}
                    value={formatCost(packCost, { grouping: false })}
                  />
                  <ScaledInput
                    label="Units in one pack"
                    description="How many selling units are in that pack. A carton of 24 → 24."
                    disabled={readOnly}
                    value={unitsPerPack}
                    parse={parseWholeNumber}
                    render={String}
                    onChange={(value) => {
                      const safe = value > 0 ? value : 1
                      setUnitsPerPack(safe)
                      recomputeUnitCost(supplierPrice, discountBp, safe)
                    }}
                  />
                </Group>

                <CostInput
                  label="Unit cost"
                  description="What ONE selling unit costs you. This is the figure that is saved — and every purchase re-averages it."
                  leftSection={<Text size="sm">{currencySymbol}</Text>}
                  disabled={readOnly}
                  value={form.costPrice}
                  onChange={(value) => set('costPrice', value)}
                />

                <Divider label="Selling prices" labelPosition="left" my="xs" />

                <Group grow align="flex-start">
                  <Select
                    label="Prices are entered…"
                    description="Which of the two boxes below is the one you actually typed."
                    data={[
                      { value: 'exclusive', label: 'Excluding tax' },
                      { value: 'inclusive', label: 'Including tax' }
                    ]}
                    value={form.priceEntryMode}
                    allowDeselect={false}
                    disabled={readOnly}
                    onChange={(value) => value && set('priceEntryMode', value as PriceEntryMode)}
                  />
                  <PercentInput
                    label="Tax rate"
                    description="17% is Pakistan's standard GST"
                    disabled={readOnly || form.isTaxExempt}
                    value={form.taxRateBp}
                    onChange={(value) => set('taxRateBp', Math.max(0, value))}
                  />
                </Group>

                <Switch
                  label="This item is tax exempt"
                  description="No tax is charged on it, whatever the rate above says."
                  checked={form.isTaxExempt}
                  disabled={readOnly}
                  onChange={(event) => set('isTaxExempt', event.currentTarget.checked)}
                />

                <Group grow align="flex-start">
                  <MoneyInput
                    label="Retail price — excl. tax"
                    leftSection={<Text size="sm">{currencySymbol}</Text>}
                    rightSection={form.priceEntryMode === 'exclusive' ? <SavedMark /> : undefined}
                    disabled={readOnly}
                    value={retailExcl}
                    onChange={setRetailFromExcl}
                  />
                  <MoneyInput
                    label="Retail price — incl. tax"
                    description="What the customer pays"
                    leftSection={<Text size="sm">{currencySymbol}</Text>}
                    rightSection={form.priceEntryMode === 'inclusive' ? <SavedMark /> : undefined}
                    disabled={readOnly}
                    value={retailIncl}
                    onChange={setRetailFromIncl}
                  />
                  <PercentInput
                    label="Profit %"
                    description="On unit cost, before tax"
                    disabled={readOnly || unitCostMinor <= 0}
                    placeholder={unitCostMinor <= 0 ? 'Enter a unit cost first' : undefined}
                    value={retailProfitBp ?? 0}
                    onChange={(value) => setRetailFromExcl(priceFromMarkup(unitCostMinor, value))}
                  />
                </Group>

                <Group grow align="flex-start">
                  <MoneyInput
                    label="Wholesale price — excl. tax"
                    leftSection={<Text size="sm">{currencySymbol}</Text>}
                    rightSection={form.priceEntryMode === 'exclusive' ? <SavedMark /> : undefined}
                    disabled={readOnly}
                    value={wholesaleExcl}
                    onChange={setWholesaleFromExcl}
                  />
                  <MoneyInput
                    label="Wholesale price — incl. tax"
                    leftSection={<Text size="sm">{currencySymbol}</Text>}
                    rightSection={form.priceEntryMode === 'inclusive' ? <SavedMark /> : undefined}
                    disabled={readOnly}
                    value={wholesaleIncl}
                    onChange={setWholesaleFromIncl}
                  />
                  <PercentInput
                    label="Margin %"
                    description="On unit cost, before tax"
                    disabled={readOnly || unitCostMinor <= 0}
                    placeholder={unitCostMinor <= 0 ? 'Enter a unit cost first' : undefined}
                    value={wholesaleMarginBp ?? 0}
                    onChange={(value) => setWholesaleFromExcl(priceFromMarkup(unitCostMinor, value))}
                  />
                </Group>

                <Card withBorder radius="sm" padding="sm" bg="var(--mantine-color-default-hover)">
                  <Group justify="space-between">
                    <div>
                      <Text size="sm" fw={600}>
                        Net profit per unit
                      </Text>
                      <Text size="xs" c="dimmed">
                        Retail excluding tax, less the unit cost. Worked out, never stored.
                      </Text>
                    </div>
                    <Text
                      size="xl"
                      fw={700}
                      c={netProfitMinor < 0 ? 'red' : netProfitMinor > 0 ? 'teal' : undefined}
                    >
                      {formatMoney(netProfitMinor, { symbol: currencySymbol })}
                    </Text>
                  </Group>
                  {netProfitMinor < 0 && (
                    <Text size="xs" c="var(--mantine-color-red-text)" mt={6}>
                      This item sells for less than it costs.
                    </Text>
                  )}
                </Card>
              </Stack>
            </Card>

            {/* Stock — READ-ONLY, and the form says why. */}
            <Card withBorder padding="lg">
              <Group gap="sm" mb="xs">
                <Boxes size={18} />
                <Text fw={600}>Balance quantity</Text>
                <Badge variant="light" color="gray" leftSection={<Lock size={11} />}>
                  worked out, not typed
                </Badge>
              </Group>

              <Text size="xs" c="dimmed" mb="md">
                Your old system let you type over the stock figure. This one cannot, on purpose: the
                balance is the sum of every stock movement ever posted, so it always agrees with the
                history behind it. To change it, post a movement — it takes one click and it records
                who did it and why.
              </Text>

              <Group grow align="flex-start" mb="md">
                <QtyInput
                  label="Re-order level"
                  description="Warn me when the balance drops to this."
                  disabled={readOnly}
                  value={form.minStockM}
                  onChange={(value) => set('minStockM', value)}
                />

                {editing && stock ? (
                  <Stack gap={2}>
                    <Text size="sm" fw={500}>
                      On hand
                    </Text>
                    <Group gap="xs" align="baseline">
                      <Text size="xl" fw={700}>
                        {formatQty(stock.onHandM)}
                      </Text>
                      {stock.isBelowReorder && (
                        <Badge color="orange" variant="light" leftSection={<TriangleAlert size={11} />}>
                          at or below re-order level
                        </Badge>
                      )}
                      {stock.onHandM < 0 && (
                        <Badge color="red" variant="light">
                          negative
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      Average cost {formatCost(stock.avgCost, { symbol: currencySymbol })} · value{' '}
                      {formatMoney(stock.stockValueMinor, { symbol: currencySymbol })}
                    </Text>
                  </Stack>
                ) : (
                  <Stack gap={2}>
                    <Text size="sm" fw={500}>
                      On hand
                    </Text>
                    <Text size="sm" c="dimmed">
                      Zero until you post an opening movement — available once the item is created.
                    </Text>
                  </Stack>
                )}
              </Group>

              {editing && stock && (
                <Button
                  variant="default"
                  leftSection={<Plus size={16} />}
                  disabled={readOnly}
                  onClick={() => setAdjusting(true)}
                >
                  {stock.onHandM === 0 ? 'Set opening stock' : 'Post a stock movement'}
                </Button>
              )}
            </Card>

            {/* Type & tracking */}
            <Card withBorder padding="lg">
              <Group gap="sm" mb="md">
                <Layers size={18} />
                <Text fw={600}>Type &amp; tracking</Text>
              </Group>

              <Stack>
                <Select
                  label="Item type"
                  description="A non-inventory item sells and earns but has no stock — a bag charge, a service."
                  data={[
                    { value: 'inventory', label: 'Inventory — it has stock' },
                    { value: 'non_inventory', label: 'Non-inventory — no stock (service, charge)' }
                  ]}
                  value={form.itemType}
                  allowDeselect={false}
                  disabled={readOnly}
                  onChange={(value) => value && set('itemType', value as ItemType)}
                  maw={460}
                />

                <Switch
                  label="Track batches and expiry dates"
                  description="For medicines and food. The till picks the batch closest to expiry, on its own."
                  checked={form.trackBatches}
                  disabled={readOnly}
                  onChange={(event) => set('trackBatches', event.currentTarget.checked)}
                />
                <Switch
                  label="Track serial / IMEI numbers"
                  description="Only items with this switched on will ask for a serial. A tin of beans still scans in one keystroke."
                  checked={form.trackSerials}
                  disabled={readOnly}
                  onChange={(event) => set('trackSerials', event.currentTarget.checked)}
                />
                <Switch
                  label="Sold by weight"
                  description="The quantity comes from the scale, not from a count."
                  checked={form.isWeighted}
                  disabled={readOnly}
                  onChange={(event) => set('isWeighted', event.currentTarget.checked)}
                />

                {editing && (
                  <>
                    <Divider my={4} />
                    <Switch
                      label="Active"
                      description="Switch off to retire the item. It is never deleted — last year's receipts still point at it."
                      checked={form.isActive}
                      disabled={readOnly}
                      onChange={(event) => set('isActive', event.currentTarget.checked)}
                    />
                  </>
                )}
              </Stack>
            </Card>

            {/* Picture */}
            <Card withBorder padding="lg">
              <Group gap="sm" mb="md">
                <ImageIcon size={18} />
                <Text fw={600}>Picture</Text>
              </Group>
              <TextInput
                label="Image file"
                description="The full path to a picture of this item. A picture browser arrives with label printing."
                placeholder="C:\Users\Shop\Pictures\tea.jpg"
                disabled={readOnly}
                value={form.imagePath}
                onChange={(event) => set('imagePath', event.currentTarget.value)}
              />
            </Card>
          </Stack>
        </Tabs.Panel>

        {/* ── CHILD PANELS ──────────────────────────────────────────────────── */}
        <Tabs.Panel value="barcodes" pt="lg">
          {productId !== null && (
            <BarcodesPanel
              productId={productId}
              readOnly={readOnly}
              initial={detail?.barcodes ?? []}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="packs" pt="lg">
          {productId !== null && (
            <PacksPanel
              productId={productId}
              readOnly={readOnly}
              currencySymbol={currencySymbol}
              initial={detail?.packs ?? []}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="suppliers" pt="lg">
          {productId !== null && (
            <SuppliersPanel
              productId={productId}
              readOnly={readOnly}
              currencySymbol={currencySymbol}
              initial={detail?.suppliers ?? []}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="batches" pt="lg">
          {productId !== null && (
            <BatchesPanel
              productId={productId}
              readOnly={readOnly}
              currencySymbol={currencySymbol}
              trackBatches={form.trackBatches}
              initial={detail?.batches ?? []}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="history" pt="lg">
          {productId !== null && (
            <HistoryPanel productId={productId} currencySymbol={currencySymbol} />
          )}
        </Tabs.Panel>
      </Tabs>

      <AdjustStockModal
        opened={adjusting}
        onClose={() => setAdjusting(false)}
        product={
          detail
            ? {
                id: detail.product.id,
                name: detail.product.name,
                sku: detail.product.sku,
                onHandM: detail.stock.onHandM
              }
            : null
        }
        onDone={() => {
          // Re-fetch the item so the balance quantity re-derives from the movements, and tell the
          // list its stock figures are stale.
          void load()
          if (productId !== null) onSaved(productId)
        }}
      />
    </Stack>
  )
}

/** A whole, non-negative count — "units in one pack". Not money, not qty_m: just a number of things. */
function parseWholeNumber(input: string): number | null {
  const cleaned = input.trim()
  if (cleaned === '') return null
  if (!/^\d+$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : null
}

/** Marks the one box of an excl./incl. pair that is actually written to the database. */
function SavedMark(): React.JSX.Element {
  return (
    <Tooltip label="This is the box that gets saved. The other is worked out from it.">
      <Badge size="xs" variant="light" color="teal">
        saved
      </Badge>
    </Tooltip>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// BARCODES — including REPLACE, which never deletes the old code.
// ─────────────────────────────────────────────────────────────────────────────

function BarcodesPanel({
  productId,
  readOnly,
  initial
}: {
  productId: number
  readOnly: boolean
  initial: ProductBarcode[]
}): React.JSX.Element {
  const [barcodes, setBarcodes] = useState<ProductBarcode[] | null>(initial)
  const [replacements, setReplacements] = useState<BarcodeReplacement[] | null>(null)
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)

  const [oldBarcode, setOldBarcode] = useState<string | null>(null)
  const [newBarcode, setNewBarcode] = useState('')
  const [replaceOpen, setReplaceOpen] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const [list, history] = await Promise.all([
      window.pos.catalog.listBarcodes({ productId }),
      window.pos.catalog.barcodeReplacements({ productId })
    ])
    setBarcodes(list.ok ? list.data : [])
    setReplacements(history.ok ? history.data : [])
  }, [productId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function add(): Promise<void> {
    if (!adding.trim()) return
    setBusy(true)
    const result = await window.pos.catalog.addBarcode({
      productId,
      barcode: adding.trim(),
      isPrimary: (barcodes ?? []).length === 0
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not add that barcode',
        message: result.error.userMessage
      })
      return
    }
    setAdding('')
    void reload()
  }

  async function replace(): Promise<void> {
    if (!oldBarcode || !newBarcode.trim()) return
    setBusy(true)
    const result = await window.pos.catalog.replaceBarcode({
      productId,
      oldBarcode,
      newBarcode: newBarcode.trim()
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not replace that barcode',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      title: 'Barcode replaced',
      message: 'The old code still scans — the stock already on your shelf is safe.'
    })
    setReplaceOpen(false)
    setOldBarcode(null)
    setNewBarcode('')
    void reload()
  }

  return (
    <Stack gap="lg" maw={820}>
      <Alert color="blue" icon={<Info size={18} />}>
        An item can carry as many barcodes as it needs. <strong>Old codes are never deleted.</strong>{' '}
        When a supplier changes a barcode, the tins already sitting on your shelf still carry the old
        label — and they must still scan at the counter until the last one is sold. So replacing a
        barcode only changes which one gets printed on <em>new</em> labels.
      </Alert>

      <Card withBorder padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap="sm">
            <BarcodeIcon size={18} />
            <Text fw={600}>Barcodes</Text>
          </Group>
          <Button
            variant="default"
            size="xs"
            leftSection={<Replace size={14} />}
            disabled={readOnly || !barcodes?.length}
            onClick={() => setReplaceOpen(true)}
          >
            Replace a barcode
          </Button>
        </Group>

        {!barcodes ? (
          <Skeleton height={70} />
        ) : barcodes.length === 0 ? (
          <Text size="sm" c="dimmed" mb="md">
            No barcodes yet. Scan one into the box below.
          </Text>
        ) : (
          <Table striped withTableBorder mb="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Barcode</Table.Th>
                <Table.Th w={130}>Printed on labels</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {barcodes.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <Text ff="monospace">{row.barcode}</Text>
                  </Table.Td>
                  <Table.Td>
                    {row.isPrimary ? (
                      <Badge variant="light" color="teal">
                        primary
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        still scans
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

        <Group gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="Scan or type a barcode…"
            leftSection={<BarcodeIcon size={16} />}
            disabled={readOnly}
            value={adding}
            onChange={(event) => setAdding(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && adding.trim()) void add()
            }}
          />
          <Button
            leftSection={<Plus size={16} />}
            loading={busy}
            disabled={readOnly || !adding.trim()}
            onClick={() => void add()}
          >
            Add
          </Button>
        </Group>
      </Card>

      {replacements && replacements.length > 0 && (
        <Card withBorder padding="lg">
          <Group gap="sm" mb="md">
            <History size={18} />
            <Text fw={600}>Replacements</Text>
          </Group>
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Old code (still scans)</Table.Th>
                <Table.Th>New code</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {replacements.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>{new Date(row.at).toLocaleString()}</Table.Td>
                  <Table.Td>
                    <Text ff="monospace" size="sm">
                      {row.oldBarcode}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text ff="monospace" size="sm">
                      {row.newBarcode}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <Modal
        opened={replaceOpen}
        onClose={() => setReplaceOpen(false)}
        title="Replace a barcode"
        centered
      >
        <Stack>
          <Alert color="yellow" icon={<Info size={18} />} p="xs">
            <Text size="xs">
              The old code keeps working forever. It just stops being the one printed on new labels.
            </Text>
          </Alert>

          <Select
            label="Old barcode"
            placeholder="Choose the code being retired"
            data={(barcodes ?? []).map((row) => ({ value: row.barcode, label: row.barcode }))}
            value={oldBarcode}
            onChange={setOldBarcode}
            required
          />
          <TextInput
            label="New barcode"
            placeholder="Scan the new code…"
            leftSection={<BarcodeIcon size={16} />}
            value={newBarcode}
            onChange={(event) => setNewBarcode(event.currentTarget.value)}
            required
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setReplaceOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!oldBarcode || !newBarcode.trim()}
              onClick={() => void replace()}
            >
              Replace
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ALTERNATE PACKINGS — each pack its own cost, retail, wholesale AND barcode.
// ─────────────────────────────────────────────────────────────────────────────

type PackDraft = {
  id?: number
  uomId: number | null
  packSize: number
  cost: number
  retailPrice: number
  wholesalePrice: number
  barcode: string
  isBase: boolean
}

const EMPTY_PACK: PackDraft = {
  uomId: null,
  packSize: ONE_UNIT,
  cost: 0,
  retailPrice: 0,
  wholesalePrice: 0,
  barcode: '',
  isBase: false
}

function PacksPanel({
  productId,
  readOnly,
  currencySymbol,
  initial
}: {
  productId: number
  readOnly: boolean
  currencySymbol: string
  initial: ProductPack[]
}): React.JSX.Element {
  const [packs, setPacks] = useState<ProductPack[] | null>(initial)
  const [draft, setDraft] = useState<PackDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const { items: uoms } = useLookupList('uom')

  const uomLabel = useCallback(
    (id: number): string => (uoms ?? []).find((row) => row.id === id)?.label ?? '—',
    [uoms]
  )

  const reload = useCallback(async (): Promise<void> => {
    const result = await window.pos.catalog.listPacks({ productId })
    setPacks(result.ok ? result.data : [])
  }, [productId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function save(): Promise<void> {
    if (!draft || draft.uomId === null) return
    setBusy(true)
    const result = await window.pos.catalog.savePack({
      id: draft.id,
      productId,
      uomId: draft.uomId,
      packSize: draft.packSize,
      cost: draft.cost,
      retailPrice: draft.retailPrice,
      wholesalePrice: draft.wholesalePrice,
      barcode: draft.barcode.trim() === '' ? null : draft.barcode.trim(),
      isBase: draft.isBase
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not save that packing',
        message: result.error.userMessage
      })
      return
    }
    setDraft(null)
    void reload()
  }

  async function remove(pack: ProductPack): Promise<void> {
    const result = await window.pos.catalog.deletePack({ id: pack.id })
    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not remove that packing',
        message: result.error.userMessage
      })
      return
    }
    void reload()
  }

  return (
    <Stack gap="lg" maw={980}>
      <Alert color="blue" icon={<Info size={18} />}>
        Buy in cartons, sell in pieces. Each packing carries its <strong>own</strong> cost, retail
        price, wholesale price and barcode — scan the carton barcode at the till and it sells the
        whole carton at the carton price. The <strong>base</strong> packing is one selling unit.
      </Alert>

      <Card withBorder padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap="sm">
            <Boxes size={18} />
            <Text fw={600}>Packings</Text>
          </Group>
          <Button
            size="xs"
            leftSection={<Plus size={14} />}
            disabled={readOnly}
            onClick={() => setDraft({ ...EMPTY_PACK })}
          >
            Add a packing
          </Button>
        </Group>

        {!packs ? (
          <Skeleton height={90} />
        ) : packs.length === 0 ? (
          <Text size="sm" c="dimmed">
            No alternate packings. This item is bought and sold in its base unit only.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Unit</Table.Th>
                  <Table.Th>Holds</Table.Th>
                  <Table.Th>Cost</Table.Th>
                  <Table.Th>Retail</Table.Th>
                  <Table.Th>Wholesale</Table.Th>
                  <Table.Th>Barcode</Table.Th>
                  <Table.Th w={90} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {packs.map((pack) => (
                  <Table.Tr key={pack.id}>
                    <Table.Td>
                      <Group gap={6}>
                        <Text size="sm">{uomLabel(pack.uomId)}</Text>
                        {pack.isBase && (
                          <Badge size="xs" variant="light">
                            base
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{formatQty(pack.packSize)}</Table.Td>
                    <Table.Td>{formatCost(pack.cost, { symbol: currencySymbol })}</Table.Td>
                    <Table.Td>{formatMoney(pack.retailPrice, { symbol: currencySymbol })}</Table.Td>
                    <Table.Td>
                      {formatMoney(pack.wholesalePrice, { symbol: currencySymbol })}
                    </Table.Td>
                    <Table.Td>
                      <Text ff="monospace" size="sm">
                        {pack.barcode ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <ActionIcon
                          variant="subtle"
                          disabled={readOnly}
                          aria-label="Edit packing"
                          onClick={() =>
                            setDraft({
                              id: pack.id,
                              uomId: pack.uomId,
                              packSize: pack.packSize,
                              cost: pack.cost,
                              retailPrice: pack.retailPrice,
                              wholesalePrice: pack.wholesalePrice,
                              barcode: pack.barcode ?? '',
                              isBase: pack.isBase
                            })
                          }
                        >
                          <Pencil size={15} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          disabled={readOnly}
                          aria-label="Remove packing"
                          onClick={() => void remove(pack)}
                        >
                          <Trash2 size={15} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Modal
        opened={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit packing' : 'Add a packing'}
        centered
        size="lg"
      >
        {draft && (
          <Stack>
            <LookupSelect
              listKey="uom"
              label="Unit"
              value={draft.uomId}
              onChange={(value) => setDraft({ ...draft, uomId: value })}
              required
              clearable={false}
            />

            <QtyInput
              label="Selling units in one pack"
              description="A carton of 24 pieces holds 24. The base packing holds exactly 1."
              value={draft.packSize}
              onChange={(value) => setDraft({ ...draft, packSize: value })}
              required
            />

            <Group grow align="flex-start">
              <CostInput
                label="Cost"
                description="What the whole pack costs you"
                leftSection={<Text size="sm">{currencySymbol}</Text>}
                value={draft.cost}
                onChange={(value) => setDraft({ ...draft, cost: value })}
              />
              <MoneyInput
                label="Retail price"
                leftSection={<Text size="sm">{currencySymbol}</Text>}
                value={draft.retailPrice}
                onChange={(value) => setDraft({ ...draft, retailPrice: value })}
              />
              <MoneyInput
                label="Wholesale price"
                leftSection={<Text size="sm">{currencySymbol}</Text>}
                value={draft.wholesalePrice}
                onChange={(value) => setDraft({ ...draft, wholesalePrice: value })}
              />
            </Group>

            <TextInput
              label="Barcode for this pack"
              description="Scanning this at the till sells the whole pack."
              leftSection={<BarcodeIcon size={16} />}
              value={draft.barcode}
              onChange={(event) => setDraft({ ...draft, barcode: event.currentTarget.value })}
            />

            <Switch
              label="This is the base packing"
              description="One selling unit. Every item has exactly one, and it must hold exactly 1."
              checked={draft.isBase}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  isBase: event.currentTarget.checked,
                  packSize: event.currentTarget.checked ? ONE_UNIT : draft.packSize
                })
              }
            />

            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button
                loading={busy}
                disabled={draft.uomId === null || draft.packSize <= 0}
                leftSection={<Save size={16} />}
                onClick={() => void save()}
              >
                Save packing
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTIPLE SUPPLIERS — each with its OWN item code and its OWN price.
// ─────────────────────────────────────────────────────────────────────────────

type SupplierDraft = {
  id?: number
  supplierId: number | null
  supplierItemCode: string
  supplierPrice: number
  discountBp: number
  isPreferred: boolean
}

const EMPTY_SUPPLIER_DRAFT: SupplierDraft = {
  supplierId: null,
  supplierItemCode: '',
  supplierPrice: 0,
  discountBp: 0,
  isPreferred: false
}

function SuppliersPanel({
  productId,
  readOnly,
  currencySymbol,
  initial
}: {
  productId: number
  readOnly: boolean
  currencySymbol: string
  initial: ProductSupplier[]
}): React.JSX.Element {
  const [links, setLinks] = useState<ProductSupplier[] | null>(initial)
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [draft, setDraft] = useState<SupplierDraft | null>(null)
  const [busy, setBusy] = useState(false)

  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierOpen, setNewSupplierOpen] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const [rows, all] = await Promise.all([
      window.pos.catalog.listProductSuppliers({ productId }),
      window.pos.suppliers.list({ page: 1, pageSize: 200 })
    ])
    setLinks(rows.ok ? rows.data : [])
    setSuppliers(all.ok ? all.data.rows : [])
  }, [productId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function save(): Promise<void> {
    if (!draft || draft.supplierId === null) return
    setBusy(true)
    const result = await window.pos.catalog.linkSupplier({
      id: draft.id,
      productId,
      supplierId: draft.supplierId,
      supplierItemCode: draft.supplierItemCode.trim() === '' ? null : draft.supplierItemCode.trim(),
      supplierPrice: draft.supplierPrice,
      discountBp: draft.discountBp,
      isPreferred: draft.isPreferred
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not save that supplier',
        message: result.error.userMessage
      })
      return
    }
    setDraft(null)
    void reload()
  }

  async function unlink(row: ProductSupplier): Promise<void> {
    const result = await window.pos.catalog.unlinkSupplier({ id: row.id })
    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not remove that supplier',
        message: result.error.userMessage
      })
      return
    }
    void reload()
  }

  async function createSupplier(): Promise<void> {
    if (!newSupplierName.trim()) return
    setBusy(true)
    const result = await window.pos.suppliers.create({ name: newSupplierName.trim() })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not add that supplier',
        message: result.error.userMessage
      })
      return
    }

    const created = result.data
    await reload()
    setNewSupplierName('')
    setNewSupplierOpen(false)
    setDraft((current) => ({ ...(current ?? EMPTY_SUPPLIER_DRAFT), supplierId: created.id }))
  }

  return (
    <Stack gap="lg" maw={980}>
      <Alert color="blue" icon={<Info size={18} />}>
        One item, many suppliers — each with the code <em>they</em> use for it on their invoice, and
        the price <em>they</em> charge. Mark one as preferred and it is the one the purchase order
        goes to.
      </Alert>

      <Card withBorder padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap="sm">
            <Truck size={18} />
            <Text fw={600}>Suppliers</Text>
          </Group>
          <Button
            size="xs"
            leftSection={<Plus size={14} />}
            disabled={readOnly}
            onClick={() => setDraft({ ...EMPTY_SUPPLIER_DRAFT })}
          >
            Add a supplier
          </Button>
        </Group>

        {!links ? (
          <Skeleton height={90} />
        ) : links.length === 0 ? (
          <Text size="sm" c="dimmed">
            No suppliers linked to this item yet.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={720}>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Supplier</Table.Th>
                  <Table.Th>Their item code</Table.Th>
                  <Table.Th>Their price</Table.Th>
                  <Table.Th>Discount</Table.Th>
                  <Table.Th>Net cost</Table.Th>
                  <Table.Th w={90} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {links.map((row) => (
                  <Table.Tr key={row.id}>
                    <Table.Td>
                      <Group gap={6}>
                        <Text size="sm">{row.supplierName ?? `#${row.supplierId}`}</Text>
                        {row.isPreferred && (
                          <Badge size="xs" variant="light" color="teal">
                            preferred
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text ff="monospace" size="sm">
                        {row.supplierItemCode ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>{formatCost(row.supplierPrice, { symbol: currencySymbol })}</Table.Td>
                    <Table.Td>{renderPercent(row.discountBp)}%</Table.Td>
                    <Table.Td>
                      {formatCost(costAfterDiscount(row.supplierPrice, row.discountBp), {
                        symbol: currencySymbol
                      })}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <ActionIcon
                          variant="subtle"
                          disabled={readOnly}
                          aria-label="Edit supplier link"
                          onClick={() =>
                            setDraft({
                              id: row.id,
                              supplierId: row.supplierId,
                              supplierItemCode: row.supplierItemCode ?? '',
                              supplierPrice: row.supplierPrice,
                              discountBp: row.discountBp,
                              isPreferred: row.isPreferred
                            })
                          }
                        >
                          <Pencil size={15} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          disabled={readOnly}
                          aria-label="Remove supplier link"
                          onClick={() => void unlink(row)}
                        >
                          <Trash2 size={15} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Modal
        opened={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit supplier' : 'Add a supplier'}
        centered
        size="lg"
      >
        {draft && (
          <Stack>
            <Group gap={6} align="flex-end" wrap="nowrap">
              <Select
                style={{ flex: 1 }}
                label="Supplier"
                placeholder={suppliers === null ? 'Loading…' : 'Choose a supplier…'}
                data={(suppliers ?? []).map((row) => ({
                  value: String(row.id),
                  label: row.name
                }))}
                value={draft.supplierId === null ? null : String(draft.supplierId)}
                searchable
                required
                disabled={suppliers === null}
                nothingFoundMessage="No suppliers yet — use + to add one"
                onChange={(value) =>
                  setDraft({ ...draft, supplierId: value === null ? null : Number(value) })
                }
              />
              <Tooltip label="Add a new supplier">
                <ActionIcon
                  variant="default"
                  size={36}
                  aria-label="Add a new supplier"
                  onClick={() => setNewSupplierOpen(true)}
                >
                  <Plus size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>

            <TextInput
              label="Their item code"
              description="What this supplier calls it on their invoice. Goes on the purchase order."
              value={draft.supplierItemCode}
              onChange={(event) =>
                setDraft({ ...draft, supplierItemCode: event.currentTarget.value })
              }
            />

            <Group grow align="flex-start">
              <CostInput
                label="Their price"
                leftSection={<Text size="sm">{currencySymbol}</Text>}
                value={draft.supplierPrice}
                onChange={(value) => setDraft({ ...draft, supplierPrice: value })}
              />
              <PercentInput
                label="Discount"
                value={draft.discountBp}
                onChange={(value) =>
                  setDraft({ ...draft, discountBp: Math.min(Math.max(value, 0), BASIS_POINTS) })
                }
              />
            </Group>

            <Text size="xs" c="dimmed">
              Net cost:{' '}
              <strong>
                {formatCost(costAfterDiscount(draft.supplierPrice, draft.discountBp), {
                  symbol: currencySymbol
                })}
              </strong>
            </Text>

            <Switch
              label="Preferred supplier"
              description="The one purchase orders go to by default."
              checked={draft.isPreferred}
              onChange={(event) => setDraft({ ...draft, isPreferred: event.currentTarget.checked })}
            />

            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button
                loading={busy}
                disabled={draft.supplierId === null}
                leftSection={<Save size={16} />}
                onClick={() => void save()}
              >
                Save supplier
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={newSupplierOpen}
        onClose={() => setNewSupplierOpen(false)}
        title="Add a new supplier"
        centered
      >
        <Stack>
          <TextInput
            label="Supplier name"
            data-autofocus
            value={newSupplierName}
            onChange={(event) => setNewSupplierName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createSupplier()
            }}
          />
          <Text size="xs" c="dimmed">
            You can add their phone, address and type later, on the Suppliers screen.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setNewSupplierOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!newSupplierName.trim()}
              onClick={() => void createSupplier()}
            >
              Add
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHES
// ─────────────────────────────────────────────────────────────────────────────

function BatchesPanel({
  productId,
  readOnly,
  currencySymbol,
  trackBatches,
  initial
}: {
  productId: number
  readOnly: boolean
  currencySymbol: string
  trackBatches: boolean
  initial: Batch[]
}): React.JSX.Element {
  const [batches, setBatches] = useState<Batch[] | null>(initial)
  const [open, setOpen] = useState(false)
  const [batchNo, setBatchNo] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [cost, setCost] = useState(0)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const result = await window.pos.catalog.listBatches({ productId, page: 1, pageSize: 100 })
    setBatches(result.ok ? result.data.rows : [])
  }, [productId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function add(): Promise<void> {
    if (!batchNo.trim()) return
    setBusy(true)
    const result = await window.pos.catalog.addBatch({
      productId,
      batchNo: batchNo.trim(),
      expiryDate: expiryDate.trim() === '' ? null : expiryDate.trim(),
      cost
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not add that batch',
        message: result.error.userMessage
      })
      return
    }
    setBatchNo('')
    setExpiryDate('')
    setCost(0)
    setOpen(false)
    void reload()
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <Stack gap="lg" maw={820}>
      {!trackBatches && (
        <Alert color="yellow" icon={<TriangleAlert size={18} />}>
          <strong>Track batches</strong> is switched off for this item, so the till will not ask for
          a batch when it is sold. Switch it on under Type &amp; tracking if this item has expiry
          dates.
        </Alert>
      )}

      <Card withBorder padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap="sm">
            <Layers size={18} />
            <Text fw={600}>Batches</Text>
          </Group>
          <Button
            size="xs"
            leftSection={<Plus size={14} />}
            disabled={readOnly}
            onClick={() => setOpen(true)}
          >
            Add a batch
          </Button>
        </Group>

        {!batches ? (
          <Skeleton height={80} />
        ) : batches.length === 0 ? (
          <Text size="sm" c="dimmed">
            No batches recorded for this item.
          </Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Batch</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th>Cost</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {batches.map((batch) => {
                const expired = batch.expiryDate !== null && batch.expiryDate < today
                return (
                  <Table.Tr key={batch.id}>
                    <Table.Td>
                      <Text ff="monospace" size="sm">
                        {batch.batchNo}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6}>
                        <Text size="sm">{batch.expiryDate ?? 'Does not expire'}</Text>
                        {expired && (
                          <Badge size="xs" color="red" variant="light">
                            expired
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{formatCost(batch.cost, { symbol: currencySymbol })}</Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      <Modal opened={open} onClose={() => setOpen(false)} title="Add a batch" centered>
        <Stack>
          <TextInput
            label="Batch number"
            data-autofocus
            required
            value={batchNo}
            onChange={(event) => setBatchNo(event.currentTarget.value)}
          />
          <TextInput
            label="Expiry date"
            description="Leave empty if this item does not expire."
            type="date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.currentTarget.value)}
          />
          <CostInput
            label="Cost for this batch"
            leftSection={<Text size="sm">{currencySymbol}</Text>}
            value={cost}
            onChange={setCost}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!batchNo.trim()} onClick={() => void add()}>
              Add batch
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY — the legacy "SHOW HISTORY" panel.
// ─────────────────────────────────────────────────────────────────────────────

const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  opening: 'Opening',
  purchase: 'Purchase',
  sale: 'Sale',
  sale_return: 'Customer return',
  purchase_return: 'Return to supplier',
  adjustment: 'Adjustment',
  damage: 'Damage / waste',
  stock_take: 'Stock take'
}

function MovementsTable({
  movements,
  currencySymbol,
  showProduct = false
}: {
  movements: StockMovement[]
  currencySymbol: string
  showProduct?: boolean
}): React.JSX.Element {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th>
            <Table.Th>What</Table.Th>
            {showProduct && <Table.Th>Item</Table.Th>}
            <Table.Th ta="right">Change</Table.Th>
            <Table.Th ta="right">Unit cost</Table.Th>
            <Table.Th>Reason</Table.Th>
            <Table.Th>Who</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {movements.map((movement) => (
            <Table.Tr key={movement.id}>
              <Table.Td>
                <Text size="sm">{new Date(movement.at).toLocaleString()}</Text>
              </Table.Td>
              <Table.Td>
                <Badge variant="light" size="sm">
                  {MOVEMENT_TYPE_LABEL[movement.type] ?? movement.type}
                </Badge>
              </Table.Td>
              {showProduct && (
                <Table.Td>
                  <Text size="sm">#{movement.productId}</Text>
                </Table.Td>
              )}
              <Table.Td ta="right">
                <Text size="sm" fw={600} c={movement.qtyM < 0 ? 'red' : 'teal'}>
                  {movement.qtyM > 0 ? '+' : ''}
                  {formatQty(movement.qtyM)}
                </Text>
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm">{formatCost(movement.unitCost, { symbol: currencySymbol })}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {movement.reasonCode ?? movement.note ?? '—'}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{movement.userName ?? '—'}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

const HISTORY_PAGE_SIZE = 25

function HistoryPanel({
  productId,
  currencySymbol
}: {
  productId: number
  currencySymbol: string
}): React.JSX.Element {
  const [movements, setMovements] = useState<StockMovement[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setMovements(null)
      const result = await window.pos.stock.movements({
        productId,
        page,
        pageSize: HISTORY_PAGE_SIZE
      })
      if (cancelled) return
      if (result.ok) {
        setMovements(result.data.rows)
        setTotal(result.data.total)
      } else {
        setMovements([])
        setTotal(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [productId, page])

  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))

  return (
    <Stack gap="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        Every movement this item has ever made, newest first. This is what the balance quantity is
        the sum of — nothing else can change it.
      </Alert>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <History size={18} />
          <Text fw={600}>Stock movements</Text>
          {total > 0 && (
            <Badge variant="light" size="sm">
              {total}
            </Badge>
          )}
        </Group>

        {!movements ? (
          <Stack gap={8}>
            <Skeleton height={32} />
            <Skeleton height={32} />
            <Skeleton height={32} />
          </Stack>
        ) : movements.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing has moved yet. This item has never been bought, sold or adjusted.
          </Text>
        ) : (
          <>
            <MovementsTable movements={movements} currencySymbol={currencySymbol} />
            {pages > 1 && (
              <Group justify="center" mt="md">
                <Pagination value={page} onChange={setPage} total={pages} size="sm" />
              </Group>
            )}
          </>
        )}
      </Card>
    </Stack>
  )
}
