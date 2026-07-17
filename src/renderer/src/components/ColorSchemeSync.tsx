import { useEffect } from 'react'
import { useMantineColorScheme, type MantineColorScheme } from '@mantine/core'

/**
 * THE COLOUR SCHEME LIVES IN THE DATABASE, NOT IN localStorage.
 *
 * Mantine's own persistence is localStorage, and CLAUDE.md §4 is explicit: if a behaviour could
 * reasonably differ between two shops, it is a SETTING. `ui.colorScheme` is declared in the settings
 * registry like every other knob, so the Settings screen renders the picker for free and the choice
 * survives a reinstall — localStorage would not.
 *
 * This component is the one place the DB value is pushed into Mantine. It renders nothing.
 *
 * WHY A COMPONENT AND NOT A PROP ON MantineProvider: the provider mounts before any IPC call can
 * finish, so the scheme cannot be known at first paint. The provider starts on 'auto' (which is also
 * the registry default, so the common case never flickers) and this corrects it once main answers.
 */
export function ColorSchemeSync(): null {
  const { setColorScheme } = useMantineColorScheme()

  // Empty deps ON PURPOSE — this reads the stored choice once, on mount. After that the user is the
  // only thing that changes it: the header toggle and the Settings picker both call setColorScheme
  // themselves, and re-running this would stamp the saved value back over the toggle they just
  // clicked. (Trap #19: a useEffect that re-runs and resets state the user owns.)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.pos.settings.getAll()
      if (cancelled || !result.ok) return

      const stored = result.data['ui.colorScheme']
      if (stored === 'light' || stored === 'dark' || stored === 'auto') {
        setColorScheme(stored as MantineColorScheme)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setColorScheme])

  return null
}
