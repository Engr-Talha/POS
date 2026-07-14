import log from 'electron-log/main'

/**
 * App log -> a file in userData. This is NOT the audit log.
 *
 *   app log   = what the software did (crashes, update checks, slow queries). For us.
 *   audit log = WHO did WHAT and WHEN (voids, refunds, discounts). In the database. For the owner.
 *
 * They are different things and both exist (CLAUDE.md §4).
 */
log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

// Keep a bounded amount of history — this app runs for years on a shop counter.
log.transports.file.maxSize = 10 * 1024 * 1024

export default log
