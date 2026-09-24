// Chromium NetLog ("Everything" capture mode) parsing: reconstructs HTTP
// request/response exchanges from browser traffic. The archive writing
// (WprGo record format) lives in wpr-archive.mjs.
//
// NetLog event model:
//
// Events are chronological; each has { source: { id, type }, type, params }.
// Types are numeric in the file; names come from constants.logEventTypes /
// constants.logSourceType (numbers vary between Chrome versions, so they are
// always resolved dynamically).
//
// Relevant sources:
// - URL_REQUEST: one per resource; its events carry the request headers
//   (HTTP_TRANSACTION_*_SEND_REQUEST_HEADERS), response headers
//   (HTTP_TRANSACTION_READ_RESPONSE_HEADERS) and the raw, still
//   content-encoded response body chunks (URL_REQUEST_JOB_BYTES_READ).
// - HTTP_STREAM_JOB: binds a URL_REQUEST to a socket/HTTP2_SESSION and
//   carries the negotiated protocol (HTTP_STREAM_REQUEST_PROTO).
// - SOCKET: SSL_SOCKET_BYTES_SENT carries the TLS payload plaintext (for
//   HTTP/1.1 these are the raw HTTP bytes; SOCKET_BYTES_* carry ciphertext
//   for TLS sockets).
// - HTTP2_SESSION: wraps a SOCKET; SEND_HEADERS events carry request header
//   blocks with stream ids, which lets request bodies be recovered from
//   HTTP/2 DATA frames on the underlying socket.

import fs from 'fs/promises'
import { createInterface } from 'node:readline'

export class NetLogError extends Error {
  constructor (message) {
    super(message)
    this.name = 'NetLogError'
  }
}

// Upper bound for netlog files, guarding against unbounded memory growth.
// The browser caps the file itself via --net-log-max-size-mb: its bounded
// observer rotates files and drops the oldest events once the cap is
// reached, and the final stitched file lands at or below the cap. A file
// that grew into the last stretch of the cap therefore proves that earlier
// traffic was dropped, so parsing rejects files at or above 90% of the cap.
// The cap (in megabytes) is overridable via the MAX_NETLOG_BYTES env var;
// the exported constant is in bytes.
const maxNetlogMb = parseInt(process.env.MAX_NETLOG_BYTES, 10)
export const MAX_NETLOG_BYTES = (Number.isInteger(maxNetlogMb) && maxNetlogMb > 0 ? maxNetlogMb : 300) * 1024 * 1024

/**
 * Replaces the deterministic.js placeholders exactly like wpr's
 * replaceConstants (legacy {{X}} form first, then the bare form).
 */
export const replaceConstants = (script, timeSeedMs, constantMathRandomResult) => {
  const randomResultStr = constantMathRandomResult === undefined || constantMathRandomResult === null
    ? 'null'
    : String(constantMathRandomResult)
  const timeSeedTimestamp = String(timeSeedMs)
  return script
    .replaceAll('{{WPR_TIME_SEED_TIMESTAMP}}', timeSeedTimestamp)
    .replaceAll('{{WPR_CONSTANT_RANDOM_RESULT}}', randomResultStr)
    .replaceAll('WPR_TIME_SEED_TIMESTAMP', timeSeedTimestamp)
    .replaceAll('WPR_CONSTANT_RANDOM_RESULT', randomResultStr)
}

/**
 * Reads and validates the netlog file. Supports both the legacy single-JSON
 * format ({constants, events, polledData}) and the NDJSON format written when
 * the browser runs with --net-log-file-format=ndjson (one JSON object per
 * line: {"type":"constants",...} first, then one {"type":"event","event":...}
 * per event, then {"type":"polledData",...} and {"type":"end"}).
 */
const readNetLog = async (netlogPath, { maxNetlogBytes = MAX_NETLOG_BYTES } = {}) => {
  // Bounded mode writes a file at or below the browser cap (rotating away
  // the oldest events once it is reached), so a file within the last 10% of
  // the cap proves that earlier traffic was rotated away and parsing must
  // fail; a truncated archive passes silently otherwise.
  const limit = Math.floor(maxNetlogBytes * 0.9)
  const stat = await fs.stat(netlogPath)
  if (stat.size >= limit) {
    throw new NetLogError(`netlog file (${stat.size} bytes) reached the ${limit} byte limit (90% of the ${maxNetlogBytes} byte browser cap); earlier traffic was dropped`)
  }
  let handle
  try {
    handle = await fs.open(netlogPath, 'r')
  } catch (error) {
    throw new NetLogError(`invalid netlog data: ${error.message}`)
  }
  try {
    // Peek at the first bytes to tell the NDJSON format from the legacy
    // single-JSON document
    const head = Buffer.alloc(8) // '{"type":'
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (head.subarray(0, bytesRead).toString('utf8') === '{"type":') {
      return await readNdjsonEvents(handle)
    }
    // Legacy format: a single JSON document, which can only be parsed whole;
    // its size stays bounded by the stat check above
    let content
    try {
      content = await handle.readFile('utf8')
    } catch (error) {
      throw new NetLogError(`invalid netlog data: ${error.message}`)
    }
    let netlog
    try {
      netlog = JSON.parse(content)
    } catch (error) {
      throw new NetLogError(`invalid netlog data: ${error.message}`)
    }
    if (netlog === null || typeof netlog !== 'object' || Array.isArray(netlog.events) !== true) {
      throw new NetLogError('netlog is missing the events list')
    }
    return { constants: netlog.constants ?? {}, events: netlog.events }
  } finally {
    await handle.close()
  }
}

/**
 * Streams NDJSON netlog lines instead of materializing the whole file as one
 * string: {"type":"constants",...} first, then one {"type":"event",...} per
 * event, then {"type":"polledData",...} and {"type":"end"} (which carry no
 * recorded traffic). The parsed events still accumulate in memory, but the
 * raw file string and its per-line split copy never exist.
 */
const readNdjsonEvents = async (handle) => {
  const stream = handle.createReadStream({ encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    let constants
    const events = []
    for await (const line of lines) {
      if (line.trim() === '') continue
      const entry = JSON.parse(line)
      if (entry.type === 'constants') {
        constants = entry.constants
      } else if (entry.type === 'event' && entry.event !== undefined) {
        events.push(entry.event)
      }
    }
    return { constants, events }
  } catch (error) {
    throw new NetLogError(`invalid netlog data: ${error.message}`)
  } finally {
    lines.close()
    stream.destroy()
  }
}

const HTTP2_CONNECTION_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')
const HTTP2_FRAME_DATA = 0x0
const HTTP2_FLAG_PADDED = 0x8

// Canonical MIME header key casing (like Go's textproto.CanonicalMIMEHeaderKey)
const canonicalHeaderKey = (key) => key.split('-').map(part => (part === '' ? '' : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())).join('-')

/**
 * Reads a header value from a logged "name: value" header list.
 */
const headerValue = (headerList, name) => {
  const canonical = canonicalHeaderKey(name)
  for (const line of headerList) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    if (canonicalHeaderKey(line.slice(0, idx).trim()) === canonical) {
      return line.slice(idx + 1).trim()
    }
  }
  return null
}

/**
 * Collects HTTP/2 DATA frame payloads per stream from the TLS payload
 * plaintext written on a connection.
 */
const extractH2DataFrames = (bytes) => {
  const payloads = new Map() // streamId -> [Buffer]
  let offset = 0
  if (bytes.subarray(0, HTTP2_CONNECTION_PREFACE.length).equals(HTTP2_CONNECTION_PREFACE)) {
    offset = HTTP2_CONNECTION_PREFACE.length
  }
  while (offset + 9 <= bytes.length) {
    const length = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
    const type = bytes[offset + 3]
    const flags = bytes[offset + 4]
    const streamId = bytes.readUInt32BE(offset + 5) & 0x7fffffff
    const payloadStart = offset + 9
    if (payloadStart + length > bytes.length) {
      break // truncated
    }
    if (type === HTTP2_FRAME_DATA && length > 0) {
      let payload = bytes.subarray(payloadStart, payloadStart + length)
      if ((flags & HTTP2_FLAG_PADDED) !== 0 && payload.length > 0) {
        payload = payload.subarray(1, payload.length - payload[0])
      }
      if (payload.length > 0) {
        let frames = payloads.get(streamId)
        if (frames === undefined) payloads.set(streamId, frames = [])
        frames.push(Buffer.from(payload))
      }
    }
    offset = payloadStart + length
  }
  return payloads
}

/**
 * Parses a logged request header list ("name: value" strings; HTTP/2 lists
 * include pseudo-headers) into { method, path, authority, userAgent, entries }
 * where entries are [canonicalName, value] pairs without Host/User-Agent/
 * Content-Length/Transfer-Encoding (serialized separately, like Go's
 * req.Write).
 */
const parseRequestHeaders = (headerList) => {
  let method = null
  let path = null
  let authority = null
  let userAgent = null
  const entries = []
  for (const line of headerList) {
    if (line.startsWith(':')) {
      // HTTP/2 pseudo-header: ":name: value"
      const sep = line.indexOf(':', 1)
      if (sep === -1) continue
      const rawName = line.slice(0, sep)
      const value = line.slice(sep + 1).trim()
      if (rawName === ':method') method = value
      else if (rawName === ':path') path = value
      else if (rawName === ':authority') authority = value
      // :scheme/:protocol and other pseudo-headers are dropped
      continue
    }
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const rawName = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    const name = canonicalHeaderKey(rawName)
    if (name === 'Host') {
      authority = value
      continue
    }
    if (name === 'User-Agent') {
      userAgent = value
      continue
    }
    if (name === 'Content-Length' || name === 'Transfer-Encoding') {
      continue // written separately from the recovered body
    }
    entries.push([name, value])
  }
  return { method, path, authority, userAgent, entries }
}

/**
 * Parses a logged response header list (first entry is the status line).
 * Returns { code, chunked, contentLength, entries } with entries as
 * [canonicalName, value] pairs without Content-Length/Transfer-Encoding,
 * which are written separately like Go's resp.Write does.
 */
const parseResponseHeaders = (headerList) => {
  const match = /^(HTTP\/\d(?:\.\d)?) (\d{3})(?: (.*))?$/.exec(headerList[0] ?? '')
  const code = match === null ? 0 : parseInt(match[2], 10)
  let chunked = false
  let contentLength = null
  const entries = []
  for (const line of headerList.slice(1)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const name = canonicalHeaderKey(line.slice(0, idx).trim())
    const value = line.slice(idx + 1).trim()
    if (name === 'Content-Length') {
      contentLength = value
      continue
    }
    if (name === 'Transfer-Encoding' && /chunked/i.test(value)) {
      chunked = true
      continue
    }
    entries.push([name, value])
  }
  return { statusLine: headerList[0] ?? '', code, chunked, contentLength, entries }
}

/**
 * Parses the netlog and reconstructs the recorded HTTP exchanges.
 *
 * @param {string} netlogPath path of the netlog JSON file
 * @returns {Promise<{exchanges: object[], negotiatedProtocols: Map<string, string>}>}
 *   exchanges are chronological objects:
 *   { url, method, path, authority, userAgent, isHttp1, requestEntries,
 *     requestContentLength, requestChunked, requestBody, responseCode,
 *     responseEntries, responseContentLength, responseChunked, responseBody,
 *     negotiatedProtocol }
 */
export const buildExchangesFromNetLog = async (netlogPath, options = {}) => {
  const netlog = await readNetLog(netlogPath, options)
  const constants = netlog.constants ?? {}
  const eventType = name => constants.logEventTypes?.[name]
  const sourceType = constants.logSourceType ?? {}
  if (constants.logEventTypes === undefined || sourceType.URL_REQUEST === undefined) {
    throw new NetLogError('netlog is missing the event/source type constants')
  }

  // Events grouped by source, preserving chronological order. Source ids are
  // partitioned per source type, so maps are keyed by type:id pairs.
  const sourceKey = (type, id) => `${type}-${id}`
  const sources = new Map() // type:id -> { type, events }
  for (const event of netlog.events) {
    const { id, type } = event.source ?? {}
    if (id === undefined || type === undefined) continue
    const key = sourceKey(type, id)
    let source = sources.get(key)
    if (source === undefined) sources.set(key, source = { type, events: [] })
    source.events.push(event)
  }

  const ET = {
    requestAlive: eventType('REQUEST_ALIVE'),
    startJob: eventType('URL_REQUEST_START_JOB'),
    redirected: eventType('URL_REQUEST_REDIRECTED'),
    sendHeaders: eventType('HTTP_TRANSACTION_SEND_REQUEST_HEADERS'),
    http2SendHeaders: eventType('HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS'),
    readResponseHeaders: eventType('HTTP_TRANSACTION_READ_RESPONSE_HEADERS'),
    jobBytesRead: eventType('URL_REQUEST_JOB_BYTES_READ'),
    jobFilteredBytesRead: eventType('URL_REQUEST_JOB_FILTERED_BYTES_READ'),
    streamBound: eventType('HTTP_STREAM_REQUEST_BOUND_TO_JOB'),
    socketBound: eventType('SOCKET_POOL_BOUND_TO_SOCKET'),
    proto: eventType('HTTP_STREAM_REQUEST_PROTO'),
    sessionInitialized: eventType('HTTP2_SESSION_INITIALIZED'),
    sessionSendHeaders: eventType('HTTP2_SESSION_SEND_HEADERS'),
    sessionPoolImported: eventType('HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET'),
    sessionPoolFound: eventType('HTTP2_SESSION_POOL_FOUND_EXISTING_SESSION'),
    socketBytesSent: eventType('SOCKET_BYTES_SENT'),
    sslSocketBytesSent: eventType('SSL_SOCKET_BYTES_SENT')
  }

  // TLS payload plaintext written per socket. SSL_SOCKET_BYTES_* events carry
  // the decrypted bytes; SOCKET_BYTES_* carry the ciphertext for TLS sockets.
  const socketSentChunks = new Map() // sourceKey -> [Buffer]
  for (const source of sources.values()) {
    if (source.type !== sourceType.SOCKET) continue
    const sslChunks = []
    const tcpChunks = []
    for (const event of source.events) {
      if (event.params?.bytes === undefined) continue
      if (event.type === ET.sslSocketBytesSent) {
        sslChunks.push(Buffer.from(event.params.bytes, 'base64'))
      } else if (event.type === ET.socketBytesSent) {
        tcpChunks.push(Buffer.from(event.params.bytes, 'base64'))
      }
    }
    const { id, type } = source.events[0].source
    socketSentChunks.set(sourceKey(type, id), sslChunks.length > 0 ? sslChunks : tcpChunks)
  }

  // HTTP/2 sessions: request bodies as DATA frames and stream ids per
  // request header block
  const h2Sessions = new Map() // sourceKey -> { headerBlocks, dataFrames }
  for (const source of sources.values()) {
    if (source.type !== sourceType.HTTP2_SESSION) continue
    let socketKey
    const headerBlocks = [] // { key, streamId } in chronological order
    for (const event of source.events) {
      if (event.type === eventType('HTTP2_SESSION_INITIALIZED')) {
        const dep = event.params?.source_dependency
        if (dep?.id !== undefined) {
          socketKey = sourceKey(dep.type, dep.id)
        }
      } else if (event.type === ET.sessionSendHeaders) {
        headerBlocks.push({
          key: JSON.stringify(event.params?.headers),
          streamId: event.params?.stream_id
        })
      }
    }
    const { id, type } = source.events[0].source
    h2Sessions.set(sourceKey(type, id), {
      headerBlocks,
      dataFrames: extractH2DataFrames(Buffer.concat(socketSentChunks.get(socketKey) ?? []))
    })
  }

  // Stream jobs: negotiated protocol, bound socket/session
  const jobs = new Map() // sourceKey -> { protocol, socketId, sessions }
  for (const source of sources.values()) {
    if (source.type !== sourceType.HTTP_STREAM_JOB) continue
    const job = { protocol: null, socketId: null, sessions: [] }
    for (const event of source.events) {
      const params = event.params ?? {}
      if (event.type === ET.proto) {
        job.protocol = params.proto
      } else if (event.type === ET.socketBound) {
        const dep = params.source_dependency
        job.socketId = dep === undefined ? null : sourceKey(dep.type, dep.id)
      } else if (event.type === ET.sessionPoolImported || event.type === ET.sessionPoolFound) {
        const dep = params.source_dependency
        if (dep?.type === sourceType.HTTP2_SESSION) {
          job.sessions.push(sourceKey(dep.type, dep.id))
        }
      }
    }
    const { id, type } = source.events[0].source
    jobs.set(sourceKey(type, id), job)
  }

  // Reconstruct request/response pairs from URL_REQUEST sources
  const exchanges = []
  for (const source of sources.values()) {
    if (source.type !== sourceType.URL_REQUEST) continue

    let url = null
    let redirectTarget = null
    let boundJobId = null
    let hop = null
    let browserInternal = false
    const hops = []
    source.events.forEach((event, index) => {
      const params = event.params ?? {}
      // Failure events on the source: the URL_REQUEST_START_JOB end (and the
      // REQUEST_ALIVE end) carry net_error only when the job genuinely failed
      // (truncated body, reset H2 stream, ...), mirroring the browser's own
      // explicit error; cancellations are deliberately not logged as errors
      // (url_request.cc logs net_error "only on failure"). The in-flight hop
      // never completed, so it is dropped like the browser did.
      if (hop !== null && typeof params.net_error === 'number' && params.net_error !== 0) {
        hop.failed = true
      }
      if (event.type === ET.requestAlive) {
        url = typeof params.url === 'string' ? params.url : url
      } else if (event.type === ET.startJob) {
        if (typeof params.url === 'string') url = params.url
        // Browser-internal traffic (updater, safebrowsing, telemetry, background
        // services) is issued outside any page frame: either it has no frame
        // context (empty network isolation key) or it is a browser-issued
        // non-navigation request ("not an origin" initiator). Redirects re-log
        // START_JOB with the same attribution, so one match filters the whole
        // source. A missing NIK keeps the request.
        browserInternal ||= (params.network_isolation_key ?? params.network_anonymization_key ?? '').startsWith('null') ||
          (params.initiator === 'not an origin' && params.request_type !== undefined && params.request_type !== 'main frame')
      } else if (event.type === ET.redirected) {
        redirectTarget = typeof params.location === 'string' ? params.location : redirectTarget
      } else if (event.type === ET.streamBound) {
        const dep = params.source_dependency
        boundJobId = dep === undefined ? undefined : sourceKey(dep.type, dep.id)
      } else if (event.type === ET.sendHeaders || event.type === ET.http2SendHeaders) {
        hop = {
          eventIndex: index,
          url: redirectTarget ?? url,
          isHttp1: event.type === ET.sendHeaders,
          requestLine: event.params.line ?? null,
          requestHeaders: event.params.headers ?? [],
          responseHeaders: null,
          rawChunks: [],
          filteredChunks: [],
          boundJobId,
          failed: false
        }
        redirectTarget = null
        hops.push(hop)
      } else if (event.type === ET.readResponseHeaders && hop !== null) {
        hop.responseHeaders = event.params.headers
      } else if (event.type === ET.jobBytesRead && hop !== null && event.params?.bytes !== undefined) {
        // Raw (still content-encoded) bytes; only logged when a content filter ran
        hop.rawChunks.push(Buffer.from(event.params.bytes, 'base64'))
      } else if (event.type === ET.jobFilteredBytesRead && hop !== null && event.params?.bytes !== undefined) {
        // Post-filter bytes; for identity responses these are the wire bytes
        hop.filteredChunks.push(Buffer.from(event.params.bytes, 'base64'))
      }
    })

    for (const candidate of hops) {
      if (candidate.url === null || candidate.responseHeaders === null || candidate.failed || browserInternal) {
        continue
      }
      const request = parseRequestHeaders(candidate.requestHeaders)
      // HTTP/1.x has no :method pseudo-header; take it from the request line
      if (candidate.isHttp1 && request.method === null) {
        const lineMatch = /^(\S+) (\S+) HTTP\/\d+(?:\.\d+)?$/.exec((candidate.requestLine ?? '').replace(/\r?\n$/, ''))
        if (lineMatch !== null) {
          request.method = lineMatch[1]
          request.path = lineMatch[2]
        }
      }
      if (request.authority === null || request.method === null) {
        continue
      }
      const response = parseResponseHeaders(candidate.responseHeaders)
      const job = candidate.boundJobId === undefined ? undefined : jobs.get(candidate.boundJobId)
      exchanges.push({
        url: candidate.url,
        method: request.method,
        path: request.path,
        authority: request.authority,
        userAgent: request.userAgent,
        isHttp1: candidate.isHttp1,
        requestLine: candidate.requestLine,
        requestHeaders: candidate.requestHeaders,
        requestEntries: request.entries,
        requestContentLength: headerValue(candidate.requestHeaders, 'content-length'),
        requestChunked: /chunked/i.test(headerValue(candidate.requestHeaders, 'transfer-encoding') ?? ''),
        requestBody: Buffer.alloc(0),
        responseStatusLine: response.statusLine,
        responseCode: response.code,
        responseEntries: response.entries,
        responseContentLength: response.contentLength,
        responseChunked: response.chunked,
        // Raw chunks carry the still-content-encoded wire body; identity
        // responses only log filtered chunks (identical to the wire bytes)
        responseBody: Buffer.concat(candidate.rawChunks.length > 0 ? candidate.rawChunks : candidate.filteredChunks),
        negotiatedProtocol: job?.protocol ?? null,
        boundSessions: job?.sessions ?? [],
        boundSocketId: job?.socketId,
        eventIndex: candidate.eventIndex
      })
    }
  }

  // Recover request bodies from the bound connections
  recoverH2RequestBodies(exchanges, h2Sessions)
  recoverH1RequestBodies(exchanges, socketSentChunks)
  return { exchanges, negotiatedProtocols: collectNegotiatedProtocols(exchanges) }
}

/**
 * HTTP/2 request body recovery: each URL_REQUEST's header block is matched
 * against the bound HTTP/2 session's SEND_HEADERS events (the logged header
 * lists are identical), yielding the stream id whose DATA frames carry the
 * body. Tasks are processed in chronological order so that identical requests
 * consume stream ids in order.
 */
const recoverH2RequestBodies = (exchanges, h2Sessions) => {
  const tasks = exchanges
    .filter(exchange => !exchange.isHttp1)
    .sort((a, b) => a.eventIndex - b.eventIndex)
  for (const exchange of tasks) {
    const headerKey = JSON.stringify(exchange.requestHeaders)
    for (const sessionId of exchange.boundSessions) {
      const session = h2Sessions.get(sessionId)
      if (session === undefined) continue
      const blockIndex = session.headerBlocks.findIndex(block => block.key === headerKey)
      if (blockIndex === -1) continue
      const block = session.headerBlocks[blockIndex]
      session.headerBlocks.splice(blockIndex, 1)
      exchange.requestBody = Buffer.concat(session.dataFrames.get(block.streamId) ?? [])
      break
    }
  }
}

/**
 * HTTP/1.1 request body recovery: finds the request line in the plaintext
 * bytes written on the bound socket and slices out the body after the header
 * block. Keep-alive sockets are scanned with a monotonic cursor so that
 * repeated requests are attributed in chronological order.
 */
const recoverH1RequestBodies = (exchanges, socketSentChunks) => {
  const cursors = new Map() // socketId -> search offset
  const streams = new Map() // socketId -> concatenated plaintext, built once per socket
  const tasks = exchanges
    .filter(exchange => exchange.isHttp1)
    .sort((a, b) => a.eventIndex - b.eventIndex)
  for (const exchange of tasks) {
    const socketId = exchange.boundSocketId
    if (socketId === undefined) continue
    let stream = streams.get(socketId)
    if (stream === undefined && socketSentChunks.has(socketId)) {
      streams.set(socketId, stream = Buffer.concat(socketSentChunks.get(socketId)))
    }
    if (stream === undefined) continue
    const cursor = cursors.get(socketId) ?? 0
    const requestLine = Buffer.from(exchange.requestLine.replace(/\r?\n$/, ''))
    const lineIndex = stream.indexOf(requestLine, cursor)
    if (lineIndex === -1) continue
    const headEnd = stream.indexOf('\r\n\r\n', lineIndex)
    if (headEnd === -1) continue
    const contentLength = parseInt(headerValue(
      stream.toString('latin1', lineIndex, headEnd).split('\r\n'),
      'content-length'
    ), 10)
    const length = Number.isNaN(contentLength) || contentLength < 0 ? 0 : contentLength
    const bodyStart = headEnd + 4
    exchange.requestBody = Buffer.from(stream.subarray(bodyStart, bodyStart + length))
    cursors.set(socketId, bodyStart + length)
  }
}

/**
 * Per-host negotiated protocols, preferring h2; hosts are keyed like the
 * archive's Requests map (the request authority).
 */
const collectNegotiatedProtocols = (exchanges) => {
  const protocols = new Map() // authority -> protocol
  for (const exchange of exchanges) {
    if (exchange.negotiatedProtocol === null) continue
    const existing = protocols.get(exchange.authority)
    if (existing === undefined || (existing !== 'h2' && exchange.negotiatedProtocol === 'h2')) {
      protocols.set(exchange.authority, exchange.negotiatedProtocol)
    }
  }
  return protocols
}
