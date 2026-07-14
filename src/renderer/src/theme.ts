import { createTheme } from '@mantine/core'

/**
 * The theme. Light AND dark are both first-class (CLAUDE.md §4) — a shop counter can be under
 * fluorescent light at midday or a single bulb at night, and the cashier picks.
 *
 * Slightly larger base text and controls than Mantine's default: this is read at arm's length,
 * across a counter, often quickly, sometimes by someone who does not love screens.
 */
export const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  headings: { fontWeight: '650' },
  components: {
    Button: { defaultProps: { size: 'md' } },
    TextInput: { defaultProps: { size: 'md' } }
  }
})
