import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Text,
  Title,
  Skeleton,
  Alert,
  ActionIcon,
  useMantineColorScheme,
  useComputedColorScheme
} from '@mantine/core'
import {
  Store,
  Database,
  RefreshCw,
  Sun,
  Moon,
  CircleCheck,
  CircleAlert,
  WifiOff
} from 'lucide-react'
import type { SystemInfo, DbSelfCheck, UpdateStatus } from '@shared/ipc'

/**
 * PLAIN FLEX LAYOUT — NOT Mantine `AppShell`.
 *
 * AppShell rendered a BLANK SCREEN in the packaged build (trap #9). It works perfectly in dev, which
 * is exactly what makes it dangerous. We do not use it. A header div and a content div in a column
 * flex container cannot break.
 */
export function App(): React.JSX.Element {
  const { setColorScheme } = useMantineColorScheme()
  const computedColorScheme = useComputedColorScheme('light')

  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [dbCheck, setDbCheck] = useState<DbSelfCheck | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [checking, setChecking] = useState(false)

  // Empty deps ON PURPOSE, and nothing in here reaches back into state it also sets.
  // A careless dep here is trap #19 — the re-run that reset auth phase and bounced the user to login.
  // On the Sell screen the same mistake would drop a customer's cart.
  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      const [infoResult, dbResult] = await Promise.all([
        window.pos.system.getInfo(),
        window.pos.system.dbSelfCheck()
      ])
      if (cancelled) return

      if (!infoResult.ok) return setLoadError(infoResult.error.userMessage)
      if (!dbResult.ok) return setLoadError(dbResult.error.userMessage)

      setInfo(infoResult.data)
      setDbCheck(dbResult.data)
    }

    void load()
    const unsubscribe = window.pos.updates.onStatus(setUpdate)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function checkForUpdates(): Promise<void> {
    setChecking(true)
    const result = await window.pos.updates.check()
    if (result.ok) setUpdate(result.data)
    setChecking(false)
  }

  const dark = computedColorScheme === 'dark'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          height: 56,
          flexShrink: 0,
          borderBottom: '1px solid var(--mantine-color-default-border)'
        }}
      >
        <Store size={22} />
        <Text fw={650} size="lg">
          Insha POS
        </Text>

        {/* The version is ALWAYS visible (CLAUDE.md §7) — so we can tell which build a shop is on
            without asking them to find an About box. */}
        {info ? (
          <Badge variant="light" size="sm">
            v{info.appVersion}
          </Badge>
        ) : (
          <Skeleton height={20} width={52} radius="xl" />
        )}
        {info && !info.isPackaged && (
          <Badge variant="light" color="orange" size="sm">
            dev
          </Badge>
        )}

        <div style={{ flex: 1 }} />

        <ActionIcon
          variant="default"
          size="lg"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setColorScheme(dark ? 'light' : 'dark')}
        >
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </ActionIcon>
      </header>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <Stack gap="lg" maw={760}>
          <div>
            <Title order={2}>Phase 0 — Foundation</Title>
            <Text c="dimmed" size="sm" mt={4}>
              The installer and the auto-updater ship before any feature does. Everything below must
              be green in the <strong>packaged</strong> build, not just in dev.
            </Text>
          </div>

          {loadError && (
            <Alert color="red" icon={<CircleAlert size={18} />} title="Could not start up">
              {loadError}
            </Alert>
          )}

          {/* Database — this card is the trap #8 detector. If better-sqlite3 was left inside
              app.asar, it loads fine in dev and dies here in the packaged build. */}
          <Card withBorder padding="lg">
            <Group gap="sm" mb="md">
              <Database size={18} />
              <Text fw={600}>Database</Text>
              {dbCheck && (
                <Badge
                  color={dbCheck.roundTripOk ? 'teal' : 'red'}
                  variant="light"
                  leftSection={
                    dbCheck.roundTripOk ? <CircleCheck size={12} /> : <CircleAlert size={12} />
                  }
                >
                  {dbCheck.roundTripOk ? 'Working' : 'Failed'}
                </Badge>
              )}
            </Group>

            {!dbCheck && !loadError ? (
              <Stack gap={8}>
                <Skeleton height={12} width="70%" />
                <Skeleton height={12} width="45%" />
              </Stack>
            ) : dbCheck ? (
              <Stack gap={6}>
                <Row label="SQLite" value={dbCheck.sqliteVersion} />
                <Row label="Journal mode" value={dbCheck.journalMode.toUpperCase()} />
                <Row label="Foreign keys" value={dbCheck.foreignKeys ? 'ON' : 'OFF'} />
                <Row label="Write + read test" value={dbCheck.roundTripOk ? 'Passed' : 'FAILED'} />
                {info && <Row label="File" value={info.dbPath} mono />}
              </Stack>
            ) : null}
          </Card>

          {/* Auto-update — shipped in v0.1.0 itself (trap #1). Nothing is published yet, so
              "no update found" IS the expected result. Silence is correct. */}
          <Card withBorder padding="lg">
            <Group gap="sm" mb="md">
              <RefreshCw size={18} />
              <Text fw={600}>Automatic updates</Text>
              <UpdateBadge status={update} />
            </Group>

            <Text size="sm" c="dimmed" mb="md">
              The app checks quietly in the background and installs new versions when it closes —
              never in the middle of a sale. Nothing is published yet, so &ldquo;up to date&rdquo; is
              the expected answer.
            </Text>

            <Button
              variant="default"
              leftSection={<RefreshCw size={16} />}
              loading={checking}
              onClick={() => void checkForUpdates()}
            >
              Check for updates
            </Button>
          </Card>

          {info && (
            <Card withBorder padding="lg">
              <Text fw={600} mb="md">
                Build
              </Text>
              <Stack gap={6}>
                <Row label="Version" value={info.appVersion} />
                <Row label="Platform" value={info.platform} />
                <Row label="Packaged" value={info.isPackaged ? 'Yes' : 'No (dev)'} />
                <Row label="Log file" value={info.logPath} mono />
              </Stack>
            </Card>
          )}
        </Stack>
      </main>
    </div>
  )
}

function Row({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" w={130} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      {mono ? (
        <Code style={{ wordBreak: 'break-all' }}>{value}</Code>
      ) : (
        <Text size="sm">{value}</Text>
      )}
    </Group>
  )
}

function UpdateBadge({ status }: { status: UpdateStatus }): React.JSX.Element | null {
  switch (status.state) {
    case 'checking':
      return <Badge variant="light">Checking…</Badge>
    case 'up-to-date':
      return (
        <Badge color="teal" variant="light" leftSection={<CircleCheck size={12} />}>
          Up to date
        </Badge>
      )
    case 'available':
      return <Badge color="blue" variant="light">v{status.version} found</Badge>
    case 'downloading':
      return <Badge color="blue" variant="light">Downloading {status.percent}%</Badge>
    case 'ready':
      return (
        <Badge color="teal" variant="light">
          v{status.version} installs on close
        </Badge>
      )
    case 'error':
      // Offline is the NORMAL state for this app, so this is never alarming — no red, no icon of
      // doom. But it does not SAY "no connection" either: the same state covers a bad signature or
      // a corrupt download, and claiming a network fault we did not diagnose would be a guess
      // dressed up as a fact. "Unavailable" is true in every case.
      return (
        <Badge color="gray" variant="light" leftSection={<WifiOff size={12} />}>
          Update unavailable
        </Badge>
      )
    default:
      return null
  }
}
