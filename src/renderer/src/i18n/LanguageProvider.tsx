import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { formatString, STRINGS, type Lang, type StringKey } from './strings'

type I18n = {
  lang: Lang
  /** Translate a key. Falls back to English if Urdu is missing a key. */
  t: (key: StringKey, vars?: Record<string, string | number>) => string
  /** Apply a language immediately (and persist via Settings when the caller asks). */
  setLang: (lang: Lang) => void
  /** Urdu is RTL; English is LTR. */
  dir: 'ltr' | 'rtl'
}

const LanguageContext = createContext<I18n | null>(null)

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'ur'
}

/**
 * Loads `shop.language` once and keeps `document.documentElement.lang/dir` in sync so Mantine
 * inputs and native text direction follow the shop's choice — including the login screen.
 */
export function LanguageProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [lang, setLangState] = useState<Lang>('en')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.pos.settings.getAll()
      if (cancelled || !result.ok) return
      const saved = result.data['shop.language']
      if (isLang(saved)) setLangState(saved)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang === 'ur' ? 'ur' : 'en'
    document.documentElement.dir = lang === 'ur' ? 'rtl' : 'ltr'
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
  }, [])

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>): string => {
      const pack = STRINGS[lang] ?? STRINGS.en
      const template = pack[key] ?? STRINGS.en[key] ?? key
      return formatString(template, vars)
    },
    [lang]
  )

  const value = useMemo<I18n>(
    () => ({ lang, t, setLang, dir: lang === 'ur' ? 'rtl' : 'ltr' }),
    [lang, t, setLang]
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(LanguageContext)
  if (!ctx) {
    // Safe fallback so a forgotten provider never blanks the till mid-sale.
    return {
      lang: 'en',
      dir: 'ltr',
      setLang: () => {},
      t: (key, vars) => formatString(STRINGS.en[key] ?? key, vars)
    }
  }
  return ctx
}
