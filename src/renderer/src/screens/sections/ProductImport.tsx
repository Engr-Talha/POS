import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  Radio,
  Stack,
  Table,
  Text,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  CircleAlert,
  CircleCheck,
  Download,
  FileSpreadsheet,
  PackagePlus,
  Pencil,
  Upload
} from 'lucide-react'
import type {
  ImportError,
  OnExisting,
  ProductImportPreview,
  ProductImportRow
} from '@shared/ipc'
import { formatMoney } from '@shared/money'

/**
 * IMPORT PRODUCTS FROM EXCEL — the anytime catalogue importer, on the Items screen.
 *
 * Mirrors OpeningSetup's ImportFromExcel in shape, but this importer is a DIFFERENT thing: it touches
 * ONLY the catalogue. It never posts a journal, never moves stock, never writes cost — so it is safe
 * to run on a live, trading shop, any day, as many times as the owner likes.
 *
 * THE FLOW, and it must never surprise them:
 *   1. Download the template — it already lists every item they have.
 *   2. Choose what happens to items that already exist: SKIP them (safe), or ALSO UPDATE their prices.
 *   3. Upload the filled sheet → PREVIEW: how many new, how many repriced, how many skipped, and every
 *      problem in plain words by row number. NOT ONE ROW IS WRITTEN.
 *   4. Import — the whole file, or none of it. A file with any problem is refused, and MAIN refuses it
 *      again regardless of what this screen does with the button.
 *
 * THE RENDERER NEVER NAMES A FILE. Main opens the dialog, reads the bytes, remembers the pick and the
 * mode. All this screen can say is "the one you chose". (CLAUDE.md §3.)
 *
 * ON AN EXPIRED LICENCE the template and the preview still work; only Import goes. (CLAUDE.md §6.)
 */
export function ProductImport({
  readOnly,
  currencySymbol,
  onImported
}: {
  readOnly: boolean
  currencySymbol: string
  onImported: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<'template' | 'file' | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onExisting, setOnExisting] = useState<OnExisting>('skip')
  const [preview, setPreview] = useState<ProductImportPreview | null>(null)

  async function downloadTemplate(): Promise<void> {
    setBusy('template')
    setError(null)

    const result = await window.pos.productImport.downloadTemplate()
    setBusy(null)

    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }
    if (result.data === null) return // they closed the save dialog — not an error

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

    // WRITES NOTHING — it reads the file and says what WOULD happen, under the mode chosen above.
    const result = await window.pos.productImport.previewImport(onExisting)
    setBusy(null)

    if (!result.ok) {
      setError(result.error.userMessage)
      return
    }
    if (result.data === null) return // they closed the file picker

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
          Adding or repricing a lot of items? Download the sheet — <strong>it already lists every item
          you have</strong> — fill it in, and upload it back. This changes <strong>only your
          catalogue and your selling prices</strong>. It never changes your stock and never changes
          your cost.
        </Text>

        {/* ── The per-import choice for existing items ─────────────────────────── */}
        <Card withBorder mt="md" padding="md" bg="var(--mantine-color-default-hover)">
          <Radio.Group
            label="What should happen to items you already have?"
            description="New items are always added. This is only about items whose stock code already exists."
            value={onExisting}
            onChange={(value) => setOnExisting(value as OnExisting)}
          >
            <Stack gap="xs" mt="sm">
              <Radio
                value="skip"
                label="Skip them (safe) — leave their prices exactly as they are"
              />
              <Radio
                value="update-prices"
                label="Also update their prices — change a price only where your sheet differs"
              />
            </Stack>
          </Radio.Group>
        </Card>

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
              Open it in Excel, fill it in, save it, then press <strong>Upload the filled sheet</strong>.
            </Text>
          </Alert>
        )}

        {error && (
          <Alert color="red" icon={<CircleAlert size={18} />} mt="md" title="That did not work">
            {error}
          </Alert>
        )}

        <Text size="xs" c="dimmed" mt="md">
          You will see exactly what the file would do before any of it happens — how many items are
          new, how many prices would change, and how many would be left alone.
        </Text>
      </Card>

      {preview && (
        <ProductImportPreviewModal
          preview={preview}
          readOnly={readOnly}
          currencySymbol={currencySymbol}
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
 * WHAT THIS FILE WOULD DO — shown before it does any of it. Every figure came back from MAIN, computed
 * by the same code that will do the writing. This screen does no arithmetic of its own.
 */
function ProductImportPreviewModal({
  preview,
  readOnly,
  currencySymbol,
  onClose,
  onReupload,
  onImported
}: {
  preview: ProductImportPreview
  readOnly: boolean
  currencySymbol: string
  onClose: () => void
  onReupload: () => void
  onImported: () => void
}): React.JSX.Element {
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  const problems = preview.errors.length
  const blocked = problems > 0

  async function runImport(): Promise<void> {
    setApplying(true)
    setApplyError(null)

    // Apply under the SAME mode the file was previewed with — main refuses a mismatch and asks for a
    // re-preview, exactly as it does if the file's bytes have changed.
    const result = await window.pos.productImport.applyImport(preview.onExisting)
    setApplying(false)

    if (!result.ok) {
      setApplyError(result.error.userMessage)
      return
    }

    // NULL = main had no remembered file and they closed the picker it offered.
    if (result.data === null) {
      onClose()
      return
    }

    const done = result.data
    notifications.show({
      color: 'teal',
      icon: <CircleCheck size={18} />,
      title: 'Your items are imported',
      message: `${count(done.created, 'new item', 'new items')} added, ${count(done.updated, 'price', 'prices')} updated, ${count(done.skipped, 'item', 'items')} left alone.`,
      autoClose: 8000
    })

    onImported()
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
              skipping the rest would leave you with a catalogue you cannot trust.
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

        {/* ── The counts ─────────────────────────────────────────────────────── */}
        <Group gap="lg">
          <CountTile
            icon={<PackagePlus size={18} />}
            label="New items"
            value={preview.toCreate}
            color="teal"
          />
          <CountTile
            icon={<Pencil size={18} />}
            label="Prices to update"
            value={preview.toUpdate}
            color="blue"
          />
          <CountTile
            icon={<FileSpreadsheet size={18} />}
            label="Left alone"
            value={preview.toSkip}
            color="gray"
          />
        </Group>

        {preview.onExisting === 'skip' && (
          <Alert color="blue" variant="light" icon={<CircleAlert size={18} />}>
            You chose to <strong>skip</strong> items you already have, so their prices will not change.
            Upload again with <strong>Also update their prices</strong> if you want them repriced.
          </Alert>
        )}

        {blocked && <ImportProblems errors={preview.errors} />}

        <LookupsToCreate lookups={preview.lookupsToCreate} />

        <PreviewTable rows={preview.rows} currencySymbol={currencySymbol} />

        {applyError && (
          <Alert color="red" icon={<CircleAlert size={18} />} title="That did not work">
            {applyError}
          </Alert>
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onReupload}>
            Choose a different file
          </Button>
          <Tooltip
            label="Your licence has expired — items cannot be imported until it is renewed"
            disabled={!readOnly}
          >
            <Button
              leftSection={<Upload size={16} />}
              loading={applying}
              disabled={blocked || readOnly}
              onClick={() => void runImport()}
            >
              Import
            </Button>
          </Tooltip>
        </Group>
      </Stack>
    </Modal>
  )
}

function CountTile({
  icon,
  label,
  value,
  color
}: {
  icon: React.ReactNode
  label: string
  value: number
  color: string
}): React.JSX.Element {
  return (
    <Card withBorder padding="md" style={{ minWidth: 160 }}>
      <Group gap="xs" mb={4} c={`var(--mantine-color-${color}-6)`}>
        {icon}
        <Text size="sm" fw={600}>
          {label}
        </Text>
      </Group>
      <Text fz={28} fw={700}>
        {value}
      </Text>
    </Card>
  )
}

/** Every problem in the file, by row number, in the words MAIN chose — verbatim. */
function ImportProblems({ errors }: { errors: ImportError[] }): React.JSX.Element {
  return (
    <Card withBorder padding="lg">
      <Text fw={600} mb="sm">
        Fix these {count(errors.length, 'problem', 'problems')} in the sheet
      </Text>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 70 }}>Row</Table.Th>
            <Table.Th style={{ width: 180 }}>Column</Table.Th>
            <Table.Th>What to fix</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {errors.map((e, index) => (
            <Table.Tr key={`${e.row}-${e.column}-${index}`}>
              <Table.Td>{e.row}</Table.Td>
              <Table.Td>{e.column}</Table.Td>
              <Table.Td>{e.message}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}

/** Departments, categories, brands… the sheet mentions that will be created for new items. */
function LookupsToCreate({
  lookups
}: {
  lookups: ProductImportPreview['lookupsToCreate']
}): React.JSX.Element | null {
  const groups = (Object.entries(lookups) as [string, string[]][]).filter(
    ([, labels]) => labels.length > 0
  )
  if (groups.length === 0) return null

  const nice: Record<string, string> = {
    department: 'Departments',
    category: 'Categories',
    sub_category: 'Sub categories',
    brand: 'Brands',
    location: 'Locations'
  }

  return (
    <Card withBorder padding="lg">
      <Text fw={600} mb="sm">
        New lists that will be created
      </Text>
      <Stack gap="xs">
        {groups.map(([list, labels]) => (
          <Group key={list} gap="xs" wrap="wrap">
            <Text size="sm" fw={600}>
              {nice[list] ?? list}:
            </Text>
            {labels.map((label) => (
              <Badge key={label} variant="light">
                {label}
              </Badge>
            ))}
          </Group>
        ))}
      </Stack>
    </Card>
  )
}

const CLASSIFICATION_LABEL: Record<ProductImportRow['classification'], { text: string; color: string }> =
  {
    create: { text: 'New', color: 'teal' },
    update: { text: 'Price update', color: 'blue' },
    'skip-exists': { text: 'Skipped', color: 'gray' },
    'skip-nochange': { text: 'No change', color: 'gray' },
    error: { text: 'Problem', color: 'red' }
  }

/** Every row and what would happen to it. Prices are 2-dp money — formatMoney, never raw arithmetic. */
function PreviewTable({
  rows,
  currencySymbol
}: {
  rows: ProductImportRow[]
  currencySymbol: string
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <Card withBorder padding="lg">
        <Text c="dimmed" ta="center">
          This sheet has no item rows in it.
        </Text>
      </Card>
    )
  }

  return (
    <Card withBorder padding="lg">
      <Text fw={600} mb="sm">
        Every row ({rows.length})
      </Text>
      <Table.ScrollContainer minWidth={720}>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 70 }}>Row</Table.Th>
              <Table.Th>Stock code</Table.Th>
              <Table.Th>Item name</Table.Th>
              <Table.Th style={{ textAlign: 'right' }}>Retail</Table.Th>
              <Table.Th style={{ textAlign: 'right' }}>Wholesale</Table.Th>
              <Table.Th style={{ width: 130 }}>What happens</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => {
              const tag = CLASSIFICATION_LABEL[row.classification]
              return (
                <Table.Tr key={row.row}>
                  <Table.Td>{row.row}</Table.Td>
                  <Table.Td>{row.sku}</Table.Td>
                  <Table.Td>{row.name || <Text c="dimmed">—</Text>}</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>
                    {row.retailPrice === undefined
                      ? '—'
                      : formatMoney(row.retailPrice, { symbol: currencySymbol })}
                  </Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>
                    {row.wholesalePrice === undefined
                      ? '—'
                      : formatMoney(row.wholesalePrice, { symbol: currencySymbol })}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={tag.color} variant="light">
                      {tag.text}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              )
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  )
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
