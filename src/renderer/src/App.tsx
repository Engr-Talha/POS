import { useCallback, useEffect, useState } from 'react'
import { Center, Loader, Stack, Text } from '@mantine/core'
import type { AppState } from '@shared/app-state'
import { ColorSchemeSync } from './components/ColorSchemeSync'
import { Activation } from './screens/Activation'
import { CreateOwner } from './screens/CreateOwner'
import { Login } from './screens/Login'
import { Home } from './screens/Home'

/**
 * THE ROUTER — and it does not decide anything.
 *
 * The phase comes from MAIN (`app:getState`). The renderer never works out for itself whether the
 * app is activated or who is signed in; it asks, and it draws the answer. Two reasons:
 *
 *   1. Security: a renderer that decides it is "signed in as owner" is a renderer that can be told
 *      to decide that. The session lives in main.
 *   2. Trap #19: a stray useEffect dependency once re-ran and reset the auth phase, bouncing the
 *      user back to login mid-work. With one server-owned phase and an explicit refresh(), there is
 *      no local auth state left to accidentally reset.
 */
export function App(): React.JSX.Element {
  return (
    <>
      {/* The shop's saved light/dark choice, applied on every screen including the login one — the
          till should look the same at the sign-in prompt as it does mid-sale. Renders nothing. */}
      <ColorSchemeSync />
      <Phase />
    </>
  )
}

function Phase(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.pos.app.getState()
    if (result.ok) setState(result.data)
    else setFatal(result.error.userMessage)
  }, [])

  // Empty deps ON PURPOSE. This runs once, on mount. Everything that can change the phase calls
  // refresh() (or hands us the new state directly), so there is nothing here to re-trigger.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (fatal) {
    return (
      <Center h="100vh" p="xl">
        <Stack align="center" gap="xs">
          <Text fw={600}>The app could not start</Text>
          <Text c="dimmed" size="sm" ta="center" maw={420}>
            {fatal}
          </Text>
        </Stack>
      </Center>
    )
  }

  if (!state) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  switch (state.phase) {
    case 'activation':
      return <Activation state={state} onActivated={setState} />
    case 'first-owner':
      return <CreateOwner onCreated={setState} />
    case 'login':
      return <Login onSignedIn={setState} />
    case 'ready':
      return <Home state={state} onStateChange={setState} />
  }
}
