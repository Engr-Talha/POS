/**
 * DATES THE SHOPKEEPER READS — formatted the way THEIR country writes them, not the way the machine's
 * Windows locale happens to be set.
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────────────────────────────
 * Every printed date went through `new Date(x).toLocaleString()` with NO locale, which means "whatever
 * this PC is set to". A Pakistani shop on a laptop that shipped with a US Windows image printed
 * **7/22/2026** on its receipts — a date its own customers read as the 7th of some 22nd month, and its
 * own accountant reads wrong. Meanwhile `shop.country` sat in Settings with help text literally
 * promising "Sets the default tax rate and the date format", doing nothing of the sort.
 *
 * The shop's OWN country decides. Not the OS. Not the timezone. Not `navigator.language`.
 *
 * ── WHY A MAP AND NOT A LOCALE STRING ───────────────────────────────────────────────────────────────
 * `toLocaleDateString('en-PK')` depends on the ICU data compiled into whatever Node/Electron/Chromium
 * build is running, and a slim ICU build silently falls back to en-US — which is EXACTLY the bug, back
 * again, invisibly, on a machine we cannot inspect. So the format is written out here, explicitly, and
 * the numbers are assembled by hand. It cannot fall back because there is nothing to fall back to.
 *
 * Five of the six countries the app offers write day-first. Only the US writes month-first. That is the
 * whole table — and it is why the default is right for a Pakistani shop even if nobody ever opens
 * Settings.
 */

import { z } from 'zod'

/** ISO 3166-1 alpha-2, matching the `shop.country` setting's options exactly. */
export type ShopCountry = 'PK' | 'AE' | 'SA' | 'IN' | 'GB' | 'US'

/**
 * A DAY — 'YYYY-MM-DD' — THAT REALLY EXISTS ON A CALENDAR.
 *
 * The shape alone is not enough, and this is the trap: `/^\d{4}-\d{2}-\d{2}$/` happily passes
 * '2026-02-30', and JS then SILENTLY ROLLS IT to March 2. No error, no warning — a February tax return
 * quietly containing a March date, or an expense landing in the wrong P&L month. The expenses audit
 * caught it there; the same shape had been copied WITHOUT the guard into seven other schemas, so every
 * one of them accepted a day that does not exist.
 *
 * ONE definition, imported everywhere. Seven copies of a `.refine()` is seven chances for the eighth to
 * be written without one.
 *
 * The check is a round-trip: build the date, then ask it back for its own parts. A rolled date answers
 * with different ones, and that is the whole test. UTC, deliberately — this validates a CALENDAR DAY,
 * not an instant, so it must not shift under a timezone.
 */
export const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')
  .refine((value) => {
    const parts = value.split('-')
    const year = Number(parts[0])
    const month = Number(parts[1])
    const day = Number(parts[2])
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
      date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    )
  }, 'That is not a real calendar date.')

type DateOrder = 'dmy' | 'mdy'

/**
 * How each country the app offers writes a date. Everything except the US is day-first.
 * A country we do not know writes day-first: it is what most of the world does, and it is what every
 * country in this app's list except one does.
 */
const ORDER: Record<string, DateOrder> = {
  PK: 'dmy',
  AE: 'dmy',
  SA: 'dmy',
  IN: 'dmy',
  GB: 'dmy',
  US: 'mdy'
}

function orderFor(country: string | null | undefined): DateOrder {
  return ORDER[String(country ?? '').toUpperCase()] ?? 'dmy'
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * A DATE, the way this shop writes one: `22/07/2026` in Karachi, `07/22/2026` in Denver.
 *
 * Takes an ISO timestamp (what the DB stores) or a Date. Reads the LOCAL calendar date — a receipt is
 * printed in the shop, by the shop, for a customer standing in the shop, so the day it says must be the
 * day it is THERE. (The UTC-vs-local bucketing of REPORTS is a separate, deliberate decision — see
 * PLAN §7; this is the printed line on a piece of paper.)
 */
export function formatDate(value: string | Date, country: string | null | undefined): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const day = pad2(date.getDate())
  const month = pad2(date.getMonth() + 1)
  const year = date.getFullYear()

  return orderFor(country) === 'mdy' ? `${month}/${day}/${year}` : `${day}/${month}/${year}`
}

/**
 * A DATE AND TIME, for the line on a receipt that says when the money changed hands: `22/07/2026 3:45 pm`.
 *
 * 12-hour with a lowercase am/pm — that is how a till receipt reads in every country in the list, and a
 * cashier matching a receipt to a shift should not have to translate 15:45 in their head.
 */
export function formatDateTime(value: string | Date, country: string | null | undefined): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const hours24 = date.getHours()
  const suffix = hours24 < 12 ? 'am' : 'pm'
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12

  return `${formatDate(date, country)} ${hours12}:${pad2(date.getMinutes())} ${suffix}`
}
