// Shared netlog fixtures for the parser tests.

import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Netlog event/source type numbers are arbitrary; the parser resolves them
// from the constants, so the fixture can use its own numbering.
export const ET = {
  REQUEST_ALIVE: 1,
  URL_REQUEST_START_JOB: 2,
  URL_REQUEST_REDIRECTED: 3,
  HTTP_TRANSACTION_SEND_REQUEST_HEADERS: 4,
  HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS: 5,
  HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 6,
  URL_REQUEST_JOB_BYTES_READ: 7,
  URL_REQUEST_JOB_FILTERED_BYTES_READ: 8,
  HTTP_STREAM_REQUEST_BOUND_TO_JOB: 9,
  SOCKET_POOL_BOUND_TO_SOCKET: 10,
  HTTP_STREAM_REQUEST_PROTO: 11,
  HTTP2_SESSION_INITIALIZED: 12,
  HTTP2_SESSION_SEND_HEADERS: 13,
  HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET: 14,
  SOCKET_BYTES_SENT: 15,
  SSL_SOCKET_BYTES_SENT: 16,
  // Cache bookkeeping logged on URL_REQUEST sources before the transaction
  // sends its headers; the parser does not model it, but real captures are
  // full of events like this one, so tests use it to shift event positions
  HTTP_CACHE_READ_DATA: 17
}
export const ST = {
  URL_REQUEST: 1,
  SOCKET: 2,
  HTTP_STREAM_JOB: 3,
  HTTP2_SESSION: 4
}

// Event phases are numeric in the file ({PHASE_NONE: 0, PHASE_BEGIN: 1,
// PHASE_END: 2} in current Chromium); the parser resolves the values from
// constants.logEventPhase, so the fixture mirrors the real numbering.
export const PHASE = {
  PHASE_NONE: 0,
  PHASE_BEGIN: 1,
  PHASE_END: 2
}

export const fixtureConstants = () => ({
  logCaptureMode: 'Everything',
  logEventTypes: { ...ET },
  logSourceType: { ...ST },
  logEventPhase: { ...PHASE }
})

// Non-lifecycle events (header transfers, body reads, bindings, redirects)
// log as PHASE_NONE; REQUEST_ALIVE and URL_REQUEST_START_JOB log as
// BEGIN/END pairs and pass their phase explicitly.
export const event = (sourceType, sourceId, type, params = {}, phase = PHASE.PHASE_NONE) => ({
  source: { id: sourceId, type: sourceType },
  type,
  phase,
  params
})

// HTTP/2 request bytes written as TLS payload plaintext: connection preface
// plus a HEADERS frame (HPACK bytes; the parser skips non-DATA frames) and a
// DATA frame carrying the request body. Set preface to false to get bare
// frames for extending a connection with further requests.
export const h2SentBytes = (streamId, requestBody, { preface = true } = {}) => {
  const headersFrame = Buffer.concat([
    Buffer.from([0, 0, 5]), Buffer.from([0x1, 0x4]), Buffer.from([0, 0, 0, streamId]), Buffer.alloc(5)
  ])
  const dataFrame = Buffer.concat([
    Buffer.from([0, 0, requestBody.length]), Buffer.from([0x0, 0x0]), Buffer.from([0, 0, 0, streamId]), requestBody
  ])
  const frames = Buffer.concat([headersFrame, dataFrame])
  return preface ? Buffer.concat([Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'), frames]) : frames
}

export const writeNetlog = async (t, events, { format = 'json' } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-netlog-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const isNdjson = format === 'ndjson'
  const netlogPath = path.join(dir, isNdjson ? 'netlog.ndjson' : 'netlog.json')
  const content = isNdjson
    ? [
        JSON.stringify({ type: 'constants', constants: fixtureConstants() }),
        ...events.map(e => JSON.stringify({ type: 'event', event: e })),
        JSON.stringify({ type: 'polledData', polledData: {} }),
        JSON.stringify({ type: 'end' })
      ].join('\n') + '\n'
    : JSON.stringify({ constants: fixtureConstants(), events, polledData: [] })
  await fs.writeFile(netlogPath, content)
  return netlogPath
}

export const writeRawNetlog = async (t, content, name = 'netlog.json') => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-netlog-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const netlogPath = path.join(dir, name)
  await fs.writeFile(netlogPath, content)
  return netlogPath
}
