// Chromium NetLog ("Everything" capture mode) parsing: reconstructs HTTP
// request/response exchanges from browser traffic. The archive writing
// (WprGo record format) lives in ../archive.mjs.
//
// NetLog event model:
//
// Events are chronological; each has { source: { id, type }, type, phase,
// params }. Types and phases are numeric in the file; their names map through
// constants.logEventTypes / constants.logSourceType /
// constants.logEventPhase (numbers vary between Chrome versions, so they are
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

import { NetLogError } from './errors.mjs'
import { readNetLog } from './reader.mjs'
import { sourceKeyOf, depKey } from './keys.mjs'
import {
  headerValue, parseContentLength, parseRequestHeaders, parseRequestLine, parseResponseHeaders, stripLineEnding
} from './http-headers.mjs'
import { extractH2DataFrames } from './http2-frames.mjs'

/** @typedef {import('./keys.mjs').SourceKey} SourceKey */

/**
 * The constants section of a netlog as far as the parser relies on it; the
 * numeric ids vary between Chrome versions, so the mappings are resolved
 * dynamically by name.
 * @typedef {object} NetLogConstants
 * @property {Record<string, number>} logEventTypes
 * @property {Record<string, number>} logSourceType
 * @property {Record<string, number>} logEventPhase
 */

/**
 * The event parameter fields the parser consumes; each is validated where
 * it is read.
 * @typedef {object} NetLogParams
 * @property {string} [bytes]  base64 payload
 * @property {string} [proto]
 * @property {{ id?: number, type?: number }} [source_dependency]
 * @property {number} [net_error]
 * @property {string} [url]
 * @property {string} [location]
 * @property {string} [line]
 * @property {string[] | Record<string, string>} [headers]  header lines on
 *   transaction events, a name/value map on HTTP2_SESSION_SEND_HEADERS
 * @property {number} [stream_id]
 * @property {string} [network_isolation_key]
 * @property {string} [network_anonymization_key]
 * @property {string} [initiator]
 * @property {string} [request_type]
 */

/**
 * The event envelope of a netlog entry. The source is validated through
 * sourceKeyOf, the other fields where they are consumed.
 * @typedef {object} NetLogEvent
 * @property {{ id?: number, type?: number }} source
 * @property {number} [type]
 * @property {number} [phase]
 * @property {NetLogParams} [params]
 */

/**
 * A reconstructed HTTP exchange.
 * @typedef {object} Exchange
 * @property {string} url
 * @property {string} method
 * @property {string|null} path
 * @property {string} authority
 * @property {string|null} userAgent
 * @property {boolean} isHttp1
 * @property {string|null} requestLine
 * @property {import('./http-headers.mjs').HeaderEntry[]} requestEntries
 * @property {number|null} requestContentLength
 * @property {Buffer} requestBody
 * @property {string} responseStatusLine
 * @property {number} responseCode
 * @property {import('./http-headers.mjs').HeaderEntry[]} responseEntries
 * @property {number|null} responseContentLength
 * @property {boolean} responseChunked
 * @property {Buffer} responseBody
 * @property {string|null} negotiatedProtocol
 */

/**
 * A netlog source's events with their positions in netlog.events.
 * @typedef {object} NetLogSource
 * @property {import('./keys.mjs').SourceKey} key
 * @property {number|undefined} type
 * @property {NetLogEvent[]} events
 * @property {number[]} eventIndices
 */

/**
 * A sent request of a URL_REQUEST source, awaiting its response.
 * @typedef {object} HopCandidate
 * @property {number} eventIndex  position of the send-headers event in netlog.events
 * @property {string|null} url
 * @property {boolean} isHttp1
 * @property {string|null} requestLine
 * @property {string[]} requestHeaders
 * @property {string[]|null} responseHeaders
 * @property {Buffer[]} rawChunks
 * @property {Buffer[]} filteredChunks
 * @property {import('./keys.mjs').SourceKey|null} boundJobId
 * @property {boolean} failed
 * @property {Buffer} [requestBody]  resolved by connection correlation
 */

/**
 * A stream job's negotiated protocol and bound socket/HTTP/2 sessions.
 * @typedef {object} StreamJob
 * @property {string|null} protocol
 * @property {import('./keys.mjs').SourceKey|null} socketId
 * @property {import('./keys.mjs').SourceKey[]} sessions
 */

/** @typedef {{ key: string, streamId: number|undefined }} H2HeaderBlock */

/**
 * An HTTP/2 session's logged request header blocks and DATA payloads.
 * @typedef {object} H2Session
 * @property {H2HeaderBlock[]} headerBlocks  chronological, minus consumed blocks
 * @property {Map<number, Buffer>} dataByStream
 */

/** @typedef {{ requestLine: string|null, jobId: import('./keys.mjs').SourceKey|null, eventIndex: number, hop: HopCandidate }} H1CorrelationTask */

/** @typedef {{ requestKey: string, jobId: import('./keys.mjs').SourceKey|null, eventIndex: number, hop: HopCandidate }} H2CorrelationTask */

/**
 * Parses the netlog and reconstructs the recorded HTTP exchanges.
 *
 * @param {string} netlogPath path of the netlog JSON file
 * @param {{ maxNetlogBytes?: number, onWarning?: (warning: { code: 'UNPARSABLE_STATUS', url: string, message: string }) => void, dropInternalRequests?: boolean }} [options]
 * @returns {Promise<{exchanges: Exchange[], negotiatedProtocols: Map<string, string>, stats: { exchanges: number, dropped: { failed: number, unparsable: number, internalRequests: number } }}>}
 *   exchanges are chronological objects (ordered by the netlog position of
 *   their request-headers event):
 *   { url, method, path, authority, userAgent, isHttp1, requestLine,
 *     requestEntries, requestContentLength, requestBody,
 *     responseStatusLine, responseCode, responseEntries, responseContentLength,
 *     responseChunked, responseBody, negotiatedProtocol }
 *   stats counts the reconstructed exchanges and the candidates dropped for
 *   failing or for an unparsable status line (the latter are also reported
 *   through onWarning), plus the browser-internal sources skipped when
 *   dropInternalRequests is enabled (0 when it is disabled).
 */
export const parseNetLog = async (netlogPath, { maxNetlogBytes, onWarning, dropInternalRequests = true } = {}) => {
  const netlog = await readNetLog(netlogPath, { maxNetlogBytes })
  const rawConstants = typeof netlog.constants === 'object' && netlog.constants !== null && !Array.isArray(netlog.constants)
    ? /** @type {Partial<NetLogConstants>} */ (netlog.constants)
    : null
  if (rawConstants?.logEventTypes === undefined || rawConstants?.logSourceType?.URL_REQUEST === undefined ||
      rawConstants?.logEventPhase?.PHASE_BEGIN === undefined || rawConstants?.logEventPhase?.PHASE_END === undefined) {
    throw new NetLogError('netlog is missing the event/source type or phase constants', { code: 'MISSING_CONSTANTS' })
  }
  const eventTypes = rawConstants.logEventTypes
  const sourceType = rawConstants.logSourceType
  /** @type {(name: string) => number|undefined} */
  const eventType = (name) => eventTypes[name]
  // Phases are numeric in the file ({PHASE_NONE: 0, PHASE_BEGIN: 1,
  // PHASE_END: 2} in current Chromium) and resolved dynamically like the
  // types above
  const PHASE_BEGIN = rawConstants.logEventPhase.PHASE_BEGIN
  const PHASE_END = rawConstants.logEventPhase.PHASE_END

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

  // Events grouped by source, preserving chronological order. Source ids are
  // partitioned per source type, so maps are keyed by type:id pairs. Each
  // event's position in netlog.events is recorded alongside it: a per-source
  // position says nothing about when other sources logged, while the netlog
  // position is the only cross-source time order the file provides.
  /** @type {Map<SourceKey, NetLogSource>} */
  const sources = new Map() // sourceKey -> { key, type, events, eventIndices }
  for (const [eventIndex, rawEvent] of netlog.events.entries()) {
    if (rawEvent === null || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      throw new NetLogError('netlog events contain a non-object entry', { code: 'INVALID' })
    }
    const event = /** @type {NetLogEvent} */ (rawEvent)
    const key = sourceKeyOf(event.source)
    if (key === null) continue
    let source = sources.get(key)
    if (source === undefined) sources.set(key, source = { key, type: event.source.type, events: [], eventIndices: [] })
    source.events.push(event)
    source.eventIndices.push(eventIndex)
  }
  // TLS payload plaintext written per socket. SSL_SOCKET_BYTES_* events carry
  // the decrypted bytes; SOCKET_BYTES_* carry the ciphertext for TLS sockets.
  /** @type {Map<SourceKey, Buffer[]>} */
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
    socketSentChunks.set(source.key, sslChunks.length > 0 ? sslChunks : tcpChunks)
  }

  // HTTP/2 sessions: request bodies as DATA frames and stream ids per
  // request header block
  /** @type {Map<SourceKey, H2Session>} */
  const h2Sessions = new Map() // sourceKey -> { headerBlocks, dataByStream }
  for (const source of sources.values()) {
    if (source.type !== sourceType.HTTP2_SESSION) continue
    /** @type {SourceKey|null} */
    let sessionSocketKey = null
    /** @type {H2HeaderBlock[]} */
    const headerBlocks = [] // { key, streamId } in chronological order
    for (const event of source.events) {
      if (event.type === ET.sessionInitialized) {
        const socketKey = depKey(event.params)
        if (socketKey !== null) sessionSocketKey = socketKey
      } else if (event.type === ET.sessionSendHeaders) {
        headerBlocks.push({
          key: JSON.stringify(event.params?.headers),
          streamId: event.params?.stream_id
        })
      }
    }
    const frames = extractH2DataFrames(Buffer.concat(sessionSocketKey === null ? [] : socketSentChunks.get(sessionSocketKey) ?? []))
    // hasPreface/truncated become parser stats in the data-model step
    h2Sessions.set(source.key, { headerBlocks, dataByStream: frames.dataByStream })
  }

  // Stream jobs: negotiated protocol, bound socket/session
  /** @type {Map<SourceKey, StreamJob>} */
  const jobs = new Map() // sourceKey -> { protocol, socketId, sessions }
  for (const source of sources.values()) {
    if (source.type !== sourceType.HTTP_STREAM_JOB) continue
    const job = /** @type {StreamJob} */ ({ protocol: null, socketId: null, sessions: [] })
    for (const event of source.events) {
      const params = /** @type {NetLogParams} */ (event.params ?? {})
      if (event.type === ET.proto) {
        job.protocol = params.proto ?? null
      } else if (event.type === ET.socketBound) {
        job.socketId = depKey(params)
      } else if (event.type === ET.sessionPoolImported || event.type === ET.sessionPoolFound) {
        const dep = params.source_dependency
        if (dep?.type === sourceType.HTTP2_SESSION) {
          const sessionKey = depKey(params)
          if (sessionKey !== null) job.sessions.push(sessionKey)
        }
      }
    }
    jobs.set(source.key, job)
  }

  // Reconstruct request/response pairs from URL_REQUEST sources
  /** @type {HopCandidate[]} */
  const allHops = [] // candidates across sources, in first-seen order
  /** @type {H1CorrelationTask[]} */
  const h1Tasks = [] // every sent h1 hop, for socket body correlation
  /** @type {H2CorrelationTask[]} */
  const h2Tasks = [] // every sent h2 hop, for stream correlation
  let internalRequestsCount = 0
  for (const source of sources.values()) {
    if (source.type !== sourceType.URL_REQUEST) continue

    /** @type {string|null} */
    let url = null
    /** @type {string|null} */
    let redirectTarget = null
    /** @type {SourceKey|null} */
    let boundJobId = null
    /** @type {HopCandidate|null} */
    let hop = null
    let sourceInternal = false
    /** @type {HopCandidate[]} */
    const hops = []
    source.events.forEach((event, index) => {
      const params = /** @type {NetLogParams} */ (event.params ?? {})
      // Failure events on the source: only the URL_REQUEST_START_JOB and
      // REQUEST_ALIVE end events carry the job's result (net_error is logged
      // there "only on failure"; cancellations are deliberately not logged as
      // errors). Other events on the source can carry unrelated net_errors
      // (e.g. HttpCache transactions log their own failures), so they are
      // ignored. The failure attaches to the in-flight hop: the hop whose
      // request the failing job sent. A job start (BEGIN) seals the previous
      // hop, so a completed redirect hop is immune to failures of the next
      // job, which fails before its own request ever had headers.
      if (event.phase === PHASE_END && (event.type === ET.startJob || event.type === ET.requestAlive) &&
        hop !== null && typeof params.net_error === 'number' && params.net_error !== 0) {
        hop.failed = true
      }
      if (event.type === ET.requestAlive) {
        if (typeof params.url === 'string') url = params.url
      } else if (event.type === ET.startJob) {
        if (typeof params.url === 'string') url = params.url
        // A job start (BEGIN) seals the previous hop: the next job (e.g. the
        // redirect destination) begins only after the previous hop's response
        // was logged, and events logged before the next send-headers event
        // (DNS, proxy or connection setup, ...) belong to the still
        // header-less job. The START_JOB end event never seals: in real
        // captures it fires once the response starts, after the response
        // headers and before the body events. The bound stream job resets
        // with the hop: a destination hop without its own
        // HTTP_STREAM_REQUEST_BOUND_TO_JOB must not inherit the previous
        // hop's job (socket, sessions, negotiated protocol).
        if (event.phase === PHASE_BEGIN) {
          hop = null
          boundJobId = null
        }
        // Redirects re-log START_JOB with the same attribution, so one match
        // filters the whole source (see isInternalRequest)
        sourceInternal ||= isInternalRequest(params)
      } else if (event.type === ET.redirected) {
        if (typeof params.location === 'string') redirectTarget = params.location
      } else if (event.type === ET.streamBound) {
        boundJobId = depKey(params)
      } else if (event.type === ET.sendHeaders || event.type === ET.http2SendHeaders) {
        hop = {
          eventIndex: /** @type {number} */ (source.eventIndices[index]),
          url: redirectTarget ?? url,
          isHttp1: event.type === ET.sendHeaders,
          // Stripped once here; the request-line regex, body recovery and the
          // archive serializer all use the line without its CRLF
          requestLine: typeof params.line === 'string' ? stripLineEnding(params.line) : null,
          requestHeaders: /** @type {string[]} */ (params.headers ?? []),
          responseHeaders: null,
          rawChunks: [],
          filteredChunks: [],
          boundJobId,
          failed: false
        }
        redirectTarget = null
        hops.push(hop)
        // Every sent request of this source joins body correlation, including
        // hops that later fail: their wire bytes or session header blocks
        // must be consumed so later requests with identical headers bind to
        // their own stream and body. With internal requests dropped,
        // browser-internal sources are excluded: their sockets and sessions
        // are partitioned by network isolation key, so they can neither
        // shadow page requests nor contribute bodies, and their traffic is
        // ignored before any wire-level parsing.
        if (!(dropInternalRequests && sourceInternal)) {
          if (hop.isHttp1) {
            h1Tasks.push({ requestLine: hop.requestLine, jobId: boundJobId, eventIndex: hop.eventIndex, hop })
          } else {
            h2Tasks.push({ requestKey: JSON.stringify(hop.requestHeaders), jobId: boundJobId, eventIndex: hop.eventIndex, hop })
          }
        }
      } else if (event.type === ET.readResponseHeaders && hop !== null) {
        // A missing header list is not a valid response; only a present list
        // counts as a logged response
        if (Array.isArray(params.headers)) hop.responseHeaders = params.headers
      } else if (event.type === ET.jobBytesRead && hop !== null && event.params?.bytes !== undefined) {
        // Raw (still content-encoded) bytes; only logged when a content filter ran
        hop.rawChunks.push(Buffer.from(event.params.bytes, 'base64'))
      } else if (event.type === ET.jobFilteredBytesRead && hop !== null && event.params?.bytes !== undefined) {
        // Post-filter bytes; for identity responses these are the wire bytes
        hop.filteredChunks.push(Buffer.from(event.params.bytes, 'base64'))
      }
    })

    // Browser-internal sources never contribute exchanges: skip them before
    // collecting the hops
    if (dropInternalRequests && sourceInternal) {
      internalRequestsCount++
      continue
    }
    allHops.push(...hops)
  }

  // Bind request bodies to their connections before filtering the hops:
  // a hop dropped for failing was still sent, and its wire bytes or session
  // header block must be consumed so a later request with identical headers
  // binds to its own stream and body
  correlateH2RequestBodies(h2Tasks, h2Sessions, jobs)
  correlateH1RequestBodies(h1Tasks, socketSentChunks, jobs)

  // Sources are iterated in first-seen order, so the hops collected above are
  // grouped per source rather than in time order; sorting the candidates by
  // the send-headers event position restores the chronological order the
  // docstring promises, and the exchanges below are built in that order
  allHops.sort((a, b) => a.eventIndex - b.eventIndex)

  /** @type {Exchange[]} */
  const exchanges = []
  let failedCount = 0
  let unparsableCount = 0
  for (const candidate of allHops) {
    if (candidate.url === null || candidate.responseHeaders === null || candidate.failed) {
      if (candidate.failed) failedCount++
      continue
    }
    const request = parseRequestHeaders(candidate.requestHeaders)
    // An HTTP/1.x exchange that survives always has a non-null requestLine:
    // its method can only come from the request line (there is no :method
    // pseudo-header), and hops without a usable line are dropped below
    if (candidate.isHttp1 && request.method === null) {
      const line = parseRequestLine(candidate.requestLine ?? '')
      if (line !== null) {
        request.method = line.method
        request.path = line.target
      }
    }
    if (request.authority === null || request.method === null) {
      continue
    }
    const response = parseResponseHeaders(candidate.responseHeaders)
    if (response === null) {
      onWarning?.({ code: 'UNPARSABLE_STATUS', url: candidate.url, message: 'unparsable status line' })
      unparsableCount++
      continue
    }
    const job = candidate.boundJobId === null ? null : jobs.get(candidate.boundJobId) ?? null
    if (candidate.isHttp1 && request.chunked) {
      // Backstop for requests whose wire bytes the walk never saw (no
      // captured socket traffic): same rejection as the walk
      throw new NetLogError(`unexpected chunked HTTP/1 request body on ${candidate.url}: streamed uploads are not supported`, { code: 'CHUNKED_UPLOAD' })
    }
    exchanges.push({
      url: candidate.url,
      method: request.method,
      path: request.path,
      authority: request.authority,
      userAgent: request.userAgent,
      isHttp1: candidate.isHttp1,
      requestLine: candidate.requestLine,
      requestEntries: request.entries,
      requestContentLength: request.contentLength,
      // Request bodies were resolved during connection correlation, before
      // the hops were filtered
      requestBody: candidate.requestBody ?? Buffer.alloc(0),
      responseStatusLine: response.statusLine,
      responseCode: response.code,
      responseEntries: response.entries,
      responseContentLength: response.contentLength,
      responseChunked: response.chunked,
      // Raw chunks carry the still-content-encoded wire body; identity
      // responses only log filtered chunks (identical to the wire bytes)
      responseBody: Buffer.concat(candidate.rawChunks.length > 0 ? candidate.rawChunks : candidate.filteredChunks),
      negotiatedProtocol: job?.protocol ?? null
    })
  }

  return {
    exchanges,
    negotiatedProtocols: collectNegotiatedProtocols(exchanges),
    stats: {
      exchanges: exchanges.length,
      dropped: { failed: failedCount, unparsable: unparsableCount, internalRequests: internalRequestsCount }
    }
  }
}

/**
 * Whether a URL_REQUEST's START_JOB params attribute the request to the
 * browser itself rather than to a page frame. "Internal" means requests the
 * browser issues on its own (updater, Safe Browsing, telemetry, spellcheck),
 * not intranet traffic.
 *
 * Browser-internal traffic (updater, safebrowsing, telemetry, background
 * services) is issued outside any page frame: its network
 * isolation/anonymization key has no accountable frame site (verified in
 * real captures: empty keys log as exactly "null" in newer Chromium and
 * "null null" in older builds, anonymized telemetry as
 * "null [internally: ...]"), or it is a browser-issued non-navigation
 * request ("not an origin" initiator; some of those carry a real site
 * key, e.g. spellcheck dictionary downloads). Subresources of frames
 * with opaque origins (sandboxed iframes) keep the real top-frame site
 * at the start of their key and are not filtered. Redirects re-log
 * START_JOB with the same attribution, so one match filters the whole
 * source. A missing key keeps the request.
 * @param {{ network_isolation_key?: string, network_anonymization_key?: string, initiator?: string, request_type?: string }|undefined} startJobParams
 * @returns {boolean}
 */
export const isInternalRequest = (startJobParams) => {
  const params = startJobParams ?? {}
  // Both keys are checked independently: either one without an accountable
  // frame site makes the request internal
  if ((params.network_isolation_key ?? '').startsWith('null') || (params.network_anonymization_key ?? '').startsWith('null')) return true
  return params.initiator === 'not an origin' && params.request_type !== undefined && params.request_type !== 'main frame'
}

/**
 * HTTP/2 request body correlation: every sent hop's header block is matched
 * against the bound HTTP/2 session's SEND_HEADERS events (the logged header
 * lists are identical), yielding the stream id whose DATA frames carry the
 * body, stored on the hop. Tasks are processed in netlog order so that
 * identical requests consume stream ids in the order the requests were sent.
 * All sent hops participate — including ones that later fail
 * — so a surviving request can never bind to a dropped one's stream.
 * @param {H2CorrelationTask[]} tasks
 * @param {Map<SourceKey, H2Session>} h2Sessions
 * @param {Map<SourceKey, StreamJob>} jobs
 */
const correlateH2RequestBodies = (tasks, h2Sessions, jobs) => {
  tasks.sort((a, b) => a.eventIndex - b.eventIndex)
  for (const task of tasks) {
    const job = task.jobId === null ? undefined : jobs.get(task.jobId)
    for (const sessionId of job?.sessions ?? []) {
      const session = h2Sessions.get(sessionId)
      if (session === undefined) continue
      const blockIndex = session.headerBlocks.findIndex(block => block.key === task.requestKey)
      if (blockIndex === -1) continue
      const [block] = session.headerBlocks.splice(blockIndex, 1)
      task.hop.requestBody = session.dataByStream.get(block?.streamId ?? -1) ?? Buffer.alloc(0)
      break
    }
  }
}

/**
 * HTTP/1.1 request body correlation: finds the request line in the plaintext
 * bytes written on the bound socket and slices out the body after the header
 * block, stored on the hop. Keep-alive sockets are scanned with a monotonic
 * cursor so that repeated requests are attributed in the order they were
 * sent. All sent hops participate — including ones that later fail
 * — so a surviving request can never match a dropped one's wire bytes.
 * A chunked request (a streamed upload) has no determinable body boundary, so
 * it is rejected: page-load traffic does not stream request bodies, and the
 * upload bytes could otherwise be attributed to a later request on the same
 * socket.
 * @param {H1CorrelationTask[]} tasks
 * @param {Map<SourceKey, Buffer[]>} socketSentChunks
 * @param {Map<SourceKey, StreamJob>} jobs
 */
const correlateH1RequestBodies = (tasks, socketSentChunks, jobs) => {
  /** @type {Map<SourceKey, number>} */
  const cursors = new Map() // socketId -> search offset
  /** @type {Map<SourceKey, Buffer>} */
  const streams = new Map() // socketId -> concatenated plaintext, built once per socket
  tasks.sort((a, b) => a.eventIndex - b.eventIndex)
  for (const task of tasks) {
    if (task.requestLine === null) continue
    const job = task.jobId === null ? undefined : jobs.get(task.jobId)
    const socketId = job?.socketId ?? null
    if (socketId === null) continue
    let stream = streams.get(socketId)
    if (stream === undefined && socketSentChunks.has(socketId)) {
      streams.set(socketId, stream = Buffer.concat(socketSentChunks.get(socketId) ?? []))
    }
    if (stream === undefined) continue
    const cursor = cursors.get(socketId) ?? 0
    const lineIndex = stream.indexOf(Buffer.from(task.requestLine), cursor)
    if (lineIndex === -1) continue
    const headEnd = stream.indexOf('\r\n\r\n', lineIndex)
    if (headEnd === -1) continue
    const head = stream.toString('latin1', lineIndex, headEnd).split('\r\n')
    if (headerValue(head, 'transfer-encoding')?.includes('chunked')) {
      throw new NetLogError(`unexpected chunked HTTP/1 request body on ${task.hop.url}: streamed uploads are not supported`, { code: 'CHUNKED_UPLOAD' })
    }
    const length = parseContentLength(headerValue(head, 'content-length')) ?? 0
    const bodyStart = headEnd + 4
    task.hop.requestBody = Buffer.from(stream.subarray(bodyStart, bodyStart + length))
    cursors.set(socketId, bodyStart + length)
  }
}

/**
 * Per-host negotiated protocols, preferring h2; hosts are keyed like the
 * archive's Requests map (the request authority).
 * @param {Exchange[]} exchanges
 * @returns {Map<string, string>}
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
