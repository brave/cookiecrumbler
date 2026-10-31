// Public entry point of the netlog2wpr package: converts Chromium NetLog
// captures into WebPageReplay (wpr-go) record-format archive objects.

import { archiveFromExchanges } from './archive.mjs'
import { parseNetLog } from './netlog/exchanges.mjs'
import { NetLogError } from './netlog/errors.mjs'

export { archiveFromExchanges } from './archive.mjs'
export { createRecordingContext } from './recording.mjs'
export { renderDeterministicScript } from './deterministic.mjs'
export { isInternalRequest, parseNetLog } from './netlog/exchanges.mjs'
export { NetLogError } from './netlog/errors.mjs'
export { DEFAULT_NETLOG_CAP_MB } from './netlog/config.mjs'

/**
 * A dropped or unparsable exchange, reported through onWarning and collected
 * in the returned warnings array.
 * @typedef {{ code: string, url?: string, message: string }} Warning
 */

/**
 * Converts a netlog file into a WprGo archive object: parses the recorded
 * exchanges (see parseNetLog) and serializes them (see archiveFromExchanges).
 *
 * Throws a NetLogError with code 'NO_REQUESTS' when the netlog contains no
 * recorded requests, and code 'ALL_DROPPED' when serialization dropped every
 * reconstructed exchange (truncated HTTP/1 bodies).
 *
 * @param {string} netlogPath path of the netlog JSON file
 * @param {object} [options]
 * @param {number} [options.maxNetlogBytes] cap matching the browser's
 *   --net-log-max-size-mb; the parser rejects files at 90% of it because
 *   bounded mode rotates older events away
 * @param {boolean} [options.dropInternalRequests] drop browser-internal
 *   traffic (updater, Safe Browsing, telemetry, spellcheck); default true
 * @param {Record<string, string>} [options.injectedScripts] map of script name to source,
 *   embedded in the archive like wpr record embeds --inject-scripts
 * @param {number} [options.deterministicTimeSeedMs] time seed for the archive
 * @param {string} [options.replayNonce] base64 CSP replay nonce; a fresh
 *   random one is generated when omitted
 * @param {string} [options.metadata] free-form metadata stored in the
 *   archive; wpr-go replay targets are unaffected by it
 * @param {function(Warning): void} [options.onWarning]
 *   called for every dropped or unparsable exchange; warnings are also
 *   collected in the returned warnings array
 * @returns {Promise<{ archive: import('./archive.mjs').WprArchive, stats: {
 *   exchanges: number, hosts: number, dropped: { failed: number, unparsable: number,
 *   internalRequests: number, truncatedBodies: number } }, warnings: Warning[] }>}
 *   archive is the WprGo archive object, stats merges the parser stats with
 *   the archive host count and the truncated-body drop count, warnings lists
 *   every warning also passed to onWarning
 */
export const netlogToWprArchive = async (netlogPath, { maxNetlogBytes, dropInternalRequests, injectedScripts, deterministicTimeSeedMs, replayNonce, metadata, onWarning } = {}) => {
  /** @type {Warning[]} */
  const warnings = []
  /**
   * @param {Warning} warning
   */
  const warn = (warning) => {
    warnings.push(warning)
    onWarning?.(warning)
  }
  const parsed = await parseNetLog(netlogPath, { maxNetlogBytes, dropInternalRequests, onWarning: warn })
  if (parsed.exchanges.length === 0) {
    throw new NetLogError('netlog contains no recorded requests', { code: 'NO_REQUESTS' })
  }
  const archive = archiveFromExchanges(parsed.exchanges, parsed.negotiatedProtocols, {
    injectedScripts,
    deterministicTimeSeedMs,
    replayNonce,
    metadata,
    onWarning: warn
  })
  // Filtering can drop every reconstructed exchange (truncated HTTP/1
  // bodies); reporting success would hide a capture with nothing replayable
  if (Object.keys(archive.Requests).length === 0) {
    throw new NetLogError('every recorded request was dropped as unreplayable', { code: 'ALL_DROPPED' })
  }
  const stats = {
    ...parsed.stats,
    hosts: Object.keys(archive.Requests).length,
    dropped: {
      ...parsed.stats.dropped,
      truncatedBodies: warnings.filter(warning => warning.code === 'TRUNCATED_BODY').length
    }
  }
  return { archive, stats, warnings }
}
