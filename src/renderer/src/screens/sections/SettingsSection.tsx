import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { TriangleAlert, Store, Coins, Receipt, CalendarDays } from 'lucide-react'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
].map((name, index) => ({ value: String(index + 1), label: name }))

export function SettingsSection({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.pos.settings.getAll()
      if (!cancelled && result.ok) setSettings(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function save(key: string, value: unknown): Promise<void> {
    const result = await window.pos.settings.set({ key, value })
    if (result.ok) {
      setSettings(result.data)
      notifications.show({ color: 'teal', title: 'Saved', message: key, autoClose: 2000 })
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not save',
        message: result.error.userMessage
      })
    }
  }

  if (!settings) {
    return (
      <Stack gap="md" maw={720}>
        <Skeleton height={30} width={200} />
        <Skeleton height={140} />
        <Skeleton height={140} />
      </Stack>
    )
  }

  const get = <T,>(key: string, fallback: T): T => (settings[key] as T) ?? fallback

  return (
    <Stack gap="lg" maw={720}>
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Changes here are recorded in the audit log — currency, tax and invoice numbering all move
          money.
        </Text>
      </div>

      {/* ── Shop ──────────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Store size={18} />
          <Text fw={600}>Shop</Text>
        </Group>

        <Stack>
          <TextInput
            label="Shop name"
            defaultValue={get('shop.name', '')}
            disabled={readOnly}
            onBlur={(event) => void save('shop.name', event.currentTarget.value)}
          />
          <TextInput
            label="Address"
            defaultValue={get('shop.address', '')}
            disabled={readOnly}
            onBlur={(event) => void save('shop.address', event.currentTarget.value)}
          />
          <Group grow>
            <TextInput
              label="Phone"
              defaultValue={get('shop.phone', '')}
              disabled={readOnly}
              onBlur={(event) => void save('shop.phone', event.currentTarget.value)}
            />
            <TextInput
              label="Tax number (NTN/STRN)"
              description="Printed on the receipt"
              defaultValue={get('shop.taxNumber', '')}
              disabled={readOnly}
              onBlur={(event) => void save('shop.taxNumber', event.currentTarget.value)}
            />
          </Group>
        </Stack>
      </Card>

      {/* ── Currency ──────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Coins size={18} />
          <Text fw={600}>Currency</Text>
        </Group>

        {/* THIS WARNING IS LOAD-BEARING. Changing the currency relabels; it does not convert. An
            owner who switches PKR to USD and assumes their prices converted has just mispriced
            their entire shop by a factor of ~280. */}
        <Alert color="yellow" icon={<TriangleAlert size={18} />} mb="md">
          Changing the currency only changes the <strong>label</strong>. It does{' '}
          <strong>not</strong> convert any of your saved prices — Rs 500 becomes $500, not $1.79. Set
          this once, before you enter your prices.
        </Alert>

        <Group grow>
          <TextInput
            label="Symbol"
            description="Shown before every amount"
            defaultValue={get('currency.symbol', 'Rs')}
            disabled={readOnly}
            onBlur={(event) => void save('currency.symbol', event.currentTarget.value)}
          />
          <TextInput
            label="Code"
            defaultValue={get('currency.code', 'PKR')}
            disabled={readOnly}
            onBlur={(event) => void save('currency.code', event.currentTarget.value)}
          />
        </Group>
      </Card>

      {/* ── Tax ───────────────────────────────────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Receipt size={18} />
          <Text fw={600}>Tax</Text>
        </Group>

        <Stack>
          <Switch
            label="Charge tax on sales"
            checked={get('tax.enabled', true)}
            disabled={readOnly}
            onChange={(event) => void save('tax.enabled', event.currentTarget.checked)}
          />

          <NumberInput
            label="Default tax rate (%)"
            description="Each product can override this. 17% is Pakistan's standard GST."
            defaultValue={get<number>('tax.defaultRateBp', 1700) / 100}
            min={0}
            max={100}
            decimalScale={2}
            disabled={readOnly}
            onBlur={(event) => {
              const percent = Number(event.currentTarget.value)
              if (!Number.isFinite(percent)) return
              // Stored as BASIS POINTS — an integer. 17% -> 1700. Never a float.
              void save('tax.defaultRateBp', Math.round(percent * 100))
            }}
          />

          <Select
            label="Prices are entered…"
            description="Each product can be set the other way; a cart may mix both."
            data={[
              { value: 'exclusive', label: 'Excluding tax (tax added at the till)' },
              { value: 'inclusive', label: 'Including tax (shelf price is what they pay)' }
            ]}
            value={get('tax.defaultMode', 'exclusive')}
            disabled={readOnly}
            allowDeselect={false}
            onChange={(value) => value && void save('tax.defaultMode', value)}
          />
        </Stack>
      </Card>

      {/* ── Invoice numbering & fiscal year ───────────────────────────────── */}
      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <CalendarDays size={18} />
          <Text fw={600}>Invoices &amp; financial year</Text>
        </Group>

        <Stack>
          <Group grow>
            <TextInput
              label="Invoice prefix"
              defaultValue={get('invoice.prefix', 'INV-')}
              disabled={readOnly}
              onBlur={(event) => void save('invoice.prefix', event.currentTarget.value)}
            />
            <NumberInput
              label="Number length"
              description="INV-000001"
              defaultValue={get('invoice.padding', 6)}
              min={1}
              max={12}
              disabled={readOnly}
              onBlur={(event) => void save('invoice.padding', Number(event.currentTarget.value))}
            />
          </Group>

          <Text size="xs" c="dimmed">
            Invoice numbers are always sequential with no gaps. A cancelled invoice keeps its number
            — it is never reused and never renumbered.
          </Text>

          <Select
            label="Financial year starts in"
            description="Pakistan's tax year runs 1 July – 30 June."
            data={MONTHS}
            value={String(get('fiscal.yearStartMonth', 7))}
            disabled={readOnly}
            allowDeselect={false}
            onChange={(value) => value && void save('fiscal.yearStartMonth', Number(value))}
          />
        </Stack>
      </Card>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so settings cannot be changed. You can still view and export
          everything.
        </Alert>
      )}
    </Stack>
  )
}
