import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  BarChart3,
  BookOpen,
  BookUser,
  Boxes,
  CalendarClock,
  CircleCheck,
  CreditCard,
  FileDown,
  FileSpreadsheet,
  FileText,
  Landmark,
  PackageSearch,
  Percent,
  ReceiptText,
  RefreshCw,
  Scale,
  ShieldAlert,
  Tags,
  TriangleAlert,
  TrendingUp,
  Truck,
  Wallet
} from 'lucide-react'
import type { Account } from '@shared/accounting'
import type { ReportRequest } from '@shared/reports'
import {
  buildReportView,
  REPORT_TITLES,
  type Cell,
  type ReportKind,
  type ReportPayload,
  type Section as ReportSection
} from '@shared/report-export'
import { formatMoney } from '@shared/money'
import { formatCost } from '@shared/cost'
import { formatQty } from '@shared/qty'
import { Paginator } from '../../components/Paginator'

/**
 * REPORTS — the payoff screen. Seventeen reports, each read on screen and exportable to Excel or PDF.
 *
 * This screen NEVER computes a number. It asks MAIN (`reports.get`) for the frozen figures and RENDERS
 * them, and it uses the very same `buildReportView` the export layer uses (shared/report-export.ts) to
 * turn a report into columns, rows and a total. That is deliberate: the table a shopkeeper reads on
 * screen and the .xlsx / .pdf he prints are built from ONE description of the report, so the two can
 * never disagree about which columns exist, which rows, or which line is the total. Only the *formatting*
 * of a cell differs (on screen we show the currency symbol; the raw integer and its scale are identical).
 *
 * Every figure is an INTEGER at its own scale — money 2 dp, cost 4 dp, qty 3 dp, a margin in basis
 * points, a count plain — and each is formatted through the app's one formatter (`formatCell`). A float
 * can never enter here.
 *
 * The whole screen is a READ. It is gated `report.view` in MAIN, and — like every read — it keeps
 * working when the licence has lapsed: a read-only shop must still run every report and get its numbers
 * out (CLAUDE.md §6). Hiding the nav entry from a Cashier is a courtesy; MAIN is the boundary.
 */

// ── Dates: local YYYY-MM-DD, the shape every service input (`IsoDate`) validates ────────────────────

/** Today, in the machine's local time. `new Date().toISOString()` is UTC and can be a day off. */
function todayIso(): string {
  return fmtIso(new Date())
}

/** The first day of the current month — the default "This month" start. */
function monthStartIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** The first day of the current year — the default "This year" start. */
function yearStartIso(): string {
  return `${new Date().getFullYear()}-01-01`
}

function fmtIso(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

// ── One cell → one string. The SAME rules the PDF writer uses (reports-pdf.ts), so the screen and the
//    printout read identically. Money and cost carry the shop's symbol on screen; the integer is untouched.
function formatCell(cell: Cell, symbol: string): string {
  switch (cell.kind) {
    case 'text':
      return cell.text
    case 'money':
      return formatMoney(cell.raw, { symbol })
    case 'cost':
      return formatCost(cell.raw, { symbol })
    case 'qty':
      return formatQty(cell.raw)
    case 'percent': {
      // Basis points to a human percentage: 3655 -> "36.55%", 3600 -> "36%".
      const percent = cell.raw / 100
      return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
    }
    case 'int':
      return cell.raw.toLocaleString('en-US')
  }
}

/** The Balanced / NOT BALANCED status line (trial balance, balance sheet) earns a colour; the rest are plain. */
function metaColor(value: string): string {
  if (value === 'NOT BALANCED') return 'red'
  if (value === 'Balanced') return 'teal'
  return 'gray'
}

// ── The menu of reports. Which params each report takes mirrors the `ReportRequest` union exactly:
//    a PERIOD [from, to], a PERIOD + a PAGE, an AS-OF date, "as of now" + a knob, a paged "as of now",
//    or one ACCOUNT over a period. `makeRequest` closes over the literal `kind` so the request is built
//    type-safely with no cast — MAIN re-validates it anyway.
//
// ── PAGING IS THE SERVER'S, NOT THE SCREEN'S ──────────────────────────────────────────────────────
//
// Seven of these reports are PAGED IN MAIN (CLAUDE.md §4 — assume 100k+ rows, never an unbounded
// SELECT *). For those, `page`/`pageSize` ride the request and the answer comes back with its own
// `total` and the WHOLE period's totals. The screen must NOT re-slice those rows: MAIN already sent
// exactly one page, and slicing it again would hide rows behind a pager that promised them. So a paged
// report re-fetches on a page click, and the unpaged ones keep the client-side pager they have always
// had (their row sets are bounded — a shop has a handful of tenders, not 100k).
type PeriodParams = { from: string; to: string }
type PagedPeriodParams = PeriodParams & { page: number; pageSize: number }
type AsOfParams = { asOf: string }
type StockParams = { nearExpiryDays: number | undefined }
type PagedParams = { page: number; pageSize: number }
type NearExpiryParams = PagedParams & { withinDays: number | undefined }
type LedgerParams = PagedPeriodParams & { accountCode: string }

type ReportDefBase = {
  kind: ReportKind
  icon: typeof BarChart3
  group: string
  description: string
}

/**
 * `paged: true` marks a report MAIN pages. It drives two things and nothing else: the screen re-runs the
 * request on a page click, and `SectionBlock` shows the server's pager instead of its own.
 */
type ReportDef =
  | (ReportDefBase & { params: 'period'; makeRequest: (p: PeriodParams) => ReportRequest })
  | (ReportDefBase & {
      params: 'pagedPeriod'
      paged: true
      makeRequest: (p: PagedPeriodParams) => ReportRequest
    })
  | (ReportDefBase & { params: 'asOf'; makeRequest: (p: AsOfParams) => ReportRequest })
  | (ReportDefBase & { params: 'stock'; makeRequest: (p: StockParams) => ReportRequest })
  | (ReportDefBase & { params: 'paged'; paged: true; makeRequest: (p: PagedParams) => ReportRequest })
  | (ReportDefBase & {
      params: 'nearExpiry'
      paged: true
      makeRequest: (p: NearExpiryParams) => ReportRequest
    })
  | (ReportDefBase & { params: 'ledger'; paged: true; makeRequest: (p: LedgerParams) => ReportRequest })

const REPORTS: ReportDef[] = [
  {
    kind: 'salesSummary',
    group: 'Sales & profit',
    icon: ReceiptText,
    params: 'period',
    description: 'Totals, tender breakdown and the takings for each day of a period.',
    makeRequest: ({ from, to }) => ({ kind: 'salesSummary', from, to })
  },
  {
    kind: 'profit',
    group: 'Sales & profit',
    icon: TrendingUp,
    params: 'period',
    description: 'Revenue, cost of goods sold and the gross margin on a period’s sales.',
    makeRequest: ({ from, to }) => ({ kind: 'profit', from, to })
  },
  {
    kind: 'itemWise',
    group: 'Sales & profit',
    icon: PackageSearch,
    params: 'pagedPeriod',
    paged: true,
    description: 'What each item sold, earned and cost — best sellers first.',
    makeRequest: ({ from, to, page, pageSize }) => ({ kind: 'itemWise', from, to, page, pageSize })
  },
  {
    kind: 'categoryWise',
    group: 'Sales & profit',
    icon: Tags,
    params: 'pagedPeriod',
    paged: true,
    description: 'The same trade as item-wise, grouped by category.',
    makeRequest: ({ from, to, page, pageSize }) => ({ kind: 'categoryWise', from, to, page, pageSize })
  },
  {
    kind: 'paymentMethodBreakdown',
    group: 'Sales & profit',
    icon: CreditCard,
    params: 'pagedPeriod',
    paged: true,
    description: 'Per tender: what came in, what went back out, and the net.',
    makeRequest: ({ from, to, page, pageSize }) => ({
      kind: 'paymentMethodBreakdown',
      from,
      to,
      page,
      pageSize
    })
  },
  {
    kind: 'stockValuation',
    group: 'Inventory',
    icon: Boxes,
    params: 'stock',
    description: 'What the stock on hand is worth right now, item by item.',
    makeRequest: ({ nearExpiryDays }) =>
      nearExpiryDays === undefined
        ? { kind: 'stockValuation' }
        : { kind: 'stockValuation', nearExpiryDays }
  },
  {
    kind: 'lowStock',
    group: 'Inventory',
    icon: PackageSearch,
    params: 'paged',
    paged: true,
    description: 'What to buy: every item at or below its re-order level, worst first.',
    makeRequest: ({ page, pageSize }) => ({ kind: 'lowStock', page, pageSize })
  },
  {
    kind: 'nearExpiry',
    group: 'Inventory',
    icon: CalendarClock,
    params: 'nearExpiry',
    paged: true,
    description: 'Batches about to expire — and any already expired — soonest first.',
    makeRequest: ({ withinDays, page, pageSize }) =>
      withinDays === undefined
        ? { kind: 'nearExpiry', page, pageSize }
        : { kind: 'nearExpiry', withinDays, page, pageSize }
  },
  {
    kind: 'customerAging',
    group: 'Receivables & payables',
    icon: BookUser,
    params: 'asOf',
    description: 'Who owes the shop money, split by how old the debt is.',
    makeRequest: ({ asOf }) => ({ kind: 'customerAging', asOf })
  },
  {
    kind: 'supplierAging',
    group: 'Receivables & payables',
    icon: Truck,
    params: 'asOf',
    description: 'What the shop owes its suppliers, split by age.',
    makeRequest: ({ asOf }) => ({ kind: 'supplierAging', asOf })
  },
  {
    kind: 'leakage',
    group: 'Anti-theft',
    icon: ShieldAlert,
    params: 'period',
    description: 'Voids, refunds, over-threshold discounts and no-sales — by staff member.',
    makeRequest: ({ from, to }) => ({ kind: 'leakage', from, to })
  },
  {
    kind: 'trialBalance',
    group: 'Accounting',
    icon: Scale,
    params: 'asOf',
    description: 'Every account’s debit and credit at a date. It must balance.',
    makeRequest: ({ asOf }) => ({ kind: 'trialBalance', asOf })
  },
  {
    kind: 'profitAndLoss',
    group: 'Accounting',
    icon: FileText,
    params: 'period',
    description: 'Income less expenses for a period.',
    makeRequest: ({ from, to }) => ({ kind: 'profitAndLoss', from, to })
  },
  {
    kind: 'balanceSheet',
    group: 'Accounting',
    icon: Landmark,
    params: 'asOf',
    description: 'Assets, liabilities and equity at a date.',
    makeRequest: ({ asOf }) => ({ kind: 'balanceSheet', asOf })
  },
  {
    kind: 'taxSummary',
    group: 'Accounting',
    icon: Percent,
    params: 'period',
    description: 'Output tax collected less input tax paid — what the shop owes the government.',
    makeRequest: ({ from, to }) => ({ kind: 'taxSummary', from, to })
  },
  {
    kind: 'cashBook',
    group: 'Accounting',
    icon: Wallet,
    params: 'pagedPeriod',
    paged: true,
    description: 'The cash account’s story: opening, every movement, and the closing balance.',
    makeRequest: ({ from, to, page, pageSize }) => ({ kind: 'cashBook', from, to, page, pageSize })
  },
  {
    kind: 'generalLedger',
    group: 'Accounting',
    icon: BookOpen,
    params: 'ledger',
    paged: true,
    description: 'One account, every line over a period, with a running balance.',
    makeRequest: ({ from, to, accountCode, page, pageSize }) => ({
      kind: 'generalLedger',
      from,
      to,
      accountCode,
      page,
      pageSize
    })
  }
]

/** The three families that take a [from, to] period — they share the preset bar and the date boxes. */
function usesPeriod(def: ReportDef): boolean {
  return def.params === 'period' || def.params === 'pagedPeriod' || def.params === 'ledger'
}

/**
 * The server's paging for a paged report, read back OFF THE PAYLOAD — never off renderer state.
 *
 * MAIN is the source of truth for `total`, `page` and `pageSize`: it ran the COUNT. Reading them off the
 * answer means the pager describes the rows actually on screen, even if a request is still in flight or
 * MAIN clamped a page we asked for. `null` for a report MAIN does not page.
 */
function serverPagingOf(
  payload: ReportPayload | null
): { total: number; page: number; pageSize: number } | null {
  if (!payload) return null
  const data = payload.data as Partial<{ total: number; page: number; pageSize: number }>
  if (
    typeof data.total !== 'number' ||
    typeof data.page !== 'number' ||
    typeof data.pageSize !== 'number'
  ) {
    return null
  }
  return { total: data.total, page: data.page, pageSize: data.pageSize }
}

type Preset = 'today' | 'month' | 'year' | 'custom'

const PRESETS: Array<{ label: string; value: Preset }> = [
  { label: 'Today', value: 'today' },
  { label: 'This month', value: 'month' },
  { label: 'This year', value: 'year' },
  { label: 'Custom', value: 'custom' }
]

export function Reports({ currencySymbol }: { currencySymbol: string }): React.JSX.Element {
  const [selectedKind, setSelectedKind] = useState<ReportKind>('salesSummary')

  // The three param families keep their own state, so switching between two period reports (or two
  // as-of reports) keeps the dates you already picked.
  const [period, setPeriod] = useState<{ preset: Preset; from: string; to: string }>({
    preset: 'month',
    from: monthStartIso(),
    to: todayIso()
  })
  const [asOf, setAsOf] = useState<string>(todayIso())
  const [nearExpiry, setNearExpiry] = useState<number | ''>('')
  // The near-expiry REPORT's own window. Deliberately separate from `nearExpiry` (the stock-valuation
  // knob): they are two different reports whose windows a shopkeeper sets independently.
  const [expiryWindow, setExpiryWindow] = useState<number | ''>('')
  // The General Ledger's account. Empty until the accounts load and one is chosen.
  const [accountCode, setAccountCode] = useState<string>('')
  const [accounts, setAccounts] = useState<Account[]>([])

  // The page a SERVER-PAGED report is on. Held here (not in SectionBlock) because a page click has to
  // re-issue the request to MAIN — the rows for page 2 exist only there.
  const [serverPage, setServerPage] = useState({ page: 1, pageSize: 50 })

  const [payload, setPayload] = useState<ReportPayload | null>(null)
  const [activeRequest, setActiveRequest] = useState<ReportRequest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null)
  // Bumped on every successful load so each section's paginator snaps back to page 1 for the new data.
  const [reloadKey, setReloadKey] = useState(0)

  const activeDef: ReportDef = REPORTS.find((r) => r.kind === selectedKind) ?? REPORTS[0]!

  // Only the LATEST run may write to the screen. A quick click from one report to another can leave two
  // fetches in flight; without this guard the slower (older) one could land last and show stale numbers.
  const runSeq = useRef(0)

  const run = useCallback(async (request: ReportRequest): Promise<void> => {
    const seq = ++runSeq.current
    setLoading(true)
    setError(null)
    setPayload(null)
    setActiveRequest(request)

    const result = await window.pos.reports.get(request)
    if (seq !== runSeq.current) return // a newer run superseded this one

    setLoading(false)
    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }
    setPayload(result.data)
    setReloadKey((k) => k + 1)
  }, [])

  // Open on the first report so the screen is never blank.
  useEffect(() => {
    void run({ kind: 'salesSummary', from: period.from, to: period.to })
    // Run once on mount; the click handlers drive every run after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The chart of accounts, for the General Ledger's account picker. Loaded once — it is a small, stable
  // list, and MAIN gates it 'report.view' like every other read on this screen. A failure here is not an
  // error banner: it only means the picker has nothing to offer, which it says itself.
  useEffect(() => {
    let cancelled = false
    void window.pos.ledger.accounts().then((result) => {
      if (cancelled || !result.ok) return
      setAccounts(result.data.filter((account) => account.isActive))
    })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * THE ONE PLACE A REQUEST IS BUILT, for any report, at any page. Every caller — picking a report,
   * hitting Run, clicking a page — goes through here, so a page click cannot accidentally send different
   * dates than the Run button did. `paging` is only consulted by the reports MAIN pages.
   */
  const buildRequest = useCallback(
    (def: ReportDef, paging: { page: number; pageSize: number }): ReportRequest | null => {
      switch (def.params) {
        case 'period':
          return def.makeRequest({ from: period.from, to: period.to })
        case 'pagedPeriod':
          return def.makeRequest({ from: period.from, to: period.to, ...paging })
        case 'asOf':
          return def.makeRequest({ asOf })
        case 'stock':
          return def.makeRequest({ nearExpiryDays: nearExpiry === '' ? undefined : nearExpiry })
        case 'paged':
          return def.makeRequest(paging)
        case 'nearExpiry':
          return def.makeRequest({
            withinDays: expiryWindow === '' ? undefined : expiryWindow,
            ...paging
          })
        case 'ledger':
          // No account chosen yet — there is nothing to ask MAIN for. The picker says so on screen.
          if (!accountCode) return null
          return def.makeRequest({ from: period.from, to: period.to, accountCode, ...paging })
      }
    },
    [period.from, period.to, asOf, nearExpiry, expiryWindow, accountCode]
  )

  /** Run a report from page 1 — what every param change means: a different question, asked afresh. */
  const runFirstPage = useCallback(
    (def: ReportDef): void => {
      const first = { page: 1, pageSize: serverPage.pageSize }
      setServerPage(first)
      const request = buildRequest(def, first)
      if (request) void run(request)
      else setPayload(null)
    },
    [buildRequest, run, serverPage.pageSize]
  )

  function selectReport(def: ReportDef): void {
    setSelectedKind(def.kind)
    // Run immediately with whatever params that family already holds, from the top of the report.
    runFirstPage(def)
  }

  /** A page click on a SERVER-PAGED report: same question, next page — re-asked of MAIN. */
  function goToPage(paging: { page: number; pageSize: number }): void {
    setServerPage(paging)
    const request = buildRequest(activeDef, paging)
    if (request) void run(request)
  }

  // ── Period reports: the quick presets run at once; Custom reveals the two date boxes and waits for
  //    the Run button, so we do not fire a query on every keystroke of a half-typed date.
  function applyPreset(preset: Preset): void {
    if (!usesPeriod(activeDef)) return
    if (preset === 'custom') {
      setPeriod((p) => ({ ...p, preset }))
      return
    }
    const to = todayIso()
    const from = preset === 'today' ? to : preset === 'month' ? monthStartIso() : yearStartIso()
    setPeriod({ preset, from, to })
    // `period` state has not landed yet, so build this run from the dates we just computed — a switch,
    // not a ternary chain, so the compiler narrows each family to its own makeRequest.
    const paging = { page: 1, pageSize: serverPage.pageSize }
    setServerPage(paging)

    let request: ReportRequest | null = null
    switch (activeDef.params) {
      case 'period':
        request = activeDef.makeRequest({ from, to })
        break
      case 'pagedPeriod':
        request = activeDef.makeRequest({ from, to, ...paging })
        break
      case 'ledger':
        request = accountCode ? activeDef.makeRequest({ from, to, accountCode, ...paging }) : null
        break
      default:
        // usesPeriod() has already excluded every other family.
        return
    }
    if (request) void run(request)
  }

  function runCustomPeriod(): void {
    if (!usesPeriod(activeDef)) return
    if (period.from > period.to) {
      notifications.show({
        color: 'orange',
        icon: <TriangleAlert size={18} />,
        title: 'Check the dates',
        message: 'The “from” date is after the “to” date.'
      })
      return
    }
    runFirstPage(activeDef)
  }

  // ── As-of reports: one date, defaulting to today.
  function runAsOf(date: string): void {
    if (activeDef.params !== 'asOf') return
    setAsOf(date)
    void run(activeDef.makeRequest({ asOf: date }))
  }

  // ── The "as of now" reports (stock valuation, low stock, near expiry) and the ledger: no date to
  //    pick, just their own knob. Always from page 1 — a new window is a new question.
  function runNow(): void {
    runFirstPage(activeDef)
  }

  async function exportReport(kind: 'excel' | 'pdf'): Promise<void> {
    if (!activeRequest) return
    setExporting(kind)
    const result =
      kind === 'excel'
        ? await window.pos.reports.exportExcel(activeRequest)
        : await window.pos.reports.exportPdf(activeRequest)
    setExporting(null)

    if (!result.ok) {
      notifications.show({ color: 'red', title: 'The report could not be exported', message: result.error.userMessage })
      return
    }
    if (result.data === null) {
      // They closed the save dialog — not an error, just nothing to report.
      notifications.show({ color: 'gray', title: 'Export cancelled', message: 'No file was saved.' })
      return
    }
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: `${kind === 'excel' ? 'Excel' : 'PDF'} report saved`,
      message: result.data,
      autoClose: 8000
    })
  }

  const view = useMemo(() => (payload ? buildReportView(payload) : null), [payload])
  const canExport = payload !== null && !loading
  // Only a report MAIN pages gets the server pager; for the rest SectionBlock keeps its own.
  const serverPaging = 'paged' in activeDef && activeDef.paged ? serverPagingOf(payload) : null
  // The General Ledger cannot run until an account is named. That is not an error — it is a prompt.
  const awaitingAccount = activeDef.params === 'ledger' && !accountCode

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Reports</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Pick a report on the left, choose the dates, and read it below — or export the exact same figures
          to Excel or PDF. Every number is read straight from the books; nothing here is recomputed.
        </Text>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Left: pick the report ───────────────────────────────────────────── */}
        <Card withBorder padding="sm" style={{ flex: '1 1 230px', maxWidth: 280, minWidth: 210 }}>
          <Stack gap={2}>
            {REPORTS.map((def, i) => {
              const prev = i === 0 ? undefined : REPORTS[i - 1]
              const showGroup = prev?.group !== def.group
              const Icon = def.icon
              const active = def.kind === selectedKind
              return (
                <div key={def.kind}>
                  {showGroup && (
                    <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt={i === 0 ? 0 : 12} mb={4} px={6}>
                      {def.group}
                    </Text>
                  )}
                  <UnstyledButton
                    onClick={() => selectReport(def)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 8,
                      width: '100%',
                      fontWeight: active ? 600 : 400,
                      background: active ? 'var(--mantine-color-default-hover)' : 'transparent'
                    }}
                  >
                    <Icon size={17} style={{ flexShrink: 0 }} />
                    <Text size="sm">{REPORT_TITLES[def.kind]}</Text>
                  </UnstyledButton>
                </div>
              )
            })}
          </Stack>
        </Card>

        {/* ── Right: dates, export, and the report itself ─────────────────────── */}
        <Stack gap="md" style={{ flex: '1 1 520px', minWidth: 0 }}>
          {/* Date / as-of control + the two export buttons */}
          <Card withBorder padding="md">
            <Group justify="space-between" align="flex-end" gap="md" wrap="wrap">
              <div>
                {usesPeriod(activeDef) && (
                  <Stack gap="sm">
                    {/* The General Ledger walks ONE account — pick it before the dates mean anything. */}
                    {activeDef.params === 'ledger' && (
                      <Select
                        label="Account"
                        placeholder={accounts.length === 0 ? 'Loading accounts…' : 'Choose an account'}
                        description="The account whose lines this report walks"
                        searchable
                        disabled={accounts.length === 0}
                        value={accountCode || null}
                        data={accounts.map((account) => ({
                          value: account.code,
                          label: `${account.code} — ${account.name}`
                        }))}
                        onChange={(value) => {
                          if (!value) return
                          setAccountCode(value)
                          const paging = { page: 1, pageSize: serverPage.pageSize }
                          setServerPage(paging)
                          void run(
                            (activeDef as Extract<ReportDef, { params: 'ledger' }>).makeRequest({
                              from: period.from,
                              to: period.to,
                              accountCode: value,
                              ...paging
                            })
                          )
                        }}
                        w={320}
                      />
                    )}
                    <SegmentedControl
                      value={period.preset}
                      onChange={(value) => applyPreset(value as Preset)}
                      data={PRESETS}
                    />
                    {period.preset === 'custom' && (
                      <Group align="flex-end" gap="sm">
                        <TextInput
                          label="From"
                          type="date"
                          value={period.from}
                          onChange={(e) =>
                            setPeriod((p) => ({ ...p, preset: 'custom', from: e.currentTarget.value }))
                          }
                        />
                        <TextInput
                          label="To"
                          type="date"
                          value={period.to}
                          onChange={(e) =>
                            setPeriod((p) => ({ ...p, preset: 'custom', to: e.currentTarget.value }))
                          }
                        />
                        <Button
                          leftSection={<RefreshCw size={16} />}
                          onClick={runCustomPeriod}
                          loading={loading}
                        >
                          Run report
                        </Button>
                      </Group>
                    )}
                  </Stack>
                )}

                {activeDef.params === 'asOf' && (
                  <Group align="flex-end" gap="sm">
                    <TextInput
                      label="As of"
                      type="date"
                      value={asOf}
                      onChange={(e) => setAsOf(e.currentTarget.value)}
                    />
                    <Button variant="default" onClick={() => runAsOf(todayIso())}>
                      Today
                    </Button>
                    <Button
                      leftSection={<RefreshCw size={16} />}
                      onClick={() => runAsOf(asOf)}
                      loading={loading}
                    >
                      Run report
                    </Button>
                  </Group>
                )}

                {activeDef.params === 'stock' && (
                  <Group align="flex-end" gap="sm">
                    <NumberInput
                      label="Near-expiry window (days)"
                      description="Leave blank to use the shop’s setting"
                      placeholder="Shop default"
                      value={nearExpiry}
                      onChange={(value) =>
                        setNearExpiry(value === '' || value === undefined ? '' : Number(value))
                      }
                      min={0}
                      max={3650}
                      allowDecimal={false}
                      w={220}
                    />
                    <Button leftSection={<RefreshCw size={16} />} onClick={runNow} loading={loading}>
                      Run report
                    </Button>
                  </Group>
                )}

                {/* Low stock is "as of now" and takes no knob — the re-order level is the shop's own
                    setting (or the item's override), never something typed here. */}
                {activeDef.params === 'paged' && (
                  <Button leftSection={<RefreshCw size={16} />} onClick={runNow} loading={loading}>
                    Run report
                  </Button>
                )}

                {activeDef.params === 'nearExpiry' && (
                  <Group align="flex-end" gap="sm">
                    <NumberInput
                      label="Expiring within (days)"
                      description="Leave blank to use the shop’s setting"
                      placeholder="Shop default"
                      value={expiryWindow}
                      onChange={(value) =>
                        setExpiryWindow(value === '' || value === undefined ? '' : Number(value))
                      }
                      min={0}
                      max={3650}
                      allowDecimal={false}
                      w={220}
                    />
                    <Button leftSection={<RefreshCw size={16} />} onClick={runNow} loading={loading}>
                      Run report
                    </Button>
                  </Group>
                )}
              </div>

              <Group gap="sm">
                <Button
                  variant="default"
                  leftSection={<FileSpreadsheet size={16} />}
                  disabled={!canExport}
                  loading={exporting === 'excel'}
                  onClick={() => void exportReport('excel')}
                >
                  Export to Excel
                </Button>
                <Button
                  variant="default"
                  leftSection={<FileDown size={16} />}
                  disabled={!canExport}
                  loading={exporting === 'pdf'}
                  onClick={() => void exportReport('pdf')}
                >
                  Export to PDF
                </Button>
              </Group>
            </Group>
          </Card>

          {/* The report */}
          <Card withBorder padding="lg">
            {loading ? (
              <Stack gap={10}>
                <Skeleton height={26} width="40%" />
                <Skeleton height={16} width="60%" />
                <Skeleton height={34} mt="md" />
                <Skeleton height={30} />
                <Skeleton height={30} />
                <Skeleton height={30} />
              </Stack>
            ) : error ? (
              <Alert color="red" icon={<TriangleAlert size={18} />} title="The report could not be built">
                {error}
                <Group mt="sm">
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => activeRequest && void run(activeRequest)}
                  >
                    Try again
                  </Button>
                </Group>
              </Alert>
            ) : awaitingAccount ? (
              <Stack align="center" gap="xs" py="xl">
                <BookOpen size={32} opacity={0.5} />
                <Text fw={600}>Choose an account</Text>
                <Text size="sm" c="dimmed">
                  Pick the account whose ledger you want to read, above.
                </Text>
              </Stack>
            ) : !view ? (
              <Stack align="center" gap="xs" py="xl">
                <BarChart3 size={32} opacity={0.5} />
                <Text fw={600}>Pick a report</Text>
                <Text size="sm" c="dimmed">
                  Choose a report from the list on the left.
                </Text>
              </Stack>
            ) : (
              <Stack gap="lg">
                <div>
                  <Title order={3}>{view.title}</Title>
                  <Text c="dimmed" size="sm" mt={2}>
                    {activeDef.description}
                  </Text>
                  {view.meta.length > 0 && (
                    <Group gap="xs" mt="sm">
                      {view.meta.map((m) => (
                        <Badge key={m.label} variant="light" color={metaColor(m.value)}>
                          {m.label}: {m.value}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </div>

                {view.note && (
                  <Alert color="red" variant="light" icon={<TriangleAlert size={18} />}>
                    {view.note}
                  </Alert>
                )}

                {view.sections.map((section, i) => (
                  <SectionBlock
                    key={i}
                    section={section}
                    currencySymbol={currencySymbol}
                    reloadKey={reloadKey}
                    // MAIN pages these reports, so the pager is the server's and a click re-fetches.
                    // Only the FIRST section carries it: a paged report has exactly one long table.
                    serverPaging={i === 0 ? serverPaging : null}
                    onServerPage={goToPage}
                  />
                ))}
              </Stack>
            )}
          </Card>
        </Stack>
      </div>
    </Stack>
  )
}

/**
 * One titled block of the report: its heading, its table (paginated when long), and its bold TOTAL line.
 * The total is the sum across ALL rows, so it stays pinned in the footer no matter which page you are on.
 *
 * ── TWO KINDS OF PAGING, AND MIXING THEM WOULD HIDE ROWS ─────────────────────────────────────────
 *
 * `serverPaging` present  — MAIN already sent exactly ONE page and told us the real `total`. The rows
 *                           are rendered AS GIVEN (never re-sliced: slicing a page of 50 by another 50
 *                           would drop rows behind a pager that claims to show them), and a page click
 *                           goes back to MAIN for the next page.
 * `serverPaging` null     — the report is unpaged and its rows are all here (a handful of tenders, a
 *                           month of days). The old client-side pager keeps that table readable.
 */
function SectionBlock({
  section,
  currencySymbol,
  reloadKey,
  serverPaging,
  onServerPage
}: {
  section: ReportSection
  currencySymbol: string
  reloadKey: number
  /** The server's `{ total, page, pageSize }` when MAIN pages this report; null when it does not. */
  serverPaging: { total: number; page: number; pageSize: number } | null
  onServerPage: (paging: { page: number; pageSize: number }) => void
}): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // A fresh report (new reloadKey) starts at the top — page 7 of the old data is nonsense here.
  useEffect(() => {
    setPage(1)
  }, [reloadKey])

  // Server-paged: show what MAIN sent, exactly. Client-paged: slice locally as before.
  const clientTotal = section.rows.length
  const totalPages = Math.max(1, Math.ceil(clientTotal / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const clientPaginated = !serverPaging && clientTotal > pageSize
  const visible = clientPaginated
    ? section.rows.slice((safePage - 1) * pageSize, (safePage - 1) * pageSize + pageSize)
    : section.rows
  const minWidth = Math.max(360, section.columns.length * 130)

  return (
    <Stack gap={8}>
      {section.heading && (
        <Text fw={600} size="sm">
          {section.heading}
        </Text>
      )}

      <Table.ScrollContainer minWidth={minWidth}>
        <Table striped withTableBorder highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              {section.columns.map((column, ci) => (
                <Table.Th key={ci} ta={column.align}>
                  {column.header}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>

          <Table.Tbody>
            {visible.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={section.columns.length}>
                  <Text size="sm" c="dimmed" ta="center" py="sm">
                    No rows.
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : (
              visible.map((row, ri) => (
                <Table.Tr key={ri}>
                  {row.map((cell, ci) => (
                    <Table.Td key={ci} ta={section.columns[ci]?.align}>
                      <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatCell(cell, currencySymbol)}
                      </Text>
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))
            )}
          </Table.Tbody>

          {section.totalRow && (
            <Table.Tfoot>
              <Table.Tr>
                {section.totalRow.map((cell, ci) => (
                  <Table.Td
                    key={ci}
                    ta={section.columns[ci]?.align}
                    style={{ borderTop: '2px solid var(--mantine-color-default-border)' }}
                  >
                    <Text size="sm" fw={700} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatCell(cell, currencySymbol)}
                    </Text>
                  </Table.Td>
                ))}
              </Table.Tr>
            </Table.Tfoot>
          )}
        </Table>
      </Table.ScrollContainer>

      {serverPaging ? (
        <Paginator
          page={serverPaging.page}
          pageSize={serverPaging.pageSize}
          total={serverPaging.total}
          onPage={(next) => onServerPage({ page: next, pageSize: serverPaging.pageSize })}
          onPageSize={(size) => onServerPage({ page: 1, pageSize: size })}
          unit="row"
        />
      ) : (
        clientPaginated && (
          <Paginator
            page={safePage}
            pageSize={pageSize}
            total={clientTotal}
            onPage={setPage}
            onPageSize={setPageSize}
            unit="row"
          />
        )
      )}
    </Stack>
  )
}
