// Browser-side cap (--net-log-max-size-mb) and parser-side rejection
// threshold. Bounded mode writes a stitched file at or below the browser cap
// (rotating away the oldest events once the cap is reached), so a file within
// the last stretch of the cap proves that earlier traffic was rotated away
// and parsing must fail; a truncated archive passes silently otherwise.
export const DEFAULT_NETLOG_CAP_MB = 300
export const NETLOG_REJECT_RATIO = 0.9
