import { useEffect, useRef, useState } from 'react'
import { Card, Loader, Text, TextInput } from '@mantine/core'
import { Search } from 'lucide-react'
import type { ProductListItem } from '@shared/catalog'
import { formatMoney } from '@shared/money'
import { formatQty } from '@shared/qty'
import { useI18n } from '../i18n/LanguageProvider'

export type ProductSuggestMode = 'search' | 'list'

type ListFilters = {
  itemType?: 'inventory' | 'non_inventory'
  includeInactive?: boolean
}

/**
 * ONE product typeahead for the whole app.
 *
 * Sell, Purchases, Stock take, Offers, Opening setup and the Items list all used to invent their
 * own search box. A cashier who learns "type a name, press Enter" on the till must get the same
 * behaviour everywhere — otherwise rush hour is a memory test.
 *
 * Behaviour:
 *   - Debounced fetch (default 180ms)
 *   - Arrow keys move the highlight; Enter picks the highlight, or the FIRST match if none yet
 *   - Esc closes the list
 *   - Rows show English name + Urdu (`nameOtherLang`) when present
 *   - `mode: 'search'` uses `products.search` (cashier-safe); `list` uses `products.list`
 */
export function ProductSuggest({
  value,
  onChange,
  onPick,
  onSubmitRaw,
  mode = 'list',
  listFilters,
  minLength = 1,
  debounceMs = 180,
  pageSize = 8,
  placeholder,
  disabled,
  autoFocus,
  size = 'sm',
  currencySymbol = 'Rs',
  leftSection,
  inputStyles
}: {
  value: string
  onChange: (next: string) => void
  onPick: (item: ProductListItem) => void
  /**
   * Exact barcode / raw Enter path. Tried FIRST when provided — scanners finish with Enter before the
   * debounce list appears, and an exact barcode must beat a fuzzy first-match.
   * Return `false` to fall through to "pick highlighted suggestion".
   */
  onSubmitRaw?: (raw: string) => boolean | void | Promise<boolean | void>
  mode?: ProductSuggestMode
  listFilters?: ListFilters
  minLength?: number
  debounceMs?: number
  pageSize?: number
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  size?: 'sm' | 'md' | 'lg' | 'xl'
  currencySymbol?: string
  leftSection?: React.ReactNode
  inputStyles?: React.ComponentProps<typeof TextInput>['styles']
}): React.JSX.Element {
  const { t } = useI18n()
  const [suggestions, setSuggestions] = useState<ProductListItem[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const term = value.trim()
    if (term.length < minLength) {
      setSuggestions([])
      setOpen(false)
      setHighlight(null)
      return
    }

    const my = ++seq.current
    setBusy(true)
    const timer = setTimeout(() => {
      void (async () => {
        const result =
          mode === 'search'
            ? await window.pos.products.search({ search: term, pageSize })
            : await window.pos.products.list({
                page: 1,
                pageSize,
                search: term,
                itemType: listFilters?.itemType,
                includeInactive: listFilters?.includeInactive
              })

        if (my !== seq.current) return
        setBusy(false)
        if (!result.ok) {
          setSuggestions([])
          setOpen(false)
          setHighlight(null)
          return
        }
        setSuggestions(result.data.rows)
        setOpen(result.data.rows.length > 0)
        // Default the highlight to the first row so Enter alone picks it — the rush-hour path.
        setHighlight(result.data.rows.length > 0 ? 0 : null)
      })()
    }, debounceMs)

    return () => {
      clearTimeout(timer)
    }
  }, [value, minLength, debounceMs, pageSize, mode, listFilters?.itemType, listFilters?.includeInactive])

  function pick(item: ProductListItem): void {
    onPick(item)
    setOpen(false)
    setHighlight(null)
    setSuggestions([])
  }

  async function handleEnter(): Promise<void> {
    const raw = value.trim()
    // Exact resolve first (barcode scan). Parent returns false when the code is unknown so we can
    // still pick the highlighted name-search row.
    if (onSubmitRaw && raw !== '') {
      const handled = await Promise.resolve(onSubmitRaw(raw))
      if (handled !== false) {
        setOpen(false)
        setHighlight(null)
        setSuggestions([])
        return
      }
    }
    if (open && suggestions.length > 0) {
      const index = highlight ?? 0
      const item = suggestions[index]
      if (item) {
        pick(item)
      }
    }
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <TextInput
        size={size}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder ?? t('common.typeToSearch')}
        leftSection={leftSection ?? <Search size={16} />}
        rightSection={busy ? <Loader size="xs" /> : null}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        styles={inputStyles}
        onKeyDown={(event) => {
          if (open && suggestions.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setHighlight((current) =>
                current == null ? 0 : Math.min(suggestions.length - 1, current + 1)
              )
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlight((current) => (current == null ? 0 : Math.max(0, current - 1)))
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              setHighlight(null)
              return
            }
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            handleEnter()
          }
        }}
        onBlur={() => {
          // Delay so a mouse pick (mousedown) still fires before we close.
          window.setTimeout(() => setOpen(false), 120)
        }}
      />

      {open && suggestions.length > 0 && (
        <Card
          withBorder
          shadow="md"
          padding={0}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 400,
            marginTop: 4,
            maxHeight: 320,
            overflowY: 'auto'
          }}
        >
          {suggestions.map((product, index) => (
            <div
              key={product.id}
              onMouseDown={(event) => {
                event.preventDefault()
                pick(product)
              }}
              onMouseEnter={() => setHighlight(index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 14px',
                cursor: 'pointer',
                backgroundColor:
                  highlight === index ? 'var(--mantine-color-blue-light)' : undefined,
                borderTop: index === 0 ? undefined : '1px solid var(--mantine-color-default-border)'
              }}
            >
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} truncate>
                  {product.name}
                </Text>
                {product.nameOtherLang ? (
                  <Text size="sm" c="dimmed" truncate dir="auto">
                    {product.nameOtherLang}
                  </Text>
                ) : null}
                <Text size="xs" c="dimmed">
                  {product.sku}
                  {product.primaryBarcode ? ` · ${product.primaryBarcode}` : ''}
                  {product.itemType === 'inventory'
                    ? ` · ${t('common.onHand', { qty: formatQty(product.onHandM) })}`
                    : ''}
                </Text>
              </div>
              <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
                {formatMoney(product.retailPrice, { symbol: currencySymbol })}
              </Text>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
