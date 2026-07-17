import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
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
  BadgePercent,
  CircleAlert,
  CircleCheck,
  Pencil,
  Plus,
  PowerOff,
  Save,
  Search,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type {
  Promotion,
  PromotionDetail,
  PromotionKind,
  PromotionRule,
  PromotionRuleInput,
  PromotionRuleScope
} from '@shared/promotions'
import { DAYS_MASK_LABELS, PROMOTION_KINDS, PROMOTION_RULE_SCOPES } from '@shared/promotions'
import { formatMoney } from '@shared/money'
import { Paginator } from '../../components/Paginator'
import { LookupSelect, MoneyInput, QtyInput } from './ProductForm'

/**
 * OFFERS (promotions) — the shop's own standing discounts: "buy 2 get 1 free", "10% off Sunday",
 * "Rs 50 off tea". They fire automatically at the till so the cashier never has to remember one.
 *
 * THE RENDERER NEVER COMPUTES A DISCOUNT. This screen writes down the shop's INTENT — what kind of
 * offer, its knobs, when it runs, and what it applies to. The engine in MAIN resolves every offer
 * against the catalog and works out the money itself (shared/promotions.ts). A renderer that could
 * name its own promotion discount could sell at any price it liked, so it does not get to.
 *
 * THE KNOBS FOLLOW THE KIND, AND THAT IS ENFORCED IN TWO PLACES. Zod REFUSES a knob that does not
 * belong to the kind — `{kind:'percent_off', percentBp:1000, amountMinor:5000}` has two readings and
 * whichever the engine picked, the owner set the other one. So the form shows ONLY the kind's own
 * knobs (`KIND_FIELDS`) and CLEARS the rest when the kind changes. Showing a percentage box on a
 * buy-x-get-y is how a half-described offer reaches the till.
 *
 * AN OFFER IS SWITCHED OFF, NEVER DELETED. Last March's sales must still explain themselves, and a
 * sale line carries a FROZEN copy of the offer's name and the money it gave away — so switching one
 * off, or renaming it, never rewrites what an old receipt says it cost (migration 0018).
 *
 * The writes are `promotion.manage` (manager) + writable in MAIN. Read-only (an expired licence) can
 * still READ every offer — they just cannot change one. Disabling a button is a courtesy; MAIN is the
 * boundary (CLAUDE.md §4).
 */

const PAGE_SIZE = 25

/** An empty box means "cleared" for a nullable column — `.nullish()` is what the schema expects. */
function orNull(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

// ── The kinds, in the owner's language ────────────────────────────────────────
// `kind` is a closed list, NOT a lookup, and deliberately so: the engine branches on it, so adding a
// kind means writing the arithmetic that computes it (shared/promotions.ts). It is the one select on
// this screen that is not lookups-driven, and that is the reason — this is arithmetic, not shop data.

const KIND_LABEL: Record<PromotionKind, string> = {
  percent_off: 'Percentage off',
  amount_off: 'Amount off each unit',
  buy_x_get_y: 'Buy some, get some free',
  fixed_price: 'Fixed price'
}

const KIND_HELP: Record<PromotionKind, string> = {
  percent_off: 'Takes a percentage off whatever the matching items come to.',
  amount_off: 'Takes a fixed amount off every single unit sold.',
  buy_x_get_y: 'For every so many bought, so many come free — the cheapest ones are the free ones.',
  fixed_price: 'The matching item sells at this price instead of its own shelf price.'
}

/**
 * WHICH BOXES EACH KIND SHOWS — the renderer's half of the pairing zod enforces (KIND_KNOBS in
 * shared/promotions.ts). These two lists must agree: a box shown here whose knob zod does not accept
 * produces a save the owner cannot explain, and a knob zod requires with no box is an offer that can
 * never be saved at all.
 */
const KIND_FIELDS: Record<PromotionKind, ReadonlyArray<'percentBp' | 'amountMinor' | 'buyGet'>> = {
  percent_off: ['percentBp'],
  amount_off: ['amountMinor'],
  buy_x_get_y: ['buyGet'],
  fixed_price: ['amountMinor']
}

const SCOPE_LABEL: Record<PromotionRuleScope, string> = {
  product: 'One item',
  category: 'A category',
  brand: 'A brand',
  department: 'A department',
  all: 'Everything in the shop'
}

/** The group scopes map onto a lookup list each; 'product' and 'all' do not. */
const SCOPE_LOOKUP_KEY: Partial<Record<PromotionRuleScope, string>> = {
  category: 'category',
  brand: 'brand',
  department: 'department'
}

/** Basis points to a human percent: 1000 -> "10%", 1250 -> "12.5%". Display only. */
function formatPercentBp(bp: number): string {
  return `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

/** 3-dp thousandths to a human quantity: 1000 -> "1", 1500 -> "1.5". Display only. */
function formatQtyM(qtyM: number): string {
  return (qtyM / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })
}

/**
 * THE KNOB VALUES, in one phrase, for the list. Reads the knob the KIND owns — never a knob the kind
 * does not use, which for a well-formed row is null anyway.
 */
function describeKnobs(row: Promotion, currencySymbol: string): string {
  switch (row.kind) {
    case 'percent_off':
      return row.percentBp == null ? '—' : `${formatPercentBp(row.percentBp)} off`
    case 'amount_off':
      return row.amountMinor == null
        ? '—'
        : `${formatMoney(row.amountMinor, { symbol: currencySymbol })} off each`
    case 'fixed_price':
      return row.amountMinor == null
        ? '—'
        : `${formatMoney(row.amountMinor, { symbol: currencySymbol })} each`
    case 'buy_x_get_y':
      return row.buyQtyM == null || row.getQtyM == null
        ? '—'
        : `Buy ${formatQtyM(row.buyQtyM)}, get ${formatQtyM(row.getQtyM)} free`
  }
}

/** The date window in one phrase. NULL start = since forever; NULL end = until further notice. */
function describeWindow(row: Promotion): string {
  if (row.startsOn == null && row.endsOn == null) return 'Always'
  if (row.startsOn != null && row.endsOn == null) return `From ${row.startsOn}`
  if (row.startsOn == null && row.endsOn != null) return `Until ${row.endsOn}`
  return `${row.startsOn} to ${row.endsOn}`
}

/**
 * The weekday mask, short. NULL = every day. The mask is MONDAY-FIRST and `DAYS_MASK_LABELS` is the
 * one mapping (shared/promotions.ts) — index it, never `getDay()`, or a weekend offer reads as
 * Thursday/Friday.
 */
function describeDays(daysMask: string | null): string {
  if (daysMask == null) return 'Every day'
  const days = DAYS_MASK_LABELS.filter((_, index) => daysMask[index] === '1')
  if (days.length === DAYS_MASK_LABELS.length) return 'Every day'
  return days.map((day) => day.slice(0, 3)).join(', ')
}

/** Every-day is stored as NULL, not '1111111' — the same offer should not have two spellings. */
const EVERY_DAY_MASK = '1111111'

type ActiveFilter = 'all' | 'active' | 'inactive'

export function Promotions({
  readOnly,
  currencySymbol
}: {
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [rows, setRows] = useState<Promotion[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all')
  const [search, setSearch] = useState('')

  /** null = the modal is closed; a row = editing it; 'new' = creating one. */
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null)
  const [deactivating, setDeactivating] = useState<Promotion | null>(null)
  const [editingRules, setEditingRules] = useState<Promotion | null>(null)

  /**
   * WHAT EACH OFFER APPLIES TO, for the list — an offer with NO rules applies to NOTHING, and the
   * owner who thinks they created a live offer and did not is THE failure mode this screen exists to
   * prevent (migration 0018). The list endpoint returns the offers without their rules, so we fetch
   * each page's rules alongside and warn on the rows that have none.
   */
  const [ruleCounts, setRuleCounts] = useState<Record<number, number>>({})

  // A changed filter puts us back on page 1 — page 5 of a different result set is nonsense. (The pager
  // resets the page itself when the rows-per-page changes, so that is deliberately not here.)
  useEffect(() => {
    setPage(1)
  }, [activeFilter, search])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.promotions.list({
      page,
      pageSize,
      isActive: activeFilter === 'all' ? undefined : activeFilter === 'active',
      search: search.trim() === '' ? undefined : search.trim()
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    // The order is the engine's own (priority, then id) — it is the order the offers would actually
    // fire in, so the screen never re-sorts it.
    setRows(result.data.rows)
    setTotal(result.data.total)

    // Ask what each offer on THIS page applies to. A failed rules call is not worth an error box over
    // the whole list — the row simply shows no "applies to nothing" warning rather than a false one.
    const counts: Record<number, number> = {}
    await Promise.all(
      result.data.rows.map(async (row) => {
        const rules = await window.pos.promotions.rules({ promotionId: row.id })
        if (rules.ok) counts[row.id] = rules.data.length
      })
    )
    setRuleCounts(counts)
  }, [page, pageSize, activeFilter, search])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Offers</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Your shop’s own discounts, applied automatically at the till — so the cashier never has to
            remember one. An offer is switched off, never deleted: old sales must still explain
            themselves.
          </Text>
        </div>

        <Tooltip label="Your licence has expired — offers cannot be changed" disabled={!readOnly}>
          <Button leftSection={<Plus size={16} />} disabled={readOnly} onClick={() => setEditing('new')}>
            New offer
          </Button>
        </Tooltip>
      </Group>

      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <div>
            <Text size="sm" fw={500} mb={6}>
              Show
            </Text>
            <SegmentedControl
              value={activeFilter}
              onChange={(value) => setActiveFilter(value as ActiveFilter)}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Running', value: 'active' },
                { label: 'Switched off', value: 'inactive' }
              ]}
            />
          </div>

          <TextInput
            label="Search"
            placeholder="Offer name"
            leftSection={<Search size={15} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            style={{ minWidth: 260 }}
          />
        </Group>
      </Card>

      {/* ── Error ────────────────────────────────────────────────────────────── */}
      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The offers could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      {/* ── List ─────────────────────────────────────────────────────────────── */}
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
            <BadgePercent size={32} opacity={0.5} />
            <Text fw={600}>No offers yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={460}>
              Create an offer and it runs at the till by itself — “10% off Sunday”, “buy 2 get 1
              free”, “Rs 50 off tea”. Remember to say what it applies to, or it applies to nothing.
            </Text>
            {!readOnly && (
              <Button mt="sm" leftSection={<Plus size={16} />} onClick={() => setEditing('new')}>
                New offer
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={980}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Offer</Table.Th>
                    <Table.Th>Kind</Table.Th>
                    <Table.Th>What it does</Table.Th>
                    <Table.Th>When</Table.Th>
                    <Table.Th>Days</Table.Th>
                    <Table.Th ta="right">Priority</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => {
                    // An offer with no rules fires on nothing. Say so, loudly, on the row itself.
                    // `undefined` means the rules call for this row has not answered (or failed) —
                    // which is NOT the same as "no rules", so it must not raise the warning.
                    const ruleCount = ruleCounts[row.id]
                    const appliesToNothing = ruleCount === 0

                    return (
                      <Table.Tr key={row.id}>
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {row.name}
                          </Text>
                          {row.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {row.description}
                            </Text>
                          )}
                          {appliesToNothing && (
                            <Group gap={4} wrap="nowrap" mt={4}>
                              <TriangleAlert size={13} color="var(--mantine-color-orange-text)" />
                              <Text size="xs" c="var(--mantine-color-orange-text)" fw={500}>
                                Applies to nothing yet
                              </Text>
                            </Group>
                          )}
                        </Table.Td>

                        <Table.Td>
                          <Badge size="sm" variant="light" color="gray">
                            {KIND_LABEL[row.kind]}
                          </Badge>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm">{describeKnobs(row, currencySymbol)}</Text>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm">{describeWindow(row)}</Text>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm">{describeDays(row.daysMask)}</Text>
                        </Table.Td>

                        <Table.Td ta="right">
                          <Text size="sm">{row.priority}</Text>
                        </Table.Td>

                        <Table.Td>
                          {row.isActive ? (
                            <Badge size="sm" color="teal" variant="light">
                              Running
                            </Badge>
                          ) : (
                            <Badge size="sm" color="gray" variant="light">
                              Switched off
                            </Badge>
                          )}
                        </Table.Td>

                        <Table.Td>
                          <Group gap={6} wrap="nowrap" justify="flex-end">
                            <Button
                              size="compact-sm"
                              variant="light"
                              onClick={() => setEditingRules(row)}
                            >
                              Applies to
                              {ruleCount !== undefined && ruleCount > 0 ? ` (${ruleCount})` : ''}
                            </Button>

                            <Tooltip
                              label="Your licence has expired — offers cannot be changed"
                              disabled={!readOnly}
                            >
                              <Button
                                size="compact-sm"
                                variant="default"
                                leftSection={<Pencil size={13} />}
                                disabled={readOnly}
                                onClick={() => setEditing(row)}
                              >
                                Edit
                              </Button>
                            </Tooltip>

                            {row.isActive && (
                              <Tooltip
                                label="Your licence has expired — offers cannot be changed"
                                disabled={!readOnly}
                              >
                                <Button
                                  size="compact-sm"
                                  variant="default"
                                  color="red"
                                  leftSection={<PowerOff size={13} />}
                                  disabled={readOnly}
                                  onClick={() => setDeactivating(row)}
                                >
                                  Switch off
                                </Button>
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
              unit="offer"
            />
          </>
        )}
      </Card>

      <OfferModal
        target={editing}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        onClose={() => setEditing(null)}
        onSaved={(detail, wasNew) => {
          setEditing(null)
          void load()
          // A new offer applies to NOTHING until its rules are set. Walk the owner straight there
          // rather than leaving them believing the offer is live — that is the expensive mistake.
          if (wasNew) setEditingRules(detail)
        }}
      />

      <RulesModal
        promotion={editingRules}
        readOnly={readOnly}
        onClose={() => setEditingRules(null)}
        onSaved={() => {
          setEditingRules(null)
          void load()
        }}
      />

      <DeactivateModal
        promotion={deactivating}
        onClose={() => setDeactivating(null)}
        onDone={() => {
          setDeactivating(null)
          void load()
        }}
      />
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The offer form — create and edit
// ═════════════════════════════════════════════════════════════════════════════

function OfferModal({
  target,
  readOnly,
  currencySymbol,
  onClose,
  onSaved
}: {
  target: Promotion | 'new' | null
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  onSaved: (detail: PromotionDetail, wasNew: boolean) => void
}): React.JSX.Element {
  const opened = target !== null
  const isNew = target === 'new'
  const existing = target !== null && target !== 'new' ? target : null

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<PromotionKind>('percent_off')

  // The knobs. Each is the INTEGER the contract wants — basis points, 2-dp minor units, 3-dp
  // thousandths. There is never a float here (CLAUDE.md §4).
  const [percentBp, setPercentBp] = useState(0)
  const [amountMinor, setAmountMinor] = useState(0)
  const [buyQtyM, setBuyQtyM] = useState(0)
  const [getQtyM, setGetQtyM] = useState(0)

  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [everyDay, setEveryDay] = useState(true)
  const [days, setDays] = useState<boolean[]>(() => DAYS_MASK_LABELS.map(() => true))
  const [priority, setPriority] = useState(100)

  const [saving, setSaving] = useState(false)

  // A fresh box every time it opens — a stale knob from the last offer is a wrong offer waiting to
  // happen. Editing loads the row we were handed; creating starts clean.
  useEffect(() => {
    if (!opened) return
    setName(existing?.name ?? '')
    setDescription(existing?.description ?? '')
    setKind(existing?.kind ?? 'percent_off')
    setPercentBp(existing?.percentBp ?? 0)
    setAmountMinor(existing?.amountMinor ?? 0)
    setBuyQtyM(existing?.buyQtyM ?? 0)
    setGetQtyM(existing?.getQtyM ?? 0)
    setStartsOn(existing?.startsOn ?? '')
    setEndsOn(existing?.endsOn ?? '')
    setEveryDay(existing?.daysMask == null)
    setDays(
      existing?.daysMask == null
        ? DAYS_MASK_LABELS.map(() => true)
        : DAYS_MASK_LABELS.map((_, index) => existing.daysMask?.[index] === '1')
    )
    setPriority(existing?.priority ?? 100)
    setSaving(false)
  }, [opened, existing])

  /**
   * CHANGING THE KIND CLEARS THE KNOBS THE NEW KIND DOES NOT USE. Zod REFUSES a knob that does not
   * belong to the kind, so a leftover amount from "Rs 50 off" would make the switch to "10% off" fail
   * to save with a message about a box that is no longer even on screen. Clearing it here means the
   * form can only ever describe one offer.
   */
  function changeKind(next: PromotionKind): void {
    setKind(next)
    const fields = KIND_FIELDS[next]
    if (!fields.includes('percentBp')) setPercentBp(0)
    if (!fields.includes('amountMinor')) setAmountMinor(0)
    if (!fields.includes('buyGet')) {
      setBuyQtyM(0)
      setGetQtyM(0)
    }
  }

  const fields = KIND_FIELDS[kind]
  const datesBackwards = startsOn !== '' && endsOn !== '' && endsOn < startsOn
  const noDayPicked = !everyDay && !days.some(Boolean)

  // Mirrors what zod will check, so the button is honest about what will save. MAIN validates it all
  // again regardless — this is a courtesy, not the boundary.
  const knobsFilled =
    (!fields.includes('percentBp') || percentBp > 0) &&
    (!fields.includes('amountMinor') || amountMinor > 0) &&
    (!fields.includes('buyGet') || (buyQtyM > 0 && getQtyM > 0))

  const canSave = name.trim() !== '' && knobsFilled && !datesBackwards && !noDayPicked

  async function save(): Promise<void> {
    if (readOnly || !canSave) return
    setSaving(true)

    // Send ONLY the knobs this KIND owns. A knob the kind does not use is OMITTED, never sent as 0 —
    // zod refuses a stray knob outright, and that refusal is the whole point of the pairing.
    const knobs = {
      percentBp: fields.includes('percentBp') ? percentBp : undefined,
      amountMinor: fields.includes('amountMinor') ? amountMinor : undefined,
      buyQtyM: fields.includes('buyGet') ? buyQtyM : undefined,
      getQtyM: fields.includes('buyGet') ? getQtyM : undefined
    }

    // Every-day is sent as "no mask at all" rather than '1111111' — one meaning, one spelling.
    const daysMask = everyDay ? undefined : days.map((on) => (on ? '1' : '0')).join('')

    const common = {
      name: name.trim(),
      description: orNull(description),
      kind,
      ...knobs,
      startsOn: startsOn === '' ? undefined : startsOn,
      endsOn: endsOn === '' ? undefined : endsOn,
      daysMask,
      priority
    }

    // `isActive` is never sent: switching an offer on or off is `deactivate`, which is audited. An
    // edit must never quietly bring a switched-off offer back to life (trap #18).
    const result = existing
      ? await window.pos.promotions.update({ id: existing.id, ...common })
      : await window.pos.promotions.create(common)

    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: existing ? 'Could not save this offer' : 'Could not create this offer',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: existing ? 'Offer saved' : 'Offer created',
      message: existing
        ? result.data.name
        : `${result.data.name} — now say what it applies to, or it applies to nothing.`
    })
    onSaved(result.data, isNew)
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={existing ? 'Edit offer' : 'New offer'}
      centered
      size="lg"
    >
      <Stack>
        <TextInput
          label="Name"
          description="What the cashier and the customer see on the receipt."
          placeholder="Sunday special"
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          disabled={readOnly}
        />

        <Textarea
          label="Description"
          description="A note to yourself about this offer. Optional."
          autosize
          minRows={2}
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
          disabled={readOnly}
        />

        <Select
          label="What kind of offer"
          description={KIND_HELP[kind]}
          required
          allowDeselect={false}
          data={PROMOTION_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }))}
          value={kind}
          onChange={(value) => value && changeKind(value as PromotionKind)}
          disabled={readOnly}
        />

        {/* ── The knobs. ONLY the ones this kind uses are ever on screen. ────── */}
        {fields.includes('percentBp') && (
          <NumberInput
            label="Percentage off"
            description="How much comes off — 10 means 10%."
            required
            min={0}
            max={100}
            step={1}
            decimalScale={2}
            suffix="%"
            // The canonical value is BASIS POINTS: 10% = 1000. The box shows a human percent and we
            // convert at this boundary — `Math.round` because a typed 12.5 must land on 1250 exactly
            // and never on 1249.9999 (CLAUDE.md §4: no float ever reaches the contract).
            value={percentBp === 0 ? '' : percentBp / 100}
            onChange={(value) => {
              const percent = typeof value === 'number' ? value : Number(value)
              setPercentBp(Number.isFinite(percent) ? Math.round(percent * 100) : 0)
            }}
            disabled={readOnly}
          />
        )}

        {fields.includes('amountMinor') && (
          <MoneyInput
            label={kind === 'fixed_price' ? 'Sells at' : 'Amount off each unit'}
            description={
              kind === 'fixed_price'
                ? 'The matching item sells at this price instead of its own.'
                : 'Comes off every single unit sold.'
            }
            required
            leftSection={<Text size="sm">{currencySymbol}</Text>}
            value={amountMinor}
            onChange={setAmountMinor}
            disabled={readOnly}
          />
        )}

        {fields.includes('buyGet') && (
          <Group grow align="flex-start">
            <QtyInput
              label="Buy this many"
              description="How many must be bought."
              required
              value={buyQtyM}
              onChange={setBuyQtyM}
              disabled={readOnly}
            />
            <QtyInput
              label="Get this many free"
              description="How many come free — the cheapest ones."
              required
              value={getQtyM}
              onChange={setGetQtyM}
              disabled={readOnly}
            />
          </Group>
        )}

        {/* ── When it runs ──────────────────────────────────────────────────── */}
        <Group grow align="flex-start">
          <TextInput
            label="Starts on"
            description="Leave empty to start straight away."
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.currentTarget.value)}
            disabled={readOnly}
          />
          <TextInput
            label="Ends on"
            description="Leave empty to run until you switch it off."
            type="date"
            value={endsOn}
            onChange={(event) => setEndsOn(event.currentTarget.value)}
            error={datesBackwards ? 'The offer cannot end before it starts.' : undefined}
            disabled={readOnly}
          />
        </Group>

        {/* ── Which days. The mask is MONDAY FIRST — DAYS_MASK_LABELS is the one
             mapping, so the boxes are built from it in its own order and can
             never drift from what the engine reads. ──────────────────────── */}
        <div>
          <Text size="sm" fw={500}>
            Which days
          </Text>
          <Text size="xs" c="dimmed" mb={8}>
            The days of the week this offer runs on.
          </Text>

          <Checkbox
            label="Every day"
            checked={everyDay}
            onChange={(event) => setEveryDay(event.currentTarget.checked)}
            disabled={readOnly}
          />

          {!everyDay && (
            <Group gap="md" mt="sm" wrap="wrap">
              {DAYS_MASK_LABELS.map((label, index) => (
                <Checkbox
                  key={label}
                  label={label}
                  checked={days[index]}
                  onChange={(event) => {
                    const next = [...days]
                    next[index] = event.currentTarget.checked
                    setDays(next)
                  }}
                  disabled={readOnly}
                />
              ))}
            </Group>
          )}

          {noDayPicked && (
            <Text size="xs" c="var(--mantine-color-red-text)" mt={6}>
              An offer must run on at least one day of the week.
            </Text>
          )}
        </div>

        <NumberInput
          label="Priority"
          description="Lower runs first. Only one offer ever discounts an item — the first that matches takes it."
          min={0}
          max={10000}
          step={10}
          allowDecimal={false}
          value={priority}
          onChange={(value) => {
            const next = typeof value === 'number' ? value : Number(value)
            setPriority(Number.isFinite(next) ? Math.trunc(next) : 0)
          }}
          disabled={readOnly}
        />

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Save size={16} />}
            loading={saving}
            disabled={readOnly || !canSave}
            onClick={() => void save()}
          >
            {existing ? 'Save offer' : 'Create offer'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The rules editor — WHAT an offer applies to
// ═════════════════════════════════════════════════════════════════════════════

/** A rule being edited. `targetId` is null until the owner picks one ('all' never has one). */
type DraftRule = {
  /** A stable key for React — a draft has no id until MAIN gives it one. */
  key: string
  scope: PromotionRuleScope
  targetId: number | null
}

let draftKeySeq = 0
function newDraftKey(): string {
  draftKeySeq += 1
  return `draft-${draftKeySeq}`
}

function RulesModal({
  promotion,
  readOnly,
  onClose,
  onSaved
}: {
  promotion: Promotion | null
  readOnly: boolean
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const opened = promotion !== null

  const [drafts, setDrafts] = useState<DraftRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!promotion) return
    setDrafts(null)
    setError(null)

    const result = await window.pos.promotions.rules({ promotionId: promotion.id })
    if (!result.ok) {
      setError(result.error.userMessage)
      setDrafts([])
      return
    }
    setDrafts(
      result.data.map((rule: PromotionRule) => ({
        key: `rule-${rule.id}`,
        scope: rule.scope,
        targetId: rule.targetId
      }))
    )
  }, [promotion])

  useEffect(() => {
    if (!opened) return
    void load()
  }, [opened, load])

  function addRule(): void {
    setDrafts([...(drafts ?? []), { key: newDraftKey(), scope: 'product', targetId: null }])
  }

  function updateRule(key: string, patch: Partial<DraftRule>): void {
    setDrafts((current) =>
      (current ?? []).map((rule) => (rule.key === key ? { ...rule, ...patch } : rule))
    )
  }

  function removeRule(key: string): void {
    setDrafts((current) => (current ?? []).filter((rule) => rule.key !== key))
  }

  // 'all' takes NO target; every other scope REQUIRES one. Zod refuses either mistake, so the button
  // waits until every row is answered rather than sending a save that cannot land.
  const incomplete = (drafts ?? []).some((rule) => rule.scope !== 'all' && rule.targetId == null)
  const appliesToNothing = drafts !== null && drafts.length === 0

  async function save(): Promise<void> {
    if (!promotion || readOnly || incomplete) return
    setSaving(true)

    // The WHOLE set, replacing whatever was there. An empty list is legal and means "applies to
    // nothing" — the safe direction: clearing the rules stops the offer dead rather than
    // accidentally applying it shop-wide (migration 0018).
    const rules: PromotionRuleInput[] = (drafts ?? []).map((rule) =>
      rule.scope === 'all' ? { scope: 'all' } : { scope: rule.scope, targetId: rule.targetId }
    )

    const result = await window.pos.promotions.setRules({ promotionId: promotion.id, rules })
    setSaving(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not save what this offer applies to',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Saved what this offer applies to',
      message:
        result.data.length === 0
          ? `${promotion.name} now applies to nothing, so it will not run.`
          : `${promotion.name} — ${result.data.length} ${result.data.length === 1 ? 'rule' : 'rules'}.`
    })
    onSaved()
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={promotion ? `What “${promotion.name}” applies to` : 'What this offer applies to'}
      centered
      size="xl"
    >
      <Stack>
        <Text size="sm" c="dimmed">
          Add a line for each item or group this offer covers. An offer with no lines applies to
          nothing and will never run — that is deliberate, so an offer can never go shop-wide by
          accident.
        </Text>

        {error && (
          <Alert color="red" icon={<CircleAlert size={18} />} title="Could not load these rules">
            {error}
            <Group mt="sm">
              <Button size="xs" variant="default" onClick={() => void load()}>
                Try again
              </Button>
            </Group>
          </Alert>
        )}

        {/* An offer that applies to nothing is THE failure mode — an owner who thinks they created a
            live offer and did not. Say it plainly, where they are looking. */}
        {appliesToNothing && !error && (
          <Alert color="orange" icon={<TriangleAlert size={18} />} title="This offer applies to nothing yet">
            It will not discount anything at the till until you add at least one line below.
          </Alert>
        )}

        {!drafts ? (
          <Stack gap={10}>
            <Skeleton height={44} />
            <Skeleton height={44} />
          </Stack>
        ) : (
          <Stack gap="sm">
            {drafts.map((rule) => (
              <RuleRow
                key={rule.key}
                rule={rule}
                readOnly={readOnly}
                onChange={(patch) => updateRule(rule.key, patch)}
                onRemove={() => removeRule(rule.key)}
              />
            ))}
          </Stack>
        )}

        <Group>
          <Tooltip label="Your licence has expired — offers cannot be changed" disabled={!readOnly}>
            <Button
              variant="default"
              leftSection={<Plus size={16} />}
              disabled={readOnly || drafts === null}
              onClick={addRule}
            >
              Add a line
            </Button>
          </Tooltip>
        </Group>

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Tooltip label="Your licence has expired — offers cannot be changed" disabled={!readOnly}>
            <Button
              leftSection={<Save size={16} />}
              loading={saving}
              disabled={readOnly || drafts === null || incomplete}
              onClick={() => void save()}
            >
              Save
            </Button>
          </Tooltip>
        </Group>
      </Stack>
    </Modal>
  )
}

function RuleRow({
  rule,
  readOnly,
  onChange,
  onRemove
}: {
  rule: DraftRule
  readOnly: boolean
  onChange: (patch: Partial<DraftRule>) => void
  onRemove: () => void
}): React.JSX.Element {
  const lookupKey = SCOPE_LOOKUP_KEY[rule.scope]

  return (
    <Card withBorder padding="sm">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <Select
          label="Applies to"
          allowDeselect={false}
          w={210}
          data={PROMOTION_RULE_SCOPES.map((value) => ({ value, label: SCOPE_LABEL[value] }))}
          value={rule.scope}
          // A changed scope means the old target points at the wrong table — a category id is not a
          // product id. Clear it, or the row would silently name the wrong thing.
          onChange={(value) =>
            value && onChange({ scope: value as PromotionRuleScope, targetId: null })
          }
          disabled={readOnly}
        />

        {/* 'all' takes NO target — the table CHECKs it and zod refuses it first. */}
        {rule.scope === 'all' ? (
          <Text size="sm" c="dimmed" pb={8} style={{ flex: 1 }}>
            Every stocked item in the shop.
          </Text>
        ) : rule.scope === 'product' ? (
          <div style={{ flex: 1, minWidth: 280 }}>
            <ProductPicker
              value={rule.targetId}
              onChange={(id) => onChange({ targetId: id })}
              disabled={readOnly}
            />
          </div>
        ) : lookupKey ? (
          <div style={{ flex: 1, minWidth: 280 }}>
            <LookupSelect
              listKey={lookupKey}
              label={SCOPE_LABEL[rule.scope]}
              placeholder={`Choose a ${rule.scope}`}
              value={rule.targetId}
              onChange={(id) => onChange({ targetId: id })}
              required
              disabled={readOnly}
            />
          </div>
        ) : null}

        <Tooltip label="Your licence has expired — offers cannot be changed" disabled={!readOnly}>
          <Button
            variant="subtle"
            color="red"
            leftSection={<Trash2 size={15} />}
            disabled={readOnly}
            onClick={onRemove}
          >
            Remove
          </Button>
        </Tooltip>
      </Group>
    </Card>
  )
}

/**
 * THE PRODUCT PICKER. There is no shared one in this codebase, so this is the minimal thing that
 * works: a searchable Select over `products.list`, which is paginated and indexed (CLAUDE.md §4 —
 * assume 100k+ rows, never an unbounded list). We ask for one page of matches as the owner types
 * rather than pulling the whole catalog into a dropdown.
 *
 * `products.list` is `product.manage` (manager) and so is `promotion.manage` — anyone who can reach
 * this screen can therefore search it. If that ever stops being true, this box goes quiet and empty,
 * which is why the "not found" case says so rather than silently showing nothing.
 */
function ProductPicker({
  value,
  onChange,
  disabled
}: {
  value: number | null
  onChange: (id: number | null) => void
  disabled?: boolean
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  /**
   * The chosen product must have a label even before any search has run — an edit that opened on an
   * existing rule would otherwise show a bare id, or nothing at all. Keep it beside the search
   * results so the box can always name what is selected.
   */
  const [chosen, setChosen] = useState<{ value: string; label: string } | null>(null)

  useEffect(() => {
    if (value == null) {
      setChosen(null)
      return
    }
    // Already showing the right one — don't re-fetch on every keystroke.
    if (chosen?.value === String(value)) return

    let cancelled = false
    void (async () => {
      const result = await window.pos.products.get({ id: value })
      if (cancelled || !result.ok) return
      setChosen({ value: String(value), label: `${result.data.product.name}` })
    })()
    return () => {
      cancelled = true
    }
  }, [value, chosen])

  // Search as they type, but not on every keystroke — a debounce keeps a 100k-row catalog quiet.
  useEffect(() => {
    const term = search.trim()
    if (term === '') {
      setOptions([])
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
          setFailed(true)
          setOptions([])
          return
        }
        setFailed(false)
        setOptions(
          result.data.rows.map((row) => ({
            value: String(row.id),
            // The stock code disambiguates two items with the same name — a real shop has them.
            label: row.sku ? `${row.name} (${row.sku})` : row.name
          }))
        )
      })()
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search])

  // The chosen item must stay in the data list or Mantine cannot render its label.
  const data = useMemo(() => {
    if (!chosen) return options
    return options.some((option) => option.value === chosen.value)
      ? options
      : [chosen, ...options]
  }, [options, chosen])

  return (
    <Select
      label="Item"
      placeholder="Type to search by name, code or barcode"
      description={failed ? undefined : 'Search your items and pick one.'}
      error={failed ? 'The items could not be searched.' : undefined}
      required
      searchable
      data={data}
      value={value == null ? null : String(value)}
      searchValue={search}
      onSearchChange={setSearch}
      onChange={(next) => onChange(next == null ? null : Number(next))}
      rightSection={loading ? <Loader size={14} /> : undefined}
      nothingFoundMessage={search.trim() === '' ? 'Type to search' : 'No items match'}
      disabled={disabled}
      clearable
    />
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Switch off — never a delete
// ═════════════════════════════════════════════════════════════════════════════

function DeactivateModal({
  promotion,
  onClose,
  onDone
}: {
  promotion: Promotion | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (promotion) setWorking(false)
  }, [promotion])

  async function deactivate(): Promise<void> {
    if (!promotion) return
    setWorking(true)
    const result = await window.pos.promotions.deactivate({ id: promotion.id })
    setWorking(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not switch this offer off',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Offer switched off',
      message: `${result.data.name} will not run at the till any more.`
    })
    onDone()
  }

  return (
    <Modal opened={promotion !== null} onClose={onClose} title="Switch this offer off?" centered>
      <Stack>
        <Text size="sm">
          <strong>{promotion?.name}</strong> will stop running at the till straight away.
        </Text>
        <Text size="sm" c="dimmed">
          It is switched off, not deleted. Sales that already used it keep the name and the discount
          they were given, so your old receipts and reports still explain themselves.
        </Text>

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            leftSection={<PowerOff size={16} />}
            loading={working}
            onClick={() => void deactivate()}
          >
            Switch off
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
