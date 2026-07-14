import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  useComputedColorScheme,
  useMantineColorScheme
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  Store,
  Sun,
  Moon,
  LogOut,
  Save,
  FolderOpen,
  ShieldAlert,
  Clock,
  ScrollText,
  ListChecks,
  CircleCheck
} from 'lucide-react'
import type { AppState } from '@shared/app-state'
import type { AuditEntry, Lookup } from '@shared/types'
import { ROLE_LABEL } from '@shared/rbac'
import { LicenseBanner } from '../components/LicenseBanner'

/**
 * PLAIN FLEX LAYOUT — NOT Mantine `AppShell`, which rendered a BLANK SCREEN in the packaged build
 * while working perfectly in dev (trap #9). A header div and a content div cannot break.
 */
export function Home({
  state,
  onStateChange
}: {
  state: AppState
  onStateChange: (state: AppState) => void
}): React.JSX.Element {
  const { setColorScheme } = useMantineColorScheme()
  const dark = useComputedColorScheme('light') === 'dark'

  const [version, setVersion] = useState<string | null>(null)
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [paymentMethods, setPaymentMethods] = useState<Lookup[] | null>(null)
  const [backingUp, setBackingUp] = useState(false)

  const user = state.session?.user

  // Runs once. Nothing in here feeds back into its own dependencies (trap #19).
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const [info, auditResult, methods] = await Promise.all([
        window.pos.system.getInfo(),
        window.pos.audit.list({ page: 1, pageSize: 10 }),
        window.pos.lookups.list({ listKey: 'payment_method' })
      ])
      if (cancelled) return

      if (info.ok) setVersion(info.data.appVersion)
      // A Cashier is not allowed to read the audit log. That is a refusal, not an error — show an
      // empty list rather than shouting at someone for a button they were shown.
      setAudit(auditResult.ok ? auditResult.data.rows : [])
      setPaymentMethods(methods.ok ? methods.data : [])
    })()

    return () => {
      cancelled = true
    }
  }, [])

  async function signOut(): Promise<void> {
    const result = await window.pos.auth.signOut()
    if (result.ok) onStateChange(result.data)
  }

  async function runBackup(): Promise<void> {
    setBackingUp(true)
    const result = await window.pos.backup.run()
    setBackingUp(false)

    if (result.ok) {
      notifications.show({
        color: 'teal',
        icon: <CircleCheck size={18} />,
        title: 'Backup saved and verified',
        message: result.data.path,
        autoClose: 6000
      })
    } else {
      notifications.show({
        color: 'red',
        title: 'Backup failed',
        message: result.error.userMessage // never a stack trace
      })
    }
  }

  async function chooseFolder(): Promise<void> {
    const result = await window.pos.backup.chooseFolder()
    if (result.ok && result.data) {
      notifications.show({ title: 'Backup folder set', message: result.data })
    } else if (!result.ok) {
      notifications.show({ color: 'red', title: 'Could not set folder', message: result.error.userMessage })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
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

        {/* The version is ALWAYS visible, so we can tell which build a shop is on without asking. */}
        {version ? (
          <Badge variant="light" size="sm">
            v{version}
          </Badge>
        ) : (
          <Skeleton height={20} width={52} radius="xl" />
        )}

        {state.readOnly && (
          <Badge color="orange" variant="filled" size="sm" leftSection={<ShieldAlert size={12} />}>
            READ-ONLY
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

        {user && (
          <Menu position="bottom-end">
            <Menu.Target>
              <Button variant="default" size="sm">
                {user.fullName}
                <Badge ml={8} size="xs" variant="light">
                  {ROLE_LABEL[user.role]}
                </Badge>
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<LogOut size={14} />} onClick={() => void signOut()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </header>

      <main style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <Stack gap="lg" maw={860}>
          <LicenseBanner license={state.license} />

          <div>
            <Title order={2}>Phase 1 — Foundation</Title>
            <Text c="dimmed" size="sm" mt={4}>
              Database, migrations, backup, users and roles, audit log, and the licence. The sell
              screen comes next.
            </Text>
          </div>

          {/* ── Backup ─────────────────────────────────────────────────────── */}
          <Card withBorder padding="lg">
            <Group gap="sm" mb="xs">
              <Save size={18} />
              <Text fw={600}>Backup</Text>
            </Group>

            <Text size="sm" c="dimmed" mb="md">
              One click. The backup is written and then <strong>opened and verified</strong> — an
              unchecked backup is a rumour. Save it to a USB drive: a backup on the same failing disk
              is not a backup.
              {state.readOnly && ' Backups keep working even though the licence has expired.'}
            </Text>

            <Group>
              <Button leftSection={<Save size={16} />} loading={backingUp} onClick={() => void runBackup()}>
                Back up now
              </Button>
              <Button
                variant="default"
                leftSection={<FolderOpen size={16} />}
                onClick={() => void chooseFolder()}
              >
                Choose folder
              </Button>
            </Group>
          </Card>

          {/* ── Lookups ────────────────────────────────────────────────────── */}
          <Card withBorder padding="lg">
            <Group gap="sm" mb="xs">
              <ListChecks size={18} />
              <Text fw={600}>Payment methods</Text>
            </Group>

            <Text size="sm" c="dimmed" mb="md">
              Every dropdown in this app is data-driven — nothing is hardcoded. The shop can add its
              own, and rename the built-in ones (&ldquo;Cash&rdquo; → &ldquo;Naqad&rdquo;).
            </Text>

            {!paymentMethods ? (
              <Skeleton height={32} />
            ) : (
              <Group gap="xs">
                {paymentMethods.map((method) => (
                  <Badge key={method.id} variant="light" size="lg">
                    {method.label}
                  </Badge>
                ))}
              </Group>
            )}
          </Card>

          {/* ── Audit log ──────────────────────────────────────────────────── */}
          <Card withBorder padding="lg">
            <Group gap="sm" mb="xs">
              <ScrollText size={18} />
              <Text fw={600}>Audit log</Text>
            </Group>

            <Text size="sm" c="dimmed" mb="md">
              Who did what, and when — with the role they held <em>at the time</em>. Append-only.
            </Text>

            {!audit ? (
              <Stack gap={8}>
                <Skeleton height={14} />
                <Skeleton height={14} width="80%" />
              </Stack>
            ) : audit.length === 0 ? (
              <Text size="sm" c="dimmed">
                Nothing recorded yet.
              </Text>
            ) : (
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>When</Table.Th>
                    <Table.Th>Who</Table.Th>
                    <Table.Th>Role</Table.Th>
                    <Table.Th>Action</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {audit.map((entry) => (
                    <Table.Tr key={entry.id}>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Clock size={13} />
                          <Text size="sm">{new Date(entry.at).toLocaleString()}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>{entry.userName}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light">
                          {entry.userRole}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text ff="monospace" size="sm">
                          {entry.action}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Card>
        </Stack>
      </main>
    </div>
  )
}
