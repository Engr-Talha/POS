import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Pagination,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import {
  Barcode as BarcodeIcon,
  CircleAlert,
  PackageOpen,
  PackagePlus,
  Search,
  TriangleAlert
} from 'lucide-react'
import type { ProductListItem } from '@shared/catalog'
import { formatMoney } from '@shared/money'
import { formatQty } from '@shared/qty'
import { LookupSelect, ProductForm } from './ProductForm'

/**
 * THE PRODUCTS LIST.
 *
 * Paginated and indexed, because this shop will have 100k rows one day and an unbounded SELECT *
 * would take the whole app down with it (CLAUDE.md §4). Search matches stock code, item name, the
 * Urdu name, and every barcode the item has ever carried — including the retired ones, because a
 * tin on the shelf still wears its old label.
 *
 * The on-hand figure is DERIVED (SUM of stock movements) and comes down with the row, so the list
 * costs one call, not one-plus-N.
 */

const PAGE_SIZE = 25

export function Products({
  readOnly,
  currencySymbol
}: {
  readOnly: boolean
  currencySymbol: string
}): React.JSX.Element {
  // null = the list; a number = that item; 'new' = a blank form.
  const [open, setOpen] = useState<number | 'new' | null>(null)
  // Bumped whenever an item is saved, so the list refetches when we come back to it rather than
  // showing the figures it happened to load ten minutes ago.
  const [version, setVersion] = useState(0)

  if (open !== null) {
    return (
      <ProductForm
        productId={open === 'new' ? null : open}
        readOnly={readOnly}
        currencySymbol={currencySymbol}
        onClose={() => setOpen(null)}
        onSaved={(productId) => {
          // Saving does NOT close the form. A new item swaps to edit mode in place, which is what
          // unlocks its barcodes and its opening stock — the two things you want next.
          setOpen(productId)
          setVersion((current) => current + 1)
        }}
      />
    )
  }

  return (
    <ProductList
      readOnly={readOnly}
      currencySymbol={currencySymbol}
      version={version}
      onOpen={setOpen}
    />
  )
}

function ProductList({
  readOnly,
  currencySymbol,
  version,
  onOpen
}: {
  readOnly: boolean
  currencySymbol: string
  version: number
  onOpen: (target: number | 'new') => void
}): React.JSX.Element {
  const [rows, setRows] = useState<ProductListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [belowReorderOnly, setBelowReorderOnly] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)

  // A scanner types a whole barcode in a few milliseconds and finishes with Enter. Debouncing keeps
  // us from firing a query per character while still feeling instant to a human typing a name.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  // Any change to a filter puts us back on page 1 — page 7 of a different result set is nonsense.
  useEffect(() => {
    setPage(1)
  }, [debounced, categoryId, belowReorderOnly, includeInactive])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.products.list({
      page,
      pageSize: PAGE_SIZE,
      search: debounced === '' ? undefined : debounced,
      categoryId: categoryId ?? undefined,
      belowReorderOnly: belowReorderOnly || undefined,
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
  }, [page, debounced, categoryId, belowReorderOnly, includeInactive])

  useEffect(() => {
    void load()
  }, [load, version])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtered = debounced !== '' || categoryId !== null || belowReorderOnly || includeInactive

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Items</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Your catalogue. Search by stock code, name, Urdu name or barcode — old barcodes still
            find their item.
          </Text>
        </div>

        <Tooltip label="Your licence has expired — items cannot be added" disabled={!readOnly}>
          <Button
            leftSection={<PackagePlus size={16} />}
            disabled={readOnly}
            onClick={() => onOpen('new')}
          >
            New item
          </Button>
        </Tooltip>
      </Group>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <Card withBorder padding="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <TextInput
            style={{ flex: 1, minWidth: 260 }}
            label="Search"
            placeholder="Stock code, name, or scan a barcode…"
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

          <Stack gap={6} pb={6}>
            <Switch
              label="Only low stock"
              checked={belowReorderOnly}
              onChange={(event) => setBelowReorderOnly(event.currentTarget.checked)}
            />
            <Switch
              label="Show retired items"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.currentTarget.checked)}
            />
          </Stack>
        </Group>
      </Card>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
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
            <PackageOpen size={32} opacity={0.5} />
            <Text fw={600}>{filtered ? 'Nothing matches that' : 'No items yet'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              {filtered
                ? 'Try a different search, or clear the filters above.'
                : 'Your catalogue is empty. Add your first item and it will be sellable straight away.'}
            </Text>
            {!filtered && (
              <Button
                mt="sm"
                leftSection={<PackagePlus size={16} />}
                disabled={readOnly}
                onClick={() => onOpen('new')}
              >
                New item
              </Button>
            )}
          </Stack>
        ) : (
          <>
            <Group justify="space-between" mb="sm">
              <Text size="sm" c="dimmed">
                {total} {total === 1 ? 'item' : 'items'}
              </Text>
            </Group>

            <Table.ScrollContainer minWidth={900}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Stock code</Table.Th>
                    <Table.Th>Item</Table.Th>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Barcode</Table.Th>
                    <Table.Th ta="right">Retail</Table.Th>
                    <Table.Th ta="right">On hand</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr
                      key={row.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onOpen(row.id)}
                    >
                      <Table.Td>
                        <Text ff="monospace" size="sm">
                          {row.sku}
                        </Text>
                      </Table.Td>

                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <div>
                            <Text size="sm" fw={500}>
                              {row.name}
                            </Text>
                            {row.nameOtherLang && (
                              <Text size="xs" c="dimmed" dir="auto">
                                {row.nameOtherLang}
                              </Text>
                            )}
                          </div>
                          {!row.isActive && (
                            <Badge size="xs" variant="light" color="gray">
                              retired
                            </Badge>
                          )}
                          {row.itemType === 'non_inventory' && (
                            <Badge size="xs" variant="light" color="grape">
                              no stock
                            </Badge>
                          )}
                        </Group>
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" c={row.categoryLabel ? undefined : 'dimmed'}>
                          {row.categoryLabel ?? '—'}
                        </Text>
                      </Table.Td>

                      <Table.Td>
                        {row.primaryBarcode ? (
                          <Group gap={4} wrap="nowrap">
                            <BarcodeIcon size={13} opacity={0.6} />
                            <Text ff="monospace" size="sm">
                              {row.primaryBarcode}
                            </Text>
                          </Group>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>

                      <Table.Td ta="right">
                        <Text size="sm">
                          {formatMoney(row.retailPrice, { symbol: currencySymbol })}
                        </Text>
                      </Table.Td>

                      {/* DERIVED from stock movements — there is no stock column to read. */}
                      <Table.Td ta="right">
                        {row.itemType === 'non_inventory' ? (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        ) : (
                          <Group gap={6} justify="flex-end" wrap="nowrap">
                            {row.isBelowReorder && (
                              <Tooltip
                                label={`At or below the re-order level of ${formatQty(row.minStockM)}`}
                              >
                                <Badge
                                  size="xs"
                                  color="orange"
                                  variant="light"
                                  leftSection={<TriangleAlert size={10} />}
                                >
                                  low
                                </Badge>
                              </Tooltip>
                            )}
                            <Text
                              size="sm"
                              fw={600}
                              c={
                                row.onHandM < 0
                                  ? 'red'
                                  : row.isBelowReorder
                                    ? 'orange'
                                    : undefined
                              }
                            >
                              {formatQty(row.onHandM)}
                            </Text>
                          </Group>
                        )}
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
