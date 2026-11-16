import { useEffect, useState } from 'react'
import { Alert, Button, Card, Group, Progress, Stack, Text } from '@mantine/core'
import { CloudDownload, RefreshCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/ipc'
import { useI18n } from '../i18n/LanguageProvider'

/**
 * Settings → Updates. The main process already downloads quietly and installs on quit; this panel
 * is so the OWNER can see that, and press "Check now", without ever interrupting a cashier mid-sale.
 */
export function UpdatesPanel(): React.JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return window.pos.updates.onStatus(setStatus)
  }, [])

  async function checkNow(): Promise<void> {
    setBusy(true)
    const result = await window.pos.updates.check()
    setBusy(false)
    if (result.ok) setStatus(result.data)
  }

  const body = ((): React.ReactNode => {
    switch (status.state) {
      case 'checking':
        return <Text size="sm">{t('settings.updates.checking')}</Text>
      case 'up-to-date':
        return (
          <Text size="sm" c="teal" fw={600}>
            {t('settings.updates.upToDate')}
          </Text>
        )
      case 'available':
        return (
          <Text size="sm">
            {t('settings.updates.available', { version: status.version ?? '' })}
          </Text>
        )
      case 'downloading':
        return (
          <Stack gap={6}>
            <Text size="sm">{t('settings.updates.downloading', { percent: status.percent ?? 0 })}</Text>
            <Progress value={status.percent ?? 0} animated />
          </Stack>
        )
      case 'ready':
        return (
          <Alert color="teal" icon={<CloudDownload size={16} />}>
            {t('settings.updates.ready', { version: status.version ?? '' })}
          </Alert>
        )
      case 'error':
        return (
          <Alert color="gray">
            <Text size="sm">{t('settings.updates.error')}</Text>
          </Alert>
        )
      default:
        return <Text size="sm" c="dimmed">{t('settings.updates.idle')}</Text>
    }
  })()

  return (
    <Card withBorder padding="lg">
      <Group gap="sm" mb="md">
        <CloudDownload size={18} />
        <Text fw={600}>{t('settings.updates')}</Text>
      </Group>

      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('settings.updates.intro')}
        </Text>
        {body}
        <Group>
          <Button
            leftSection={<RefreshCw size={16} />}
            loading={busy || status.state === 'checking'}
            onClick={() => void checkNow()}
          >
            {t('settings.updates.check')}
          </Button>
        </Group>
      </Stack>
    </Card>
  )
}
