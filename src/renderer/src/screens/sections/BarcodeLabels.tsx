import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Barcode as BarcodeIcon, CircleAlert, Printer, Search, Tag } from 'lucide-react'
import type { ProductListItem } from '@shared/catalog'
import { formatMoney } from '@shared/money'

/**
 * BARCODES & LABELS — generate an in-house barcode for a loose item that has none, then print a sheet
 * of peel-and-stick labels. Catalogue-only: generating a barcode never touches stock or the ledger,
 * and printing is an export.
 *
 * The whole flow reads off the items list. An item WITHOUT a barcode shows a "Generate" action; one
 * WITH a barcode can go straight onto a label sheet. "Generate for all without one" fills every gap at
 * once. Then tick the items to print, set how many stickers of each, and print the PDF.
 */
export function BarcodeLabels({
  readOnly,
  currencySymbol,
  onChanged
}: {
  readOnly: boolean
  currencySymbol: string
  /** A generated barcode changes the catalogue — let the parent refresh its own list. */
  onChanged: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<ProductListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [busy, setBusy] = useState(false)

  // Which items are ticked for the label sheet, and how many copies of each. Keyed by product id.
  const [copies, setCopies] = useState<Map<number, number>>(new Map())

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)
    const result = await window.pos.products.list({
      page: 1,
      pageSize: 100,
      search: debounced === '' ? undefined : debounced,
      sortBy: 'name',
      sortDir: 'asc'
    })
    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      return
    }
    setRows(result.data.rows)
  }, [debounced])

  useEffect(() => {
    void load()
  }, [load])

  async function generateOne(productId: number): Promise<void> {
    setBusy(true)
    const result = await window.pos.barcode.generate({ productId })
    setBusy(false)
    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not generate a barcode', message: result.error.userMessage })
      return
    }
    notifications.show({
      color: 'teal',
      icon: <BarcodeIcon size={18} />,
      title: 'Barcode generated',
      message: `${result.data.barcode} — you can print its label now.`
    })
    onChanged()
    void load()
  }

  async function generateAllMissing(): Promise<void> {
    setBusy(true)
    const result = await window.pos.barcode.generateMissing({})
    setBusy(false)
    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not generate barcodes', message: result.error.userMessage })
      return
    }
    notifications.show({
      color: 'teal',
      icon: <BarcodeIcon size={18} />,
      title: 'Barcodes generated',
      message: `Made ${result.data.generated} barcode${result.data.generated === 1 ? '' : 's'}; ${result.data.alreadyHad} item${result.data.alreadyHad === 1 ? '' : 's'} already had one.`
    })
    onChanged()
    void load()
  }

  function toggle(productId: number, checked: boolean): void {
    setCopies((current) => {
      const next = new Map(current)
      if (checked) next.set(productId, next.get(productId) ?? 1)
      else next.delete(productId)
      return next
    })
  }

  function setCount(productId: number, n: number): void {
    setCopies((current) => {
      const next = new Map(current)
      next.set(productId, Math.min(100, Math.max(1, Math.trunc(n) || 1)))
      return next
    })
  }

  async function printLabels(): Promise<void> {
    const items = [...copies.entries()].map(([productId, n]) => ({ productId, copies: n }))
    if (items.length === 0) return
    setBusy(true)
    const result = await window.pos.barcode.printLabels({ items })
    setBusy(false)
    if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not print labels', message: result.error.userMessage })
      return
    }
    if (result.data.printedCount === 0) {
      notifications.show({
        color: 'orange',
        icon: <CircleAlert size={18} />,
        title: 'Nothing to print',
        message:
          result.data.skippedNoBarcode.length > 0
            ? `These items have no barcode yet — generate one first: ${result.data.skippedNoBarcode.join(', ')}.`
            : 'No labels were produced.'
      })
      return
    }
    const skipped =
      result.data.skippedNoBarcode.length > 0
        ? ` Skipped ${result.data.skippedNoBarcode.length} with no barcode.`
        : ''
    notifications.show({
      color: 'teal',
      icon: <Printer size={18} />,
      title: result.data.path ? 'Label sheet saved' : 'Labels ready',
      message: `${result.data.printedCount} label${result.data.printedCount === 1 ? '' : 's'} produced.${skipped}`
    })
    setCopies(new Map())
  }

  const chosen = copies.size
  const missingCount = rows?.filter((r) => r.primaryBarcode === null).length ?? 0

  return (
    <Card withBorder padding="md">
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="sm">
            <Tag size={18} />
            <Text fw={650}>Barcodes &amp; labels</Text>
            <Badge variant="light" color="grape">
              For loose items with no barcode
            </Badge>
          </Group>
          <Group gap="sm">
            <Tooltip
              label={readOnly ? 'Your licence has expired — barcodes cannot be generated' : ''}
              disabled={!readOnly}
            >
              <Button
                variant="light"
                leftSection={<BarcodeIcon size={16} />}
                disabled={readOnly || busy || missingCount === 0}
                onClick={() => void generateAllMissing()}
              >
                Generate for all without one{missingCount > 0 ? ` (${missingCount})` : ''}
              </Button>
            </Tooltip>
            <Button
              leftSection={<Printer size={16} />}
              disabled={busy || chosen === 0}
              onClick={() => void printLabels()}
            >
              Print {chosen > 0 ? `${chosen} ` : ''}label{chosen === 1 ? '' : 's'}
            </Button>
          </Group>
        </Group>

        <Text size="xs" c="dimmed">
          A generated barcode is a valid in-store code your own scanner reads at the till. Items that
          already carry a supplier barcode keep it — only loose items need one made. Printing labels
          works even on an expired licence.
        </Text>

        <TextInput
          placeholder="Search items by name, code or barcode…"
          leftSection={<Search size={16} />}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />

        {error ? (
          <Alert color="red" icon={<CircleAlert size={18} />}>
            {error}
          </Alert>
        ) : rows === null ? (
          <Stack gap={6}>
            <Skeleton height={18} />
            <Skeleton height={18} />
            <Skeleton height={18} />
          </Stack>
        ) : rows.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="md">
            No items found.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Print</Table.Th>
                  <Table.Th>Item</Table.Th>
                  <Table.Th>Barcode</Table.Th>
                  <Table.Th ta="right">Price</Table.Th>
                  <Table.Th ta="right">Copies</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => {
                  const ticked = copies.has(row.id)
                  const hasBarcode = row.primaryBarcode !== null
                  return (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <input
                          type="checkbox"
                          aria-label={`Print label for ${row.name}`}
                          checked={ticked}
                          disabled={!hasBarcode}
                          onChange={(event) => toggle(row.id, event.currentTarget.checked)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{row.name}</Text>
                        <Text size="xs" c="dimmed">
                          {row.sku}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {hasBarcode ? (
                          <Text size="xs" ff="monospace">
                            {row.primaryBarcode}
                          </Text>
                        ) : (
                          <Tooltip
                            label={readOnly ? 'Licence expired' : 'Make an in-store barcode for this item'}
                            disabled={false}
                          >
                            <Button
                              size="compact-xs"
                              variant="light"
                              leftSection={<BarcodeIcon size={13} />}
                              disabled={readOnly || busy}
                              onClick={() => void generateOne(row.id)}
                            >
                              Generate
                            </Button>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">{formatMoney(row.retailPrice, { symbol: currencySymbol })}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <NumberInput
                          size="xs"
                          w={72}
                          min={1}
                          max={100}
                          disabled={!ticked}
                          value={copies.get(row.id) ?? 1}
                          onChange={(value) => setCount(row.id, Number(value))}
                        />
                      </Table.Td>
                    </Table.Tr>
                  )
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Card>
  )
}
