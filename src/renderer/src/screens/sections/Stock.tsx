import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Pagination,
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
import {
  Boxes,
  CalendarClock,
  CircleAlert,
  Info,
  PackageOpen,
  Search,
  SlidersHorizontal,
  TrendingDown,
  TriangleAlert
} from 'lucide-react'
import type { StockLevel } from '@shared/catalog'
import type { NearExpiryItem } from '@shared/ipc'
import { formatMoney } from '@shared/money'
import { formatCost } from '@shared/cost'
import { formatQty } from '@shared/qty'
import { AdjustStockModal, LookupSelect } from './ProductForm'

/**
 * STOCK.
 *
 * Every figure on this screen is DERIVED: on-hand is SUM(stock_movements.qty_m), re-summed on read.
 * There is no stock column to edit, and nothing here writes one. The single button that changes
 * stock — "Adjust" — posts a movement with a reason code and the cashier's name on it, and the
 * balance re-adds itself from the history. That is the whole design, and it is why the balance can
 * never disagree with the movements behind it.
 */

const PAGE_SIZE = 25

type Target = { id: number; name: string; sku: string; onHandM: number }

export function Stock({
  readOnly,
  currencySymbol
}: {
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  const [tab, setTab] = useState<string | null>('levels')
  const [adjusting, setAdjusting] = useState<Target | null>(null)
  // Bumped after a movement is posted, to make every tab reload its derived figures.
  const [version, setVersion] = useState(0)

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Stock</Title>
        <Text c="dimmed" size="sm" mt={4}>
          What you have, what is running out, and what is about to expire. Every number here is added
          up from your stock movements — none of it is typed in.
        </Text>
      </div>

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="levels" leftSection={<Boxes size={15} />}>
            Stock levels
          </Tabs.Tab>
          <Tabs.Tab value="low" leftSection={<TrendingDown size={15} />}>
            Low stock
          </Tabs.Tab>
          <Tabs.Tab value="expiry" leftSection={<CalendarClock size={15} />}>
            Near expiry
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="levels" pt="lg">
          <Levels
            readOnly={readOnly}
            currencySymbol={currencySymbol}
            version={version}
            onAdjust={setAdjusting}
          />
        </Tabs.Panel>

        <Tabs.Panel value="low" pt="lg">
          <LowStock
            readOnly={readOnly}
            currencySymbol={currencySymbol}
            version={version}
            onAdjust={setAdjusting}
          />
        </Tabs.Panel>

        <Tabs.Panel value="expiry" pt="lg">
          <NearExpiry currencySymbol={currencySymbol} version={version} />
        </Tabs.Panel>
      </Tabs>

      <AdjustStockModal
        opened={adjusting !== null}
        onClose={() => setAdjusting(null)}
        product={adjusting}
        onDone={() => setVersion((current) => current + 1)}
      />
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A stock-level table, shared by the "levels" and "low stock" tabs.
// ─────────────────────────────────────────────────────────────────────────────

function LevelsTable({
  rows,
  currencySymbol,
  readOnly,
  onAdjust
}: {
  rows: StockLevel[]
  currencySymbol: string
  readOnly: boolean
  onAdjust: (target: Target) => void
}): React.JSX.Element {
  return (
    <Table.ScrollContainer minWidth={880}>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Stock code</Table.Th>
            <Table.Th>Item</Table.Th>
            <Table.Th ta="right">On hand</Table.Th>
            <Table.Th ta="right">Re-order at</Table.Th>
            <Table.Th ta="right">Average cost</Table.Th>
            <Table.Th ta="right">Value</Table.Th>
            <Table.Th w={110} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.productId}>
              <Table.Td>
                <Text ff="monospace" size="sm">
                  {row.sku}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{row.name}</Text>
              </Table.Td>

              <Table.Td ta="right">
                <Group gap={6} justify="flex-end" wrap="nowrap">
                  {row.onHandM < 0 && (
                    <Tooltip label="Below zero. Allowed, but flagged — it means something was sold that was not there.">
                      <Badge size="xs" color="red" variant="light">
                        negative
                      </Badge>
                    </Tooltip>
                  )}
                  {row.isBelowReorder && row.onHandM >= 0 && (
                    <Badge
                      size="xs"
                      color="orange"
                      variant="light"
                      leftSection={<TriangleAlert size={10} />}
                    >
                      low
                    </Badge>
                  )}
                  <Text
                    size="sm"
                    fw={600}
                    c={row.onHandM < 0 ? 'red' : row.isBelowReorder ? 'orange' : undefined}
                  >
                    {formatQty(row.onHandM)}
                  </Text>
                </Group>
              </Table.Td>

              <Table.Td ta="right">
                <Text size="sm" c="dimmed">
                  {formatQty(row.minStockM)}
                </Text>
              </Table.Td>

              <Table.Td ta="right">
                <Text size="sm">{formatCost(row.avgCost, { symbol: currencySymbol })}</Text>
              </Table.Td>

              <Table.Td ta="right">
                <Text size="sm">{formatMoney(row.stockValueMinor, { symbol: currencySymbol })}</Text>
              </Table.Td>

              <Table.Td>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<SlidersHorizontal size={13} />}
                  disabled={readOnly}
                  onClick={() =>
                    onAdjust({
                      id: row.productId,
                      name: row.name,
                      sku: row.sku,
                      onHandM: row.onHandM
                    })
                  }
                >
                  Adjust
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock levels
// ─────────────────────────────────────────────────────────────────────────────

function Levels({
  readOnly,
  currencySymbol,
  version,
  onAdjust
}: {
  readOnly: boolean
  currencySymbol: string
  version: number
  onAdjust: (target: Target) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<StockLevel[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [includeInactive, setIncludeInactive] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, categoryId, includeInactive])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.stock.levels({
      page,
      pageSize: PAGE_SIZE,
      search: debounced === '' ? undefined : debounced,
      categoryId: categoryId ?? undefined,
      includeInactive: includeInactive || undefined,
      sortBy: 'name',
      sortDir: 'asc'
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, debounced, categoryId, includeInactive])

  useEffect(() => {
    void load()
  }, [load, version])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtered = debounced !== '' || categoryId !== null

  return (
    <Stack gap="lg">
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <TextInput
            style={{ flex: 1, minWidth: 240 }}
            label="Search"
            placeholder="Stock code or item name…"
            leftSection={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />

          <div style={{ minWidth: 220 }}>
            <LookupSelect
              listKey="category"
              label="Category"
              placeholder="All categories"
              value={categoryId}
              onChange={setCategoryId}
              allowAdd={false}
            />
          </div>

          <Switch
            pb={8}
            label="Show retired items"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.currentTarget.checked)}
          />
        </Group>
      </Card>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="Stock could not be loaded">
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
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <PackageOpen size={32} opacity={0.5} />
            <Text fw={600}>{filtered ? 'Nothing matches that' : 'No items yet'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              {filtered
                ? 'Try a different search, or clear the filters above.'
                : 'Add items on the Items screen and their stock will show up here.'}
            </Text>
          </Stack>
        ) : (
          <>
            <Text size="sm" c="dimmed" mb="sm">
              {total} {total === 1 ? 'item' : 'items'}
            </Text>

            <LevelsTable
              rows={rows}
              currencySymbol={currencySymbol}
              readOnly={readOnly}
              onAdjust={onAdjust}
            />

            {pages > 1 && (
              <Group justify="center" mt="lg">
                <Pagination value={page} onChange={setPage} total={pages} size="sm" />
              </Group>
            )}
          </>
        )}
      </Card>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Low stock — the re-order report
// ─────────────────────────────────────────────────────────────────────────────

function LowStock({
  readOnly,
  currencySymbol,
  version,
  onAdjust
}: {
  readOnly: boolean
  currencySymbol: string
  version: number
  onAdjust: (target: Target) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<StockLevel[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.stock.lowStock({
      page,
      pageSize: PAGE_SIZE,
      sortBy: 'on_hand',
      sortDir: 'asc'
    })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page])

  useEffect(() => {
    void load()
  }, [load, version])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Stack gap="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        Everything at or below its re-order level — the list you take to your supplier. Set the
        re-order level on each item, under Balance quantity.
      </Alert>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The list could not be loaded">
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
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <Boxes size={32} opacity={0.5} />
            <Text fw={600}>Nothing is running low</Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              Every item is above its re-order level. If that seems too good to be true, check that
              your re-order levels are actually set.
            </Text>
          </Stack>
        ) : (
          <>
            <Text size="sm" c="dimmed" mb="sm">
              {total} {total === 1 ? 'item needs' : 'items need'} re-ordering
            </Text>

            <LevelsTable
              rows={rows}
              currencySymbol={currencySymbol}
              readOnly={readOnly}
              onAdjust={onAdjust}
            />

            {pages > 1 && (
              <Group justify="center" mt="lg">
                <Pagination value={page} onChange={setPage} total={pages} size="sm" />
              </Group>
            )}
          </>
        )}
      </Card>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Near expiry
// ─────────────────────────────────────────────────────────────────────────────

function NearExpiry({
  currencySymbol,
  version
}: {
  currencySymbol: string
  version: number
}): React.JSX.Element {
  const [rows, setRows] = useState<NearExpiryItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [days, setDays] = useState(30)

  useEffect(() => {
    setPage(1)
  }, [days])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.stock.nearExpiry({ days, page, pageSize: PAGE_SIZE })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [days, page])

  useEffect(() => {
    void load()
  }, [load, version])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const atRisk = (rows ?? []).reduce((sum, row) => sum + row.valueMinor, 0)

  return (
    <Stack gap="lg">
      <Alert color="blue" icon={<Info size={18} />}>
        Batches that expire soon — and every batch already past its date. Only items with{' '}
        <strong>Track batches</strong> switched on appear here.
      </Alert>

      <Card withBorder padding="md">
        <Group align="flex-end" gap="md">
          <NumberInput
            label="Expiring within"
            description="Days from today"
            value={days}
            min={0}
            max={3650}
            allowDecimal={false}
            w={200}
            onChange={(value) => {
              const next = typeof value === 'number' ? value : Number(value)
              if (Number.isFinite(next)) setDays(Math.max(0, Math.trunc(next)))
            }}
          />
        </Group>
      </Card>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The list could not be loaded">
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
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <CalendarClock size={32} opacity={0.5} />
            <Text fw={600}>Nothing is expiring</Text>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              No tracked batch expires in the next {days} {days === 1 ? 'day' : 'days'}.
            </Text>
          </Stack>
        ) : (
          <>
            <Group justify="space-between" mb="sm">
              <Text size="sm" c="dimmed">
                {total} {total === 1 ? 'batch' : 'batches'}
              </Text>
              <Text size="sm">
                On this page:{' '}
                <strong>{formatMoney(atRisk, { symbol: currencySymbol })}</strong> at risk
              </Text>
            </Group>

            <Table.ScrollContainer minWidth={820}>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Stock code</Table.Th>
                    <Table.Th>Item</Table.Th>
                    <Table.Th>Batch</Table.Th>
                    <Table.Th>Expires</Table.Th>
                    <Table.Th ta="right">On hand</Table.Th>
                    <Table.Th ta="right">Value</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.batchId}>
                      <Table.Td>
                        <Text ff="monospace" size="sm">
                          {row.sku}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{row.name}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text ff="monospace" size="sm">
                          {row.batchNo}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm">{row.expiryDate}</Text>
                          {row.expired ? (
                            <Badge size="xs" color="red" variant="light">
                              expired
                            </Badge>
                          ) : (
                            <Badge
                              size="xs"
                              color={row.daysToExpiry <= 7 ? 'orange' : 'gray'}
                              variant="light"
                            >
                              {row.daysToExpiry} {row.daysToExpiry === 1 ? 'day' : 'days'}
                            </Badge>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={600}>
                          {formatQty(row.onHandM)}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c={row.expired ? 'red' : undefined}>
                          {formatMoney(row.valueMinor, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            {pages > 1 && (
              <Group justify="center" mt="lg">
                <Pagination value={page} onChange={setPage} total={pages} size="sm" />
              </Group>
            )}
          </>
        )}
      </Card>
    </Stack>
  )
}
