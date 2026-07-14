import { useCallback, useEffect, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Plus, Trash2, Lock } from 'lucide-react'
import type { Lookup } from '@shared/types'

/**
 * MANAGE LISTS — the screen behind every dropdown in the app.
 *
 * Nothing in this app has a hardcoded <Select> option. Payment methods, categories, units, reason
 * codes, expense categories — all of them live in the `lookups` table and all of them are edited
 * here, by the shop, without us shipping a new build.
 */
const LISTS = [
  { value: 'payment_method', label: 'Payment methods' },
  { value: 'department', label: 'Departments' },
  { value: 'category', label: 'Categories' },
  { value: 'sub_category', label: 'Sub-categories' },
  { value: 'brand', label: 'Brands' },
  { value: 'location', label: 'Locations' },
  { value: 'uom', label: 'Units of measure' },
  { value: 'void_reason', label: 'Void reasons' },
  { value: 'refund_reason', label: 'Refund reasons' },
  { value: 'discount_reason', label: 'Discount reasons' },
  { value: 'adjustment_reason', label: 'Stock adjustment reasons' },
  { value: 'expense_category', label: 'Expense categories' },
  { value: 'customer_type', label: 'Customer types' },
  { value: 'supplier_type', label: 'Supplier types' }
]

export function Lists({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [listKey, setListKey] = useState('payment_method')
  const [items, setItems] = useState<Lookup[] | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (key: string): Promise<void> => {
    setItems(null)
    const result = await window.pos.lookups.list({ listKey: key })
    setItems(result.ok ? result.data : [])
  }, [])

  useEffect(() => {
    void load(listKey)
  }, [listKey, load])

  async function add(): Promise<void> {
    setBusy(true)
    const result = await window.pos.lookups.add({ listKey, label: newLabel })
    setBusy(false)

    if (result.ok) {
      setNewLabel('')
      void load(listKey)
      notifications.show({ color: 'teal', title: 'Added', message: result.data.label })
    } else {
      notifications.show({ color: 'red', title: 'Could not add', message: result.error.userMessage })
    }
  }

  async function rename(item: Lookup, label: string): Promise<void> {
    if (!label.trim() || label === item.label) return

    // Only the field the form actually edited goes back. We never POST the whole object (trap #18).
    const result = await window.pos.lookups.update({ id: item.id, label })
    if (result.ok) void load(listKey)
    else
      notifications.show({
        color: 'red',
        title: 'Could not rename',
        message: result.error.userMessage
      })
  }

  async function remove(item: Lookup): Promise<void> {
    const result = await window.pos.lookups.deactivate({ id: item.id })
    if (result.ok) void load(listKey)
    else
      notifications.show({
        color: 'red',
        title: 'Could not remove',
        message: result.error.userMessage
      })
  }

  return (
    <Stack gap="lg" maw={720}>
      <div>
        <Title order={2}>Manage lists</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Every dropdown in the app comes from here. Add your own options, or rename the built-in
          ones — &ldquo;Cash&rdquo; can become &ldquo;Naqad&rdquo;.
        </Text>
      </div>

      <Select
        label="List"
        data={LISTS}
        value={listKey}
        onChange={(value) => value && setListKey(value)}
        allowDeselect={false}
      />

      <Card withBorder padding="lg">
        {!items ? (
          <Stack gap={8}>
            <Skeleton height={36} />
            <Skeleton height={36} />
          </Stack>
        ) : (
          <Stack gap="xs">
            {items.length === 0 && (
              <Text size="sm" c="dimmed">
                This list is empty. Add the first option below.
              </Text>
            )}

            {items.map((item) => (
              <Group key={item.id} gap="xs" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  defaultValue={item.label}
                  disabled={readOnly}
                  onBlur={(event) => void rename(item, event.currentTarget.value)}
                />

                {item.isSystem ? (
                  // A built-in the ledger posts on. Renameable, never removable — the code behind it
                  // would lose its footing.
                  <Tooltip label="Built in — you can rename it, but it cannot be removed">
                    <Badge variant="light" color="gray" leftSection={<Lock size={11} />}>
                      built in
                    </Badge>
                  </Tooltip>
                ) : (
                  <Tooltip label="Remove from the dropdown">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={readOnly}
                      onClick={() => void remove(item)}
                      aria-label={`Remove ${item.label}`}
                    >
                      <Trash2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            ))}

            <Group gap="xs" mt="sm" wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                placeholder="Add a new option…"
                value={newLabel}
                disabled={readOnly}
                onChange={(event) => setNewLabel(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newLabel.trim()) void add()
                }}
              />
              <Button
                leftSection={<Plus size={16} />}
                loading={busy}
                disabled={readOnly || !newLabel.trim()}
                onClick={() => void add()}
              >
                Add
              </Button>
            </Group>
          </Stack>
        )}
      </Card>
    </Stack>
  )
}
