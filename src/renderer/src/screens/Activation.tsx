import { useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Center,
  CopyButton,
  Group,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
  ActionIcon
} from '@mantine/core'
import { KeyRound, Copy, Check, CircleAlert } from 'lucide-react'
import type { AppState } from '@shared/app-state'

/**
 * ACTIVATION — the first thing a new customer sees.
 *
 * They read the Machine ID to us (WhatsApp, phone, whatever), we run tools/keygen.ts, we send back
 * a key, they paste it. No internet on either side.
 *
 * The Machine ID is a HASH. It is designed to be sent to a stranger — it reveals nothing about the
 * machine except that it is this one.
 */
export function Activation({
  state,
  onActivated
}: {
  state: AppState
  onActivated: (state: AppState) => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const machineId = state.license.machineId
  const invalidReason = state.license.status === 'invalid' ? state.license.reason : null

  async function activate(): Promise<void> {
    setBusy(true)
    setError(null)

    const result = await window.pos.license.activate({ key })
    if (result.ok) onActivated(result.data)
    else setError(result.error.userMessage)

    setBusy(false)
  }

  return (
    <Center mih="100vh" p="xl">
      <Stack gap="lg" w="100%" maw={560}>
        <Group gap="sm">
          <KeyRound size={24} />
          <Title order={2}>Activate Insha POS</Title>
        </Group>

        {invalidReason && (
          <Alert color="orange" icon={<CircleAlert size={18} />} title="Please re-activate">
            {invalidReason}
          </Alert>
        )}

        <Card withBorder padding="lg">
          <Text size="sm" c="dimmed" mb={6}>
            Step 1 — send us this Machine ID
          </Text>

          <Group gap="sm" align="center">
            <Text
              ff="monospace"
              fz={22}
              fw={650}
              style={{ letterSpacing: 1 }}
              data-testid="machine-id"
            >
              {machineId}
            </Text>

            <CopyButton value={machineId}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy'}>
                  <ActionIcon variant="default" size="lg" onClick={copy} aria-label="Copy Machine ID">
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>

          <Text size="xs" c="dimmed" mt="sm">
            This code identifies this computer only. It is safe to send.
          </Text>
        </Card>

        <Card withBorder padding="lg">
          <Text size="sm" c="dimmed" mb={8}>
            Step 2 — paste the licence key we send back
          </Text>

          <Textarea
            value={key}
            onChange={(event) => setKey(event.currentTarget.value)}
            placeholder="Paste your licence key here"
            autosize
            minRows={4}
            error={error}
            styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
          />

          <Button
            mt="md"
            fullWidth
            loading={busy}
            disabled={key.trim().length === 0}
            onClick={() => void activate()}
          >
            Activate
          </Button>
        </Card>
      </Stack>
    </Center>
  )
}
