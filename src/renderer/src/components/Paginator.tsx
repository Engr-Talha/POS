import { Group, Pagination, Select, Text } from '@mantine/core'

/**
 * THE ONE PAGER. Every list in the app uses this — the owner asked, explicitly, that a list always
 * show the page numbers, the total row count, and a rows-per-page selector, so it lives in one place
 * and looks the same everywhere (CLAUDE.md §4: lists are paginated over an index, assume 100k+ rows,
 * never an unbounded SELECT *).
 *
 * It is a CONTROLLED component and nothing else: it owns no state, fetches nothing, and reads no
 * balance. `page`, `pageSize` and `total` come down from the list that ran the query; `onPage` and
 * `onPageSize` report a click back up. The parent owns the state and does the fetch — so the query
 * lives in one place and this component is trivial to reason about.
 *
 * It renders, left to right:
 *   - "Showing 51–100 of 312 customers"  — the current range and the grand total (with its noun)
 *   - a rows-per-page selector (25 / 50 / 100 / 200)
 *   - the page numbers "1 2 3 … 20" with previous/next and first/last controls (only when >1 page)
 *
 * Changing the rows-per-page also snaps back to page 1 — page 7 of a 25-per-page result set does not
 * exist at 200 per page, and an empty "page 7" is how a list looks broken. Doing that reset HERE means
 * every caller gets it for free and none of them has to remember (a list that resets on a filter
 * change but forgets to on a page-size change is a classic empty-page bug).
 *
 * `total === 0` renders nothing: the list shows its own empty state, and a pager over no rows is noise.
 */

const PAGE_SIZES = [25, 50, 100, 200] as const

export function Paginator({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  unit,
  units
}: {
  /** 1-based current page. */
  page: number
  /** Rows shown per page. */
  pageSize: number
  /** The grand total across every page — what makes "of 312" honest. */
  total: number
  onPage: (page: number) => void
  onPageSize: (pageSize: number) => void
  /** Singular noun for the count, e.g. "customer" → "312 customers". Omit for a bare count. */
  unit?: string
  /** Plural override, e.g. "entries" for "entry". Defaults to `${unit}s`. */
  units?: string
}): React.JSX.Element | null {
  if (total <= 0) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // A page can run past the end when the rows-per-page grows — clamp so the range text stays sane.
  const safePage = Math.min(Math.max(1, page), totalPages)
  const from = (safePage - 1) * pageSize + 1
  const to = Math.min(safePage * pageSize, total)
  const noun = unit ? ` ${total === 1 ? unit : (units ?? `${unit}s`)}` : ''

  // Keep whatever pageSize we were handed selectable, even if a caller uses a size off the presets.
  const sizes = (
    PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number])
      ? [...PAGE_SIZES]
      : [...PAGE_SIZES, pageSize].sort((a, b) => a - b)
  ).map(String)

  return (
    <Group justify="space-between" align="center" wrap="wrap" gap="md" mt="lg">
      <Text size="sm" c="dimmed">
        Showing {from.toLocaleString('en-US')}–{to.toLocaleString('en-US')} of{' '}
        <Text span fw={600}>
          {total.toLocaleString('en-US')}
        </Text>
        {noun}
      </Text>

      <Group gap="lg" align="center" wrap="wrap">
        <Group gap={8} align="center" wrap="nowrap">
          <Text size="sm" c="dimmed">
            Rows
          </Text>
          <Select
            size="xs"
            w={88}
            aria-label="Rows per page"
            data={sizes}
            value={String(pageSize)}
            allowDeselect={false}
            onChange={(value) => {
              if (!value) return
              onPageSize(Number(value))
              // A different page size is a different set of pages — start at the top of it.
              onPage(1)
            }}
          />
        </Group>

        {totalPages > 1 && (
          <Pagination
            value={safePage}
            onChange={onPage}
            total={totalPages}
            size="sm"
            siblings={1}
            boundaries={1}
            withEdges
          />
        )}
      </Group>
    </Group>
  )
}
