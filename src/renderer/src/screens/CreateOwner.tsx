import { useState } from 'react'
import {
  Button,
  Card,
  Center,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import { UserCog } from 'lucide-react'
import type { AppState } from '@shared/app-state'

/**
 * FIRST RUN — create the Owner account.
 *
 * We do NOT ship a default admin password. A shipped default password is a shipped back door, and
 * this one would open a shop's books. So the shop makes its own, once, here.
 */
export function CreateOwner({
  onCreated
}: {
  onCreated: (state: AppState) => void
}): React.JSX.Element {
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit =
    fullName.trim() && username.trim() && password.length >= 8 && password === confirm

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)

    const result = await window.pos.auth.createFirstOwner({ fullName, username, password })
    if (result.ok) onCreated(result.data)
    else setError(result.error.userMessage)

    setBusy(false)
  }

  return (
    <Center mih="100vh" p="xl">
      <Stack gap="lg" w="100%" maw={480}>
        <Group gap="sm">
          <UserCog size={24} />
          <Title order={2}>Create the owner account</Title>
        </Group>

        <Text size="sm" c="dimmed">
          This is the shop&apos;s master account. It can do everything, including managing staff and
          settings. Keep the password safe — nobody can reset it for you.
        </Text>

        <Card withBorder padding="lg">
          <Stack>
            <TextInput
              label="Your name"
              placeholder="Talha"
              value={fullName}
              onChange={(event) => setFullName(event.currentTarget.value)}
              autoFocus
            />

            <TextInput
              label="Username"
              description="What you type to sign in"
              placeholder="talha"
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
            />

            <PasswordInput
              label="Password"
              description="At least 8 characters"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />

            <PasswordInput
              label="Confirm password"
              value={confirm}
              onChange={(event) => setConfirm(event.currentTarget.value)}
              error={mismatch ? 'The two passwords do not match.' : error}
            />

            <Button
              fullWidth
              mt="xs"
              loading={busy}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              Create account and continue
            </Button>
          </Stack>
        </Card>
      </Stack>
    </Center>
  )
}
