import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Card,
  Group,
  NavLink,
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
 *
 * ── AND IT NAVIGATES ITSELF ─────────────────────────────────────────────────────────────────────────
 * The section list is built from SETTING_GROUPS, so a new group appears in the sidebar the moment it is
 * declared. A hand-written nav would be the same trap the hand-written form fields were: a second place
 * to remember, and the one that gets forgotten.
 */

/**
 * The one section that is NOT a settings group. "Close the month" is an ACT, not a knob, so it cannot
 * come from the registry — but it belongs on this screen, and it belongs in this list. The sentinel is
 * prefixed so it can never collide with a real group key.
 */
const PERIODS_SECTION = '__periods'

/**
 * ONE SECTION'S WORTH OF SCREEN. Rendered by both layouts — the sidebar one and the narrow dropdown one
 * — so the two can never drift into showing different things.
 */
function SettingsPanel({
  section,
  grouped,
  settings,
  currencySymbol,
  readOnly,
  isOwner,
  onSave
}: {
  section: string
  grouped: Array<{ group: string; items: SettingDef[] }>
  settings: Record<string, unknown>
  currencySymbol: string
  readOnly: boolean
  isOwner: boolean
  onSave: (key: string, value: unknown) => Promise<void>
}): React.JSX.Element | null {
  /* ── CLOSING THE MONTH ──────────────────────────────────────────────────────
     Not a setting — it is an ACT, and an audited one, so it does not come from
     the registry and must not. It lives on this screen because closing the books
     is the owner's job ('period.manage').

     Owner-only here is a COURTESY, exactly like `ownerOnly` on a field: MAIN
     enforces the permission and refuses a non-owner's lock with a plain sentence
     whether or not this panel was ever drawn (CLAUDE.md §4). */
  if (section === PERIODS_SECTION) {
    return isOwner ? <Periods readOnly={readOnly} /> : null
  }

  const found = grouped.find((g) => g.group === section)
  if (!found) return null

  return (
    <Card withBorder padding="lg">
      <Text fw={600} mb="md">
        {GROUP_LABEL[found.group as keyof typeof GROUP_LABEL]}
      </Text>

      <Stack gap="md">
        {found.items.map((def) => (
          <SettingField
            key={def.key}
            def={def}
            value={settings[def.key]}
            currencySymbol={currencySymbol}
            disabled={readOnly || (def.ownerOnly === true && !isOwner)}
            onSave={onSave}
          />
        ))}
      </Stack>
    </Card>
  )
}

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

  /**
   * WHICH SECTION IS OPEN. One at a time — see the note on the layout below.
   *
   * It is NOT a setting and NOT persisted: "where was I in Settings" is not a shop's preference, it is
   * this minute's context, and restoring it a week later would be a surprise rather than a courtesy.
   * The first group is the landing spot because `shop` is what a new shop fills in first.
   */
  const [section, setSection] = useState<string>(SETTING_GROUPS[0])

  if (!settings) {
    return (
      <Stack gap="md">
        <Skeleton height={30} width={200} />
        <Group align="flex-start" gap="lg" wrap="nowrap">
          <Skeleton height={320} width={220} />
          <Skeleton height={320} style={{ flex: 1, maxWidth: 760 }} />
        </Group>
      </Stack>
    )
  }

  const currencySymbol = (settings['currency.symbol'] as string) ?? 'Rs'

  return (
    // No maw here any more: the 760px belongs to the PANEL, not the page — the sidebar sits beside it.
    <Stack gap="lg">
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

      {/* ── ONE SECTION AT A TIME, DOWN THE SIDE ──────────────────────────────
          Every group used to be stacked in one column, so 34 settings across 12
          sections were one long scroll: the owner hunted for the discount limit
          by dragging a scrollbar past the printer and the backup schedule.

          A SIDEBAR rather than tabs across the top, for one reason: there are
          twelve sections and they are growing (the registry is designed to grow —
          adding a knob is one line in one file). Twelve tabs wrap onto a second
          row and stop looking like tabs; twelve rows down the side are just a
          list, and the app already reads left-to-right from a nav. It also means
          a new group appears here automatically, which is the whole point of the
          screen rendering itself.

          It collapses to a full-width dropdown on a narrow window — a sidebar
          that eats half a 1024px laptop is worse than the scroll it replaced. */}
      <Group align="flex-start" gap="lg" wrap="nowrap" visibleFrom="sm">
        <Card withBorder padding="xs" w={220} style={{ flexShrink: 0 }}>
          <Stack gap={2}>
            {grouped.map(({ group }) => (
              <NavLink
                key={group}
                active={section === group}
                label={GROUP_LABEL[group]}
                onClick={() => setSection(group)}
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
              />
            ))}
            {isOwner && (
              <NavLink
                active={section === PERIODS_SECTION}
                label="Close the month"
                leftSection={<Lock size={16} />}
                onClick={() => setSection(PERIODS_SECTION)}
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
              />
            )}
          </Stack>
        </Card>

        <div style={{ flex: 1, maxWidth: 760 }}>
          <SettingsPanel
            section={section}
            grouped={grouped}
            settings={settings}
            currencySymbol={currencySymbol}
            readOnly={readOnly}
            isOwner={isOwner}
            onSave={save}
          />
        </div>
      </Group>

      {/* The same thing on a narrow window: the list becomes a dropdown. */}
      <Stack gap="lg" hiddenFrom="sm">
        <Select
          label="Section"
          value={section}
          onChange={(value) => value && setSection(value)}
          data={[
            ...grouped.map(({ group }) => ({ value: group, label: GROUP_LABEL[group] })),
            ...(isOwner ? [{ value: PERIODS_SECTION, label: 'Close the month' }] : [])
          ]}
          allowDeselect={false}
        />
        <SettingsPanel
          section={section}
          grouped={grouped}
          settings={settings}
          currencySymbol={currencySymbol}
          readOnly={readOnly}
          isOwner={isOwner}
          onSave={save}
        />
      </Stack>
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
