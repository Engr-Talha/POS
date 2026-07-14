import type { DB } from '../db'
import type { AuditEntry, User } from '@shared/types'

/**
 * THE AUDIT LOG — WHO did WHAT and WHEN. (CLAUDE.md §4)
 *
 * This is where a shop finds out who has been stealing from it. Voids, refunds, big discounts,
 * price overrides, opening the till with no sale — every one of them lands here with a name, a
 * ROLE, and a timestamp.
 *
 * APPEND-ONLY. Nothing in this app updates or deletes an audit row. If a feature ever needs to,
 * that feature is wrong.
 *
 * The user's NAME AND ROLE ARE COPIED IN, not looked up by join. If a cashier is later promoted, or
 * renamed, or deleted, the log must still say what was true AT THE TIME. A join would silently
 * rewrite history — and a history that can be rewritten is not evidence of anything.
 */

export type AuditInput = {
  action: string
  entity?: string
  entityId?: string | number
  reasonCode?: string
  reasonText?: string
  before?: unknown
  after?: unknown
  approvedBy?: User
}

export function record(db: DB, actor: User, input: AuditInput, now = new Date()): void {
  db.prepare(
    `INSERT INTO audit_log
       (at, user_id, user_name, user_role, action, entity, entity_id,
        reason_code, reason_text, before_json, after_json, approved_by_user_id, approved_by_name)
     VALUES
       (@at, @userId, @userName, @userRole, @action, @entity, @entityId,
        @reasonCode, @reasonText, @beforeJson, @afterJson, @approvedById, @approvedByName)`
  ).run({
    at: now.toISOString(),
    userId: actor.id,
    userName: actor.fullName, // copied in — see above
    userRole: actor.role, // copied in — see above
    action: input.action,
    entity: input.entity ?? null,
    entityId: input.entityId != null ? String(input.entityId) : null,
    reasonCode: input.reasonCode ?? null,
    reasonText: input.reasonText ?? null,
    beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
    afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    approvedById: input.approvedBy?.id ?? null,
    approvedByName: input.approvedBy?.fullName ?? null
  })
}

export type AuditQuery = {
  page?: number
  pageSize?: number
  action?: string
  userId?: number
}

/** Paginated, always. Assume 100k+ rows — a busy shop generates audit rows all day. */
export function list(
  db: DB,
  query: AuditQuery = {}
): { rows: AuditEntry[]; total: number; page: number; pageSize: number } {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (query.action) {
    where.push('action = @action')
    params['action'] = query.action
  }
  if (query.userId != null) {
    where.push('user_id = @userId')
    params['userId'] = query.userId
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(`SELECT COUNT(*) FROM audit_log ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT id, at, user_id, user_name, user_role, action, entity, entity_id,
              reason_code, reason_text, approved_by_name
       FROM audit_log ${whereSql}
       ORDER BY at DESC, id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<
    Record<string, unknown>
  >

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row['id'] as number,
      at: row['at'] as string,
      userId: (row['user_id'] as number | null) ?? null,
      userName: row['user_name'] as string,
      userRole: row['user_role'] as string,
      action: row['action'] as string,
      entity: (row['entity'] as string | null) ?? null,
      entityId: (row['entity_id'] as string | null) ?? null,
      reasonCode: (row['reason_code'] as string | null) ?? null,
      reasonText: (row['reason_text'] as string | null) ?? null,
      approvedByName: (row['approved_by_name'] as string | null) ?? null
    }))
  }
}
