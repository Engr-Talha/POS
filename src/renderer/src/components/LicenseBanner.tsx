import { Alert } from '@mantine/core'
import { ShieldAlert, Clock, TriangleAlert } from 'lucide-react'
import type { LicenseState } from '@shared/types'

/**
 * The licence banner.
 *
 * TONE MATTERS HERE. This is a paying customer, and the message is about money and access — the two
 * things most likely to make someone panic mid-shift. So:
 *
 *   - An EXPIRED licence does NOT say "locked" or "disabled". It says exactly what still works —
 *     because everything still works except selling, and the first thing a frightened shopkeeper
 *     needs to know is that their data is safe and still theirs.
 *   - We warn EARLY (30/15/7/1 days), so renewal is a calendar item and never a crisis.
 *   - A trial shows the days left, always, without nagging.
 */
export function LicenseBanner({ license }: { license: LicenseState }): React.JSX.Element | null {
  if (license.status === 'expired') {
    return (
      <Alert color="orange" icon={<ShieldAlert size={18} />} title="Your licence has expired">
        New sales and purchases are paused until you renew.{' '}
        <strong>Everything else still works</strong> — you can view all your records, run and export
        every report, and take a backup. Nothing has been deleted. Enter a new key in Settings →
        Licence to start selling again.
      </Alert>
    )
  }

  if (license.status === 'invalid') {
    return (
      <Alert color="red" icon={<TriangleAlert size={18} />} title="Licence problem">
        {license.reason}
      </Alert>
    )
  }

  if (license.status !== 'active') return null

  const { plan, daysRemaining } = license

  if (plan === 'trial') {
    return (
      <Alert color="blue" icon={<Clock size={18} />} title={`Trial — ${daysRemaining} days left`}>
        You have the full app during the trial. Contact us before it runs out and nothing will be
        interrupted.
      </Alert>
    )
  }

  // Warn at 30 / 15 / 7 / 1 days, getting more urgent as it closes in.
  if (daysRemaining !== null && daysRemaining <= 30) {
    const urgent = daysRemaining <= 7
    return (
      <Alert
        color={urgent ? 'orange' : 'yellow'}
        icon={<Clock size={18} />}
        title={`Your licence expires in ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'}`}
      >
        Contact us to renew. If it does lapse, you will still be able to see and export everything —
        you just won&apos;t be able to make new sales until it is renewed.
      </Alert>
    )
  }

  return null
}
