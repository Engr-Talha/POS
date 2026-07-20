import { useEffect, useState } from 'react'
import { Button, Card, Code, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { FolderOpen, Save } from 'lucide-react'

/**
 * BACKUP, ON THE SETTINGS SCREEN — where a shopkeeper goes looking for it.
 *
 * The folder picker and the backup itself always worked, but the ONLY button was on the Overview
 * screen and inside the daily reminder. A shop owner who wanted to change where backups are written
 * opened Settings → Backup, saw two reminder toggles and nothing else, and concluded the app could not
 * do it. It could; it just never said so. (Reported by a real shop.)
 *
 * It also shows the CURRENT folder. "Choose folder" with no indication of what is chosen leaves the
 * owner unable to answer the only question that matters — *where are my backups actually going?* — and
 * that question is the whole point of the feature.
 *
 * The two reminder settings above this panel come from the registry and render themselves. This is a
 * PANEL rather than a registry field because picking a folder needs a native OS dialog (main process),
 * which no declarative text/number/select field can express.
 */
export function BackupPanel({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [directory, setDirectory] = useState<string | null>(null)
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    const result = await window.pos.settings.getAll()
    if (result.ok) {
      setDirectory((result.data['backup.directory'] as string | null) ?? null)
      setLastRunAt((result.data['backup.lastRunAt'] as string | null) ?? null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function chooseFolder(): Promise<void> {
    const result = await window.pos.backup.chooseFolder()
    if (result.ok && result.data) {
      setDirectory(result.data)
      notifications.show({ color: 'teal', title: 'Backup folder set', message: result.data })
    }
  }

  async function runBackup(): Promise<void> {
    setBusy(true)
    const result = await window.pos.backup.run()
    setBusy(false)

    if (result.ok) {
      void refresh()
      notifications.show({
        color: 'teal',
        title: 'Backup saved and verified',
        message: result.data.path
      })
    } else {
      notifications.show({ color: 'red', title: 'Backup failed', message: result.error.userMessage })
    }
  }

  return (
    <Card withBorder padding="lg">
      <Group gap="sm" mb="xs">
        <Save size={18} />
        <Text fw={600}>Where backups are saved</Text>
      </Group>

      <Text size="sm" c="dimmed" mb="md">
        A backup on the same disk as the shop&apos;s data is not a backup — if that disk fails, both go
        together. Choose a <strong>USB drive</strong> or another drive.
        {/* Backups keep working on an expired licence — CLAUDE.md §6: expiry never holds data hostage. */}
        {readOnly && ' Backups keep working even though the licence has expired.'}
      </Text>

      <Stack gap="xs" mb="md">
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
            Folder:
          </Text>
          {directory ? (
            <Code style={{ wordBreak: 'break-all' }}>{directory}</Code>
          ) : (
            <Text size="sm" c="dimmed">
              Not chosen yet — the app will ask the first time you back up.
            </Text>
          )}
        </Group>

        <Group gap="xs">
          <Text size="sm" c="dimmed">
            Last backup:
          </Text>
          <Text size="sm">
            {lastRunAt ? new Date(lastRunAt).toLocaleString() : 'never'}
          </Text>
        </Group>
      </Stack>

      <Group>
        <Button variant="default" leftSection={<FolderOpen size={16} />} onClick={() => void chooseFolder()}>
          {directory ? 'Change folder' : 'Choose folder'}
        </Button>
        <Button leftSection={<Save size={16} />} loading={busy} onClick={() => void runBackup()}>
          Back up now
        </Button>
      </Group>
    </Card>
  )
}
