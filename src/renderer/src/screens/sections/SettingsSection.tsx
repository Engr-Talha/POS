import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Card,
  Group,
  NumberInput,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
  type MantineColorScheme
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { TriangleAlert, Lock } from 'lucide-react'
import {
  SETTINGS,
  SETTING_GROUPS,
  GROUP_LABEL,
  type SettingDef
} from '@shared/settings-registry'
import { formatMoney, parseMoney } from '@shared/money'
import { Periods } from './Periods'

/**
 * THE SETTINGS SCREEN RENDERS ITSELF.
 *
 * There is not one hand-written form field below. Every control comes from the declaration in
 * src/shared/settings-registry.ts — key, type, default, label, help, group, validation.
 *
 * That is the whole point. The owner asked for "as much as possible configurable", and the only way
 * that stays true a year from now is if adding a knob costs one line in one file, rather than another
 * field, another handler, another default and another place to forget.
 */
export function SettingsSection({
  readOnly,
  isOwner
}: {
  readOnly: boolean
  isOwner: boolean
}): React.JSX.Element {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)
  const { setColorScheme } = useMantineColorScheme()

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

      // Appearance is the one setting you must SEE take effect — saving "Dark" and staying white
      // reads as a broken switch. Every other knob here changes a number the next sale will use;
      // this one changes the screen you are looking at, so apply it on the spot.
      if (key === 'ui.colorScheme') setColorScheme(value as MantineColorScheme)

      notifications.show({ color: 'teal', title: 'Saved', message: key, autoClose: 1500 })
    } else {
      // The message comes from the registry's own validation, so it already reads like a sentence.
      notifications.show({ color: 'red', title: 'Not saved', message: result.error.userMessage })
    }
  }

  const grouped = useMemo(() => {
    return SETTING_GROUPS.map((group) => ({
      group,
      items: SETTINGS.filter((s) => s.group === group)
    })).filter((g) => g.items.length > 0)
  }, [])

  if (!settings) {
    return (
      <Stack gap="md" maw={760}>
        <Skeleton height={30} width={200} />
        <Skeleton height={160} />
        <Skeleton height={160} />
      </Stack>
    )
  }

  const currencySymbol = (settings['currency.symbol'] as string) ?? 'Rs'

  return (
    <Stack gap="lg" maw={760}>
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Changes here are recorded in the audit log — currency, tax and discount limits all move
          money.
        </Text>
      </div>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so settings cannot be changed. You can still view and export
          everything.
        </Alert>
      )}

      {grouped.map(({ group, items }) => (
        <Card withBorder padding="lg" key={group}>
          <Text fw={600} mb="md">
            {GROUP_LABEL[group]}
          </Text>

          <Stack gap="md">
            {items.map((def) => (
              <SettingField
                key={def.key}
                def={def}
                value={settings[def.key]}
                currencySymbol={currencySymbol}
                disabled={readOnly || (def.ownerOnly === true && !isOwner)}
                onSave={save}
              />
            ))}
          </Stack>
        </Card>
      ))}

      {/* ── CLOSING THE MONTH ────────────────────────────────────────────────
          Not a setting — it is an ACT, and an audited one, so it does not come
          from the registry and must not. It lives here because this is the
          owner's screen and closing the books is the owner's job ('period.manage').

          Owner-only here is a COURTESY, exactly like `ownerOnly` on a field
          above: MAIN enforces the permission and refuses a non-owner's lock
          with a plain sentence whether or not this panel was ever drawn
          (CLAUDE.md §4). */}
      {isOwner && <Periods readOnly={readOnly} />}
    </Stack>
  )
}

function SettingField({
  def,
  value,
  currencySymbol,
  disabled,
  onSave
}: {
  def: SettingDef
  value: unknown
  currencySymbol: string
  disabled: boolean
  onSave: (key: string, value: unknown) => Promise<void>
}): React.JSX.Element {
  const label = (
    <Group gap={6}>
      <span>{def.label}</span>
      {def.ownerOnly && <Lock size={12} />}
    </Group>
  )

  const field = ((): React.JSX.Element => {
    switch (def.type) {
      case 'boolean':
        return (
          <Switch
            label={def.label}
            description={def.help}
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(event) => void onSave(def.key, event.currentTarget.checked)}
          />
        )

      case 'select':
        return (
          <Select
            label={label}
            description={def.help}
            data={def.options ?? []}
            value={String(value ?? '')}
            disabled={disabled}
            allowDeselect={false}
            onChange={(next) => {
              if (next == null) return
              // A numeric select (the fiscal-year month) must go back as a NUMBER, not the string
              // the <Select> hands us — the registry validates whole numbers, and "7" is not 7.
              const asNumber = Number(next)
              const original = def.default
              void onSave(def.key, typeof original === 'number' ? asNumber : next)
            }}
          />
        )

      case 'percent':
        return (
          <NumberInput
            label={label}
            description={def.help}
            suffix=" %"
            defaultValue={(Number(value) || 0) / 100}
            min={(def.min ?? 0) / 100}
            max={(def.max ?? 10_000) / 100}
            decimalScale={2}
            disabled={disabled}
            onBlur={(event) => {
              const percent = Number(String(event.currentTarget.value).replace(/[^\d.-]/g, ''))
              if (!Number.isFinite(percent)) return
              // Stored in BASIS POINTS — an integer. 17% -> 1700. Never a float.
              void onSave(def.key, Math.round(percent * 100))
            }}
          />
        )

      case 'money':
        return (
          <TextInput
            label={label}
            description={def.help}
            leftSection={
              <Text size="xs" c="dimmed">
                {currencySymbol}
              </Text>
            }
            defaultValue={formatMoney(Number(value) || 0, { grouping: false })}
            disabled={disabled}
            onBlur={(event) => {
              // Through parseMoney, like every other amount in the app — so a typed value becomes an
              // INTEGER number of paisa, and a value that will not convert exactly is refused rather
              // than rounded.
              const minor = parseMoney(event.currentTarget.value)
              if (minor == null) {
                notifications.show({
                  color: 'red',
                  title: 'Not saved',
                  message: `${def.label} must be an amount, like 500 or 500.50`
                })
                return
              }
              void onSave(def.key, minor)
            }}
          />
        )

      case 'number':
        return (
          <NumberInput
            label={label}
            description={def.help}
            defaultValue={Number(value) || 0}
            min={def.min}
            max={def.max}
            allowDecimal={false}
            disabled={disabled}
            onBlur={(event) => {
              const n = Number(String(event.currentTarget.value).replace(/[^\d-]/g, ''))
              if (!Number.isSafeInteger(n)) return
              void onSave(def.key, n)
            }}
          />
        )

      case 'text':
      default:
        return (
          <TextInput
            label={label}
            description={def.help}
            defaultValue={String(value ?? '')}
            disabled={disabled}
            onBlur={(event) => void onSave(def.key, event.currentTarget.value)}
          />
        )
    }
  })()

  return (
    <div>
      {field}

      {/* A warning is declared in the registry only where getting it wrong costs real money — so it
          stays rare enough that people still read it. */}
      {def.warning && (
        <Alert color="yellow" icon={<TriangleAlert size={16} />} mt="xs" p="xs">
          <Text size="xs">{def.warning}</Text>
        </Alert>
      )}
    </div>
  )
}
