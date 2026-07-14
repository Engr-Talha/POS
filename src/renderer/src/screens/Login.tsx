import { useState } from 'react'
import { Button, Card, Center, Group, PasswordInput, Stack, TextInput, Title } from '@mantine/core'
import { LogIn, Store } from 'lucide-react'
import type { AppState } from '@shared/app-state'

export function Login({
  onSignedIn
}: {
  onSignedIn: (state: AppState) => void
}): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)

    const result = await window.pos.auth.signIn({ username, password })
    if (result.ok) onSignedIn(result.data)
    else setError(result.error.userMessage)

    setBusy(false)
  }

  return (
    <Center mih="100vh" p="xl">
      <Stack gap="lg" w="100%" maw={400}>
        <Group gap="sm" justify="center">
          <Store size={24} />
          <Title order={2}>Insha POS</Title>
        </Group>

        <Card withBorder padding="lg">
          {/* A form, so Enter submits. The cashier's hands stay on the keyboard. */}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <Stack>
              <TextInput
                label="Username"
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                autoFocus
              />

              <PasswordInput
                label="Password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                error={error}
              />

              <Button
                type="submit"
                fullWidth
                mt="xs"
                loading={busy}
                leftSection={<LogIn size={16} />}
                disabled={!username.trim() || !password}
              >
                Sign in
              </Button>
            </Stack>
          </form>
        </Card>
      </Stack>
    </Center>
  )
}
