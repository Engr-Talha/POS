import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Kbd,
  Loader,
  Menu,
  PasswordInput,
  Modal,
  Pagination,
  ScrollArea,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  Award,
  Ban,
  Banknote,
  CircleAlert,
  CircleCheck,
  CreditCard,
  FileText,
  Pause,
  Percent,
  Play,
  Printer,
  Receipt,
  ScanLine,
  Scale,
  Search,
  ShoppingCart,
  Tag,
  Trash2,
  TriangleAlert,
  User,
  UserPlus,
  UserX,
  X,
  BadgePercent
} from 'lucide-react'

import { normalizeBarcode } from '@shared/barcode'
import type { Result } from '@shared/result'
import type { Lookup } from '@shared/types'
import type { Customer } from '@shared/opening'
import type { Role } from '@shared/rbac'
import { ROLE_RANK } from '@shared/rbac'
import type { CompleteSaleResponse, ScannedItem } from '@shared/ipc'
import type { LoyaltyBalance } from '@shared/loyalty'
import type { PriceTier, SaleLineInput, SaleListItem } from '@shared/sales'
import type { TaxMode } from '@shared/tax'
import { extendPrice } from '@shared/pricing'
import type { LinePromotionResult } from '@shared/promotions'
import type { CartMath, LineInfo, Shortage } from '@shared/sell-preview'
import {
  EMPTY_CART,
  findShortages,
  infoKey,
  lineInfoFromScan,
  priceCart
} from '@shared/sell-preview'
import { formatMoney } from '@shared/money'
import { formatQty, ONE_UNIT } from '@shared/qty'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import { LookupCodeSelect, LookupSelect, MoneyInput, QtyInput } from './ProductForm'

/**
 * THE SELL SCREEN. THE APP.
 *
 * A cashier stands here all day with a queue in front of him. Everything below is in service of one
 * sentence: HIS HANDS NEVER LEAVE THE KEYBOARD AND THE SCANNER.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE BARCODE FIELD OWNS THE FOCUS, AND TAKES IT BACK
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * If focus is ever lost, the next scan types into nothing and the cashier looks like a fool in front
 * of a customer. Two mechanisms, because one is not enough:
 *
 *   REFOCUS   an effect keyed on "is a modal open" puts focus back the instant the last one closes.
 *   REDIRECT  a global keydown: if a printable character arrives while focus is somewhere that cannot
 *             take it (a button, the body), focus moves to the barcode field BEFORE the browser
 *             delivers the character — so the character lands in the field. A scan is never lost, even
 *             if the cashier had clicked a button a moment earlier.
 *
 * We do NOT trap focus. Trapping it would make the mouse useless — clicking a quantity box would bounce
 * you straight back out of it. Focus FOLLOWS TYPING instead of being handcuffed to one field.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. THE CART LIVES HERE, AND MAIN DECIDES THE MONEY
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The cart is an array of INTENT — what was scanned, and how many. It is not in the database (that
 * would be a write per keystroke on the busiest screen in the shop) and it does not carry prices.
 * `complete()` re-resolves every price, every tax rate and every cost from the catalog and freezes
 * them. This screen only ever PREDICTS what main will do.
 *
 * And it predicts it with MAIN'S OWN FUNCTIONS. `extendPrice`, `apportionCartDiscount` (shared/pricing)
 * and `computeLineTax` (shared/tax) are the same code the sale service freezes the sale with. There is
 * no second implementation of the arithmetic, so the number on the screen and the number on the paper
 * cannot drift apart — not on a weighed line, not on a cart discount that will not divide by three.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. THE MUTATION QUEUE — WHY A FAST SCANNER CANNOT DROP AN ITEM
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `addLine` lives in main (it carries the merge rule: the same tin scanned twice becomes qty 2). So
 * every cart change is a round trip, and a cashier scanning fast fires them faster than they return.
 *
 * Two overlapping calls that both read the cart from a stale React closure would each write back their
 * own version, and the SECOND one to land would silently erase the first — an item on the counter that
 * is not on the receipt. So every mutation goes through ONE serialised promise chain and reads the cart
 * from a ref, never from a closure. It cannot race.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 4. TRAP #19 — A useEffect MUST NEVER BE ABLE TO DROP THE CART
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A stray effect re-run once bounced a user back to login. Here it would empty a customer's basket
 * mid-sale. So: NOTHING in this file clears or rewrites the cart from an effect. The cart changes only
 * where a human did something. The keyboard listener is registered ONCE, with no dependencies at all —
 * it reads the latest handler through a ref — so it has nothing to re-run over.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Settings — read from the registry, never hardcoded (CLAUDE.md §4)
// ═════════════════════════════════════════════════════════════════════════════

type ScannerProfile = {
  terminator: 'enter' | 'tab' | 'none'
  prefix: string
  suffix: string
  minLength: number
}

type SellSettings = {
  currencySymbol: string
  taxEnabled: boolean
  defaultTaxRateBp: number
  defaultTaxMode: TaxMode
  negativeStock: 'warn' | 'block' | 'allow'
  creditLimit: 'warn' | 'block' | 'ignore'
  requireCustomerForCredit: boolean
  discountApprovalPercent: number
  discountApprovalAmount: number
  wholesaleTierRole: Role
  priceOverrideRole: Role
  /**
   * LOYALTY. Off by default — a shop that does not run points must never see any of it. Hiding it is a
   * COURTESY: MAIN refuses a redemption when the scheme is off whatever this screen draws.
   */
  loyaltyEnabled: boolean
  /** The floor before points can be SPENT. MAIN enforces it; we grey the button and say why. */
  loyaltyMinPointsToRedeem: number
  scanner: ScannerProfile
}

function readSettings(raw: Record<string, unknown>): SellSettings {
  const get = <T,>(key: string): T => (raw[key] ?? REGISTRY_DEFAULTS[key]) as T

  return {
    currencySymbol: get<string>('currency.symbol'),
    taxEnabled: get<boolean>('tax.enabled'),
    defaultTaxRateBp: get<number>('tax.defaultRateBp'),
    defaultTaxMode: get<TaxMode>('tax.defaultMode'),
    negativeStock: get<SellSettings['negativeStock']>('selling.negativeStock'),
    creditLimit: get<SellSettings['creditLimit']>('selling.creditLimit'),
    requireCustomerForCredit: get<boolean>('selling.requireCustomerForCredit'),
    discountApprovalPercent: get<number>('selling.discountApprovalPercent'),
    discountApprovalAmount: get<number>('selling.discountApprovalAmount'),
    wholesaleTierRole: get<Role>('selling.wholesaleTierRole'),
    priceOverrideRole: get<Role>('selling.priceOverrideRole'),
    loyaltyEnabled: get<boolean>('loyalty.enabled'),
    loyaltyMinPointsToRedeem: get<number>('loyalty.minPointsToRedeem'),
    scanner: {
      terminator: get<ScannerProfile['terminator']>('scanner.terminator'),
      prefix: get<string>('scanner.prefix'),
      suffix: get<string>('scanner.suffix'),
      minLength: get<number>('scanner.minLength')
    }
  }
}

/** A courtesy check only. MAIN enforces every one of these, and refuses whether or not we drew a button. */
function roleAtLeast(role: Role, required: Role): boolean {
  const needed = ROLE_RANK[required]
  if (needed == null) return false
  return ROLE_RANK[role] >= needed
}

/**
 * An ISO DAY ('YYYY-MM-DD') as the shopkeeper reads it — never a raw ISO string.
 *
 * PARSED AS A LOCAL DAY, DELIBERATELY. `new Date('2026-07-22')` parses as UTC midnight, which west of
 * Greenwich prints as the 21st: the quote would appear to lapse a day early, on the screen, next to the
 * paper that says otherwise. The parts are split and a LOCAL date is built instead — the same reasoning,
 * and the same fix, as `formatValidUntil` in printing/quotation.ts. A `valid_until` is a DAY, not an
 * instant, so it is never fed to a formatter that assumes a timestamp.
 */
function formatDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso // not a date we recognise: show it as it is, never a blank
  return new Date(year, month - 1, day).toLocaleDateString()
}

/**
 * HAS THE OFFER LAPSED? A DAY-to-DAY comparison, matching the service's own (`quotationFor`).
 *
 * Two ISO days sort lexicographically, so no Date is built at all — and the quote is good for ALL of its
 * last day, so it is expired only once today is STRICTLY past it. Nothing is blocked by this: an expired
 * quote is still resumable, because honouring it is the shopkeeper's call, not the till's.
 */
function isExpiredDay(iso: string, today: Date = new Date()): boolean {
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return iso < `${today.getFullYear()}-${month}-${day}`
}

// ═════════════════════════════════════════════════════════════════════════════
// The screen
// ═════════════════════════════════════════════════════════════════════════════

/** Everything a cart needs to be held, quoted or rung up. The payments are the only thing on top. */
type CartPayload = {
  saleId?: number
  customerId: number | null
  priceTier: PriceTier
  lines: SaleLineInput[]
  cartDiscount: number
  cartDiscountReasonCode: string | null
}

type Modal =
  | { kind: 'qty'; index: number }
  | { kind: 'line'; index: number }
  | { kind: 'cartDiscount' }
  | { kind: 'openItem' }
  | { kind: 'customer' }
  | { kind: 'held' }
  | { kind: 'payment' }
  /** A weighed item was scanned: ask the scale, not the keyboard. Nothing is in the cart yet. */
  | { kind: 'weigh'; item: ScannedItem }
  /** A serialised item was scanned: one IMEI per unit. Nothing is in the cart yet. */
  | { kind: 'serials'; item: ScannedItem }

export function Sell({
  readOnly,
  userRole
}: {
  readOnly: boolean
  userRole: Role
}): React.JSX.Element {
  // ── The cart. A ref shadows the state so a queued mutation always reads the LATEST cart, never a
  //    stale closure — see §3 of the header. ────────────────────────────────────────────────────────
  const [cart, setCartState] = useState<SaleLineInput[]>([])
  const cartRef = useRef<SaleLineInput[]>([])
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const [infos, setInfos] = useState<Map<string, LineInfo>>(new Map())
  const [selected, setSelected] = useState<number | null>(null)

  /**
   * THE SHOP'S OWN OFFERS ON THIS CART, AS MAIN RESOLVED THEM — one entry per line, in the same order,
   * null where no offer fired. (Migration 0018.)
   *
   * NEVER COMPUTED HERE. An offer is resolved against the catalog, in main, by the same `priceCart`
   * that freezes the sale — so the discount the cashier reads off the screen is the one the customer
   * is charged. A renderer that could name its own promotion discount could sell at any price it liked
   * (shared/promotions.ts).
   *
   * Empty until the answer lands, which is the honest state: the cart draws with no offers on it, as it
   * did before this feature existed, and `complete()` applies them regardless of what was ever shown.
   */
  const [linePromotions, setLinePromotions] = useState<LinePromotionResult[]>([])

  const [tier, setTier] = useState<PriceTier>('retail')
  const [cartDiscount, setCartDiscount] = useState(0)
  const [cartDiscountReason, setCartDiscountReason] = useState<string | null>(null)

  const [customer, setCustomer] = useState<Customer | null>(null)
  const [outstanding, setOutstanding] = useState<number | null>(null)

  /**
   * The selected customer's POINTS — read from MAIN when they are picked, never worked out here. Null
   * while unknown (nobody chosen, loyalty off, or the read failed): the chip simply does not draw.
   */
  const [points, setPoints] = useState<LoyaltyBalance | null>(null)

  /** The parked cart we are ringing up, if any. Completing it CONVERTS it — it does not leave a twin. */
  const [resumedSaleId, setResumedSaleId] = useState<number | null>(null)

  const [barcode, setBarcode] = useState('')
  const [modal, setModal] = useState<Modal | null>(null)
  const [completed, setCompleted] = useState<CompleteSaleResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [retiering, setRetiering] = useState(false)

  const [settings, setSettings] = useState<SellSettings | null>(null)
  const [methods, setMethods] = useState<Lookup[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const barcodeRef = useRef<HTMLInputElement>(null)

  // ── Focus. The single most important behaviour on this screen. ──────────────
  const refocus = useCallback((): void => {
    // rAF wins the race with Mantine returning focus to whatever opened the modal.
    requestAnimationFrame(() => barcodeRef.current?.focus())
  }, [])

  const modalOpen = modal !== null

  // Fires on mount (so the field is live the moment the screen opens) and every time the LAST modal
  // closes. Its only dependency is a boolean — it has no way to touch the cart. (Trap #19.)
  useEffect(() => {
    if (!modalOpen) refocus()
  }, [modalOpen, refocus])

  // ── Load what the till needs. Once. ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const [rawSettings, paymentMethods] = await Promise.all([
        window.pos.settings.getAll(),
        window.pos.lookups.list({ listKey: 'payment_method' })
      ])
      if (cancelled) return

      if (!rawSettings.ok) {
        setLoadError(rawSettings.error.userMessage)
        return
      }
      setSettings(readSettings(rawSettings.data))

      if (!paymentMethods.ok) {
        setLoadError(paymentMethods.error.userMessage)
        return
      }
      setMethods(paymentMethods.data)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // ═══════════════════════════════════════════════════════════════════════════
  // The cart, mutated through ONE serialised chain
  // ═══════════════════════════════════════════════════════════════════════════

  const setCart = useCallback((next: SaleLineInput[]): void => {
    cartRef.current = next
    setCartState(next)
  }, [])

  const fail = useCallback((title: string, message: string): void => {
    notifications.show({ color: 'red', icon: <CircleAlert size={18} />, title, message })
  }, [])

  /**
   * Every cart change goes through here, in order, reading the cart from the REF. Two scans arriving a
   * millisecond apart cannot overwrite one another — which would take an item off the receipt while it
   * sat on the counter.
   */
  const mutate = useCallback(
    (
      op: (current: SaleLineInput[]) => Promise<Result<SaleLineInput[]>>,
      onDone?: (next: SaleLineInput[], before: SaleLineInput[]) => void
    ): Promise<void> => {
      const run = queueRef.current.then(async () => {
        const before = cartRef.current
        const result = await op(before)
        if (!result.ok) {
          fail('That did not work', result.error.userMessage)
          return
        }
        setCart(result.data)
        onDone?.(result.data, before)
      })

      queueRef.current = run.catch(() => undefined)
      return run
    },
    [fail, setCart]
  )

  const rememberInfo = useCallback((key: string, info: LineInfo): void => {
    setInfos((current) => new Map(current).set(key, info))
  }, [])

  // `lineInfoFromScan` lives in shared/sell-preview so that the cross-check test builds its carts the
  // same way this screen does — see the comment on it.
  const infoFromScan = lineInfoFromScan

  /**
   * Put a line in the cart and SELECT it, so F2 immediately edits what was just scanned — scan, F2, "3",
   * Enter, without ever looking away from the customer.
   *
   * Main's `addLine` may have MERGED this into an existing row (the same tin scanned twice is qty 2, not
   * two rows). Rather than re-implement that rule to find out — the one thing this screen must not do —
   * we compare the cart before and after: it either grew by a row, or one row's quantity changed.
   */
  const addLine = useCallback(
    async (line: SaleLineInput): Promise<void> => {
      await mutate(
        (current) => window.pos.sales.addLine({ cart: current, line }),
        (next, before) => {
          if (next.length > before.length) {
            setSelected(next.length - 1)
            return
          }
          const merged = next.findIndex((row, index) => row.qtyM !== before[index]?.qtyM)
          setSelected(merged >= 0 ? merged : next.length - 1)
        }
      )
    },
    [mutate]
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // THE HOT PATH: a barcode arrives
  // ═══════════════════════════════════════════════════════════════════════════

  const scan = useCallback(
    async (code: string): Promise<void> => {
      const result = await window.pos.sales.scan({ barcode: code, tier, customerId: customer?.id })

      if (!result.ok) {
        // A carton with no selling price lands here — "scan the item itself to sell it". It is a
        // sentence a cashier can act on, which is the whole point of the Result envelope.
        fail('Cannot sell that', result.error.userMessage)
        refocus()
        return
      }

      if (result.data === null) {
        // NOT AN ERROR. A loyalty card swiped at the till is a Tuesday.
        notifications.show({
          color: 'yellow',
          icon: <Search size={18} />,
          title: 'Not found',
          message: `Nothing in the catalogue has the barcode ${code}.`
        })
        refocus()
        return
      }

      const item = result.data
      rememberInfo(infoKey(item), infoFromScan(item, code))

      // The moment anything lands in the cart, last sale's change is history.
      setCompleted(null)

      // A WEIGHED item is not a quantity, it is a weight — ask before it goes in the cart, so the line
      // is right the first time rather than being scanned as 1 kg and corrected.
      if (item.isWeighted) {
        setModal({ kind: 'weigh', item })
        return
      }

      // A SERIALISED item sells one physical unit at a time, and each one has an IMEI. A tin of beans
      // never comes down this branch and never costs the cashier a keystroke for it.
      if (item.trackSerials) {
        setModal({ kind: 'serials', item })
        return
      }

      await addLine({
        productId: item.productId,
        packId: item.packId,
        qtyM: item.qtyM,
        lineDiscount: 0
      })
      refocus()
    },
    [tier, customer, fail, refocus, rememberInfo, infoFromScan, addLine]
  )

  /**
   * The scanner is an HID keyboard-wedge: it types fast and finishes with its terminator. It may also
   * wrap the code in a prefix/suffix. All four are SETTINGS, and all four are honoured here.
   */
  const submitBarcode = useCallback((): void => {
    if (settings == null) return

    const raw = barcode

    // ENTER ON AN EMPTY FIELD IS "PAY". It is the single most-pressed key in the shop.
    if (raw.trim() === '') {
      if (completed != null) {
        setCompleted(null)
        refocus()
        return
      }
      if (cartRef.current.length > 0 && !readOnly) setModal({ kind: 'payment' })
      return
    }

    // First strip a STANDARD AIM identifier (]C1, ]E0, …) — the same normaliser the store and lookup
    // sides use, so a scanned code matches whatever was saved, with no setting to configure. THEN apply
    // the per-shop prefix/suffix, which exist for the odd scanner that wraps a code in something
    // non-standard. Main normalises again on lookup, so this is belt-and-braces, not the only guard.
    let code = normalizeBarcode(raw)
    const { prefix, suffix, minLength } = settings.scanner
    if (prefix !== '' && code.startsWith(prefix)) code = code.slice(prefix.length)
    if (suffix !== '' && code.endsWith(suffix)) code = code.slice(0, code.length - suffix.length)
    code = code.trim()

    setBarcode('')

    if (code.length < minLength) {
      // `scanner.minLength` exists to stop a stray keypress being read as a scan. Say so — silence would
      // just look broken.
      notifications.show({
        color: 'yellow',
        title: 'That code is too short',
        message: `A barcode must be at least ${minLength} characters. Nothing was looked up.`
      })
      refocus()
      return
    }

    void scan(code)
  }, [settings, barcode, completed, readOnly, refocus, scan])

  /**
   * `scanner.terminator: 'none'` — the scanner sends nothing after the barcode, so there is no keystroke
   * to submit on. A wedge types a whole code in a few milliseconds; a human does not. When the characters
   * stop arriving, that was the scan.
   */
  useEffect(() => {
    if (settings == null || settings.scanner.terminator !== 'none') return
    if (barcode.trim() === '') return

    const timer = setTimeout(() => submitBarcode(), 120)
    return () => clearTimeout(timer)
  }, [barcode, settings, submitBarcode])

  // ═══════════════════════════════════════════════════════════════════════════
  // Derived: the totals, and what the shop does not have
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ASK MAIN WHICH OFFERS FIRE ON THIS CART — as it changes, and never from anywhere else.
   *
   * TRAP #19: THIS EFFECT NEVER TOUCHES THE CART. It only ever calls `setLinePromotions`, so a stray
   * re-run cannot empty a customer's basket. The cart is the one thing on this screen that changes only
   * where a human did something.
   *
   * A STALE ANSWER MUST NEVER LAND ON A NEWER CART. The cashier scans faster than a round trip returns,
   * and an answer for a 3-line cart applied to a 5-line one would put "Sunday special" on the wrong
   * item. So each run tags itself and a superseded reply is dropped on arrival.
   */
  useEffect(() => {
    if (cart.length === 0) {
      setLinePromotions([])
      return
    }

    let live = true

    void window.pos.sales
      .previewPromotions({
        lines: cart,
        priceTier: tier,
        customerId: customer?.id ?? null
      })
      .then((result) => {
        if (!live) return
        // A failed preview is NOT an error the cashier can act on, and it is not a broken sale: the
        // offers are applied by main when the sale is rung up regardless of what this screen drew. So
        // it fails QUIET — no badge — rather than throwing a banner across a queue.
        setLinePromotions(result.ok ? result.data : [])
      })

    return () => {
      live = false
    }
  }, [cart, tier, customer])

  const math = useMemo((): CartMath | { error: string } => {
    if (settings == null) return EMPTY_CART
    try {
      return priceCart(cart, infos, cartDiscount, settings, linePromotions)
    } catch (error) {
      // `extendPrice` throws on an amount too large to record exactly. Better an honest banner than a
      // white screen with a queue in front of it.
      return {
        error:
          error instanceof Error ? error.message : 'That total could not be worked out.'
      }
    }
  }, [cart, infos, cartDiscount, settings, linePromotions])

  const totals: CartMath = 'error' in math ? EMPTY_CART : math
  const mathError = 'error' in math ? math.error : null

  const shortages = useMemo(() => findShortages(cart, infos), [cart, infos])
  const shortageIds = useMemo(() => new Set(shortages.map((s) => s.productId)), [shortages])

  /**
   * Mirrors `checkDiscountApproval` in main, so the cashier finds out NOW and not at the payment screen.
   *
   * A PROMOTION IS NOT MEASURED HERE, exactly as main does not measure it. The threshold guards a HUMAN
   * choosing to give money away; the shop's own standing offer is not that decision — it was authorised
   * by the manager who created it. Count it and a "25% off everything" Sunday would demand a supervisor
   * on every single basket, and by mid-morning the cashier would simply have been given the PIN.
   *
   * This screen asking for a PIN main will not ask for is just as bad as the reverse: the cashier calls
   * the supervisor over, who types a PIN into a prompt that never needed to exist. So the two measure
   * the SAME figure — `discountGiven` less what the offers gave.
   */
  const needsApproval = useMemo((): boolean => {
    if (settings == null) return false

    // WHAT A HUMAN CHOSE TO GIVE AWAY — the cashier's line discounts and the cart discount, and nothing
    // the shop's own offers did.
    const discount = totals.discountGiven - totals.promotionDiscountGiven
    if (discount <= 0) return false

    const percentBp = totals.listGross > 0 ? Math.round((discount * 10_000) / totals.listGross) : 0
    const overPercent = percentBp > settings.discountApprovalPercent
    const overAmount =
      settings.discountApprovalAmount > 0 && discount > settings.discountApprovalAmount
    return overPercent || overAmount
  }, [settings, totals.discountGiven, totals.promotionDiscountGiven, totals.listGross])

  const money = useCallback(
    (minor: number): string => formatMoney(minor, { symbol: settings?.currencySymbol ?? 'Rs' }),
    [settings]
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════════════════════════════

  const clearSale = useCallback((): void => {
    setCart([])
    setInfos(new Map())
    setSelected(null)
    setCartDiscount(0)
    setCartDiscountReason(null)
    setCustomer(null)
    setOutstanding(null)
    setResumedSaleId(null)
    setBarcode('')
  }, [setCart])

  const removeAt = useCallback(
    (index: number): void => {
      void mutate(
        (current) => window.pos.sales.removeLine({ cart: current, index }),
        (next) => setSelected(next.length === 0 ? null : Math.min(index, next.length - 1))
      )
      refocus()
    },
    [mutate, refocus]
  )

  /**
   * SWITCHING THE PRICE TIER RE-PRICES THE CART. Every line is scanned again at the new tier — because a
   * wholesale price is not a discount off retail, it is a different column, and the pack has its own.
   * A line we cannot re-scan (a resumed one, which has no barcode) keeps the price it came back with.
   */
  const changeTier = useCallback(
    async (next: PriceTier): Promise<void> => {
      setTier(next)

      // FOCUS GOES BACK TO THE SCANNER IMMEDIATELY — before the empty-cart early return.
      //
      // Clicking the tier control moves focus onto its radio button. If the cart is empty we used to
      // return here without refocusing, so the barcode field never got focus back and EVERY
      // subsequent scan typed into nothing — the cashier scanning into a dead field with a customer
      // waiting. The very first thing this function does now is hand focus back.
      refocus()
      if (cartRef.current.length === 0) return

      setRetiering(true)

      // Re-price each existing line at the new tier. Collect the results and merge them FUNCTIONALLY
      // at the end — never replace the map from a snapshot taken before these awaits, or an item
      // scanned DURING the re-pricing round trips would be silently discarded.
      const rescanned: Array<[string, ReturnType<typeof infoFromScan>]> = []
      for (const [key, info] of infos) {
        if (info.barcode == null) continue
        const result = await window.pos.sales.scan({
          barcode: info.barcode,
          tier: next,
          customerId: customer?.id
        })
        if (result.ok && result.data != null) {
          rescanned.push([key, infoFromScan(result.data, info.barcode)])
        }
      }

      setInfos((current) => {
        const merged = new Map(current)
        for (const [key, info] of rescanned) merged.set(key, info)
        return merged
      })
      setRetiering(false)
      refocus()
    },
    [infos, customer, infoFromScan, refocus]
  )

  /** The cart as main wants it, minus the payments. Shared by hold, quote and complete. */
  const cartPayload = useCallback(
    (): CartPayload => ({
      // A held cart that is rung up is CONVERTED — it becomes this sale, and leaves the hold tray. Send a
      // fresh cart instead and the parked one sits there for the next cashier to ring up all over again.
      ...(resumedSaleId != null ? { saleId: resumedSaleId } : {}),
      customerId: customer?.id ?? null,
      priceTier: tier,
      lines: cartRef.current,
      cartDiscount,
      cartDiscountReasonCode: cartDiscountReason
    }),
    [resumedSaleId, customer, tier, cartDiscount, cartDiscountReason]
  )

  /**
   * PRINT THE OFFER for the customer to take away. Main reads the quote from the database and builds the
   * paper — this hands it an id, never a document (see PosApi.printing).
   *
   * A failed print is NOT an error here, exactly as it is not on a completed sale: the quote is saved, so
   * the cashier gets a warning and another go, never a red box over a cart they already parked safely.
   */
  const printQuotation = useCallback(
    async (saleId: number): Promise<void> => {
      const result = await window.pos.printing.printQuotation({ id: saleId })
      if (!result.ok) {
        fail('Could not print the quotation', result.error.userMessage)
        return
      }
      if (!result.data.printed) {
        notifications.show({
          color: 'orange',
          icon: <Printer size={18} />,
          title: 'The quotation did not print',
          message: result.data.problem ?? 'It did not come out. The quote is still saved.'
        })
        return
      }
      notifications.show({
        color: 'teal',
        icon: <Printer size={18} />,
        title: 'Quotation printed',
        message: 'Hand it to the customer.'
      })
    },
    [fail]
  )

  const park = useCallback(
    async (as: 'held' | 'quote'): Promise<void> => {
      if (cartRef.current.length === 0) return
      setBusy(true)

      const payload = cartPayload()
      const result =
        as === 'held'
          ? await window.pos.sales.hold(payload)
          : await window.pos.sales.saveQuote(payload)

      setBusy(false)

      if (!result.ok) {
        fail(as === 'held' ? 'Could not hold this sale' : 'Could not save this quote', result.error.userMessage)
        refocus()
        return
      }

      if (as === 'held') {
        notifications.show({
          color: 'teal',
          icon: <CircleCheck size={18} />,
          title: 'Sale held',
          message: 'The cart is parked. Press F6 to pick it back up.'
        })
      } else {
        // THE OFFER NOW HAS A DEADLINE, AND THE CASHIER IS TOLD IT. `valid_until` comes back on the saved
        // row (main set it from `selling.quoteValidDays`) — it is never recomputed here, or the toast
        // could promise a date the paper does not carry.
        const saleId = result.data.id
        const validUntil = result.data.validUntil

        notifications.show({
          color: 'teal',
          icon: <CircleCheck size={18} />,
          title: 'Quote saved',
          // THIS TOAST CARRIES A BUTTON, so it does not vanish on the 4-second default while the cashier
          // is still reading the date. A print action that disappears before it can be clicked is not a
          // way to print — and the quote is always reprintable from the F6 tray regardless.
          autoClose: 12_000,
          // The date is the point of the message, so it leads. It takes an invoice number only if rung up.
          message: (
            <Stack gap={8} align="flex-start">
              <Text size="sm">
                {validUntil == null
                  ? 'It takes an invoice number only if it is rung up.'
                  : `Valid until ${formatDay(validUntil)}. It takes an invoice number only if it is rung up.`}
              </Text>
              {/* The offer is no use in the till — it has to go home with the customer. */}
              <Button
                size="xs"
                variant="default"
                leftSection={<Printer size={14} />}
                onClick={() => void printQuotation(saleId)}
              >
                Print quotation
              </Button>
            </Stack>
          )
        })
      }

      clearSale()
      refocus()
    },
    [cartPayload, fail, clearSale, refocus, printQuotation]
  )

  const pickCustomer = useCallback(
    async (next: Customer | null): Promise<void> => {
      setCustomer(next)
      setOutstanding(null)
      setPoints(null)
      if (next == null) return

      // What they already owe, read BEFORE we add to it — so the cashier sees the udhaar before giving more.
      const result = await window.pos.sales.outstandingCredit({ customerId: next.id })
      if (result.ok) setOutstanding(result.data)

      // ...and what they have SAVED UP. Only worth asking when the shop actually runs the scheme.
      // A failure here is silent on purpose: it must never stop the customer being served. The chip
      // stays hidden, and MAIN is the one that decides a redemption anyway.
      if (settings?.loyaltyEnabled !== true) return
      const balance = await window.pos.loyalty.balance({ customerId: next.id })
      if (balance.ok) setPoints(balance.data)
    },
    [settings?.loyaltyEnabled]
  )

  /**
   * Pick a parked cart back up. Two reads: `resume` gives the CART LINES main will re-price, and `get`
   * gives the frozen snapshot we need to DRAW them — a cart line carries no name.
   */
  const resume = useCallback(
    async (saleId: number): Promise<void> => {
      setBusy(true)
      const [lines, detail] = await Promise.all([
        window.pos.sales.resume({ id: saleId }),
        window.pos.sales.get({ id: saleId })
      ])
      setBusy(false)

      if (!lines.ok) {
        fail('Could not reopen that sale', lines.error.userMessage)
        return
      }
      if (!detail.ok) {
        fail('Could not reopen that sale', detail.error.userMessage)
        return
      }

      const rebuilt = new Map<string, LineInfo>()
      for (const line of detail.data.lines) {
        if (line.isOpenItem || line.productId == null) continue

        rebuilt.set(infoKey({ productId: line.productId, packId: line.packId }), {
          name: line.nameSnapshot,
          nameOtherLang: line.nameOtherLang,
          uom: line.uom,
          packLabel: line.packId != null ? line.uom : null,
          // Unknown, and unknowable from here — see LineInfo.packSizeM.
          packSizeM: null,
          unitPrice: line.unitPrice,
          taxRateBp: line.taxRateBp,
          taxMode: line.taxMode,
          isWeighted: false,
          trackSerials: false,
          itemType: 'inventory',
          onHandM: null, // we have no stock figure for a resumed line; main still checks it
          barcode: null,
          frozen:
            line.packId != null
              ? { net: line.net, tax: line.taxAmount, gross: line.gross }
              : null
        })
      }

      setInfos(rebuilt)
      setCart(lines.data)
      setSelected(lines.data.length > 0 ? 0 : null)
      setResumedSaleId(saleId)
      setTier(detail.data.priceTier)
      setCartDiscount(detail.data.cartDiscount)
      setCompleted(null)

      // The sale remembers WHO it was for; we need the whole customer back (their credit limit, and what
      // they already owe). There is no customers.get endpoint, so we search on the name the sale carries.
      const { customerId, customerName } = detail.data
      if (customerId != null && customerName != null) {
        const found = await window.pos.customers.list({ pageSize: 20, search: customerName })
        if (found.ok) {
          const match = found.data.rows.find((row) => row.id === customerId)
          if (match) await pickCustomer(match)
        }
      }

      setModal(null)
      refocus()
    },
    [fail, setCart, refocus, pickCustomer]
  )

  const reprint = useCallback(
    async (saleId: number): Promise<void> => {
      const result = await window.pos.printing.printReceipt({ id: saleId })
      if (!result.ok) {
        fail('Could not print', result.error.userMessage)
        return
      }
      if (!result.data.printed) {
        notifications.show({
          color: 'orange',
          icon: <Printer size={18} />,
          title: 'Still did not print',
          message: result.data.problem ?? 'The receipt did not come out.'
        })
        return
      }
      notifications.show({
        color: 'teal',
        icon: <Printer size={18} />,
        title: 'Printed',
        message: 'A DUPLICATE copy has been printed and logged.'
      })
    },
    [fail]
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // The keyboard. Registered ONCE, with no dependencies — see §4 of the header.
  // ═══════════════════════════════════════════════════════════════════════════

  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined)

  handlerRef.current = (event: KeyboardEvent): void => {
    if (settings == null) return

    const target = event.target as HTMLElement | null
    // "Editing" means a field that swallows TEXT — not a radio or a checkbox. The tier control is a
    // group of radio inputs; treating those as editable let focus get stuck on them, so the scanner
    // field never took typing back. A radio/checkbox holds no text, so it is not editing.
    const nonTextInput = ['radio', 'checkbox', 'button', 'submit', 'range', 'color'].includes(
      (target as HTMLInputElement | null)?.type ?? ''
    )
    const editing =
      target != null &&
      !nonTextInput &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)

    // ── The function keys work everywhere except inside a modal, which owns its own keyboard. ──
    if (!modalOpen) {
      const shortcut = (): boolean => {
        switch (event.key) {
          case 'F2':
            if (selected != null) setModal({ kind: 'qty', index: selected })
            return true
          case 'F3':
            if (selected != null) setModal({ kind: 'line', index: selected })
            return true
          case 'F4':
            if (cartRef.current.length > 0) setModal({ kind: 'cartDiscount' })
            return true
          case 'F5':
            if (cartRef.current.length > 0 && !readOnly) void park('held')
            return true
          case 'F6':
            setModal({ kind: 'held' })
            return true
          case 'F8':
            if (!readOnly) setModal({ kind: 'openItem' })
            return true
          case 'F9':
            setModal({ kind: 'customer' })
            return true
          case 'F12':
            if (cartRef.current.length > 0 && !readOnly) setModal({ kind: 'payment' })
            return true
          default:
            return false
        }
      }

      if (shortcut()) {
        event.preventDefault()
        return
      }

      // ESC: back out of whatever the cashier is in the middle of, one step at a time.
      if (event.key === 'Escape') {
        event.preventDefault()
        if (completed != null) {
          setCompleted(null)
        } else if (barcode !== '') {
          setBarcode('')
        } else if (selected != null) {
          removeAt(selected)
        }
        refocus()
        return
      }

      // Move the selection without leaving the barcode field.
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && cartRef.current.length > 0) {
        event.preventDefault()
        const last = cartRef.current.length - 1
        setSelected((current) => {
          if (current == null) return event.key === 'ArrowDown' ? 0 : last
          const next = current + (event.key === 'ArrowDown' ? 1 : -1)
          return Math.max(0, Math.min(last, next))
        })
        return
      }

      // ── FOCUS FOLLOWS TYPING ────────────────────────────────────────────────
      // A printable character arrived while focus was on a button, or nowhere. Send it — and the focus —
      // to the barcode field. Moving focus during keydown means the browser delivers the character to
      // the newly focused field, so the scan is not lost. This is what stops a stray click from costing
      // the cashier a sale.
      if (
        !editing &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        barcodeRef.current?.focus()
      }
    }
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handlerRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, []) // NO DEPS. It can never re-run, so it can never drop the cart.

  // ═══════════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════════

  if (loadError != null) {
    return (
      <Alert color="red" icon={<CircleAlert size={18} />} title="The till could not be opened">
        {loadError}
      </Alert>
    )
  }

  if (settings == null || methods == null) {
    return (
      <Stack gap="md">
        <Skeleton height={56} />
        <Group align="flex-start" gap="md" wrap="nowrap">
          <Skeleton height={420} style={{ flex: 1 }} />
          <Skeleton height={420} width={380} />
        </Group>
      </Stack>
    )
  }

  const mayWholesale = roleAtLeast(userRole, settings.wholesaleTierRole)
  const mayOverride = roleAtLeast(userRole, settings.priceOverrideRole)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── THE BARCODE FIELD. It never leaves the top of the screen, and it never loses focus. ── */}
      <TextInput
        ref={barcodeRef}
        size="lg"
        autoFocus
        disabled={readOnly}
        placeholder={
          readOnly
            ? 'The licence has expired — the till is read-only'
            : 'Scan barcode or type item code / name'
        }
        leftSection={<ScanLine size={22} />}
        rightSection={busy || retiering ? <Loader size="xs" /> : null}
        value={barcode}
        onChange={(event) => setBarcode(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submitBarcode()
            return
          }
          // A scanner set to send TAB must not move the focus off the field it just typed into.
          if (event.key === 'Tab' && settings.scanner.terminator === 'tab') {
            event.preventDefault()
            submitBarcode()
          }
        }}
        styles={{ input: { fontSize: 20, fontFamily: 'monospace', height: 54 } }}
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 16, position: 'relative' }}>
        {/* ══ LEFT: the cart ══════════════════════════════════════════════════ */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mathError != null && (
            <Alert color="red" icon={<CircleAlert size={18} />} title="That total could not be worked out">
              {mathError}
            </Alert>
          )}

          {shortages.length > 0 && settings.negativeStock !== 'allow' && (
            <Alert
              color={settings.negativeStock === 'block' ? 'red' : 'orange'}
              icon={<TriangleAlert size={18} />}
              title={
                settings.negativeStock === 'block'
                  ? 'There is not enough stock — this sale will be refused'
                  : 'Selling stock the shop does not have'
              }
            >
              <Stack gap={2}>
                {shortages.map((s) => (
                  <Text size="sm" key={s.productId}>
                    <strong>{s.name}</strong> — {formatQty(s.onHandM)} in stock, selling{' '}
                    {formatQty(s.wantedM)}
                  </Text>
                ))}
              </Stack>
              {settings.negativeStock === 'warn' && (
                <Text size="sm" mt={6} c="dimmed">
                  A stock count is often simply out of date. The sale can still go through — it will be
                  flagged for the owner.
                </Text>
              )}
            </Alert>
          )}

          <Card
            withBorder
            padding={0}
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            {cart.length === 0 ? (
              <Stack align="center" justify="center" gap="xs" style={{ flex: 1 }} p="xl">
                <ShoppingCart size={40} opacity={0.35} />
                <Text fw={600}>Ready</Text>
                <Text size="sm" c="dimmed" ta="center" maw={380}>
                  Scan the first item. Nothing is written to the books until the sale is paid for.
                </Text>
              </Stack>
            ) : (
              <ScrollArea style={{ flex: 1 }} type="auto">
                <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
                  <Table.Thead
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      background: 'var(--mantine-color-body)'
                    }}
                  >
                    <Table.Tr>
                      <Table.Th w={40}>#</Table.Th>
                      <Table.Th>Item</Table.Th>
                      <Table.Th ta="right" w={110}>
                        Qty
                      </Table.Th>
                      <Table.Th ta="right" w={130}>
                        Price
                      </Table.Th>
                      <Table.Th ta="right" w={140}>
                        Amount
                      </Table.Th>
                      <Table.Th w={44} />
                    </Table.Tr>
                  </Table.Thead>

                  <Table.Tbody>
                    {cart.map((line, index) => {
                      const info = infos.get(infoKey(line))
                      const lineMath = totals.lines[index]
                      const isSelected = selected === index
                      const short = line.productId != null && shortageIds.has(line.productId)

                      const name = line.openItem?.name ?? info?.name ?? 'Item'
                      const packs =
                        line.packId != null && info?.packSizeM != null && info.packSizeM > 0
                          ? line.qtyM / info.packSizeM
                          : null

                      return (
                        <Table.Tr
                          key={index}
                          onClick={() => {
                            setSelected(index)
                            refocus()
                          }}
                          style={{
                            cursor: 'pointer',
                            background: isSelected
                              ? 'var(--mantine-color-default-hover)'
                              : undefined,
                            boxShadow: isSelected
                              ? 'inset 3px 0 0 0 var(--mantine-primary-color-filled)'
                              : undefined
                          }}
                        >
                          <Table.Td>
                            <Text size="sm" c="dimmed">
                              {index + 1}
                            </Text>
                          </Table.Td>

                          <Table.Td>
                            <Group gap={6} wrap="wrap">
                              <div style={{ minWidth: 0 }}>
                                <Text size="md" fw={550}>
                                  {name}
                                </Text>
                                {info?.nameOtherLang && (
                                  <Text size="xs" c="dimmed" dir="auto">
                                    {info.nameOtherLang}
                                  </Text>
                                )}
                              </div>

                              {/*
                                THE SHOP'S OWN OFFER, so the cashier can tell the customer why the
                                price changed — "Sunday special −Rs 20". BOTH the name and the money
                                come from MAIN (`sale:previewPromotions`); nothing here is worked out
                                on the screen. It sits with the other line badges because that is what
                                it is: a fact about this line, not a number the cashier can change.
                              */}
                              {lineMath?.promotion != null && (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="teal"
                                  leftSection={<BadgePercent size={9} />}
                                >
                                  {lineMath.promotion.promotionName}
                                  {lineMath.promotion.discountMinor > 0 &&
                                    ` −${money(lineMath.promotion.discountMinor)}`}
                                </Badge>
                              )}
                              {line.openItem != null && (
                                <Badge size="xs" variant="light" color="grape">
                                  open item
                                </Badge>
                              )}
                              {info?.packLabel && (
                                <Badge size="xs" variant="light" color="blue">
                                  {info.packLabel}
                                </Badge>
                              )}
                              {line.priceOverride != null && (
                                <Badge size="xs" variant="light" color="orange" leftSection={<Tag size={9} />}>
                                  price changed
                                </Badge>
                              )}
                              {(line.serials?.length ?? 0) > 0 && (
                                <Badge size="xs" variant="light" color="cyan">
                                  {line.serials?.length} serial
                                  {(line.serials?.length ?? 0) === 1 ? '' : 's'}
                                </Badge>
                              )}
                              {short && (
                                <Badge
                                  size="xs"
                                  color="orange"
                                  variant="filled"
                                  leftSection={<TriangleAlert size={9} />}
                                >
                                  short
                                </Badge>
                              )}
                              {lineMath != null && !lineMath.editable && line.openItem == null && (
                                <Tooltip
                                  multiline
                                  w={260}
                                  label="This came back from a held sale as a whole pack. To change how many, remove it and scan it again."
                                >
                                  <Badge size="xs" variant="light" color="gray">
                                    locked
                                  </Badge>
                                </Tooltip>
                              )}
                            </Group>
                          </Table.Td>

                          <Table.Td ta="right">
                            <Text size="md" fw={600}>
                              {packs != null ? formatQty(packs * ONE_UNIT) : formatQty(line.qtyM)}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {packs != null ? (info?.packLabel ?? 'pack') : (info?.uom ?? '')}
                            </Text>
                          </Table.Td>

                          <Table.Td ta="right">
                            <Text size="sm">{money(lineMath?.unitPrice ?? 0)}</Text>
                            {(lineMath?.lineDiscount ?? 0) > 0 && (
                              <Text size="xs" c="var(--mantine-color-teal-text)">
                                −{money(lineMath?.lineDiscount ?? 0)}
                              </Text>
                            )}
                          </Table.Td>

                          <Table.Td ta="right">
                            <Text size="md" fw={650}>
                              {money(lineMath?.gross ?? 0)}
                            </Text>
                            {(lineMath?.lineDiscount ?? 0) > 0 && (
                              <Text size="xs" c="dimmed" td="line-through">
                                {money(lineMath?.listGross ?? 0)}
                              </Text>
                            )}
                          </Table.Td>

                          <Table.Td>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={`Remove ${name}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                removeAt(index)
                              }}
                            >
                              <Trash2 size={16} />
                            </ActionIcon>
                          </Table.Td>
                        </Table.Tr>
                      )
                    })}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Card>

          {/* ── The shortcuts. A cashier learns them by SEEING them. ─────────── */}
          <Group gap={6} wrap="wrap">
            {[
              ['F2', 'Quantity'],
              ['F3', 'Discount'],
              ['F4', 'Cart discount'],
              ['F5', 'Hold'],
              ['F6', 'Resume'],
              ['F8', 'Open item'],
              ['F9', 'Customer'],
              ['F12', 'Pay'],
              ['Esc', 'Clear line']
            ].map(([key, label]) => (
              <Group gap={4} key={key} wrap="nowrap">
                <Kbd size="xs">{key}</Kbd>
                <Text size="xs" c="dimmed">
                  {label}
                </Text>
              </Group>
            ))}
          </Group>
        </div>

        {/* ══ RIGHT: the money ════════════════════════════════════════════════ */}
        <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card withBorder padding="md">
            <Stack gap="sm">
              <SegmentedControl
                fullWidth
                size="sm"
                value={tier}
                disabled={readOnly || retiering}
                onChange={(next) => void changeTier(next as PriceTier)}
                data={[
                  { value: 'retail', label: 'Retail' },
                  {
                    value: 'wholesale',
                    label: mayWholesale ? 'Wholesale' : 'Wholesale (needs approval)'
                  }
                ]}
              />

              <Button
                variant="default"
                justify="space-between"
                leftSection={customer ? <User size={16} /> : <UserX size={16} />}
                rightSection={<Kbd size="xs">F9</Kbd>}
                onClick={() => setModal({ kind: 'customer' })}
              >
                <Text size="sm" truncate style={{ flex: 1, textAlign: 'left' }}>
                  {customer?.name ?? 'Walk-in customer'}
                </Text>
              </Button>

              {customer != null && outstanding != null && outstanding > 0 && (
                <Text size="xs" c="var(--mantine-color-orange-text)">
                  Already owes {money(outstanding)}
                  {customer.creditLimit > 0 && ` of a ${money(customer.creditLimit)} limit`}
                </Text>
              )}

              {/* WHAT THEY HAVE SAVED UP. Only when the shop runs the scheme and they actually have
                  some — "0 points" is noise at a till. The VALUE is MAIN's figure, never one worked
                  out here. Spending them happens at Pay, where the rest of the tenders are. */}
              {settings?.loyaltyEnabled === true && points != null && points.points > 0 && (
                <Group gap={6} wrap="nowrap">
                  <Award size={14} color="var(--mantine-color-violet-text)" />
                  <Text size="xs" c="var(--mantine-color-violet-text)">
                    {points.points.toLocaleString('en-US')} points
                    {points.valueMinor > 0 && ` — worth ${money(points.valueMinor)}`}
                  </Text>
                </Group>
              )}
            </Stack>
          </Card>

          <Card withBorder padding="md" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <Stack gap={8} style={{ flex: 1 }}>
              <Row label="Subtotal" value={money(totals.subtotalNet)} />
              {totals.discountGiven > 0 && (
                <Row label="Discount" value={`−${money(totals.discountGiven)}`} color="teal" />
              )}
              {settings.taxEnabled && <Row label="Tax" value={money(totals.taxTotal)} />}

              <Divider my={4} />

              <Group justify="space-between" align="baseline">
                <Text fw={600}>Total</Text>
                <Text fw={800} style={{ fontSize: 34, lineHeight: 1.1 }}>
                  {money(totals.grandTotal)}
                </Text>
              </Group>

              <Text size="xs" c="dimmed" ta="right">
                {cart.length} {cart.length === 1 ? 'line' : 'lines'}
              </Text>

              {needsApproval && (
                <Alert color="orange" icon={<TriangleAlert size={16} />} p="xs">
                  <Text size="xs">
                    This discount is over the limit a cashier may give. A supervisor must sign in to
                    approve it.
                  </Text>
                </Alert>
              )}

              <div style={{ flex: 1 }} />

              <Group grow gap={8}>
                <Button
                  variant="default"
                  size="sm"
                  leftSection={<Percent size={15} />}
                  disabled={cart.length === 0 || readOnly}
                  onClick={() => setModal({ kind: 'cartDiscount' })}
                >
                  Discount
                </Button>
                <Menu position="top-end">
                  <Menu.Target>
                    <Button
                      variant="default"
                      size="sm"
                      leftSection={<Pause size={15} />}
                      disabled={cart.length === 0 || readOnly}
                      loading={busy}
                    >
                      Park
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<Pause size={14} />}
                      onClick={() => void park('held')}
                    >
                      Hold the cart (F5)
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<FileText size={14} />}
                      onClick={() => void park('quote')}
                    >
                      Save as a quotation
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>

              <Group grow gap={8}>
                <Button
                  variant="default"
                  size="sm"
                  leftSection={<Play size={15} />}
                  onClick={() => setModal({ kind: 'held' })}
                >
                  Resume (F6)
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  leftSection={<Receipt size={15} />}
                  disabled={readOnly}
                  onClick={() => setModal({ kind: 'openItem' })}
                >
                  Open item
                </Button>
              </Group>

              <Tooltip
                label="Your licence has expired — new sales cannot be rung up"
                disabled={!readOnly}
              >
                <Button
                  size="xl"
                  h={64}
                  leftSection={<Banknote size={24} />}
                  rightSection={<Kbd>F12</Kbd>}
                  disabled={cart.length === 0 || readOnly || mathError != null}
                  onClick={() => setModal({ kind: 'payment' })}
                >
                  PAY
                </Button>
              </Tooltip>
            </Stack>
          </Card>
        </div>

        {/* ══ The sale just went through. The cashier needs ONE number: the change. ══ */}
        {completed != null && (
          <CompletedOverlay
            response={completed}
            money={money}
            onPrintAgain={() => void reprint(completed.sale.id)}
            onDismiss={() => {
              setCompleted(null)
              refocus()
            }}
          />
        )}
      </div>

      {/* ══ Modals ═══════════════════════════════════════════════════════════ */}

      {modal?.kind === 'weigh' && (
        <WeighModal
          item={modal.item}
          money={money}
          onClose={() => setModal(null)}
          onConfirm={(qtyM) => {
            setModal(null)
            void addLine({
              productId: modal.item.productId,
              packId: modal.item.packId,
              qtyM,
              lineDiscount: 0
            })
          }}
        />
      )}

      {modal?.kind === 'serials' && (
        <SerialsModal
          item={modal.item}
          onClose={() => setModal(null)}
          onConfirm={(serials) => {
            setModal(null)
            void addLine({
              productId: modal.item.productId,
              packId: modal.item.packId,
              qtyM: serials.length * ONE_UNIT,
              lineDiscount: 0,
              serials
            })
          }}
        />
      )}

      {modal?.kind === 'qty' && cart[modal.index] != null && (
        <QtyModal
          line={cart[modal.index]!}
          info={infos.get(infoKey(cart[modal.index]!))}
          locked={totals.lines[modal.index]?.editable === false}
          onClose={() => setModal(null)}
          onConfirm={(qtyM) => {
            const index = modal.index
            setModal(null)
            void mutate((current) =>
              window.pos.sales.updateLine({ cart: current, index, changes: { qtyM } })
            )
          }}
        />
      )}

      {modal?.kind === 'line' && cart[modal.index] != null && (
        <LineModal
          line={cart[modal.index]!}
          info={infos.get(infoKey(cart[modal.index]!))}
          money={money}
          mayOverride={mayOverride}
          locked={totals.lines[modal.index]?.editable === false}
          onClose={() => setModal(null)}
          onConfirm={(changes) => {
            const index = modal.index
            setModal(null)
            void mutate((current) =>
              window.pos.sales.updateLine({ cart: current, index, changes })
            )
          }}
        />
      )}

      {modal?.kind === 'cartDiscount' && (
        <CartDiscountModal
          value={cartDiscount}
          reason={cartDiscountReason}
          max={totals.preDiscountGross}
          money={money}
          onClose={() => setModal(null)}
          onConfirm={(amount, reason) => {
            setCartDiscount(amount)
            setCartDiscountReason(reason)
            setModal(null)
          }}
        />
      )}

      {modal?.kind === 'openItem' && (
        <OpenItemModal
          settings={settings}
          onClose={() => setModal(null)}
          onConfirm={(name, unitPrice, qtyM) => {
            setModal(null)
            setCompleted(null)
            void addLine({
              qtyM,
              lineDiscount: 0,
              openItem: { name, unitPrice }
            })
          }}
        />
      )}

      {modal?.kind === 'customer' && (
        <CustomerModal
          current={customer}
          money={money}
          onClose={() => setModal(null)}
          onPick={(next) => {
            void pickCustomer(next)
            setModal(null)
          }}
        />
      )}

      {modal?.kind === 'held' && (
        <HeldModal
          money={money}
          onClose={() => setModal(null)}
          onResume={(id) => void resume(id)}
          onPrintQuotation={printQuotation}
        />
      )}

      {modal?.kind === 'payment' && (
        <PaymentModal
          methods={methods}
          settings={settings}
          totals={totals}
          customer={customer}
          outstanding={outstanding}
          points={points}
          shortages={shortages}
          money={money}
          onClose={() => setModal(null)}
          onPaid={(response) => {
            setModal(null)
            clearSale()
            setCompleted(response)
            refocus()
          }}
          buildPayload={cartPayload}
        />
      )}
    </div>
  )
}

function Row({
  label,
  value,
  color
}: {
  label: string
  value: string
  color?: string
}): React.JSX.Element {
  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500} c={color}>
        {value}
      </Text>
    </Group>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SALE WENT THROUGH. Give the cashier the one number they need.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Deliberately NOT a Mantine Modal. A modal would steal the focus, and the very next thing that happens
 * at a till is the next customer's first item being scanned. This is an overlay UNDER the barcode field:
 * the field stays visible and stays focused, and the scan that dismisses this panel is also the scan that
 * starts the next sale.
 */
function CompletedOverlay({
  response,
  money,
  onPrintAgain,
  onDismiss
}: {
  response: CompleteSaleResponse
  money: (minor: number) => string
  onPrintAgain: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const { sale, print, drawer } = response

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--mantine-color-body)',
        borderRadius: 8
      }}
    >
      <Card withBorder padding="xl" style={{ width: 560, maxWidth: '100%' }}>
        <Stack gap="md" align="center">
          <Group gap={8}>
            <CircleCheck size={22} color="var(--mantine-color-teal-text)" />
            <Text fw={700} size="lg">
              Sale complete
            </Text>
          </Group>

          <Text ff="monospace" size="sm" c="dimmed">
            {sale.invoiceNo}
          </Text>

          <Divider w="100%" />

          {sale.changeDue > 0 ? (
            <Stack gap={0} align="center">
              <Text size="sm" c="dimmed" fw={600} tt="uppercase">
                Change due
              </Text>
              <Text fw={800} c="var(--mantine-color-teal-text)" style={{ fontSize: 64, lineHeight: 1.1 }}>
                {money(sale.changeDue)}
              </Text>
            </Stack>
          ) : (
            <Stack gap={0} align="center">
              <Text size="sm" c="dimmed" fw={600} tt="uppercase">
                Paid in full — no change
              </Text>
              <Text fw={800} style={{ fontSize: 48, lineHeight: 1.2 }}>
                {money(sale.grandTotal)}
              </Text>
            </Stack>
          )}

          {/* A PRINTER JAM DID NOT LOSE THE SALE. Never a red box — the money DID go through. */}
          {!print.printed && (
            <Alert
              color="orange"
              icon={<Printer size={18} />}
              title="The receipt did not print"
              w="100%"
            >
              <Text size="sm">{print.problem ?? 'The receipt did not come out.'}</Text>
              <Text size="sm" mt={4} fw={600}>
                The sale is saved. Nothing has been lost.
              </Text>
            </Alert>
          )}

          {!drawer.opened && drawer.problem != null && (
            <Text size="xs" c="dimmed" ta="center">
              Cash drawer: {drawer.problem}
            </Text>
          )}

          {sale.hadNegativeStock && (
            <Badge color="orange" variant="light" leftSection={<TriangleAlert size={11} />}>
              Flagged: sold below stock on hand
            </Badge>
          )}

          <Group grow w="100%">
            <Button
              variant="default"
              leftSection={<Printer size={16} />}
              onClick={onPrintAgain}
            >
              Print again
            </Button>
            <Button rightSection={<Kbd>Enter</Kbd>} onClick={onDismiss}>
              Next customer
            </Button>
          </Group>

          <Text size="xs" c="dimmed">
            Or just scan the next item — this will clear itself.
          </Text>
        </Stack>
      </Card>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Modals
// ═════════════════════════════════════════════════════════════════════════════

/** A weighed item: the cashier reads the scale and types it. 1.234 kg is 1234 — never a float. */
function WeighModal({
  item,
  money,
  onClose,
  onConfirm
}: {
  item: ScannedItem
  money: (minor: number) => string
  onClose: () => void
  onConfirm: (qtyM: number) => void
}): React.JSX.Element {
  const [qtyM, setQtyM] = useState(ONE_UNIT)

  return (
    <Modal opened onClose={onClose} title={item.name} centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Sold by weight, at {money(item.unitPrice)} per {item.uom ?? 'unit'}.
        </Text>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (qtyM > 0) onConfirm(qtyM)
          }}
        >
          <Stack gap="md">
            <QtyInput
              label={`Weight (${item.uom ?? 'units'})`}
              value={qtyM}
              onChange={setQtyM}
              leftSection={<Scale size={16} />}
              required
            />

            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Line total
              </Text>
              <Text fw={700} size="lg">
                {money(extendPrice(item.unitPrice, qtyM))}
              </Text>
            </Group>

            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={qtyM <= 0}>
                Add
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Modal>
  )
}

/** A phone is sold ONE PHYSICAL UNIT AT A TIME, and each one has an IMEI. Only a flagged item asks. */
function SerialsModal({
  item,
  onClose,
  onConfirm
}: {
  item: ScannedItem
  onClose: () => void
  onConfirm: (serials: string[]) => void
}): React.JSX.Element {
  const [serials, setSerials] = useState<string[]>([''])

  const filled = serials.map((s) => s.trim()).filter((s) => s !== '')
  const complete = filled.length === serials.length && filled.length > 0

  return (
    <Modal opened onClose={onClose} title={item.name} centered>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (complete) onConfirm(filled)
        }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            This item is tracked by serial number. Scan or type one for each unit being sold.
          </Text>

          {serials.map((serial, index) => (
            <Group key={index} gap={6} wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                autoFocus={index === serials.length - 1}
                label={`Serial / IMEI ${index + 1}`}
                value={serial}
                onChange={(event) => {
                  const next = [...serials]
                  next[index] = event.currentTarget.value
                  setSerials(next)
                }}
              />
              {serials.length > 1 && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  mt={22}
                  aria-label="Remove this serial"
                  onClick={() => setSerials(serials.filter((_, i) => i !== index))}
                >
                  <X size={16} />
                </ActionIcon>
              )}
            </Group>
          ))}

          <Button
            variant="default"
            size="xs"
            onClick={() => setSerials([...serials, ''])}
          >
            Another unit
          </Button>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete}>
              Add {filled.length} {filled.length === 1 ? 'unit' : 'units'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

function QtyModal({
  line,
  info,
  locked,
  onClose,
  onConfirm
}: {
  line: SaleLineInput
  info: LineInfo | undefined
  locked: boolean
  onClose: () => void
  onConfirm: (qtyM: number) => void
}): React.JSX.Element {
  const packSize = line.packId != null ? info?.packSizeM ?? null : null
  // A pack is sold in WHOLE packs. Show the cashier cartons, and convert back to base units on the way in.
  const [qtyM, setQtyM] = useState(packSize != null && packSize > 0 ? (line.qtyM / packSize) * ONE_UNIT : line.qtyM)
  const [error, setError] = useState<string | null>(null)

  const name = line.openItem?.name ?? info?.name ?? 'Item'
  const unit = packSize != null ? (info?.packLabel ?? 'packs') : (info?.uom ?? 'units')

  return (
    <Modal opened onClose={onClose} title={name} centered>
      {locked ? (
        <Stack gap="md">
          <Alert color="gray" icon={<CircleAlert size={18} />}>
            This line came back from a held sale as a whole pack, and the till cannot work out how many
            are in one. Remove it and scan it again to change the quantity.
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (qtyM <= 0) return

            if (packSize != null && packSize > 0) {
              // You cannot sell 2.007 cartons. A pack is bought and sold whole, and main refuses a
              // fractional-pack movement anyway — so let the cashier fix it here, at the field,
              // rather than build an impossible cart and hit a wall at Pay.
              const packs = qtyM / ONE_UNIT
              if (!Number.isInteger(packs)) {
                setError('A pack is sold whole — please enter a whole number of packs.')
                return
              }
              // Integer arithmetic: packs (whole) x packSize (qty_m). Never (qtyM/1000)*packSize as a
              // float, which produced non-round quantities that later rendered a blank screen.
              onConfirm(packs * packSize)
              return
            }

            onConfirm(qtyM)
          }}
        >
          <Stack gap="md">
            <QtyInput
              label={`Quantity (${unit})`}
              value={qtyM}
              onChange={(next) => {
                setError(null)
                setQtyM(next)
              }}
              error={error ?? undefined}
              required
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={qtyM <= 0}>
                Set
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  )
}

/**
 * The line's money: a discount off it, or a different price entirely.
 *
 * A DISCOUNT and a PRICE OVERRIDE are not the same act, and the books treat them differently. A discount
 * is contra-income — the owner can see what discounting cost. An override changes what the thing was sold
 * for, and lands in the audit log with the name of whoever authorised it.
 */
function LineModal({
  line,
  info,
  money,
  mayOverride,
  locked,
  onClose,
  onConfirm
}: {
  line: SaleLineInput
  info: LineInfo | undefined
  money: (minor: number) => string
  mayOverride: boolean
  locked: boolean
  onClose: () => void
  onConfirm: (changes: {
    lineDiscount: number
    discountReasonCode: string | null
    priceOverride: number | null
  }) => void
}): React.JSX.Element {
  const [discount, setDiscount] = useState(line.lineDiscount ?? 0)
  const [reason, setReason] = useState<string | null>(line.discountReasonCode ?? null)
  const [override, setOverride] = useState<number>(line.priceOverride ?? info?.unitPrice ?? 0)
  const [overriding, setOverriding] = useState(line.priceOverride != null)

  const name = line.openItem?.name ?? info?.name ?? 'Item'
  const catalogPrice = line.openItem?.unitPrice ?? info?.unitPrice ?? 0

  return (
    <Modal opened onClose={onClose} title={name} centered>
      {locked ? (
        <Stack gap="md">
          <Alert color="gray" icon={<CircleAlert size={18} />}>
            This line came back from a held sale as a whole pack and cannot be re-priced here. Remove it
            and scan it again.
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm({
              lineDiscount: discount,
              discountReasonCode: discount > 0 ? reason : null,
              priceOverride: overriding && line.openItem == null ? override : null
            })
          }}
        >
          <Stack gap="md">
            <MoneyInput
              label="Discount on this line"
              description={`The item is ${money(catalogPrice)}.`}
              value={discount}
              onChange={setDiscount}
              leftSection={<Percent size={16} />}
              autoFocus
            />

            <LookupCodeSelect
              listKey="discount_reason"
              label="Reason"
              description="Required once the discount is over the limit a cashier may give on their own."
              value={reason}
              onChange={setReason}
            />

            {line.openItem == null && mayOverride && (
              <>
                <Divider label="Or change the price" labelPosition="center" />
                {!overriding ? (
                  <Button variant="default" leftSection={<Tag size={15} />} onClick={() => setOverriding(true)}>
                    Change the price of this item
                  </Button>
                ) : (
                  <Stack gap={6}>
                    <MoneyInput
                      label="New price"
                      description="Recorded against your name in the audit log."
                      value={override}
                      onChange={setOverride}
                    />
                    <Button
                      variant="subtle"
                      color="gray"
                      size="xs"
                      onClick={() => setOverriding(false)}
                    >
                      Use the catalogue price instead
                    </Button>
                  </Stack>
                )}
              </>
            )}

            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Apply</Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  )
}

function CartDiscountModal({
  value,
  reason,
  max,
  money,
  onClose,
  onConfirm
}: {
  value: number
  reason: string | null
  max: number
  money: (minor: number) => string
  onClose: () => void
  onConfirm: (amount: number, reason: string | null) => void
}): React.JSX.Element {
  const [amount, setAmount] = useState(value)
  const [code, setCode] = useState<string | null>(reason)

  const tooBig = amount > max

  return (
    <Modal opened onClose={onClose} title="Discount on the whole sale" centered>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!tooBig) onConfirm(amount, amount > 0 ? code : null)
        }}
      >
        <Stack gap="md">
          <MoneyInput
            label="Discount"
            description={`The sale is ${money(max)} before any discount.`}
            value={amount}
            onChange={setAmount}
            leftSection={<Percent size={16} />}
            error={tooBig ? 'That is more than the sale itself.' : undefined}
            autoFocus
          />

          <LookupCodeSelect
            listKey="discount_reason"
            label="Reason"
            description="Required once the discount is over the limit a cashier may give on their own."
            value={code}
            onChange={setCode}
          />

          <Text size="xs" c="dimmed">
            The discount is spread across the lines in proportion to what each is worth, so the tax is
            charged only on what the customer actually pays.
          </Text>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={tooBig}>
              Apply
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

/** "Misc — Rs 50." There is no catalogue row behind it, so the cashier types the name and the price. */
function OpenItemModal({
  settings,
  onClose,
  onConfirm
}: {
  settings: SellSettings
  onClose: () => void
  onConfirm: (name: string, unitPrice: number, qtyM: number) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [price, setPrice] = useState(0)
  const [qtyM, setQtyM] = useState(ONE_UNIT)

  const valid = name.trim() !== '' && qtyM > 0

  return (
    <Modal opened onClose={onClose} title="Open item" centered>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) onConfirm(name.trim(), price, qtyM)
        }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Something with no barcode. It moves no stock, because there is nothing on a shelf to take off.
          </Text>

          <TextInput
            label="What is it?"
            placeholder="e.g. Loose sugar"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            autoFocus
          />

          <Group grow>
            <MoneyInput label="Price each" value={price} onChange={setPrice} />
            <QtyInput label="Quantity" value={qtyM} onChange={setQtyM} required />
          </Group>

          <Text size="xs" c="dimmed">
            {settings.taxEnabled
              ? `Tax is charged at the shop's default rate (${(settings.defaultTaxRateBp / 100).toFixed(2)}%, ${settings.defaultTaxMode} of the price).`
              : 'Tax is switched off for this shop.'}
          </Text>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Add
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

function CustomerModal({
  current,
  money,
  onClose,
  onPick
}: {
  current: Customer | null
  money: (minor: number) => string
  onClose: () => void
  onPick: (customer: Customer | null) => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<Customer[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  /** The "+ New customer" flow, layered over this picker. It changes no `modal` state, so the parent's
   *  refocus effect stays put until the whole picker closes — barcode focus is handed back only once. */
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced])

  useEffect(() => {
    let cancelled = false
    setRows(null)

    void (async () => {
      const result = await window.pos.customers.list({
        page,
        pageSize: 8,
        ...(debounced === '' ? {} : { search: debounced })
      })
      if (cancelled) return

      if (!result.ok) {
        setError(result.error.userMessage)
        setRows([])
        return
      }
      setError(null)
      setRows(result.data.rows)
      setTotal(result.data.total)
    })()

    return () => {
      cancelled = true
    }
  }, [debounced, page])

  const pages = Math.max(1, Math.ceil(total / 8))

  return (
    <Modal opened onClose={onClose} title="Who is this sale for?" centered size="lg">
      {/* THE "+ NEW CUSTOMER" FLOW. A wholesale customer who has never been here before can be added
          without leaving the till — the sale was blocked on this before. Selecting the new customer
          closes THIS picker too (onCreated → onPick → setModal(null)), so focus lands back on the
          barcode field and the next scan is not lost. (Trap #19.) */}
      <NewCustomerModal
        opened={creating}
        initialName={search.trim()}
        onClose={() => setCreating(false)}
        onCreated={(next) => {
          setCreating(false)
          onPick(next)
        }}
      />

      <Stack gap="md">
        <Group gap={8} align="flex-end" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="Search by name or phone…"
            leftSection={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            autoFocus
          />
          <Button
            variant="light"
            leftSection={<UserPlus size={16} />}
            onClick={() => setCreating(true)}
          >
            New customer
          </Button>
        </Group>

        {error != null && (
          <Alert color="red" icon={<CircleAlert size={18} />}>
            {error}
          </Alert>
        )}

        <Button
          variant={current == null ? 'filled' : 'default'}
          leftSection={<UserX size={16} />}
          onClick={() => onPick(null)}
        >
          Walk-in customer — no name
        </Button>

        {rows == null ? (
          <Stack gap={8}>
            <Skeleton height={38} />
            <Skeleton height={38} />
            <Skeleton height={38} />
          </Stack>
        ) : rows.length === 0 ? (
          <Stack align="center" gap={8} py="lg">
            <User size={28} opacity={0.4} />
            <Text size="sm" c="dimmed">
              {debounced === '' ? 'No customers yet.' : 'Nobody matches that.'}
            </Text>
            <Text size="xs" c="dimmed" ta="center" maw={340}>
              Add them now so this sale has a name on it. A shop name, phone and type make them easy to
              find next time.
            </Text>
            <Button
              variant="light"
              leftSection={<UserPlus size={16} />}
              onClick={() => setCreating(true)}
            >
              New customer
            </Button>
          </Stack>
        ) : (
          <Stack gap={6}>
            {rows.map((row) => (
              <Button
                key={row.id}
                variant={current?.id === row.id ? 'filled' : 'default'}
                justify="space-between"
                h="auto"
                py={8}
                onClick={() => onPick(row)}
              >
                <Stack gap={0} align="flex-start">
                  <Text size="sm" fw={600}>
                    {row.name}
                  </Text>
                  {row.phone && (
                    <Text size="xs" c="dimmed">
                      {row.phone}
                    </Text>
                  )}
                </Stack>
                {row.creditLimit > 0 && (
                  <Badge size="sm" variant="light">
                    limit {money(row.creditLimit)}
                  </Badge>
                )}
              </Button>
            ))}

            {pages > 1 && (
              <Group justify="center" mt="xs">
                <Pagination value={page} onChange={setPage} total={pages} size="sm" />
              </Group>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}

/**
 * ADD A CUSTOMER FROM THE TILL. A first-time wholesale/business customer used to block the sale — there
 * was no way to name them without leaving the screen. This captures the least a real customer needs (a
 * name, and — for a trade buyer — their shop name, phone and type), then hands the created record
 * straight to `onCreated`, which selects them onto the sale.
 *
 * MAIN is the boundary, not this form. A permission refusal, or a field the service rejects, comes back
 * as a Result error and shows here as a plain sentence with everything the cashier typed still intact —
 * never a stack trace, never a silent failure. Only the four fields the task asks for are here; the
 * credit limit, tax number and notes are set later on the full Customers screen. `creditLimit` is sent
 * as 0 so a till-made customer starts with no udhaar allowance until the owner grants one.
 */
function NewCustomerModal({
  opened,
  initialName,
  onClose,
  onCreated
}: {
  opened: boolean
  initialName: string
  onClose: () => void
  onCreated: (customer: Customer) => void
}): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const [businessName, setBusinessName] = useState('')
  const [phone, setPhone] = useState('')
  const [typeLookupId, setTypeLookupId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A fresh form every time it opens, seeded with whatever they had typed into the search box.
  useEffect(() => {
    if (!opened) return
    setName(initialName)
    setBusinessName('')
    setPhone('')
    setTypeLookupId(null)
    setError(null)
    setBusy(false)
  }, [opened, initialName])

  const valid = name.trim() !== ''

  async function save(): Promise<void> {
    if (!valid || busy) return
    setBusy(true)
    setError(null)

    const result = await window.pos.customers.create({
      name: name.trim(),
      businessName: businessName.trim() === '' ? null : businessName.trim(),
      phone: phone.trim() === '' ? null : phone.trim(),
      typeLookupId,
      creditLimit: 0
    })

    setBusy(false)

    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Customer added',
      message: `${result.data.name} is now on this sale.`
    })
    onCreated(result.data)
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New customer" centered size="md">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Stack gap="md">
          <TextInput
            label="Customer name"
            placeholder="e.g. Muhammad Rashid"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            data-autofocus
            autoFocus
          />

          <TextInput
            label="Shop / business name"
            description="For a wholesale or trade customer — printed on their invoice."
            placeholder="e.g. Rashid Kiryana Store"
            value={businessName}
            onChange={(event) => setBusinessName(event.currentTarget.value)}
          />

          <TextInput
            label="Phone"
            description="What tells two customers with the same name apart."
            placeholder="03xx-xxxxxxx"
            value={phone}
            onChange={(event) => setPhone(event.currentTarget.value)}
          />

          <LookupSelect
            listKey="customer_type"
            label="Type"
            placeholder="Retail, wholesale, staff…"
            value={typeLookupId}
            onChange={setTypeLookupId}
          />

          {error != null && (
            <Alert color="red" icon={<CircleAlert size={18} />}>
              {error}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!valid} leftSection={<UserPlus size={16} />}>
              Add customer
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

/** The hold tray: parked carts, and quotations. Neither has an invoice number. */
function HeldModal({
  money,
  onClose,
  onResume,
  onPrintQuotation
}: {
  money: (minor: number) => string
  onClose: () => void
  onResume: (id: number) => void
  /** Print the offer for the customer. Only a quote row has one — a held cart offered nothing. */
  onPrintQuotation: (id: number) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<'held' | 'quote'>('held')
  const [rows, setRows] = useState<SaleListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    const result = await window.pos.sales.listHeld({ status })
    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      return
    }
    setError(null)
    setRows(result.data)
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  async function discard(id: number): Promise<void> {
    const result = await window.pos.sales.discard({ id })
    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not discard', message: result.error.userMessage })
      return
    }
    void load()
  }

  return (
    <Modal opened onClose={onClose} title="Parked carts" centered size="lg">
      <Stack gap="md">
        <SegmentedControl
          fullWidth
          value={status}
          onChange={(next) => setStatus(next as 'held' | 'quote')}
          data={[
            { value: 'held', label: 'Held' },
            { value: 'quote', label: 'Quotations' }
          ]}
        />

        {error != null && (
          <Alert color="red" icon={<CircleAlert size={18} />}>
            {error}
          </Alert>
        )}

        {rows == null ? (
          <Stack gap={8}>
            <Skeleton height={44} />
            <Skeleton height={44} />
          </Stack>
        ) : rows.length === 0 ? (
          <Stack align="center" gap={4} py="lg">
            <Pause size={28} opacity={0.4} />
            <Text size="sm" c="dimmed">
              {status === 'held' ? 'Nothing is on hold.' : 'No quotations saved.'}
            </Text>
          </Stack>
        ) : (
          <Stack gap={6}>
            {rows.map((row) => (
              <Card withBorder padding="sm" key={row.id}>
                <Group justify="space-between" wrap="nowrap">
                  <Stack gap={0}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600}>
                        {row.customerName ?? 'Walk-in'} — {money(row.grandTotal)}
                      </Text>
                      {/* THE OFFER HAS LAPSED — said plainly, and that is ALL it does. The row still
                          resumes: whether to honour an old price is the shopkeeper's call to make with
                          the customer standing there, not something the till decides for them. */}
                      {row.validUntil != null && isExpiredDay(row.validUntil) && (
                        <Badge size="sm" color="orange" variant="light">
                          Expired
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {new Date(row.at).toLocaleString()}
                      {row.lineCount != null && ` · ${row.lineCount} lines`}
                      {row.cashierName != null && ` · ${row.cashierName}`}
                    </Text>
                    {/* The one thing a held cart has no concept of: how long the price holds. */}
                    {row.validUntil != null && (
                      <Text size="xs" c={isExpiredDay(row.validUntil) ? 'orange' : 'dimmed'}>
                        Valid until {formatDay(row.validUntil)}
                      </Text>
                    )}
                  </Stack>

                  <Group gap={6} wrap="nowrap">
                    <Button size="xs" leftSection={<Play size={14} />} onClick={() => onResume(row.id)}>
                      Resume
                    </Button>
                    {/* "Can I have that quote again?" is the reason a customer sends someone back to the
                        shop, so the offer can be reprinted without resuming the cart to get at it. A
                        held cart has nothing to print: nothing was offered and nothing was paid.
                        Keyed off the TRAY's status, not off validUntil — a pre-0015 quote has no date and
                        main refuses to print it, and that refusal should reach the cashier as the sentence
                        the service wrote ("save it again to give it one"), not as a missing button. */}
                    {status === 'quote' && (
                      <Tooltip label="Print this quotation for the customer">
                        <ActionIcon
                          variant="subtle"
                          aria-label="Print this quotation"
                          onClick={() => void onPrintQuotation(row.id)}
                        >
                          <Printer size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <Tooltip label="Throw this cart away">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Discard this cart"
                        onClick={() => void discard(row.id)}
                      >
                        <Trash2 size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENT — split across methods, and CHANGE DUE in huge type
// ═════════════════════════════════════════════════════════════════════════════

type Tender = {
  key: number
  methodLookupId: number | null
  amount: number
  chequeNo: string
  chequeDate: string
  walletRef: string
}

let tenderKey = 0

function PaymentModal({
  methods,
  settings,
  totals,
  customer,
  outstanding,
  points,
  shortages,
  money,
  onClose,
  onPaid,
  buildPayload
}: {
  methods: Lookup[]
  settings: SellSettings
  totals: CartMath
  customer: Customer | null
  outstanding: number | null
  /** The customer's points, as MAIN reported them. Null = nobody chosen, or the shop runs no scheme. */
  points: LoyaltyBalance | null
  shortages: Shortage[]
  money: (minor: number) => string
  onClose: () => void
  onPaid: (response: CompleteSaleResponse) => void
  buildPayload: () => {
    saleId?: number
    customerId: number | null
    priceTier: PriceTier
    lines: SaleLineInput[]
    cartDiscount: number
    cartDiscountReasonCode: string | null
  }
}): React.JSX.Element {
  const cashMethod = methods.find((m) => m.code === 'cash')

  const [tenders, setTenders] = useState<Tender[]>(() => [
    {
      key: tenderKey++,
      methodLookupId: cashMethod?.id ?? methods[0]?.id ?? null,
      // The common case, in one keystroke: cash, exactly the total.
      amount: totals.grandTotal,
      chequeNo: '',
      chequeDate: '',
      walletRef: ''
    }
  ])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  /**
   * POINTS BEING SPENT ON THIS SALE — a TENDER, not a discount. 0 = none.
   *
   * We send this COUNT and nothing else: MAIN values it, freezes the value onto the movement and
   * tenders it. The rupee figures below are a PREVIEW for the cashier, computed from MAIN's own
   * `points.valueMinor` (the whole balance's worth) so the screen and the till agree — but the sale is
   * settled on MAIN's number, never on this one.
   */
  const [redeemPoints, setRedeemPoints] = useState(0)

  // The supervisor-approval prompt. Non-null when main has said this sale needs approval; it holds
  // the reason to show, and the PIN the supervisor types. The PIN never leaves this component except
  // as the argument to complete() — it is not stored, not logged, not put in the payload state.
  const [approval, setApproval] = useState<{ message: string } | null>(null)
  const [approverPin, setApproverPin] = useState('')

  const byId = useMemo(() => new Map(methods.map((m) => [m.id, m])), [methods])
  const codeOf = (tender: Tender): string | null =>
    tender.methodLookupId == null ? null : (byId.get(tender.methodLookupId)?.code ?? null)

  // ── POINTS AS A TENDER ─────────────────────────────────────────────────────
  //
  // Shown only when the shop runs the scheme, a customer is named, and they have enough to reach the
  // shop's own minimum. Every one of those is re-checked in MAIN — this just keeps a control the
  // cashier cannot use off a busy screen.
  const loyaltyOffered =
    settings.loyaltyEnabled &&
    customer != null &&
    points != null &&
    points.points >= settings.loyaltyMinPointsToRedeem &&
    points.valueMinor > 0

  /** What ONE point is worth, from MAIN's own figures. Never a rate this screen read from settings. */
  const perPoint = points != null && points.points > 0 ? points.valueMinor / points.points : 0

  /** The PREVIEW of what the points being spent are worth. MAIN freezes the real figure. */
  const redeemValue = Math.round(redeemPoints * perPoint)

  // Points buy GOODS — they are never paid out as change (MAIN refuses it too). So the most that can
  // be spent is the smaller of what they have and what the sale is worth, floored to whole points.
  const maxRedeemablePoints = Math.min(
    points?.points ?? 0,
    perPoint > 0 ? Math.floor(totals.grandTotal / perPoint) : 0
  )

  const paidTotal = tenders.reduce((sum, tender) => sum + tender.amount, 0) + redeemValue
  const changeDue = paidTotal - totals.grandTotal

  /**
   * SPEND POINTS, AND TAKE THE REST IN MONEY.
   *
   * The modal opens with one tender pre-filled to the WHOLE total, because that is the common sale. If
   * the points were simply added on top of it, the cashier would take the full amount in cash AND the
   * points — the customer pays twice and the screen shows change that is not due. So applying points
   * moves the SINGLE money tender down to what is actually left to pay.
   *
   * Only when there is exactly one tender: once the cashier has split the payment by hand they have
   * said how the money is made up, and silently rewriting one of their rows is worse than leaving the
   * arithmetic to them — the "Still to pay" line already tells them what is short.
   */
  function applyPoints(next: number): void {
    setRedeemPoints(next)

    if (tenders.length !== 1) return
    const value = Math.round(next * perPoint)
    setTenders((rows) =>
      rows.map((row) => ({ ...row, amount: Math.max(0, totals.grandTotal - value) }))
    )
  }

  // Cash is NET OF THE CHANGE handed back — so change can only ever come out of a cash payment. Main
  // refuses anything else (it would post a negative debit to Cash); say so before it does.
  const cashTendered = tenders
    .filter((tender) => codeOf(tender) === 'cash')
    .reduce((sum, tender) => sum + tender.amount, 0)

  const creditTotal = tenders
    .filter((tender) => codeOf(tender) === 'credit')
    .reduce((sum, tender) => sum + tender.amount, 0)

  const overCreditLimit =
    creditTotal > 0 &&
    customer != null &&
    settings.creditLimit !== 'ignore' &&
    (outstanding ?? 0) + creditTotal > customer.creditLimit

  // POINTS CAN PAY FOR THE WHOLE SALE, and then there is no money to take: the one tender sits at zero
  // and is dropped before it is sent (main requires every payment to be an actual amount). Only then —
  // a zero row with nothing else covering the sale is still a mistake to point out.
  const moneyTenders = tenders.filter((tender) => tender.amount > 0)
  const pointsCoverAll = redeemValue >= totals.grandTotal && moneyTenders.length === 0

  const problems: string[] = []
  if (tenders.some((tender) => tender.methodLookupId == null)) problems.push('Choose how they are paying.')
  if (!pointsCoverAll && tenders.some((tender) => tender.amount <= 0)) {
    problems.push('Every payment needs an amount.')
  }
  if (changeDue < 0) problems.push(`Still ${money(-changeDue)} to pay.`)
  if (redeemPoints > 0 && redeemPoints < settings.loyaltyMinPointsToRedeem) {
    problems.push(`Points can only be used ${settings.loyaltyMinPointsToRedeem} at a time or more.`)
  }
  if (redeemPoints > (points?.points ?? 0)) problems.push('They do not have that many points.')
  // Points buy goods; the shop never hands them back as cash. MAIN refuses this outright.
  if (redeemValue > totals.grandTotal) problems.push('Those points are worth more than this sale.')
  if (changeDue > cashTendered) problems.push('Change can only be given out of a cash payment.')
  if (creditTotal > 0 && customer == null && settings.requireCustomerForCredit) {
    problems.push('A credit (udhaar) sale must name a customer. Close this and press F9.')
  }
  for (const tender of tenders) {
    if (codeOf(tender) !== 'cheque') continue
    if (tender.chequeNo.trim() === '' || tender.chequeDate.trim() === '') {
      problems.push('A cheque needs its number and its date.')
      break
    }
  }

  const blocked = problems.length > 0

  /** The two things main will WARN about and let the cashier decide. Ask BEFORE the customer is waiting. */
  const needsNegativeConfirm =
    shortages.length > 0 && settings.negativeStock === 'warn' && !accepted
  const needsCreditConfirm = overCreditLimit && settings.creditLimit === 'warn' && !accepted

  async function pay(force = false, approverPin?: string): Promise<void> {
    setBusy(true)
    setError(null)

    const result = await window.pos.sales.complete({
      ...buildPayload(),
      // Only the money that is ACTUALLY changing hands. A zero row is not a payment — it is what is
      // left when points have covered the whole sale, and main rightly refuses one.
      payments: moneyTenders.map((tender) => ({
        methodLookupId: tender.methodLookupId!,
        amount: tender.amount,
        chequeNo: tender.chequeNo.trim() === '' ? null : tender.chequeNo.trim(),
        chequeDate: tender.chequeDate.trim() === '' ? null : tender.chequeDate.trim(),
        walletRef: tender.walletRef.trim() === '' ? null : tender.walletRef.trim()
      })),
      // The supervisor's PIN — present only when one has come over to approve an over-threshold
      // discount, a price override or a wholesale tier. MAIN verifies it and derives WHO approved
      // from it. We never send a user id: a claimed id is not proof anyone was here. (CLAUDE.md §4)
      approverPin: approverPin ?? null,
      // The cashier has SEEN the warning and chosen to go ahead. Main flags and audits the sale either
      // way — and refuses outright if the shop's policy is 'block', whatever we send.
      acceptNegativeStock: accepted || force,
      acceptOverCreditLimit: accepted || force,
      // THE POINTS BEING SPENT — a COUNT, never a rupee figure. MAIN values them, freezes that value,
      // and tenders it. Null when none are being used, so a sale that redeems nothing writes nothing.
      redeemPoints: redeemPoints > 0 ? redeemPoints : null
    })

    setBusy(false)

    if (!result.ok) {
      // The sale is allowed, but a supervisor has to approve it. Ask for the PIN and retry — don't
      // just refuse. Without this branch the over-threshold discount could never be completed at all.
      if (result.error.code === 'NEEDS_APPROVAL') {
        setApproval({ message: result.error.userMessage })
        return
      }
      setError(result.error.userMessage)
      return
    }

    onPaid(result.data)
  }

  function submit(): void {
    if (blocked || busy) return
    if (needsNegativeConfirm || needsCreditConfirm) {
      setAccepted(true) // show the confirmation panel; the next press goes through
      return
    }
    void pay()
  }

  const confirming = accepted && (shortages.length > 0 || overCreditLimit)

  return (
    <Modal opened onClose={onClose} title="Payment" centered size="lg">
      {/* ── SUPERVISOR APPROVAL ──────────────────────────────────────────────
          Main refused the sale as NEEDS_APPROVAL — an over-threshold discount, a price override, a
          wholesale tier. A supervisor comes over and enters THEIR PIN. Main verifies it and records
          who approved. We send the PIN, never a user id: a claimed id is not proof anyone was here. */}
      <Modal
        opened={approval != null}
        onClose={() => {
          setApproval(null)
          setApproverPin('')
        }}
        title="Supervisor approval needed"
        centered
        size="sm"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const pin = approverPin
            setApproval(null)
            setApproverPin('')
            void pay(true, pin)
          }}
        >
          <Stack gap="md">
            <Text size="sm">{approval?.message}</Text>
            <PasswordInput
              label="Supervisor PIN"
              description="A supervisor must enter their own PIN to approve this."
              value={approverPin}
              onChange={(event) => setApproverPin(event.currentTarget.value)}
              data-autofocus
              autoFocus
            />
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => {
                  setApproval(null)
                  setApproverPin('')
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={approverPin.trim().length < 4}>
                Approve
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Stack gap="md">
          {/* ── CHANGE DUE, in huge type. It is the only number the cashier needs. ── */}
          <Card withBorder padding="md" bg={changeDue >= 0 ? undefined : 'var(--mantine-color-red-light)'}>
            <Group justify="space-between" align="center">
              <Stack gap={0}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Total
                </Text>
                <Text fw={700} size="xl">
                  {money(totals.grandTotal)}
                </Text>
              </Stack>

              <Stack gap={0} align="flex-end">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  {changeDue >= 0 ? 'Change due' : 'Still to pay'}
                </Text>
                <Text
                  fw={800}
                  c={changeDue > 0 ? 'teal' : changeDue < 0 ? 'red' : undefined}
                  style={{ fontSize: 44, lineHeight: 1.1 }}
                >
                  {money(Math.abs(changeDue))}
                </Text>
              </Stack>
            </Group>
          </Card>

          {/* ── POINTS: A TENDER, NOT A DISCOUNT ──────────────────────────────
              The points PAY for the goods, exactly as the cash below does — the sale's revenue and
              its tax are untouched. Hidden entirely unless the shop runs the scheme and this customer
              has enough to reach the minimum. We send a POINT COUNT; every figure here is a preview
              built from MAIN's own valuation, and MAIN freezes the real one. */}
          {loyaltyOffered && (
            <Card withBorder padding="sm" bg="var(--mantine-color-violet-light)">
              <Stack gap={8}>
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={8} wrap="nowrap">
                    <Award size={18} color="var(--mantine-color-violet-text)" />
                    <Text size="sm" fw={600}>
                      {customer.name} has {points.points.toLocaleString('en-US')} points
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    worth {money(points.valueMinor)}
                  </Text>
                </Group>

                <Group gap={8} align="flex-end" wrap="nowrap">
                  <TextInput
                    style={{ flex: 1 }}
                    label="Points to use"
                    description={
                      redeemPoints > 0
                        ? `Pays ${money(redeemValue)} of this sale`
                        : `${settings.loyaltyMinPointsToRedeem} or more at a time`
                    }
                    inputMode="numeric"
                    value={redeemPoints === 0 ? '' : String(redeemPoints)}
                    placeholder="0"
                    onChange={(event) => {
                      // Whole points only — they are a COUNT of promises, not money and not a
                      // quantity, so there is nothing to scale and nothing after a decimal point.
                      const digits = event.currentTarget.value.replace(/[^\d]/g, '')
                      applyPoints(digits === '' ? 0 : Number(digits))
                    }}
                  />
                  <Button
                    variant="light"
                    color="violet"
                    disabled={maxRedeemablePoints < settings.loyaltyMinPointsToRedeem}
                    onClick={() => applyPoints(maxRedeemablePoints)}
                  >
                    Use max
                  </Button>
                  {redeemPoints > 0 && (
                    <Button variant="subtle" color="gray" onClick={() => applyPoints(0)}>
                      Clear
                    </Button>
                  )}
                </Group>
              </Stack>
            </Card>
          )}

          {/* ── The tenders. A split payment is several rows. ─────────────────── */}
          <Stack gap={8}>
            {tenders.map((tender, index) => {
              const code = codeOf(tender)
              return (
                <Card withBorder padding="sm" key={tender.key}>
                  <Stack gap={8}>
                    <Group gap={8} align="flex-end" wrap="nowrap">
                      <Select
                        style={{ flex: 1 }}
                        label={index === 0 ? 'How are they paying?' : undefined}
                        data={methods.map((method) => ({
                          value: String(method.id),
                          label: method.label
                        }))}
                        value={tender.methodLookupId == null ? null : String(tender.methodLookupId)}
                        onChange={(next) =>
                          setTenders((rows) =>
                            rows.map((row) =>
                              row.key === tender.key
                                ? { ...row, methodLookupId: next == null ? null : Number(next) }
                                : row
                            )
                          )
                        }
                        allowDeselect={false}
                      />

                      <div style={{ width: 160 }}>
                        <MoneyInput
                          label={index === 0 ? 'Amount' : undefined}
                          value={tender.amount}
                          onChange={(next) =>
                            setTenders((rows) =>
                              rows.map((row) =>
                                row.key === tender.key ? { ...row, amount: next } : row
                              )
                            )
                          }
                          autoFocus={index === 0}
                        />
                      </div>

                      {tenders.length > 1 && (
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size={36}
                          aria-label="Remove this payment"
                          onClick={() =>
                            setTenders((rows) => rows.filter((row) => row.key !== tender.key))
                          }
                        >
                          <X size={16} />
                        </ActionIcon>
                      )}
                    </Group>

                    {/* A POST-DATED CHEQUE: the money is not in the bank yet. */}
                    {code === 'cheque' && (
                      <Group gap={8} grow>
                        <TextInput
                          label="Cheque number"
                          value={tender.chequeNo}
                          onChange={(event) =>
                            setTenders((rows) =>
                              rows.map((row) =>
                                row.key === tender.key
                                  ? { ...row, chequeNo: event.currentTarget.value }
                                  : row
                              )
                            )
                          }
                          required
                        />
                        <TextInput
                          label="Cheque date"
                          type="date"
                          value={tender.chequeDate}
                          onChange={(event) =>
                            setTenders((rows) =>
                              rows.map((row) =>
                                row.key === tender.key
                                  ? { ...row, chequeDate: event.currentTarget.value }
                                  : row
                              )
                            )
                          }
                          required
                        />
                      </Group>
                    )}

                    {(code === 'jazzcash' || code === 'easypaisa') && (
                      <TextInput
                        label="Transaction reference"
                        value={tender.walletRef}
                        onChange={(event) =>
                          setTenders((rows) =>
                            rows.map((row) =>
                              row.key === tender.key
                                ? { ...row, walletRef: event.currentTarget.value }
                                : row
                            )
                          )
                        }
                      />
                    )}

                    {code === 'credit' && (
                      <Alert color={overCreditLimit ? 'orange' : 'blue'} p="xs" icon={<CreditCard size={16} />}>
                        <Text size="xs">
                          {customer == null ? (
                            'Udhaar — this is money the shop has not been paid. Press F9 to say who owes it.'
                          ) : (
                            <>
                              <strong>{customer.name}</strong> already owes {money(outstanding ?? 0)}
                              {customer.creditLimit > 0 && <> of a {money(customer.creditLimit)} limit</>}.
                              {overCreditLimit && ' This takes them over it.'}
                            </>
                          )}
                        </Text>
                      </Alert>
                    )}
                  </Stack>
                </Card>
              )
            })}

            <Group gap={8}>
              <Button
                variant="default"
                size="xs"
                onClick={() =>
                  setTenders((rows) => [
                    ...rows,
                    {
                      key: tenderKey++,
                      methodLookupId: methods[0]?.id ?? null,
                      // Whatever is still owed — the point of a split payment.
                      amount: Math.max(0, totals.grandTotal - paidTotal),
                      chequeNo: '',
                      chequeDate: '',
                      walletRef: ''
                    }
                  ])
                }
              >
                Split across another method
              </Button>

              {cashMethod != null && (
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() =>
                    setTenders([
                      {
                        key: tenderKey++,
                        methodLookupId: cashMethod.id,
                        amount: totals.grandTotal,
                        chequeNo: '',
                        chequeDate: '',
                        walletRef: ''
                      }
                    ])
                  }
                >
                  Exact cash
                </Button>
              )}
            </Group>
          </Stack>

          {/* ── The two things main WARNS about. The cashier decides, on the record. ── */}
          {confirming && shortages.length > 0 && (
            <Alert color="orange" icon={<TriangleAlert size={18} />} title="Confirm: not enough stock">
              <Stack gap={2}>
                {shortages.map((s) => (
                  <Text size="sm" key={s.productId}>
                    <strong>{s.name}</strong> — {formatQty(s.onHandM)} in stock, selling{' '}
                    {formatQty(s.wantedM)}
                  </Text>
                ))}
              </Stack>
              <Text size="sm" mt={6}>
                The sale will go through and will be <strong>flagged for the owner</strong>. Press Pay
                again to continue.
              </Text>
            </Alert>
          )}

          {confirming && overCreditLimit && customer != null && (
            <Alert color="orange" icon={<TriangleAlert size={18} />} title="Confirm: over their credit limit">
              <Text size="sm">
                {customer.name} already owes {money(outstanding ?? 0)}, and this takes them over their
                limit of {money(customer.creditLimit)}. Press Pay again to give them the credit anyway.
              </Text>
            </Alert>
          )}

          {error != null && (
            <Alert color="red" icon={<CircleAlert size={18} />} title="The sale did not go through">
              <Text size="sm">{error}</Text>
              <Text size="xs" c="dimmed" mt={4}>
                Nothing has been recorded. The cart is exactly as it was.
              </Text>
              {settings.negativeStock === 'warn' && !accepted && (
                <Button
                  size="xs"
                  color="orange"
                  mt="sm"
                  leftSection={<TriangleAlert size={14} />}
                  onClick={() => {
                    setAccepted(true)
                    void pay(true)
                  }}
                >
                  Sell anyway — it will be flagged
                </Button>
              )}
            </Alert>
          )}

          {blocked && (
            <Stack gap={2}>
              {problems.map((problem) => (
                <Group gap={6} key={problem} wrap="nowrap">
                  <Ban size={13} color="var(--mantine-color-dimmed)" />
                  <Text size="xs" c="dimmed">
                    {problem}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="md"
              loading={busy}
              disabled={blocked}
              color={confirming ? 'orange' : undefined}
              leftSection={<Banknote size={18} />}
            >
              {confirming ? 'Pay anyway' : 'Pay'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}
