import { useCallback, useEffect, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  PasswordInput,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  CircleAlert,
  Crown,
  EllipsisVertical,
  Info,
  KeyRound,
  Lock,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserCog,
  UserPlus,
  UserX
} from 'lucide-react'
import type { User } from '@shared/types'
import { ROLES, ROLE_LABEL, type Role } from '@shared/rbac'
import { Paginator } from '../../components/Paginator'

/**
 * USERS & ROLES — OWNER ONLY.
 *
 * Every write here is gated `user.manage` (owner) in MAIN, and the service does the real work: it
 * checks username uniqueness, hashes the password, and — the rule that matters most — REFUSES any
 * change that would leave the shop with no active owner. The UI is a courtesy (CLAUDE.md §4): hiding a
 * button never protects anything, so this screen also shows the last-owner guard plainly, with the
 * demote and retire controls on the only owner disabled and a tooltip that says why.
 *
 * A password or a PIN goes IN and never comes back. The only thing the renderer ever learns about a
 * PIN is whether one is set (`User.hasPin`). A user is NEVER deleted — retired and restored — so last
 * year's sale keeps a name on it.
 */

const ROLE_DATA = ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))

const ROLE_BADGE: Record<Role, string> = {
  cashier: 'gray',
  supervisor: 'blue',
  manager: 'grape',
  owner: 'yellow'
}

const OWNER_GUARD = 'A shop must always have one owner'
const LICENCE_GUARD = 'Your licence has expired — staff cannot be changed'

export function Users({
  currentUser,
  readOnly
}: {
  currentUser: User | null
  readOnly: boolean
}): React.JSX.Element {
  // Owner-only. Main refuses every call from anyone else regardless, but a screen that greets a
  // manager with a wall of red refusals is worse than a calm sentence explaining why it is not theirs.
  if (!currentUser || currentUser.role !== 'owner') {
    return (
      <Stack gap="lg" maw={620}>
        <div>
          <Title order={2}>Staff</Title>
        </div>
        <Card withBorder padding="xl">
          <Stack align="center" gap="sm" py="md">
            <ShieldAlert size={32} opacity={0.6} />
            <Text fw={600}>Only the owner can manage staff</Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              Adding people, changing roles and setting counter PINs are the keys to the shop. Ask the
              owner to sign in to make these changes.
            </Text>
          </Stack>
        </Card>
      </Stack>
    )
  }

  return <StaffList currentUserId={currentUser.id} readOnly={readOnly} />
}

function StaffList({
  currentUserId,
  readOnly
}: {
  currentUserId: number
  readOnly: boolean
}): React.JSX.Element {
  const [rows, setRows] = useState<User[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // The one modal that is open, if any. Kept as separate targets so each keeps its own small form.
  const [creating, setCreating] = useState(false)
  const [roleTarget, setRoleTarget] = useState<User | null>(null)
  const [passwordTarget, setPasswordTarget] = useState<User | null>(null)
  const [pinTarget, setPinTarget] = useState<User | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setRows(null)
    setError(null)

    const result = await window.pos.users.list({ page, pageSize })

    if (!result.ok) {
      setError(result.error.userMessage)
      setRows([])
      setTotal(0)
      return
    }

    setRows(result.data.rows)
    setTotal(result.data.total)
  }, [page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  // How many active owners are on this page. The shop's true owner count could span pages in the
  // (unusual) shop with dozens of staff, and MAIN is the real guard either way — but a staff list
  // fits on one page in every real shop, so this makes the "last owner" lock visible where it lives.
  const activeOwnerCount = (rows ?? []).filter((u) => u.role === 'owner' && u.isActive).length
  const isLastOwner = (u: User): boolean =>
    u.role === 'owner' && u.isActive && activeOwnerCount === 1

  async function reactivate(u: User): Promise<void> {
    const result = await window.pos.users.reactivate({ id: u.id })
    if (result.ok) {
      notifications.show({ color: 'teal', title: 'Staff reactivated', message: u.fullName })
      void load()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not reactivate',
        message: result.error.userMessage
      })
    }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Staff</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Who may sign in, and what they are allowed to do. Set a short counter PIN so people can
            switch in at the till without typing a full password.
          </Text>
        </div>

        <Tooltip label={LICENCE_GUARD} disabled={!readOnly}>
          <Button
            leftSection={<UserPlus size={16} />}
            disabled={readOnly}
            onClick={() => setCreating(true)}
          >
            Add staff
          </Button>
        </Tooltip>
      </Group>

      <Alert color="blue" variant="light" icon={<Info size={16} />} p="xs">
        <Text size="sm">
          People are never deleted — they are retired, so old sales keep their name, and can be brought
          back at any time. The shop must always keep one active owner.
        </Text>
      </Alert>

      {error && (
        <Alert color="red" icon={<CircleAlert size={18} />} title="Staff could not be loaded">
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
          </Stack>
        ) : rows.length === 0 && !error ? (
          <Stack align="center" gap="xs" py="xl">
            <UserPlus size={32} opacity={0.5} />
            <Text fw={600}>No staff yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              Add your first staff member and they will be able to sign in.
            </Text>
          </Stack>
        ) : (
          <>
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Username</Table.Th>
                    <Table.Th>Role</Table.Th>
                    <Table.Th>Counter PIN</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th w={48} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((u) => {
                    const lastOwner = isLastOwner(u)
                    return (
                      <Table.Tr key={u.id}>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <Text size="sm" fw={500}>
                              {u.fullName}
                            </Text>
                            {u.id === currentUserId && (
                              <Badge size="xs" variant="light" color="blue">
                                you
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>

                        <Table.Td>
                          <Text ff="monospace" size="sm" c="dimmed">
                            {u.username}
                          </Text>
                        </Table.Td>

                        <Table.Td>
                          <Badge
                            variant="light"
                            color={ROLE_BADGE[u.role]}
                            leftSection={u.role === 'owner' ? <Crown size={11} /> : undefined}
                          >
                            {ROLE_LABEL[u.role]}
                          </Badge>
                        </Table.Td>

                        <Table.Td>
                          {u.hasPin ? (
                            <Badge size="sm" variant="light" color="teal">
                              PIN set
                            </Badge>
                          ) : (
                            <Text size="sm" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>

                        <Table.Td>
                          {u.isActive ? (
                            <Badge size="sm" variant="light" color="green">
                              Active
                            </Badge>
                          ) : (
                            <Badge size="sm" variant="light" color="gray">
                              Retired
                            </Badge>
                          )}
                        </Table.Td>

                        <Table.Td>
                          <Menu shadow="md" position="bottom-end" withinPortal>
                            <Menu.Target>
                              <ActionIcon
                                variant="subtle"
                                color="gray"
                                aria-label={`Actions for ${u.fullName}`}
                              >
                                <EllipsisVertical size={16} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <GuardedItem
                                icon={<UserCog size={14} />}
                                label="Change role"
                                disabled={readOnly || lastOwner}
                                tooltip={
                                  lastOwner ? OWNER_GUARD : readOnly ? LICENCE_GUARD : undefined
                                }
                                onClick={() => setRoleTarget(u)}
                              />
                              <GuardedItem
                                icon={<KeyRound size={14} />}
                                label="Reset password"
                                disabled={readOnly}
                                tooltip={readOnly ? LICENCE_GUARD : undefined}
                                onClick={() => setPasswordTarget(u)}
                              />
                              <GuardedItem
                                icon={<Lock size={14} />}
                                label={u.hasPin ? 'Change or clear PIN' : 'Set PIN'}
                                disabled={readOnly}
                                tooltip={readOnly ? LICENCE_GUARD : undefined}
                                onClick={() => setPinTarget(u)}
                              />
                              <Menu.Divider />
                              {u.isActive ? (
                                <GuardedItem
                                  icon={<UserX size={14} />}
                                  label="Deactivate"
                                  color="red"
                                  disabled={readOnly || lastOwner}
                                  tooltip={
                                    lastOwner ? OWNER_GUARD : readOnly ? LICENCE_GUARD : undefined
                                  }
                                  onClick={() => setDeactivateTarget(u)}
                                />
                              ) : (
                                <GuardedItem
                                  icon={<UserCheck size={14} />}
                                  label="Reactivate"
                                  disabled={readOnly}
                                  tooltip={readOnly ? LICENCE_GUARD : undefined}
                                  onClick={() => void reactivate(u)}
                                />
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        </Table.Td>
                      </Table.Tr>
                    )
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            <Paginator
              page={page}
              pageSize={pageSize}
              total={total}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          </>
        )}
      </Card>

      <AddStaffModal opened={creating} onClose={() => setCreating(false)} onDone={() => void load()} />
      <ChangeRoleModal
        user={roleTarget}
        onClose={() => setRoleTarget(null)}
        onDone={() => void load()}
      />
      <ResetPasswordModal
        user={passwordTarget}
        onClose={() => setPasswordTarget(null)}
        onDone={() => void load()}
      />
      <PinModal user={pinTarget} onClose={() => setPinTarget(null)} onDone={() => void load()} />
      <DeactivateModal
        user={deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        onDone={() => void load()}
      />
    </Stack>
  )
}

/**
 * A menu action that, when disabled, still explains itself. A disabled Menu.Item has
 * pointer-events: none, so the tooltip is hung on a wrapping element that DOES receive hover — this is
 * how the last-owner lock stays visible instead of being a control that simply does nothing.
 */
function GuardedItem({
  icon,
  label,
  disabled,
  tooltip,
  color,
  onClick
}: {
  icon: React.ReactNode
  label: string
  disabled?: boolean
  tooltip?: string
  color?: string
  onClick: () => void
}): React.JSX.Element {
  const item = (
    <Menu.Item leftSection={icon} color={color} disabled={disabled} onClick={onClick}>
      {label}
    </Menu.Item>
  )

  if (disabled && tooltip) {
    return (
      <Tooltip label={tooltip} position="left" withArrow multiline w={220}>
        <div>{item}</div>
      </Tooltip>
    )
  }
  return item
}

// ─────────────────────────────────────────────────────────────────────────────
// The modals. Each holds its own small form; the SERVICE does the real validation (length against the
// security.* settings, username uniqueness, the last-owner guard, PIN collision), so a friendly refusal
// comes back as a toast rather than being second-guessed here.
// ─────────────────────────────────────────────────────────────────────────────

function AddStaffModal({
  opened,
  onClose,
  onDone
}: {
  opened: boolean
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('cashier')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (opened) {
      setFullName('')
      setUsername('')
      setRole('cashier')
      setPassword('')
    }
  }, [opened])

  async function submit(): Promise<void> {
    setBusy(true)
    const result = await window.pos.users.create({
      username: username.trim(),
      fullName: fullName.trim(),
      role,
      password
    })
    setBusy(false)

    if (result.ok) {
      notifications.show({ color: 'teal', title: 'Staff added', message: result.data.fullName })
      onDone()
      onClose()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not add staff',
        message: result.error.userMessage
      })
    }
  }

  const canSubmit = fullName.trim() !== '' && username.trim() !== '' && password !== ''

  return (
    <Modal opened={opened} onClose={onClose} title="Add staff" centered>
      <Stack>
        <TextInput
          label="Full name"
          placeholder="e.g. Ali Raza"
          required
          value={fullName}
          onChange={(event) => setFullName(event.currentTarget.value)}
          data-autofocus
        />
        <TextInput
          label="Username"
          description="What they type to sign in"
          placeholder="e.g. ali"
          required
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
        />
        <Select
          label="Role"
          data={ROLE_DATA}
          value={role}
          allowDeselect={false}
          onChange={(value) => value && setRole(value as Role)}
        />
        <PasswordInput
          label="Password"
          required
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            Add staff
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function ChangeRoleModal({
  user,
  onClose,
  onDone
}: {
  user: User | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [role, setRole] = useState<Role>('cashier')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (user) setRole(user.role)
  }, [user])

  async function submit(): Promise<void> {
    if (!user) return
    setBusy(true)
    // Only the field the form edited goes back (trap #18). `id` names the user; `role` is the change.
    const result = await window.pos.users.update({ id: user.id, role })
    setBusy(false)

    if (result.ok) {
      notifications.show({
        color: 'teal',
        title: 'Role changed',
        message: `${user.fullName} is now ${ROLE_LABEL[role]}`
      })
      onDone()
      onClose()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not change role',
        message: result.error.userMessage
      })
    }
  }

  return (
    <Modal
      opened={user !== null}
      onClose={onClose}
      title={user ? `Change role — ${user.fullName}` : 'Change role'}
      centered
    >
      {user && (
        <Stack>
          <Select
            label="Role"
            data={ROLE_DATA}
            value={role}
            allowDeselect={false}
            onChange={(value) => value && setRole(value as Role)}
          />
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} disabled={role === user.role} onClick={() => void submit()}>
              Save
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}

function ResetPasswordModal({
  user,
  onClose,
  onDone
}: {
  user: User | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (user) setPassword('')
  }, [user])

  async function submit(): Promise<void> {
    if (!user) return
    setBusy(true)
    const result = await window.pos.users.setPassword({ id: user.id, password })
    setBusy(false)

    if (result.ok) {
      notifications.show({
        color: 'teal',
        title: 'Password reset',
        message: `A new password is set for ${user.fullName}`
      })
      onDone()
      onClose()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not reset password',
        message: result.error.userMessage
      })
    }
  }

  return (
    <Modal
      opened={user !== null}
      onClose={onClose}
      title={user ? `Reset password — ${user.fullName}` : 'Reset password'}
      centered
    >
      {user && (
        <Stack>
          <Text size="sm" c="dimmed">
            Set a new password for this person. They use it the next time they sign in.
          </Text>
          <PasswordInput
            label="New password"
            required
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            data-autofocus
          />
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} disabled={password === ''} onClick={() => void submit()}>
              Set password
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}

function PinModal({
  user,
  onClose,
  onDone
}: {
  user: User | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)

  useEffect(() => {
    if (user) setPin('')
  }, [user])

  async function save(): Promise<void> {
    if (!user) return
    setBusy('save')
    const result = await window.pos.users.setPin({ id: user.id, pin })
    setBusy(null)

    if (result.ok) {
      notifications.show({
        color: 'teal',
        title: 'PIN set',
        message: `${user.fullName} can now switch in at the counter`
      })
      onDone()
      onClose()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not set PIN',
        message: result.error.userMessage
      })
    }
  }

  async function clear(): Promise<void> {
    if (!user) return
    setBusy('clear')
    // A DELIBERATE null clears the PIN — .nullable(), not .nullish(), in the schema for exactly this.
    const result = await window.pos.users.setPin({ id: user.id, pin: null })
    setBusy(null)

    if (result.ok) {
      notifications.show({
        color: 'teal',
        title: 'PIN cleared',
        message: `${user.fullName} can no longer switch in with a PIN`
      })
      onDone()
      onClose()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not clear PIN',
        message: result.error.userMessage
      })
    }
  }

  return (
    <Modal
      opened={user !== null}
      onClose={onClose}
      title={user ? `Counter PIN — ${user.fullName}` : 'Counter PIN'}
      centered
    >
      {user && (
        <Stack>
          <Text size="sm" c="dimmed">
            A short PIN lets this person switch in at the till without typing their full password. It
            is not the password, and it is never shown again once set.
          </Text>
          <TextInput
            label={user.hasPin ? 'New PIN' : 'PIN'}
            placeholder="Digits only"
            inputMode="numeric"
            value={pin}
            onChange={(event) => setPin(event.currentTarget.value.replace(/\D/g, ''))}
            data-autofocus
          />
          <Group justify="space-between" mt="sm">
            <Button
              variant="subtle"
              color="red"
              leftSection={<Trash2 size={15} />}
              loading={busy === 'clear'}
              disabled={!user.hasPin}
              onClick={() => void clear()}
            >
              Clear PIN
            </Button>
            <Group>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button loading={busy === 'save'} disabled={pin === ''} onClick={() => void save()}>
                Save PIN
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}

function DeactivateModal({
  user,
  onClose,
  onDone
}: {
  user: User | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    if (!user) return
    setBusy(true)
    const result = await window.pos.users.deactivate({ id: user.id })
    setBusy(false)

    if (result.ok) {
      notifications.show({ color: 'teal', title: 'Staff retired', message: user.fullName })
      onDone()
      onClose()
    } else {
      notifications.show({
        color: 'red',
        title: 'Could not retire staff',
        message: result.error.userMessage
      })
    }
  }

  return (
    <Modal
      opened={user !== null}
      onClose={onClose}
      title={user ? `Retire ${user.fullName}?` : 'Retire staff'}
      centered
    >
      {user && (
        <Stack>
          <Text size="sm">
            They will no longer be able to sign in. Nothing they did is deleted — last year&rsquo;s
            sales keep their name — and you can bring them back at any time.
          </Text>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button color="red" loading={busy} onClick={() => void submit()}>
              Retire
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
