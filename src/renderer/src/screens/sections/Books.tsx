import { useEffect, useState } from 'react'
import { Alert, Badge, Card, Group, Skeleton, Stack, Table, Text, Title } from '@mantine/core'
import { Scale, CircleCheck, TriangleAlert } from 'lucide-react'
import type { TrialBalance } from '@shared/accounting'
import { formatMoney } from '@shared/money'

/**
 * THE TRIAL BALANCE — proof that the books are sound.
 *
 * The shopkeeper does not have to understand this page. It exists so that at any moment we (and
 * their accountant) can see that every rupee that went in one side came out the other. If "Balanced"
 * ever goes red, something wrote to the ledger without going through the posting engine, and we want
 * to know that day — not in March.
 */
export function Books({ currencySymbol }: { currencySymbol: string }): React.JSX.Element {
  const [tb, setTb] = useState<TrialBalance | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.pos.ledger.trialBalance()
      if (cancelled) return
      if (result.ok) setTb(result.data)
      else setError(result.error.userMessage)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <Alert color="red" icon={<TriangleAlert size={18} />}>
        {error}
      </Alert>
    )
  }

  return (
    <Stack gap="lg" maw={860}>
      <div>
        <Title order={2}>Books</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Every sale, purchase, payment and expense posts a balanced entry behind the scenes. The
          cashier never sees any of it. This page proves it adds up.
        </Text>
      </div>

      <Card withBorder padding="lg">
        <Group gap="sm" mb="md">
          <Scale size={18} />
          <Text fw={600}>Trial balance</Text>

          {tb &&
            (tb.balanced ? (
              <Badge color="teal" variant="light" leftSection={<CircleCheck size={12} />}>
                Balanced
              </Badge>
            ) : (
              <Badge color="red" variant="filled" leftSection={<TriangleAlert size={12} />}>
                OUT OF BALANCE
              </Badge>
            ))}
        </Group>

        {tb && !tb.balanced && (
          <Alert color="red" icon={<TriangleAlert size={18} />} title="The books do not balance" mb="md">
            Total debits ({formatMoney(tb.grossDebit, { symbol: currencySymbol })}) do not equal total
            credits ({formatMoney(tb.grossCredit, { symbol: currencySymbol })}). Something has written
            to the ledger without going through the posting engine. Please contact support — do not
            rely on these figures.
          </Alert>
        )}

        {!tb ? (
          <Stack gap={8}>
            <Skeleton height={14} />
            <Skeleton height={14} width="70%" />
          </Stack>
        ) : tb.rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            No entries yet. The books fill up once you start selling — that comes next.
          </Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Code</Table.Th>
                <Table.Th>Account</Table.Th>
                <Table.Th ta="right">Debit</Table.Th>
                <Table.Th ta="right">Credit</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tb.rows.map((row) => (
                <Table.Tr key={row.code}>
                  <Table.Td>
                    <Text ff="monospace" size="sm">
                      {row.code}
                    </Text>
                  </Table.Td>
                  <Table.Td>{row.name}</Table.Td>
                  <Table.Td ta="right">
                    {row.debit ? formatMoney(row.debit, { symbol: currencySymbol }) : ''}
                  </Table.Td>
                  <Table.Td ta="right">
                    {row.credit ? formatMoney(row.credit, { symbol: currencySymbol }) : ''}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
            {/* totalDebit/totalCredit are the sums of the columns ABOVE — not the gross sums of
                every entry ever posted. Printing the gross figures here made the Total line
                disagree with its own column, which is the first thing an accountant would spot. */}
            <Table.Tfoot>
              <Table.Tr>
                <Table.Td colSpan={2}>
                  <Text fw={700}>Total</Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text fw={700}>{formatMoney(tb.totalDebit, { symbol: currencySymbol })}</Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text fw={700}>{formatMoney(tb.totalCredit, { symbol: currencySymbol })}</Text>
                </Table.Td>
              </Table.Tr>
            </Table.Tfoot>
          </Table>
        )}
      </Card>
    </Stack>
  )
}
