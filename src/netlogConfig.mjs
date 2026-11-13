// Browser-side cap (--net-log-max-size-mb) and parser-side rejection
// threshold. Bounded mode writes a stitched file at or below the browser cap
// (rotating away the oldest events once the cap is reached), so a file within
// the last stretch of the cap proves that earlier traffic was rotated away
// and parsing must fail; a truncated archive passes silently otherwise.
import { DEFAULT_NETLOG_CAP_MB } from 'netlog2wpr'

/**
 * Parses a positive integer, or null when the value is absent or invalid.
 * @param {string|undefined} value
 * @returns {number|null}
 */
const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export const NETLOG_CAP_MB = parsePositiveInt(process.env.MAX_NETLOG_MB) ?? DEFAULT_NETLOG_CAP_MB
export const NETLOG_CAP_BYTES = NETLOG_CAP_MB * 1024 * 1024

// Upper bound for decompressed WprGo archives, enforced at record time and on
// replay uploads. This is a policy bound for replay-side memory, not a
// ceiling the record path can rely on: the archive is usually well below the
// netlog (bodies are stored once in the archive, twice or more in the
// netlog), but cache-revalidated 304 responses store their body again per
// exchange, and the CSP rewrite inflates headers, so an archive can approach
// or exceed the netlog size. Recordings above the bound fail cleanly with
// ARCHIVE_TOO_LARGE.
export const MAX_ARCHIVE_MB = parsePositiveInt(process.env.MAX_ARCHIVE_MB) ?? 200
export const MAX_ARCHIVE_BYTES = MAX_ARCHIVE_MB * 1024 * 1024
