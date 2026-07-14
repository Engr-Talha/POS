/**
 * The Result envelope. EVERY IPC handler returns one of these — never a bare value, never a throw.
 *
 * `userMessage` is read by a CASHIER. It must be plain, friendly, actionable language.
 * "This item is out of stock." — not "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed".
 * `technical` is for the log file and for us. It never reaches the screen.
 */
export type Ok<T> = { ok: true; data: T }

export type Err = {
  ok: false
  error: {
    code: string
    userMessage: string
    technical: string
  }
}

export type Result<T> = Ok<T> | Err

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data }
}

export function err(code: string, userMessage: string, technical = ''): Err {
  return { ok: false, error: { code, userMessage, technical } }
}

/**
 * Throw this from a service when something goes wrong in a way the user should hear about.
 * The IPC layer catches it and turns it into an Err. Anything else that escapes a service is a
 * BUG, and the IPC layer reports it as a generic "something went wrong" — never as a stack trace.
 */
export class AppError extends Error {
  readonly code: string
  readonly userMessage: string

  constructor(code: string, userMessage: string, technical?: string) {
    super(technical ?? userMessage)
    this.name = 'AppError'
    this.code = code
    this.userMessage = userMessage
  }
}

/** Error codes. Add to this union rather than inventing strings at call sites. */
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  LICENSE_INVALID: 'LICENSE_INVALID',
  READ_ONLY: 'READ_ONLY',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  DB: 'DB',
  UNKNOWN: 'UNKNOWN'
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]
