import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  CalendarCheck,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Lock,
  LockOpen,
  TriangleAlert
} from 'lucide-react'
import type { PeriodRow } from '@shared/periods'

/**
 * CLOSE THE MONTH — the door to a lock that has been enforced since migration 0002.
 *
 * The lock is not new and nothing here enforces it: `ledger.assertPeriodOpen` has refused every journal
 * dated in a locked month since 0002, and every stock movement since. What was missing was a way for an
 * owner to TURN it — no IPC, no screen. This panel is that door, and nothing more.
 *
 * ── LOCKING IS A DECISION. UNLOCKING IS A DECISION WITH A MOTIVE. ───────────────────────────────────
 * The two confirmations below are deliberately NOT symmetrical. A lock freezes a month that the owner
 * has finished with, and the worst case is inconvenience — they unlock it again. An UNLOCK is how a
 * reported figure changes after the accountant has signed it off, and the two readings of that act —
 * "a genuine correction" and "rewriting the books" — are indistinguishable from the outside. So the
 * unlock modal is red, it names the number of journal entries that are about to become editable again,
 * and it says out loud that the reopening is logged. `periods.list` already carries `journalCount`;
 * this screen only has to show it.
 *
 * ── OWNER-ONLY HERE IS A COURTESY. MAIN IS THE BOUNDARY. ────────────────────────────────────────────
 * 'period.manage' is the owner's and is enforced in MAIN (CLAUDE.md §4). This panel is only rendered
 * for an owner, but a non-owner who reaches it anyway gets a friendly refusal from main's own
 * `userMessage`, never a crash — which is why every call below funnels its error into an Alert or a
 * toast rather than assuming success.
 *
 * ── NEITHER WRITE NAMES A USER OR A DATE ────────────────────────────────────────────────────────────
 * `lock` and `unlock` take `{ year, month }` and nothing else. MAIN stamps the actor from the session
 * and reads its own clock: a renderer that could name the user could sign someone else's name to the
 * act that freezes the books (shared/periods.ts).
 */

/** Two years is what an owner actually looks at, and it keeps the read bounded (CLAUDE.md §4). */
const MONTHS_SHOWN = 24

export function Periods({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [rows, setRows] = useState<PeriodRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** The month awaiting confirmation, and which way it is going. Null = no modal. */
  const [confirming, setConfirming] = useState<{ row: PeriodRow; action: 'lock' | 'unlock' } | null>(
    null
  )

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.periods.list({ months: MONTHS_SHOWN })

    if (!result.ok) {
      // A non-owner lands here. Main's sentence is already plain language — show it as it is.
      setError(result.error.userMessage)
      setRows([])
      return
    }

    // Newest first, exactly as main ordered it. The screen never re-sorts the calendar.
    setRows(result.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const lockedCount = rows?.filter((row) => row.status === 'locked').length ?? 0

  return (
    <Stack gap="lg">
      <div>
        <Group gap="sm" mb={4}>
          <CalendarCheck size={18} />
          <Text fw={600}>Close the month</Text>
        </Group>
        <Text c="dimmed" size="sm">
          Closing a month freezes it. Nothing new can be dated inside it — no sale, no return, no
          purchase, no expense, no stock correction. Today’s trading is untouched: closing March never
          stops the shop selling in April. This is what stops last year’s figures from quietly changing
          after your accountant has seen them.
        </Text>
      </div>

      {readOnly && (
        <Alert color="orange" icon={<TriangleAlert size={18} />}>
          Your licence has expired, so months cannot be closed or reopened. You can still see which
          ones are closed, and run every report.
        </Alert>
      )}

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="The months could not be loaded">
          {error}
          <Group mt="sm">
            <Button size="xs" variant="default" onClick={() => void load()}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      <Card withBorder padding="lg">
        {!rows ? (
          <Stack gap={10}>
            <Skeleton height={34} />
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
          </Stack>
        ) : rows.length === 0 && !error ? (
          // The list is built from the CALENDAR, not from the table, so it can only be empty if the
          // read itself failed or was refused. Say something true rather than "no months exist".
          <Stack align="center" gap="xs" py="xl">
            <CalendarClock size={32} opacity={0.5} />
            <Text fw={600}>No months to show</Text>
            <Text size="sm" c="dimmed" ta="center" maw={460}>
              Once the shop has been trading, the last {MONTHS_SHOWN} months appear here ready to be
              closed.
            </Text>
          </Stack>
        ) : (
          <>
            {lockedCount === 0 && !error && (
              <Alert color="blue" variant="light" mb="md" icon={<Lock size={16} />}>
                <Text size="sm">
                  No month is closed yet. Close a month once you have checked its figures and you are
                  finished with it — usually after the accountant has seen them.
                </Text>
              </Alert>
            )}

            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Month</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th ta="right">Entries</Table.Th>
                    <Table.Th>Closed on</Table.Th>
                    <Table.Th>Closed by</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => {
                    const locked = row.status === 'locked'
                    return (
                      <Table.Tr key={`${row.year}-${row.month}`}>
                        <Table.Td>
                          <Group gap={8} wrap="nowrap">
                            <Text size="sm" fw={600}>
                              {row.label}
                            </Text>
                            {/* Locking the month the shop is trading in RIGHT NOW stops today's
                                sales. It is occasionally exactly right, so it is allowed — but it
                                is never a thing to do by accident, so the row says so. */}
                            {row.isCurrent && (
                              <Badge size="xs" variant="light" color="blue">
                                This month
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>

                        <Table.Td>
                          {locked ? (
                            <Badge
                              size="sm"
                              variant="light"
                              color="orange"
                              leftSection={<Lock size={10} />}
                            >
                              Closed
                            </Badge>
                          ) : (
                            <Badge
                              size="sm"
                              variant="light"
                              color="teal"
                              leftSection={<LockOpen size={10} />}
                            >
                              Open
                            </Badge>
                          )}
                        </Table.Td>

                        <Table.Td ta="right">
                          {/* WHAT the owner is freezing — or, on the unlock, what they are letting
                              back out. Main counts it; this screen only shows it. */}
                          <Text size="sm" c={row.journalCount > 0 ? undefined : 'dimmed'}>
                            {row.journalCount > 0
                              ? row.journalCount.toLocaleString('en-US')
                              : '—'}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm" c={row.lockedAt ? undefined : 'dimmed'}>
                            {row.lockedAt ? new Date(row.lockedAt).toLocaleDateString() : '—'}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Text size="sm" c={row.lockedByName ? undefined : 'dimmed'}>
                            {row.lockedByName ?? '—'}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Group gap={6} wrap="nowrap" justify="flex-end">
                            {locked ? (
                              <Tooltip
                                label="Your licence has expired — months cannot be reopened"
                                disabled={!readOnly}
                              >
                                <Button
                                  size="compact-sm"
                                  variant="default"
                                  color="red"
                                  leftSection={<LockOpen size={13} />}
                                  disabled={readOnly}
                                  onClick={() => setConfirming({ row, action: 'unlock' })}
                                >
                                  Reopen
                                </Button>
                              </Tooltip>
                            ) : (
                              <Tooltip
                                label="Your licence has expired — months cannot be closed"
                                disabled={!readOnly}
                              >
                                <Button
                                  size="compact-sm"
                                  variant="light"
                                  leftSection={<Lock size={13} />}
                                  disabled={readOnly}
                                  onClick={() => setConfirming({ row, action: 'lock' })}
                                >
                                  Close
                                </Button>
                              </Tooltip>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    )
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        )}
      </Card>

      <ConfirmModal
        target={confirming}
        onClose={() => setConfirming(null)}
        onDone={() => {
          setConfirming(null)
          void load()
        }}
      />
    </Stack>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// The confirmation. DELIBERATELY NOT SYMMETRICAL — see the file header.
// ═════════════════════════════════════════════════════════════════════════════

function ConfirmModal({
  target,
  onClose,
  onDone
}: {
  target: { row: PeriodRow; action: 'lock' | 'unlock' } | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target) {
      setWorking(false)
      setError(null)
    }
  }, [target])

  const row = target?.row ?? null
  const unlocking = target?.action === 'unlock'

  async function run(): Promise<void> {
    if (!target || !row) return
    setWorking(true)
    setError(null)

    // INTENT ONLY: which month, and which direction. No user, no timestamp — MAIN owns both.
    const input = { year: row.year, month: row.month }
    const result = unlocking
      ? await window.pos.periods.unlock(input)
      : await window.pos.periods.lock(input)

    setWorking(false)

    if (!result.ok) {
      // A non-owner, an expired licence, or a future month. All of them are sentences, not crashes.
      setError(result.error.userMessage)
      notifications.show({
        color: 'red',
        title: unlocking ? 'The month was not reopened' : 'The month was not closed',
        message: result.error.userMessage
      })
      return
    }

    notifications.show({
      color: unlocking ? 'orange' : 'teal',
      icon: unlocking ? <LockOpen size={18} /> : <CircleCheck size={18} />,
      title: unlocking ? 'Month reopened' : 'Month closed',
      message: unlocking
        ? `${result.data.label} can be changed again. This has been recorded in the audit log.`
        : `Nothing new can be dated in ${result.data.label} any more.`,
      autoClose: 6000
    })

    onDone()
  }

  return (
    <Modal
      opened={target !== null}
      onClose={onClose}
      centered
      title={
        <Group gap="sm">
          {unlocking ? (
            <TriangleAlert size={20} color="var(--mantine-color-red-text)" />
          ) : (
            <Lock size={20} />
          )}
          <Text fw={650}>{unlocking ? 'Reopen this closed month?' : 'Close this month?'}</Text>
        </Group>
      }
    >
      <Stack>
        {error && (
          <Alert color="red" icon={<CircleAlert size={18} />}>
            {error}
          </Alert>
        )}

        {unlocking ? (
          /* ── THE HEAVY ONE ────────────────────────────────────────────────
             Reopening is how books get quietly rewritten. It names the size of
             what is about to become editable again, and it says the act is
             logged — because the log is the only thing that will ever say who
             did it (services/periods.ts). */
          <>
            <Alert color="red" variant="light" icon={<TriangleAlert size={18} />}>
              <Text size="sm" fw={600} mb={4}>
                {row?.label} has {(row?.journalCount ?? 0).toLocaleString('en-US')}{' '}
                {row?.journalCount === 1 ? 'entry' : 'entries'}. Reopening it lets them be changed.
              </Text>
              <Text size="sm">
                Figures you have already reported for {row?.label} can move after this — including
                any your accountant has already seen.
              </Text>
            </Alert>

            <Text size="sm">
              Only reopen a month for a real correction you have found — a bill dated wrongly, a
              payment recorded in the wrong place. Close it again as soon as you are done.
            </Text>

            <Text size="sm" c="dimmed">
              Your name, the month and the time are written to the audit log.
            </Text>
          </>
        ) : (
          /* ── THE ORDINARY ONE ─────────────────────────────────────────────
             A lock is reversible and its worst case is inconvenience. It still
             spells out, in the shopkeeper's own words, exactly what stops. */
          <>
            <Text size="sm">
              Nothing new will be able to be dated in <strong>{row?.label}</strong>:
            </Text>

            <Stack gap={4} pl="xs">
              <Text size="sm">· no sale or return dated in that month</Text>
              <Text size="sm">· no purchase or supplier return</Text>
              <Text size="sm">· no expense</Text>
              <Text size="sm">· no stock correction or stock take</Text>
            </Stack>

            {row != null && row.journalCount > 0 && (
              <Text size="sm" c="dimmed">
                {row.journalCount.toLocaleString('en-US')}{' '}
                {row.journalCount === 1 ? 'entry is' : 'entries are'} dated in {row.label}. Closing
                freezes {row.journalCount === 1 ? 'it' : 'them'} as they stand.
              </Text>
            )}

            {/* Locking the CURRENT month stops today's till. Legal, occasionally intended, rarely
                wanted — so it is called out where the decision is actually made. */}
            {row?.isCurrent === true && (
              <Alert color="orange" variant="light" icon={<TriangleAlert size={18} />}>
                <Text size="sm">
                  This is the month you are trading in right now. Closing it stops you making any
                  more sales today, until you reopen it.
                </Text>
              </Alert>
            )}

            <Text size="sm" c="dimmed">
              You can reopen a closed month if you have to — it is recorded when you do. Today’s
              trading in other months is not affected.
            </Text>
          </>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            color={unlocking ? 'red' : undefined}
            leftSection={unlocking ? <LockOpen size={16} /> : <Lock size={16} />}
            loading={working}
            onClick={() => void run()}
          >
            {unlocking ? `Reopen ${row?.label}` : `Close ${row?.label}`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
