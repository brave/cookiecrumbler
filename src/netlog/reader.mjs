// NetLog file reading: size rejection, format sniffing (legacy single-JSON vs
// NDJSON) and event extraction. The reconstruction itself lives in index.mjs.

import fs from 'fs/promises'
import { createInterface } from 'node:readline'

import { NetLogError } from './errors.mjs'
import { NETLOG_CAP_BYTES, NETLOG_REJECT_RATIO } from './config.mjs'

/**
 * A netlog's constants and events, validated downstream (the constants
 * object and the event envelope are checked by the parser).
 * @typedef {object} RawNetLog
 * @property {unknown} constants
 * @property {unknown[]} events
 */

/**
 * Narrows an unknown value to an object (excluding arrays and null).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Message of a caught unknown error.
 * @param {unknown} error
 * @returns {string}
 */
const errorMessage = (error) => error instanceof Error ? error.message : String(error)

/**
 * Reads and validates the netlog file. Supports both the legacy single-JSON
 * format ({constants, events, polledData}) and the NDJSON format written when
 * the browser runs with --net-log-file-format=ndjson (one JSON object per
 * line: {"type":"constants",...} first, then one {"type":"event","event":...}
 * per event, then {"type":"polledData",...} and {"type":"end"}).
 * @param {string} netlogPath path of the netlog JSON file
 * @param {{ maxNetlogBytes?: number }} [options]
 * @returns {Promise<RawNetLog>}
 */
export const readNetLog = async (netlogPath, { maxNetlogBytes = NETLOG_CAP_BYTES } = {}) => {
  // Reject at 90% of the browser cap: bounded mode rotates away the oldest
  // events, so a full file proves earlier traffic was dropped (see config.mjs)
  const limit = Math.floor(maxNetlogBytes * NETLOG_REJECT_RATIO)
  let stat
  try {
    stat = await fs.stat(netlogPath)
  } catch (error) {
    throw new NetLogError(`invalid netlog data: ${errorMessage(error)}`, { cause: error })
  }
  if (stat.size >= limit) {
    throw new NetLogError(`netlog file (${stat.size} bytes) reached the ${limit} byte limit (90% of the ${maxNetlogBytes} byte browser cap); earlier traffic was dropped`)
  }
  let handle
  try {
    handle = await fs.open(netlogPath, 'r')
  } catch (error) {
    throw new NetLogError(`invalid netlog data: ${errorMessage(error)}`, { cause: error })
  }
  try {
    // Peek at the first bytes to tell the NDJSON format from the legacy
    // single-JSON document; a BOM or whitespace before the marker is skipped,
    // which browsers do not write but hand-edited or piped files can carry
    const head = Buffer.alloc(32)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (head.subarray(0, bytesRead).toString('utf8').trimStart().startsWith('{"type":')) {
      return await readNdjsonEvents(handle)
    }
    // Legacy format: a single JSON document, which can only be parsed whole;
    // its size stays bounded by the stat check above
    let content
    try {
      content = await handle.readFile('utf8')
    } catch (error) {
      throw new NetLogError(`invalid netlog data: ${errorMessage(error)}`, { cause: error })
    }
    let netlog
    try {
      netlog = /** @type {unknown} */ (JSON.parse(content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content))
    } catch (error) {
      throw new NetLogError(`invalid netlog data: ${errorMessage(error)}`, { cause: error })
    }
    if (!isObject(netlog) || !Array.isArray(netlog.events)) {
      throw new NetLogError('netlog is missing the events list')
    }
    return { constants: netlog.constants ?? null, events: netlog.events }
  } finally {
    await handle.close()
  }
}

/**
 * Streams NDJSON netlog lines instead of materializing the whole file as one
 * string: {"type":"constants",...} first, then one {"type":"event",...} per
 * event, then {"type":"polledData",...} and {"type":"end"} (which carry no
 * recorded traffic). The constants and end records are required: a browser
 * killed or crashed before finalizing the log leaves a file that parses
 * cleanly but is missing everything it never got to write, so a stream that
 * ends without them is rejected as truncated. The parsed events still
 * accumulate in memory, but the raw file string and its per-line split copy
 * never exist.
 * @param {import('fs/promises').FileHandle} handle
 * @returns {Promise<RawNetLog>}
 */
const readNdjsonEvents = async (handle) => {
  const stream = handle.createReadStream({ encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    let constants
    let sawConstants = false
    let sawEnd = false
    const events = []
    for await (const line of lines) {
      if (line.trim() === '') continue
      const entry = /** @type {unknown} */ (JSON.parse(line.charCodeAt(0) === 0xFEFF ? line.slice(1) : line))
      if (!isObject(entry)) continue
      if (entry.type === 'constants') {
        constants = entry.constants
        sawConstants = true
      } else if (entry.type === 'event' && entry.event !== undefined) {
        events.push(entry.event)
      } else if (entry.type === 'end') {
        sawEnd = true
      }
    }
    if (!sawConstants || !sawEnd) {
      throw new NetLogError(sawConstants
        ? 'truncated netlog: the NDJSON stream ended without its end record; the browser likely did not finalize the log'
        : 'truncated netlog: the NDJSON stream is missing its constants record; the browser likely did not finalize the log')
    }
    return { constants: constants ?? null, events }
  } catch (error) {
    throw error instanceof NetLogError ? error : new NetLogError(`invalid netlog data: ${errorMessage(error)}`, { cause: error })
  } finally {
    lines.close()
    stream.destroy()
  }
}
