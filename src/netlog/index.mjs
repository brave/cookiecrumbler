// Chromium NetLog ("Everything" capture mode) parsing: reconstructs HTTP
// request/response exchanges from browser traffic. The archive writing
// (WprGo record format) lives in wpr-archive.mjs.
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

// Part of the public API: wpr-archive.mjs imports NetLogError from here
export { NetLogError } from './errors.mjs'

/**
 * Parses the netlog and reconstructs the recorded HTTP exchanges.
 *
 * @param {string} netlogPath path of the netlog JSON file
 * @returns {Promise<{exchanges: object[], negotiatedProtocols: Map<string, string>}>}
 *   exchanges are chronological objects (ordered by the netlog position of
 *   their request-headers event):
 *   { url, method, path, authority, userAgent, isHttp1, requestLine,
 *     requestEntries, requestContentLength, requestBody,
 *     responseStatusLine, responseCode, responseEntries, responseContentLength,
 *     responseChunked, responseBody, negotiatedProtocol }
 *   Internal binding fields (removed from the public shape in the data-model
 *   step): requestHeaders, boundSessions, boundSocketId, eventIndex.
 */
export const buildExchangesFromNetLog = async (netlogPath, options = {}) => {
  const netlog = await readNetLog(netlogPath, options)
  const eventType = name => netlog.constants?.logEventTypes?.[name]
  if (netlog.constants?.logEventTypes === undefined || netlog.constants?.logSourceType?.URL_REQUEST === undefined ||
      netlog.constants?.logEventPhase?.PHASE_BEGIN === undefined || netlog.constants?.logEventPhase?.PHASE_END === undefined) {
    throw new NetLogError('netlog is missing the event/source type or phase constants')
  }
  const sourceType = netlog.constants.logSourceType
  // Phases are numeric in the file ({PHASE_NONE: 0, PHASE_BEGIN: 1,
  // PHASE_END: 2} in current Chromium) and resolved dynamically like the
  // types above
  const PHASE_BEGIN = netlog.constants.logEventPhase.PHASE_BEGIN
  const PHASE_END = netlog.constants.logEventPhase.PHASE_END

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
  const sources = new Map() // sourceKey -> { key, type, events, eventIndices }
  for (const [eventIndex, event] of netlog.events.entries()) {
    const key = sourceKeyOf(event.source)
    if (key === null) continue
    let source = sources.get(key)
    if (source === undefined) sources.set(key, source = { key, type: event.source.type, events: [], eventIndices: [] })
    source.events.push(event)
    source.eventIndices.push(eventIndex)
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
    socketSentChunks.set(source.key, sslChunks.length > 0 ? sslChunks : tcpChunks)
  }

  // HTTP/2 sessions: request bodies as DATA frames and stream ids per
  // request header block
  const h2Sessions = new Map() // sourceKey -> { headerBlocks, dataByStream }
  for (const source of sources.values()) {
    if (source.type !== sourceType.HTTP2_SESSION) continue
    let sessionSocketKey = null
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
    const frames = extractH2DataFrames(Buffer.concat(socketSentChunks.get(sessionSocketKey) ?? []))
    // hasPreface/truncated become parser stats in the data-model step
    h2Sessions.set(source.key, { headerBlocks, dataByStream: frames.dataByStream })
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
  const allHops = [] // surviving candidates across sources, in first-seen order
  const h2Tasks = [] // every sent h2 hop, for stream correlation
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
      // Failure events on the source: net_error is logged "only on failure"
      // (url_request.cc), mirroring the browser's own explicit error;
      // cancellations are deliberately not logged as errors. The failure
      // attaches to the in-flight hop: the hop whose request the failing job
      // sent. A job start (BEGIN) seals the previous hop, so a completed
      // redirect hop is immune to failures of the next job, which fails
      // before its own request ever had headers.
      if (hop !== null && typeof params.net_error === 'number' && params.net_error !== 0) {
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
        // headers and before the body events.
        if (event.phase === PHASE_BEGIN) hop = null
        // Browser-internal traffic (updater, safebrowsing, telemetry, background
        // services) is issued outside any page frame: its network
        // isolation/anonymization key has no accountable frame site (verified in
        // real captures: empty keys log as exactly "null" in newer Chromium and
        // "null null" in older builds, anonymized telemetry as
        // "null [internally: ...]"), or it is a browser-issued non-navigation
        // request ("not an origin" initiator; some of those carry a real site
        // key, e.g. spellcheck dictionary downloads). Subresources of frames
        // with opaque origins (sandboxed iframes) keep the real top-frame site
        // at the start of their key and are not filtered. Redirects re-log
        // START_JOB with the same attribution, so one match filters the whole
        // source. A missing key keeps the request.
        browserInternal ||= (params.network_isolation_key ?? params.network_anonymization_key ?? '').startsWith('null') ||
          (params.initiator === 'not an origin' && params.request_type !== undefined && params.request_type !== 'main frame')
      } else if (event.type === ET.redirected) {
        if (typeof params.location === 'string') redirectTarget = params.location
      } else if (event.type === ET.streamBound) {
        boundJobId = depKey(params)
      } else if (event.type === ET.sendHeaders || event.type === ET.http2SendHeaders) {
        hop = {
          eventIndex: source.eventIndices[index],
          url: redirectTarget ?? url,
          isHttp1: event.type === ET.sendHeaders,
          // Stripped once here; the request-line regex, body recovery and the
          // archive serializer all use the line without its CRLF
          requestLine: typeof params.line === 'string' ? stripLineEnding(params.line) : null,
          requestHeaders: event.params.headers ?? [],
          responseHeaders: null,
          rawChunks: [],
          filteredChunks: [],
          boundJobId,
          failed: false
        }
        redirectTarget = null
        hops.push(hop)
        // Every sent h2 request joins stream correlation, including hops that
        // later fail or are filtered: their session header blocks must be
        // consumed so later requests with identical headers bind to their own
        // streams
        if (!hop.isHttp1) {
          h2Tasks.push({
            requestKey: JSON.stringify(hop.requestHeaders),
            sessions: jobs.get(boundJobId)?.sessions ?? [],
            eventIndex: hop.eventIndex,
            hop
          })
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
    if (browserInternal) continue
    allHops.push(...hops)
  }

  // Bind the h2 request bodies to their streams before filtering the hops:
  // a hop dropped for failing or being browser-internal was still sent, and
  // its header block must be consumed so a later request with identical
  // headers binds to its own stream and body
  correlateH2RequestBodies(h2Tasks, h2Sessions)

  const exchanges = []
  for (const candidate of allHops) {
    if (candidate.url === null || candidate.responseHeaders === null || candidate.failed) {
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
      console.warn(`Skipping ${candidate.url}: unparsable status line`)
      continue
    }
    const job = candidate.boundJobId === null ? null : jobs.get(candidate.boundJobId) ?? null
    if (candidate.isHttp1 && request.chunked) {
      console.warn(`Skipping body of ${candidate.url}: chunked HTTP/1 request bodies are not recovered`)
    }
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
      requestContentLength: request.contentLength,
      // h2 bodies were resolved during stream correlation; h1 bodies stay
      // empty until the socket recovery below
      requestBody: candidate.requestBody ?? Buffer.alloc(0),
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
      boundSocketId: job?.socketId ?? null,
      eventIndex: candidate.eventIndex
    })
  }

  // Sources are iterated in first-seen order, so the hops collected above are
  // grouped per source rather than in time order; sorting by the send-headers
  // event position restores the chronological order the docstring promises
  // and the keep-alive h1 body recovery below relies on
  exchanges.sort((a, b) => a.eventIndex - b.eventIndex)

  // Recover request bodies from the bound connections
  recoverH1RequestBodies(exchanges, socketSentChunks)
  return { exchanges, negotiatedProtocols: collectNegotiatedProtocols(exchanges) }
}

/**
 * HTTP/2 request body recovery: every sent hop's header block is matched
 * against the bound HTTP/2 session's SEND_HEADERS events (the logged header
 * lists are identical), yielding the stream id whose DATA frames carry the
 * body, stored on the hop. Tasks are processed in netlog order so that
 * identical requests consume stream ids in the order the requests were sent.
 * All sent hops participate — including ones that later fail or are filtered
 * out — so a surviving request can never bind to a dropped one's stream.
 */
const correlateH2RequestBodies = (tasks, h2Sessions) => {
  tasks.sort((a, b) => a.eventIndex - b.eventIndex)
  for (const task of tasks) {
    for (const sessionId of task.sessions) {
      const session = h2Sessions.get(sessionId)
      if (session === undefined) continue
      const blockIndex = session.headerBlocks.findIndex(block => block.key === task.requestKey)
      if (blockIndex === -1) continue
      const block = session.headerBlocks[blockIndex]
      session.headerBlocks.splice(blockIndex, 1)
      task.hop.requestBody = session.dataByStream.get(block.streamId) ?? Buffer.alloc(0)
      break
    }
  }
}

/**
 * HTTP/1.1 request body recovery: finds the request line in the plaintext
 * bytes written on the bound socket and slices out the body after the header
 * block. Keep-alive sockets are scanned with a monotonic cursor so that
 * repeated requests are attributed in the order they were sent.
 */
const recoverH1RequestBodies = (exchanges, socketSentChunks) => {
  const cursors = new Map() // socketId -> search offset
  const streams = new Map() // socketId -> concatenated plaintext, built once per socket
  const tasks = exchanges
    .filter(exchange => exchange.isHttp1)
    .sort((a, b) => a.eventIndex - b.eventIndex)
  for (const exchange of tasks) {
    const socketId = exchange.boundSocketId
    if (socketId === null) continue
    let stream = streams.get(socketId)
    if (stream === undefined && socketSentChunks.has(socketId)) {
      streams.set(socketId, stream = Buffer.concat(socketSentChunks.get(socketId)))
    }
    if (stream === undefined) continue
    const cursor = cursors.get(socketId) ?? 0
    const requestLine = Buffer.from(stripLineEnding(exchange.requestLine))
    const lineIndex = stream.indexOf(requestLine, cursor)
    if (lineIndex === -1) continue
    const headEnd = stream.indexOf('\r\n\r\n', lineIndex)
    if (headEnd === -1) continue
    const length = parseContentLength(headerValue(
      stream.toString('latin1', lineIndex, headEnd).split('\r\n'),
      'content-length'
    )) ?? 0
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
