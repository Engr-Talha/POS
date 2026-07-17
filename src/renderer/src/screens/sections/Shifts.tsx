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
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  Title
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  BanknoteArrowDown,
  BanknoteArrowUp,
  Calculator,
  CircleAlert,
  CircleCheck,
  Clock,
  Coins,
  DoorOpen,
  HandCoins,
  History,
  Lock,
  Play,
  ReceiptText,
  RotateCw,
  TriangleAlert,
  Undo2,
  User as UserIcon,
  Vault,
  Wallet
} from 'lucide-react'
import type {
  CashMovement,
  CashMovementType,
  Shift,
  ShiftDetail,
  ShiftListItem,
  TenderBreakdown,
  ZReport
} from '@shared/shifts'
import { type Role, roleCan } from '@shared/rbac'
import { formatMoney } from '@shared/money'
import { Paginator } from '../../components/Paginator'
import { LookupCodeSelect, MoneyInput } from './ProductForm'

/**
 * THE SHIFT / CASH-DRAWER SCREEN — the till's trading day. Open the drawer with a float in the morning,
 * record the events that are NOT sales (a no-sale pop, cash in, cash out, a drop to the safe), and COUNT
 * the drawer at close. The difference between what you counted and what the books say should be there —
 * over or short — is the single most watched number in a shop.
 *
 * WHO SEES WHAT — the UI mirrors the gates MAIN actually enforces (CLAUDE.md §4; hiding a control is a
 * courtesy, never the security boundary — main refuses the call whether or not the button was drawn):
 *   - OPENING / CLOSING a shift and recording a drawer movement are `shift.manage` — a CASHIER's gate.
 *     Running the till is a cashier's job; the control is the audit log and the Z-report variance, not a
 *     block. So the nav entry that reaches this screen is gated `shift.manage`: everyone here can already
 *     do the headline actions, and nobody is greeted with a red refusal.
 *   - the LIVE Z-report (`shifts.get`) and the SHIFT HISTORY (`shifts.list`) are `shift.view` — a
 *     MANAGER's gate. This is deliberate, not an oversight: a cashier counts the drawer BLIND and only
 *     learns the over/short at close (which comes back on the `close` response, a `shift.manage` call).
 *     If a cashier could watch the expected cash tick up all day, skimming the difference to make the
 *     count balance would be trivial. So the running Z-report is a supervisory view, and a cashier sees
 *     the drawer actions plus the honest reveal at close — never the live expected figure.
 *
 * THE RENDERER SENDS INTENT; MAIN DECIDES THE MONEY (shared/shifts.ts). We send the opening float, the
 * counted cash, and a movement's amount — never `expectedCash` or `variance`, which main DERIVES from the
 * shift's own documents and FREEZES at close. Every figure this screen shows comes back from main.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Top level — Current drawer (everyone) + Past shifts (managers only)
// ═════════════════════════════════════════════════════════════════════════════

export function Shifts({
  userRole,
  readOnly,
  currencySymbol
}: {
  userRole: Role
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [tab, setTab] = useState<string | null>('current')

  // The live Z-report and the shift history are `shift.view` — a manager's report. A cashier runs the
  // drawer but does not get the running figures (see the file header), so both are shown to managers only.
  const canViewReport = roleCan(userRole, 'shift.view')

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Shift &amp; cash drawer</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Open the drawer with a starting float, record the cash that moves without a sale, and count the
          drawer at close. The over or short is worked out from the day&apos;s sales and movements — never
          typed in.
        </Text>
      </div>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="current" leftSection={<Wallet size={16} />}>
            Current drawer
          </Tabs.Tab>
          {canViewReport && (
            <Tabs.Tab value="history" leftSection={<History size={16} />}>
              Past shifts
            </Tabs.Tab>
          )}
        </Tabs.List>

        <Tabs.Panel value="current" pt="lg">
          <CurrentDrawer
            canViewReport={canViewReport}
            readOnly={readOnly}
            currencySymbol={currencySymbol}
          />
        </Tabs.Panel>

        {canViewReport && (
          <Tabs.Panel value="history" pt="lg">
            <PastShifts currencySymbol={currencySymbol} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// CURRENT DRAWER — the state machine: no shift → open panel; open → live view; just closed → the result.
// ═════════════════════════════════════════════════════════════════════════════

function CurrentDrawer({
  canViewReport,
  readOnly,
  currencySymbol
}: {
  canViewReport: boolean
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  // `undefined` = still loading; `null` = no shift open; a Shift = the open one.
  const [current, setCurrent] = useState<Shift | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  // The result of a close we just did. While set it takes over the screen so the cashier reads the final
  // Z-report and the over/short before starting a new day.
  const [closed, setClosed] = useState<{ shift: Shift; zReport: ZReport } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    setCurrent(undefined)
    const result = await window.pos.shifts.current()
    if (!result.ok) {
      setError(result.error.userMessage)
      setCurrent(null)
      return
    }
    setCurrent(result.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // The just-closed result wins the screen until they choose to open the next shift.
  if (closed) {
    return (
      <ClosedShiftResult
        result={closed}
        currencySymbol={currencySymbol}
        onNewShift={() => {
          setClosed(null)
          void load()
        }}
      />
    )
  }

  if (error) {
    return (
      <Alert color="red" icon={<CircleAlert size={18} />} title="The drawer could not be loaded">
        {error}
        <Group mt="sm">
          <Button size="xs" variant="default" onClick={() => void load()}>
            Try again
          </Button>
        </Group>
      </Alert>
    )
  }

  if (current === undefined) {
    return (
      <Stack gap="md">
        <Skeleton height={120} radius="md" />
        <Skeleton height={90} radius="md" />
      </Stack>
    )
  }

  if (current === null) {
    return <OpenShiftPanel readOnly={readOnly} currencySymbol={currencySymbol} onOpened={load} />
  }

  return (
    <OpenShiftView
      shift={current}
      canViewReport={canViewReport}
      readOnly={readOnly}
      currencySymbol={currencySymbol}
      onClosed={setClosed}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// No shift open — take the opening float and start the day.
// ─────────────────────────────────────────────────────────────────────────────

function OpenShiftPanel({
  readOnly,
  currencySymbol,
  onOpened
}: {
  readOnly: boolean
  currencySymbol: string
  onOpened: () => Promise<void>
}): React.JSX.Element {
  const [float, setFloat] = useState(0)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function open(): Promise<void> {
    setBusy(true)
    const result = await window.pos.shifts.open({
      openingFloat: float,
      note: note.trim() === '' ? null : note.trim()
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The shift could not be opened',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Shift opened',
      message: `The drawer is open with a ${formatMoney(float, { symbol: currencySymbol })} float.`
    })
    setFloat(0)
    setNote('')
    void onOpened()
  }

  return (
    <Stack gap="lg" maw={560}>
      <Card withBorder padding="lg">
        <Stack gap="md">
          <Group gap="sm">
            <DoorOpen size={20} />
            <div>
              <Text fw={650} size="lg">
                No shift is open
              </Text>
              <Text size="sm" c="dimmed">
                Open the drawer to start ringing up sales.
              </Text>
            </div>
          </Group>

          <Divider />

          {readOnly && (
            <Alert color="orange" icon={<TriangleAlert size={18} />}>
              Your licence has expired, so a new shift cannot be opened. You can still view past shifts and
              back up your data.
            </Alert>
          )}

          <MoneyInput
            label="Opening float"
            description="The cash the drawer starts with — the small notes and coins kept for giving change. It can be zero."
            leftSection={<Coins size={16} />}
            value={float}
            onChange={setFloat}
            disabled={readOnly}
            autoFocus
            required
          />

          <Textarea
            label="Note (optional)"
            description="Anything worth recording about this shift — e.g. which register, or who is covering."
            autosize
            minRows={1}
            maxRows={3}
            maxLength={500}
            disabled={readOnly}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />

          <Group justify="flex-end">
            <Button
              leftSection={<Play size={16} />}
              loading={busy}
              disabled={readOnly || float < 0}
              onClick={() => void open()}
            >
              Open shift
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A shift is open — facts, drawer actions, the live report (managers), and close.
// ─────────────────────────────────────────────────────────────────────────────

function OpenShiftView({
  shift,
  canViewReport,
  readOnly,
  currencySymbol,
  onClosed
}: {
  shift: Shift
  canViewReport: boolean
  readOnly: boolean
  currencySymbol: string
  onClosed: (result: { shift: Shift; zReport: ZReport }) => void
}): React.JSX.Element {
  // The drawer movement being recorded (null = no modal open), and the close modal's own flag.
  const [movement, setMovement] = useState<CashMovementType | null>(null)
  const [closing, setClosing] = useState(false)

  // The live "so far" Z-report — a MANAGER's view (`shifts.get` is `shift.view`). `null` while loading.
  const [report, setReport] = useState<ZReport | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadReport = useCallback(async (): Promise<void> => {
    if (!canViewReport) return
    setRefreshing(true)
    setReportError(null)
    const result = await window.pos.shifts.get({ id: shift.id })
    setRefreshing(false)
    if (!result.ok) {
      setReportError(result.error.userMessage)
      return
    }
    setReport(result.data.zReport)
  }, [canViewReport, shift.id])

  useEffect(() => {
    void loadReport()
  }, [loadReport])

  return (
    <Stack gap="lg">
      {/* ── The open shift, at a glance ─────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap={8} wrap="nowrap">
              <Wallet size={18} />
              <Text fw={650} size="lg">
                Shift #{shift.id}
              </Text>
              <Badge variant="light" color="blue">
                Open
              </Badge>
            </Group>
            {/* `shifts.current` returns a bare Shift with no opener NAME — only the report carries it, so
                we show the name when a manager has it loaded, and always show the time. */}
            {report?.shift.openedByName && (
              <Group gap={8} wrap="nowrap">
                <UserIcon size={14} opacity={0.7} />
                <Text size="sm">Opened by {report.shift.openedByName}</Text>
              </Group>
            )}
            <Group gap={8} wrap="nowrap">
              <Clock size={14} opacity={0.7} />
              <Text size="sm" c="dimmed">
                {new Date(shift.openedAt).toLocaleString()}
              </Text>
            </Group>
          </Stack>

          <Stack gap={2} align="flex-end">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Opening float
            </Text>
            <Text size="xl" fw={700}>
              {formatMoney(shift.openingFloat, { symbol: currencySymbol })}
            </Text>
          </Stack>
        </Group>

        {shift.note && (
          <Alert variant="light" color="gray" mt="md" p="xs">
            <Text size="sm">{shift.note}</Text>
          </Alert>
        )}
      </Card>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so no drawer movement can be recorded and the shift cannot be closed.
          You can still view everything and back up your data.
        </Alert>
      )}

      {/* ── Drawer actions — the events that are NOT sales ──────────────────── */}
      <Card withBorder padding="lg">
        <Text fw={600} size="sm" mb={4}>
          Drawer actions
        </Text>
        <Text size="sm" c="dimmed" mb="md">
          Every one of these is logged with your name and the time. A no-sale and a pay-out also ask for a
          reason.
        </Text>
        <Group gap="sm">
          <Button
            variant="default"
            leftSection={<DoorOpen size={16} />}
            disabled={readOnly}
            onClick={() => setMovement('no_sale')}
          >
            No-sale
          </Button>
          <Button
            variant="default"
            leftSection={<BanknoteArrowDown size={16} />}
            disabled={readOnly}
            onClick={() => setMovement('pay_in')}
          >
            Pay in
          </Button>
          <Button
            variant="default"
            leftSection={<BanknoteArrowUp size={16} />}
            disabled={readOnly}
            onClick={() => setMovement('pay_out')}
          >
            Pay out
          </Button>
          <Button
            variant="default"
            leftSection={<Vault size={16} />}
            disabled={readOnly}
            onClick={() => setMovement('drop')}
          >
            Drop to safe
          </Button>
        </Group>
      </Card>

      {/* ── The live Z-report (managers) or the blind-close note (cashiers) ── */}
      {canViewReport ? (
        <Stack gap="sm">
          <Group justify="space-between" align="center">
            <Group gap={8}>
              <Text fw={600}>This shift so far</Text>
              <Badge size="sm" variant="dot" color="blue">
                Live
              </Badge>
            </Group>
            <Button
              size="xs"
              variant="subtle"
              leftSection={<RotateCw size={14} />}
              loading={refreshing}
              onClick={() => void loadReport()}
            >
              Refresh
            </Button>
          </Group>

          {reportError ? (
            <Alert color="red" icon={<CircleAlert size={18} />} title="The report could not be loaded">
              {reportError}
              <Group mt="sm">
                <Button size="xs" variant="default" onClick={() => void loadReport()}>
                  Try again
                </Button>
              </Group>
            </Alert>
          ) : !report ? (
            <Skeleton height={260} radius="md" />
          ) : (
            <ZReportView zReport={report} currencySymbol={currencySymbol} />
          )}
        </Stack>
      ) : (
        <Alert color="blue" variant="light" icon={<Calculator size={18} />} title="Counting the drawer">
          <Text size="sm">
            The running sales-and-cash total for this shift is a manager&apos;s view. When you close the
            drawer, count the cash and you&apos;ll see straight away whether it is over or short.
          </Text>
        </Alert>
      )}

      {/* ── Close ───────────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group justify="space-between" align="center" wrap="wrap" gap="md">
          <Stack gap={2}>
            <Group gap={8}>
              <Lock size={16} />
              <Text fw={600}>Close the drawer</Text>
            </Group>
            <Text size="sm" c="dimmed">
              Count the cash in the drawer and enter the total. The over or short is worked out for you.
            </Text>
          </Stack>
          {/* Not color="dark": that is a FIXED near-black, and in dark mode it is a black button on
              a black counter. `filled` follows the theme and stays visible in both. */}
          <Button
            variant="filled"
            leftSection={<Lock size={16} />}
            disabled={readOnly}
            onClick={() => setClosing(true)}
          >
            Close shift
          </Button>
        </Group>
      </Card>

      {movement !== null && (
        <CashMovementModal
          type={movement}
          currencySymbol={currencySymbol}
          onClose={() => setMovement(null)}
          onDone={() => {
            setMovement(null)
            void loadReport()
          }}
        />
      )}

      {closing && (
        <CloseShiftModal
          currencySymbol={currencySymbol}
          onClose={() => setClosing(false)}
          onClosed={(result) => {
            setClosing(false)
            onClosed(result)
          }}
        />
      )}
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The drawer-movement modal — one flexible form for no-sale / pay-in / pay-out / drop.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What each movement type needs. A no-sale moves no money (amount stays 0) but MUST carry a reason; a
 * pay-out takes cash out and MUST carry a reason too — the two theft vectors. A pay-in and a drop just
 * need an amount. The reason lists (`no_sale_reason`, `pay_out_reason`) are the owner's own — never a
 * hardcoded option — so we use the shared LookupCodeSelect, which travels the CODE main checks against.
 */
const MOVEMENT_META: Record<
  CashMovementType,
  {
    title: string
    icon: React.ReactNode
    verb: string
    needsAmount: boolean
    reasonListKey: string | null
    amountLabel?: string
    amountHelp?: string
    hint?: string
  }
> = {
  no_sale: {
    title: 'Open the drawer (no sale)',
    icon: <DoorOpen size={18} />,
    verb: 'Record no-sale',
    needsAmount: false,
    reasonListKey: 'no_sale_reason',
    hint: 'The drawer pops open without a sale — no money moves. Because that is how cash goes missing, a reason is required.'
  },
  pay_in: {
    title: 'Pay in',
    icon: <BanknoteArrowDown size={18} />,
    verb: 'Record pay-in',
    needsAmount: true,
    reasonListKey: null,
    amountLabel: 'Amount paid in',
    amountHelp: 'Cash put INTO the drawer — e.g. the owner topping up the float.'
  },
  pay_out: {
    title: 'Pay out',
    icon: <BanknoteArrowUp size={18} />,
    verb: 'Record pay-out',
    needsAmount: true,
    reasonListKey: 'pay_out_reason',
    amountLabel: 'Amount paid out',
    amountHelp: 'Cash taken OUT of the drawer for a bill or an errand. A reason is required.'
  },
  drop: {
    title: 'Drop to safe',
    icon: <Vault size={18} />,
    verb: 'Record drop',
    needsAmount: true,
    reasonListKey: null,
    amountLabel: 'Amount dropped',
    amountHelp: 'Cash moved out of the drawer to the safe or the bank. It leaves the till but stays the shop’s money.'
  }
}

function CashMovementModal({
  type,
  currencySymbol,
  onClose,
  onDone
}: {
  type: CashMovementType
  currencySymbol: string
  onClose: () => void
  onDone: (movement: CashMovement) => void
}): React.JSX.Element {
  const meta = MOVEMENT_META[type]

  const [amount, setAmount] = useState(0)
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const canSubmit =
    !busy &&
    (!meta.needsAmount || amount > 0) &&
    (meta.reasonListKey === null || reasonCode !== null)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)

    // INTENT ONLY. A no-sale sends amount 0 (main and the DB CHECK both insist on it); the others send the
    // counted amount. We send the reason CODE, never an id. `at`, the journal and the audit row are all
    // main's to write (CLAUDE.md §4).
    const result = await window.pos.shifts.cashMovement({
      type,
      amount: meta.needsAmount ? amount : 0,
      reasonCode: meta.reasonListKey !== null ? reasonCode : null,
      note: note.trim() === '' ? null : note.trim()
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'That could not be recorded',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: `${meta.title} recorded`,
      message: meta.needsAmount
        ? `${formatMoney(result.data.amount, { symbol: currencySymbol })} recorded.`
        : 'The drawer was opened and logged.'
    })
    onDone(result.data)
  }

  return (
    <Modal
      opened
      onClose={onClose}
      centered
      title={
        <Group gap="sm">
          {meta.icon}
          <Text fw={650}>{meta.title}</Text>
        </Group>
      }
    >
      <Stack gap="md">
        {meta.hint && (
          <Text size="sm" c="dimmed">
            {meta.hint}
          </Text>
        )}

        {meta.needsAmount && (
          <MoneyInput
            label={meta.amountLabel ?? 'Amount'}
            description={meta.amountHelp}
            leftSection={<Text size="sm">{currencySymbol}</Text>}
            value={amount}
            onChange={setAmount}
            autoFocus
            required
          />
        )}

        {meta.reasonListKey !== null && (
          <LookupCodeSelect
            listKey={meta.reasonListKey}
            label="Reason"
            description="Chosen from your own list. Add a new reason with +."
            value={reasonCode}
            onChange={setReasonCode}
            required
          />
        )}

        <Textarea
          label="Note (optional)"
          autosize
          minRows={1}
          maxRows={3}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            {meta.verb}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The close modal — take the counted cash. Main reveals the over/short.
// ─────────────────────────────────────────────────────────────────────────────

function CloseShiftModal({
  currencySymbol,
  onClose,
  onClosed
}: {
  currencySymbol: string
  onClose: () => void
  onClosed: (result: { shift: Shift; zReport: ZReport }) => void
}): React.JSX.Element {
  const [counted, setCounted] = useState(0)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function close(): Promise<void> {
    setBusy(true)
    // We send ONLY the counted cash. Main computes what the drawer SHOULD hold from the day's own sales,
    // refunds and movements, freezes counted / expected / variance together, and hands back the frozen
    // Z-report. An over/short is recorded, never posted to the ledger (a miscount must not adjust Cash).
    const result = await window.pos.shifts.close({
      countedCash: counted,
      note: note.trim() === '' ? null : note.trim()
    })
    setBusy(false)

    if (!result.ok) {
      notifications.show({
        color: 'red',
        title: 'The shift could not be closed',
        message: result.error.userMessage
      })
      return
    }

    onClosed(result.data)
  }

  return (
    <Modal
      opened
      onClose={onClose}
      centered
      title={
        <Group gap="sm">
          <Lock size={18} />
          <Text fw={650}>Close the drawer</Text>
        </Group>
      }
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Count every note and coin in the drawer and enter the total. You will see the over or short the
          moment you close.
        </Text>

        <MoneyInput
          label="Counted cash"
          description="The physical cash in the drawer, right now."
          leftSection={<HandCoins size={16} />}
          value={counted}
          onChange={setCounted}
          autoFocus
          required
        />

        <Textarea
          label="Note (optional)"
          description="Anything worth recording about the close — e.g. a reason for a known short."
          autosize
          minRows={1}
          maxRows={3}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="filled"
            leftSection={<Lock size={16} />}
            loading={busy}
            disabled={counted < 0}
            onClick={() => void close()}
          >
            Close shift
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The just-closed result — the frozen Z-report with the over/short up front.
// ─────────────────────────────────────────────────────────────────────────────

function ClosedShiftResult({
  result,
  currencySymbol,
  onNewShift
}: {
  result: { shift: Shift; zReport: ZReport }
  currencySymbol: string
  onNewShift: () => void
}): React.JSX.Element {
  const { shift, zReport } = result
  const variance = shift.variance ?? 0
  const over = variance >= 0

  return (
    <Stack gap="lg" maw={860}>
      <Alert
        color={over ? 'teal' : 'red'}
        icon={over ? <CircleCheck size={18} /> : <TriangleAlert size={18} />}
        title="Shift closed"
      >
        <Text size="sm">
          {variance === 0
            ? 'The drawer balanced exactly — the count matched the books to the paisa.'
            : over
              ? `The drawer was OVER by ${formatMoney(variance, { symbol: currencySymbol })} — there was more cash than the books expected.`
              : `The drawer was SHORT by ${formatMoney(Math.abs(variance), { symbol: currencySymbol })} — there was less cash than the books expected.`}
        </Text>
      </Alert>

      <Card withBorder padding="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap={8} wrap="nowrap">
              <Wallet size={18} />
              <Text fw={650} size="lg">
                Shift #{shift.id}
              </Text>
              <Badge variant="light" color="gray">
                Closed
              </Badge>
            </Group>
            <Group gap={8} wrap="nowrap">
              <UserIcon size={14} opacity={0.7} />
              <Text size="sm" c="dimmed">
                Opened by {zReport.shift.openedByName ?? 'a user'} · closed by{' '}
                {zReport.shift.closedByName ?? 'a user'}
              </Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <Clock size={14} opacity={0.7} />
              <Text size="sm" c="dimmed">
                {new Date(shift.openedAt).toLocaleString()} —{' '}
                {shift.closedAt ? new Date(shift.closedAt).toLocaleString() : ''}
              </Text>
            </Group>
          </Stack>
        </Group>

        <Divider my="md" />

        <ZReportView zReport={zReport} currencySymbol={currencySymbol} />
      </Card>

      <Group>
        <Button leftSection={<Play size={16} />} onClick={onNewShift}>
          Open a new shift
        </Button>
      </Group>
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// THE Z-REPORT — rendered on screen. Reused by the live view, the close result, and a past shift.
// ═════════════════════════════════════════════════════════════════════════════

function ZReportView({
  zReport,
  currencySymbol
}: {
  zReport: ZReport
  currencySymbol: string
}): React.JSX.Element {
  const money = (value: number): string => formatMoney(value, { symbol: currencySymbol })
  const closed = zReport.shift.status === 'closed'
  const recon = zReport.reconciliation

  return (
    <Stack gap="lg">
      {/* ── Trading summary ─────────────────────────────────────────────────── */}
      <div>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
          <Stat
            icon={<ReceiptText size={16} />}
            label="Sales"
            value={String(zReport.sales.count)}
            sub={money(zReport.sales.grossTotal)}
          />
          <Stat
            icon={<Undo2 size={16} />}
            label="Refunds"
            value={String(zReport.refunds.count)}
            sub={money(zReport.refunds.total)}
          />
          <Stat icon={<CircleAlert size={16} />} label="Voids" value={String(zReport.voids.count)} />
          <Stat
            icon={<DoorOpen size={16} />}
            label="No-sales"
            value={String(zReport.cashMovements.noSaleCount)}
          />
        </SimpleGrid>

        {(zReport.sales.totalDiscount > 0 || zReport.sales.totalTax > 0) && (
          <Text size="xs" c="dimmed" mt="xs">
            Includes {money(zReport.sales.totalDiscount)} discount and {money(zReport.sales.totalTax)} tax
            across the shift&apos;s sales.
          </Text>
        )}
      </div>

      {/* ── Tender breakdown ────────────────────────────────────────────────── */}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
        <TenderTable
          title="Sales by tender"
          rows={zReport.sales.byTender}
          emptyText="No sales yet."
          currencySymbol={currencySymbol}
        />
        {zReport.refunds.byTender.length > 0 && (
          <TenderTable
            title="Refunds by tender"
            rows={zReport.refunds.byTender}
            emptyText="No refunds."
            currencySymbol={currencySymbol}
          />
        )}
      </SimpleGrid>

      <Divider />

      {/* ── Cash reconciliation — the running expected cash ─────────────────── */}
      <div>
        <Group gap={8} mb="sm">
          <Calculator size={16} />
          <Text fw={600} size="sm">
            Cash reconciliation
          </Text>
        </Group>

        <Stack gap={6} maw={460}>
          <ReconRow label="Opening float" amount={recon.openingFloat} sign="+" money={money} />
          <ReconRow label="Cash sales" amount={recon.cashSales} sign="+" money={money} />
          <ReconRow label="Cash from udhaar" amount={recon.cashUdhaar} sign="+" money={money} />
          <ReconRow label="Pay-ins" amount={recon.payIns} sign="+" money={money} />
          <ReconRow label="Cash refunds" amount={recon.cashRefunds} sign="-" money={money} />
          <ReconRow label="Pay-outs" amount={recon.payOuts} sign="-" money={money} />
          <ReconRow label="Drops to safe" amount={recon.drops} sign="-" money={money} />
          <Divider my={2} />
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={700}>
              Expected in drawer
            </Text>
            <Text size="md" fw={700}>
              {money(recon.expectedCash)}
            </Text>
          </Group>

          {closed && recon.countedCash !== null && (
            <>
              <Group justify="space-between" wrap="nowrap" mt={2}>
                <Text size="sm" c="dimmed">
                  Counted (physical)
                </Text>
                <Text size="sm">{money(recon.countedCash)}</Text>
              </Group>
              <VarianceBanner variance={recon.variance ?? 0} currencySymbol={currencySymbol} />
            </>
          )}
        </Stack>

        {!closed && (
          <Text size="xs" c="dimmed" mt="sm">
            This is what the drawer should hold right now. The counted total and the over/short are frozen
            when the shift is closed.
          </Text>
        )}
      </div>
    </Stack>
  )
}

/** One stat tile — a count with an optional money sub-line. */
function Stat({
  icon,
  label,
  value,
  sub
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <Card withBorder padding="md">
      <Group gap={6} mb={6}>
        {icon}
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {label}
        </Text>
      </Group>
      <Text size="xl" fw={700} lh={1.1}>
        {value}
      </Text>
      {sub && (
        <Text size="sm" c="dimmed" mt={2}>
          {sub}
        </Text>
      )}
    </Card>
  )
}

/** A small table of how a total split across payment methods. */
function TenderTable({
  title,
  rows,
  emptyText,
  currencySymbol
}: {
  title: string
  rows: TenderBreakdown[]
  emptyText: string
  currencySymbol: string
}): React.JSX.Element {
  return (
    <div>
      <Group gap={8} mb="xs">
        <Coins size={16} />
        <Text fw={600} size="sm">
          {title}
        </Text>
      </Group>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyText}
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing="xs">
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.methodLookupId}>
                <Table.Td>
                  <Text size="sm">{row.label}</Text>
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
      )}
    </div>
  )
}

/** One line of the cash reconciliation — label, a +/− glyph, and the money. Zeros are dimmed. */
function ReconRow({
  label,
  amount,
  sign,
  money
}: {
  label: string
  amount: number
  sign: '+' | '-'
  money: (value: number) => string
}): React.JSX.Element {
  const zero = amount === 0
  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" c={zero ? 'dimmed' : undefined}>
        {label}
      </Text>
      <Text size="sm" c={zero ? 'dimmed' : undefined}>
        <Text span c="dimmed" mr={4}>
          {sign === '-' ? '−' : '+'}
        </Text>
        {money(amount)}
      </Text>
    </Group>
  )
}

/** The over/short banner — green when over or exact, red when short (the shop's most watched number). */
function VarianceBanner({
  variance,
  currencySymbol
}: {
  variance: number
  currencySymbol: string
}): React.JSX.Element {
  const over = variance >= 0
  const label = variance === 0 ? 'Balanced exactly' : over ? 'Over' : 'Short'
  const shown = `${variance > 0 ? '+' : ''}${formatMoney(variance, { symbol: currencySymbol })}`

  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      mt={6}
      p="sm"
      style={{
        borderRadius: 8,
        border: `1px solid var(--mantine-color-${over ? 'teal' : 'red'}-outline)`,
        background: `var(--mantine-color-${over ? 'teal' : 'red'}-light)`
      }}
    >
      <Group gap={8} wrap="nowrap">
        {over ? (
          <CircleCheck size={18} color={`var(--mantine-color-teal-filled)`} />
        ) : (
          <TriangleAlert size={18} color={`var(--mantine-color-red-filled)`} />
        )}
        <Text fw={700} c={over ? 'teal' : 'red'}>
          {label}
        </Text>
      </Group>
      <Text fw={700} size="lg" c={over ? 'teal' : 'red'}>
        {shown}
      </Text>
    </Group>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// PAST SHIFTS — MANAGER-gated (`shift.view`). Paginated list + a drill-in Z-report.
// ═════════════════════════════════════════════════════════════════════════════

function PastShifts({ currencySymbol }: { currencySymbol: string }): React.JSX.Element {
  const [rows, setRows] = useState<ShiftListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // The shift open in the detail drawer, by id. Null = the drawer is closed.
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)
    const result = await window.pos.shifts.list({ page, pageSize })
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
        <Alert color="red" icon={<CircleAlert size={18} />} title="The shifts could not be loaded">
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
            <Wallet size={32} opacity={0.5} />
            <Text fw={600}>No shifts yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              Every shift you open and close appears here — with its opening float, what the books
              expected, what was counted, and the over or short.
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={880}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Shift</Table.Th>
                    <Table.Th>Opened</Table.Th>
                    <Table.Th>Closed</Table.Th>
                    <Table.Th ta="right">Float</Table.Th>
                    <Table.Th ta="right">Expected</Table.Th>
                    <Table.Th ta="right">Counted</Table.Th>
                    <Table.Th ta="right">Over / Short</Table.Th>
                    <Table.Th>Status</Table.Th>
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
                        <Text size="sm">{new Date(row.openedAt).toLocaleString()}</Text>
                        <Text size="xs" c="dimmed">
                          {row.openedByName ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {row.closedAt ? (
                          <>
                            <Text size="sm">{new Date(row.closedAt).toLocaleString()}</Text>
                            <Text size="xs" c="dimmed">
                              {row.closedByName ?? '—'}
                            </Text>
                          </>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">{formatMoney(row.openingFloat, { symbol: currencySymbol })}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c={row.expectedCash === null ? 'dimmed' : undefined}>
                          {row.expectedCash === null
                            ? '—'
                            : formatMoney(row.expectedCash, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c={row.countedCash === null ? 'dimmed' : undefined}>
                          {row.countedCash === null
                            ? '—'
                            : formatMoney(row.countedCash, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        {row.variance === null ? (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        ) : (
                          <Text size="sm" fw={600} c={row.variance >= 0 ? 'teal' : 'red'}>
                            {row.variance > 0 ? '+' : ''}
                            {formatMoney(row.variance, { symbol: currencySymbol })}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          variant="light"
                          color={row.status === 'open' ? 'blue' : 'gray'}
                        >
                          {row.status === 'open' ? 'Open' : 'Closed'}
                        </Badge>
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
              unit="shift"
            />
          </>
        )}
      </Card>

      <ShiftDetailDrawer
        shiftId={selectedId}
        currencySymbol={currencySymbol}
        onClose={() => setSelectedId(null)}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The drill-in drawer — one shift's frozen Z-report and its drawer movements.
// ─────────────────────────────────────────────────────────────────────────────

/** Label, colour and icon for each drawer-movement type, so the movements table reads plainly. */
const MOVEMENT_ROW_META: Record<
  CashMovementType,
  { label: string; color: string; icon: React.ReactNode }
> = {
  no_sale: { label: 'No-sale', color: 'gray', icon: <DoorOpen size={12} /> },
  pay_in: { label: 'Pay in', color: 'teal', icon: <BanknoteArrowDown size={12} /> },
  pay_out: { label: 'Pay out', color: 'orange', icon: <BanknoteArrowUp size={12} /> },
  drop: { label: 'Drop', color: 'grape', icon: <Vault size={12} /> }
}

function ShiftDetailDrawer({
  shiftId,
  currencySymbol,
  onClose
}: {
  shiftId: number | null
  currencySymbol: string
  onClose: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<ShiftDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (shiftId === null) {
      setDetail(null)
      setError(null)
      return
    }

    let cancelled = false
    setDetail(null)
    setError(null)

    void (async () => {
      const result = await window.pos.shifts.get({ id: shiftId })
      if (cancelled) return
      if (result.ok) setDetail(result.data)
      else setError(result.error.userMessage)
    })()

    return () => {
      cancelled = true
    }
  }, [shiftId])

  return (
    <Drawer
      opened={shiftId !== null}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        <Group gap="sm">
          <Wallet size={20} />
          <Text fw={650} size="lg">
            {detail ? `Shift #${detail.id}` : 'Shift'}
          </Text>
          {detail && (
            <Badge variant="light" color={detail.status === 'open' ? 'blue' : 'gray'}>
              {detail.status === 'open' ? 'Open' : 'Closed'}
            </Badge>
          )}
        </Group>
      }
    >
      {error ? (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The shift could not be opened">
          {error}
        </Alert>
      ) : !detail ? (
        <Stack gap={10}>
          <Skeleton height={20} width="60%" />
          <Skeleton height={16} width="40%" />
          <Skeleton height={160} mt="md" />
          <Skeleton height={100} mt="md" />
        </Stack>
      ) : (
        <Stack gap="lg">
          {/* ── The heading facts ────────────────────────────────────────── */}
          <Stack gap={6}>
            <Group gap={8} wrap="nowrap">
              <UserIcon size={15} opacity={0.7} />
              <Text size="sm">
                Opened by {detail.openedByName ?? 'a user'}
                {detail.closedByName ? (
                  <Text span c="dimmed">
                    {' '}
                    · closed by {detail.closedByName}
                  </Text>
                ) : null}
              </Text>
            </Group>
            <Group gap={8} wrap="nowrap">
              <Clock size={15} opacity={0.7} />
              <Text size="sm" c="dimmed">
                {new Date(detail.openedAt).toLocaleString()}
                {detail.closedAt ? ` — ${new Date(detail.closedAt).toLocaleString()}` : ' — still open'}
              </Text>
            </Group>
          </Stack>

          {detail.note && (
            <Alert variant="light" color="gray" p="xs">
              <Text size="sm">{detail.note}</Text>
            </Alert>
          )}

          <ZReportView zReport={detail.zReport} currencySymbol={currencySymbol} />

          {/* ── The itemised drawer movements ─────────────────────────────── */}
          <div>
            <Text fw={600} size="sm" mb={6}>
              Drawer movements
            </Text>
            {detail.cashMovements.length === 0 ? (
              <Text size="sm" c="dimmed">
                No drawer movements were recorded on this shift.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={520}>
                <Table withTableBorder verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Reason</Table.Th>
                      <Table.Th ta="right">Amount</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {detail.cashMovements.map((movement) => {
                      const meta = MOVEMENT_ROW_META[movement.type]
                      return (
                        <Table.Tr key={movement.id}>
                          <Table.Td>
                            <Text size="sm">{new Date(movement.at).toLocaleString()}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              size="sm"
                              variant="light"
                              color={meta.color}
                              leftSection={meta.icon}
                            >
                              {meta.label}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" c={movement.reasonLabel || movement.note ? undefined : 'dimmed'}>
                              {movement.reasonLabel ?? movement.note ?? '—'}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm" c={movement.amount === 0 ? 'dimmed' : undefined} fw={600}>
                              {movement.amount === 0
                                ? '—'
                                : formatMoney(movement.amount, { symbol: currencySymbol })}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      )
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </div>
        </Stack>
      )}
    </Drawer>
  )
}
