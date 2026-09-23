import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { MAX_NETLOG_BYTES, replaceConstants } from '../src/netlog.mjs'
import { buildArchiveFromNetLog, archiveFromExchanges } from '../src/wpr-archive.mjs'

// Netlog event/source type numbers are arbitrary; the parser resolves them
// from the constants, so the fixture can use its own numbering.
const ET = {
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
  SSL_SOCKET_BYTES_SENT: 16
}
const ST = {
  URL_REQUEST: 1,
  SOCKET: 2,
  HTTP_STREAM_JOB: 3,
  HTTP2_SESSION: 4
}

const fixtureConstants = () => ({
  logCaptureMode: 'Everything',
  logEventTypes: { ...ET },
  logSourceType: { ...ST }
})

const event = (sourceType, sourceId, type, params = {}) => ({
  source: { id: sourceId, type: sourceType },
  type,
  params
})

// HTTP/2 request bytes written as TLS payload plaintext: connection preface
// plus a HEADERS frame (HPACK bytes; the parser skips non-DATA frames) and a
// DATA frame carrying the request body.
const h2SentBytes = (streamId, requestBody) => {
  const headersFrame = Buffer.concat([
    Buffer.from([0, 0, 5]), Buffer.from([0x1, 0x4]), Buffer.from([0, 0, 0, streamId]), Buffer.alloc(5)
  ])
  const dataFrame = Buffer.concat([
    Buffer.from([0, 0, requestBody.length]), Buffer.from([0x0, 0x0]), Buffer.from([0, 0, 0, streamId]), requestBody
  ])
  return Buffer.concat([
    Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'),
    headersFrame,
    dataFrame
  ])
}

const writeNetlog = async (events) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-netlog-test-'))
  const netlogPath = path.join(dir, 'netlog.json')
  await fs.writeFile(netlogPath, JSON.stringify({ constants: fixtureConstants(), events, polledData: [] }))
  return { dir, netlogPath }
}

describe('netlog to WprGo archive conversion', () => {
  it('converts h2 request/response pairs into the wpr record format', async () => {
    const url = 'https://example.com/page?a=1'
    const requestHeaders = [
      ':method: GET',
      ':authority: example.com',
      ':scheme: https',
      ':path: /page?a=1',
      'user-agent: UA/1.0',
      'accept: text/html',
      'accept-encoding: gzip, deflate, br, zstd'
    ]
    const events = [
      event(ST.URL_REQUEST, 100, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 100, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
      event(ST.HTTP_STREAM_JOB, 101, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.HTTP_STREAM_JOB, 101, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 102, type: ST.SOCKET } }),
      event(ST.HTTP_STREAM_JOB, 101, ET.HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET, { source_dependency: { id: 103, type: ST.HTTP2_SESSION } }),
      event(ST.URL_REQUEST, 100, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 101, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 100, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 100, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, {
        headers: ['HTTP/1.1 200', 'content-type: text/html', 'set-cookie: a=1', 'set-cookie: b=2']
      }),
      // gzip'd response: raw (pre-filter) and filtered (decoded) chunks
      event(ST.URL_REQUEST, 100, ET.URL_REQUEST_JOB_BYTES_READ, { byte_count: 10, bytes: Buffer.from('wire-bytes').toString('base64') }),
      event(ST.URL_REQUEST, 100, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 20, bytes: Buffer.from('decoded-bytes-xxxxx').toString('base64') })
    ]
    const { dir, netlogPath } = await writeNetlog(events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive), [
      'Requests', 'Certs', 'NegotiatedProtocol', 'DeterministicTimeSeedMs',
      'ConstantMathRandomResult', 'ServeResponseInChronologicalSequence',
      'CurrentSessionId', 'DisableFuzzyURLMatching', 'Metadata', 'InjectedScripts'
    ])
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    const message = archive.Requests['example.com'][url][0]
    assert.strictEqual(message.LastServedSessionId, 0)
    assert.strictEqual(Buffer.from(message.SerializedRequest, 'base64').toString('latin1'), [
      'GET /page?a=1 HTTP/1.1',
      'Host: example.com',
      'User-Agent: UA/1.0',
      'Accept: text/html',
      'Accept-Encoding: gzip, deflate, br, zstd',
      '',
      ''
    ].join('\r\n'))
    // The raw (still content-encoded) chunk is the archive body; wpr's Go
    // serialization delimits unknown-length h2 bodies with Connection: close
    // and sorts the remaining headers
    assert.strictEqual(Buffer.from(message.SerializedResponse, 'base64').toString('latin1'), [
      'HTTP/2.0 200 OK',
      'Connection: close',
      'Content-Type: text/html',
      'Set-Cookie: a=1',
      'Set-Cookie: b=2',
      '',
      'wire-bytes'
    ].join('\r\n'))
    assert.deepStrictEqual(archive.NegotiatedProtocol, { 'example.com': 'h2' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('recovers h2 request bodies from DATA frames and serializes POSTs with Content-Length', async () => {
    const url = 'https://example.com/collect'
    const requestHeaders = [
      ':method: POST',
      ':authority: example.com',
      ':scheme: https',
      ':path: /collect',
      'content-type: text/plain'
    ]
    const body = Buffer.from('payload')
    const sentBytes = h2SentBytes(3, body)
    const events = [
      event(ST.URL_REQUEST, 200, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 200, ET.URL_REQUEST_START_JOB, { method: 'POST', url }),
      event(ST.HTTP_STREAM_JOB, 201, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.HTTP_STREAM_JOB, 201, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 202, type: ST.SOCKET } }),
      event(ST.HTTP_STREAM_JOB, 201, ET.HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET, { source_dependency: { id: 203, type: ST.HTTP2_SESSION } }),
      event(ST.URL_REQUEST, 200, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 201, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 200, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 200, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 204'] }),
      event(ST.SOCKET, 202, ET.SSL_SOCKET_BYTES_SENT, { byte_count: sentBytes.length, bytes: sentBytes.toString('base64') }),
      event(ST.HTTP2_SESSION, 203, ET.HTTP2_SESSION_INITIALIZED, { protocol: 'h2', source_dependency: { id: 202, type: ST.SOCKET } }),
      event(ST.HTTP2_SESSION, 203, ET.HTTP2_SESSION_SEND_HEADERS, { headers: requestHeaders, stream_id: 3 })
    ]
    const { dir, netlogPath } = await writeNetlog(events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    const request = Buffer.from(archive.Requests['example.com'][url][0].SerializedRequest, 'base64').toString('latin1')
    assert.strictEqual(request, [
      'POST /collect HTTP/1.1',
      'Host: example.com',
      'Content-Length: 7',
      'Content-Type: text/plain',
      '',
      'payload'
    ].join('\r\n'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reconstructs HTTP/1.1 exchanges; identity responses log their body via the filtered event', async () => {
    const url = 'http://example.com/a'
    const requestHeaders = ['Host: example.com', 'Accept: */*']
    const events = [
      event(ST.URL_REQUEST, 300, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 300, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
      event(ST.HTTP_STREAM_JOB, 301, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, 301, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 302, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, 300, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 301, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 300, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, {
        line: 'GET /a HTTP/1.1\r\n',
        headers: requestHeaders
      }),
      event(ST.URL_REQUEST, 300, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, {
        headers: ['HTTP/1.1 200 OK', 'content-type: text/plain', 'content-length: 10']
      }),
      // identity response: only the filtered event carries the body
      event(ST.URL_REQUEST, 300, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 10, bytes: Buffer.from('plain-body').toString('base64') }),
      // plaintext HTTP/1.1 request bytes on the socket (cleartext: SOCKET_BYTES_SENT)
      event(ST.SOCKET, 302, ET.SOCKET_BYTES_SENT, {
        byte_count: 38,
        bytes: Buffer.from('GET /a HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n').toString('base64')
      })
    ]
    const { dir, netlogPath } = await writeNetlog(events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    const message = archive.Requests['example.com'][url][0]
    // No User-Agent in the logged headers: none is serialized
    assert.strictEqual(Buffer.from(message.SerializedRequest, 'base64').toString('latin1'), [
      'GET /a HTTP/1.1',
      'Host: example.com',
      'Accept: */*',
      '',
      ''
    ].join('\r\n'))
    const response = Buffer.from(message.SerializedResponse, 'base64').toString('latin1')
    assert.strictEqual(response, [
      'HTTP/1.1 200 OK',
      'Content-Length: 10',
      'Content-Type: text/plain',
      '',
      'plain-body'
    ].join('\r\n'))
    assert.deepStrictEqual(archive.NegotiatedProtocol, { 'example.com': 'http/1.1' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('re-frames chunked response bodies like Go resp.Write, including empty ones', () => {
    const chunkedExchange = (path, body) => ({
      url: `https://example.com${path}`,
      method: 'GET',
      path,
      authority: 'example.com',
      userAgent: null,
      isHttp1: false,
      requestLine: null,
      requestHeaders: [],
      requestEntries: [],
      requestContentLength: null,
      requestChunked: false,
      requestBody: Buffer.alloc(0),
      responseStatusLine: null,
      responseCode: 200,
      responseEntries: [['Content-Type', 'text/plain']],
      responseContentLength: null,
      responseChunked: true,
      responseBody: body,
      negotiatedProtocol: null,
      boundSessions: [],
      boundSocketId: undefined,
      eventIndex: 0
    })
    const archive = archiveFromExchanges([
      chunkedExchange('/body', Buffer.from('hello')),
      chunkedExchange('/empty', Buffer.alloc(0))
    ], new Map())
    const response = (url) => Buffer.from(archive.Requests['example.com'][url][0].SerializedResponse, 'base64').toString('latin1')
    // non-empty: size-chunk + body + terminal chunk
    assert.strictEqual(response('https://example.com/body'), [
      'HTTP/2.0 200 OK',
      'Transfer-Encoding: chunked',
      'Content-Type: text/plain',
      '',
      '5\r\nhello\r\n0\r\n\r\n'
    ].join('\r\n'))
    // empty: only the terminal chunk
    assert.strictEqual(response('https://example.com/empty'), [
      'HTTP/2.0 200 OK',
      'Transfer-Encoding: chunked',
      'Content-Type: text/plain',
      '',
      '0\r\n\r\n'
    ].join('\r\n'))
  })

  it('splits redirect hops into one message per URL and filters browser-internal traffic', async () => {
    const firstUrl = 'http://example.com/redirect-me'
    const secondUrl = 'http://example.com/finally'
    const requestHeaders = [':method: GET', ':authority: example.com', ':scheme: http', ':path: /redirect-me']
    const events = [
      event(ST.URL_REQUEST, 400, ET.REQUEST_ALIVE, { url: firstUrl }),
      event(ST.URL_REQUEST, 400, ET.URL_REQUEST_START_JOB, { method: 'GET', url: firstUrl }),
      event(ST.HTTP_STREAM_JOB, 401, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 302'] }),
      event(ST.URL_REQUEST, 400, ET.URL_REQUEST_REDIRECTED, { location: secondUrl }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: GET', ':authority: example.com', ':scheme: http', ':path: /finally']
      }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] }),
      // browser-internal traffic (no page-frame context) is dropped
      event(ST.URL_REQUEST, 500, ET.REQUEST_ALIVE, { url: 'https://localhost.invalid/' }),
      event(ST.URL_REQUEST, 500, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'https://localhost.invalid/', network_isolation_key: 'null null' }),
      event(ST.URL_REQUEST, 500, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: POST', ':authority: localhost.invalid', ':scheme: https', ':path: /']
      }),
      event(ST.URL_REQUEST, 500, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 404'] }),
      event(ST.URL_REQUEST, 600, ET.REQUEST_ALIVE, { url: 'https://safebrowsing.example.com/list' }),
      event(ST.URL_REQUEST, 600, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'https://safebrowsing.example.com/', network_isolation_key: 'null null' }),
      event(ST.URL_REQUEST, 600, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: GET', ':authority: safebrowsing.example.com', ':scheme: https', ':path: /']
      }),
      event(ST.URL_REQUEST, 600, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] })
    ]
    const { dir, netlogPath } = await writeNetlog(events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']), [firstUrl, secondUrl])
    assert.strictEqual(archive.Requests['example.com'][firstUrl][0].SerializedResponse, Buffer.from([
      'HTTP/2.0 302 Found',
      'Connection: close',
      '',
      ''
    ].join('\r\n')).toString('base64'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('throws when the netlog contains no recorded requests', async () => {
    const { dir, netlogPath } = await writeNetlog([])
    await assert.rejects(buildArchiveFromNetLog(netlogPath), { name: 'NetLogError', message: 'netlog contains no recorded requests' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('throws on truncated netlog data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-netlog-test-'))
    const netlogPath = path.join(dir, 'netlog.json')
    await fs.writeFile(netlogPath, '{"constants": {}, "events": [')
    await assert.rejects(buildArchiveFromNetLog(netlogPath), { name: 'NetLogError' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('parses the NDJSON format written with --net-log-file-format=ndjson', async () => {
    const url = 'https://example.com/nd'
    const requestHeaders = [':method: GET', ':authority: example.com', ':scheme: https', ':path: /nd']
    const lines = [
      JSON.stringify({ type: 'constants', constants: fixtureConstants() }),
      ...[
        event(ST.URL_REQUEST, 700, ET.REQUEST_ALIVE, { url }),
        event(ST.URL_REQUEST, 700, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
        event(ST.HTTP_STREAM_JOB, 701, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
        event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
        event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] }),
        event(ST.URL_REQUEST, 700, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 3, bytes: Buffer.from('abc').toString('base64') })
      ].map(e => JSON.stringify({ type: 'event', event: e })),
      JSON.stringify({ type: 'polledData', polledData: {} }),
      JSON.stringify({ type: 'end' })
    ].join('\n') + '\n'
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-netlog-test-'))
    const netlogPath = path.join(dir, 'netlog.ndjson')
    await fs.writeFile(netlogPath, lines)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    const message = archive.Requests['example.com'][url][0]
    assert.strictEqual(Buffer.from(message.SerializedResponse, 'base64').toString('latin1'), [
      'HTTP/2.0 200 OK',
      'Connection: close',
      '',
      'abc'
    ].join('\r\n'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('fails when the netlog reached the size limit (overwritten traffic)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-netlog-test-'))
    const netlogPath = path.join(dir, 'netlog.ndjson')
    await fs.writeFile(netlogPath, 'x'.repeat(MAX_NETLOG_BYTES + 1))
    await assert.rejects(buildArchiveFromNetLog(netlogPath), {
      name: 'NetLogError',
      message: `netlog file (${MAX_NETLOG_BYTES + 1} bytes) reached the ${MAX_NETLOG_BYTES} byte limit; earlier traffic was overwritten`
    })
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('CSP replay-nonce seeding', () => {
  // Minimal exchange shaped like the objects buildExchangesFromNetLog returns;
  // only the fields archiveFromExchanges reads are populated.
  const exchange = (responseHeaders, { path = '/', status = 200, contentType = 'text/html' } = {}) => ({
    url: `https://example.com${path}`,
    method: 'GET',
    path,
    authority: 'example.com',
    userAgent: 'UA/1.0',
    isHttp1: true,
    requestLine: `GET ${path} HTTP/1.1\r\n`,
    requestHeaders: ['Host: example.com'],
    requestEntries: [],
    requestContentLength: null,
    requestChunked: false,
    requestBody: Buffer.alloc(0),
    responseStatusLine: `HTTP/1.1 ${status} OK`,
    responseCode: status,
    responseEntries: [['Content-Type', contentType], ...responseHeaders],
    responseContentLength: null,
    responseChunked: false,
    responseBody: Buffer.alloc(0),
    negotiatedProtocol: null,
    boundSessions: [],
    boundSocketId: undefined,
    eventIndex: 0
  })

  const build = (exchanges) => archiveFromExchanges(exchanges, new Map())

  const responseHeaderLines = (message) => {
    const lines = Buffer.from(message.SerializedResponse, 'base64').toString('latin1').split('\r\n')
    return lines.slice(1, lines.indexOf(''))
  }

  const cspValues = (message) => responseHeaderLines(message)
    .filter(line => line.startsWith('Content-Security-Policy: '))
    .map(line => line.slice('Content-Security-Policy: '.length))

  it('seeds a nonce into script-restricting CSP headers of HTML 200 responses', () => {
    const archive = build([exchange([['Content-Security-Policy', "script-src 'self'"]])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const match = /^script-src 'nonce-([A-Za-z0-9+/]+={0,2})' 'self'$/.exec(csp)
    assert.notStrictEqual(match, null, csp)
    assert.strictEqual(Buffer.from(match[1], 'base64').length, 16)
  })

  it('uses a fresh nonce per archive', () => {
    const first = build([exchange([['Content-Security-Policy', "script-src 'self'"]])])
    const second = build([exchange([['Content-Security-Policy', "script-src 'self'"]])])
    const [a] = cspValues(first.Requests['example.com']['https://example.com/'][0])
    const [b] = cspValues(second.Requests['example.com']['https://example.com/'][0])
    assert.notStrictEqual(a, b)
  })

  it('preserves policies that already admit the injected script', () => {
    const archive = build([
      exchange([['Content-Security-Policy', "script-src 'self' 'unsafe-inline'"]], { path: '/a' }),
      exchange([['Content-Security-Policy', "script-src 'nonce-abc'"]], { path: '/b' }),
      exchange([['Content-Security-Policy', "script-src 'sha256-abc'"]], { path: '/c' }),
      exchange([['Content-Security-Policy', "img-src 'none'"]], { path: '/d' })
    ])
    const requests = archive.Requests['example.com']
    assert.deepStrictEqual(cspValues(requests['https://example.com/a'][0]), ["script-src 'self' 'unsafe-inline'"])
    assert.deepStrictEqual(cspValues(requests['https://example.com/b'][0]), ["script-src 'nonce-abc'"])
    assert.deepStrictEqual(cspValues(requests['https://example.com/c'][0]), ["script-src 'sha256-abc'"])
    assert.deepStrictEqual(cspValues(requests['https://example.com/d'][0]), ["img-src 'none'"])
  })

  it('leaves non-HTML and non-200 responses untouched', () => {
    const archive = build([
      exchange([['Content-Security-Policy', "script-src 'self'"]], { path: '/json', contentType: 'application/json' }),
      exchange([['Content-Security-Policy', "script-src 'self'"]], { path: '/404', status: 404 })
    ])
    const requests = archive.Requests['example.com']
    assert.deepStrictEqual(cspValues(requests['https://example.com/json'][0]), ["script-src 'self'"])
    assert.deepStrictEqual(cspValues(requests['https://example.com/404'][0]), ["script-src 'self'"])
  })

  it('drops \'none\' and seeds the same nonce into every enforced policy', () => {
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'sha256-x'"],
      ['Content-Security-Policy', "default-src 'none'"],
      ['Content-Security-Policy-Report-Only', "script-src 'self'"]
    ])])
    const [first, second] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const firstNonce = /^script-src 'nonce-([^']+)' 'sha256-x'$/.exec(first)
    const secondNonce = /^default-src 'nonce-([^']+)'$/.exec(second)
    assert.notStrictEqual(firstNonce, null, first)
    assert.notStrictEqual(secondNonce, null, second)
    assert.strictEqual(firstNonce[1], secondNonce[1])
  })

  it('seeds policies with a foreign nonce so the injected tag satisfies all of them', () => {
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'nonce-abc'"],
      ['Content-Security-Policy', "script-src 'self'"]
    ])])
    const [first, second] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const firstMatch = /^script-src 'nonce-([^']+)' 'nonce-abc'$/.exec(first)
    const secondMatch = /^script-src 'nonce-([^']+)' 'self'$/.exec(second)
    assert.notStrictEqual(firstMatch, null, first)
    assert.notStrictEqual(secondMatch, null, second)
    // the seeded nonce must be the tag source's first nonce, so wpr tags its
    // injected script with it and the site's own nonce permissions are kept
    assert.strictEqual(firstMatch[1], secondMatch[1])
    assert.notStrictEqual(firstMatch[1], 'abc')
  })

  it('seeds through the full netlog pipeline', async () => {
    const url = 'https://example.com/csp'
    const requestHeaders = [':method: GET', ':authority: example.com', ':scheme: https', ':path: /csp']
    const events = [
      event(ST.URL_REQUEST, 800, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 800, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
      event(ST.HTTP_STREAM_JOB, 801, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.URL_REQUEST, 800, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 800, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, {
        headers: ['HTTP/1.1 200', 'content-type: text/html', 'content-security-policy: script-src \'self\'']
      }),
      event(ST.URL_REQUEST, 800, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 3, bytes: Buffer.from('abc').toString('base64') })
    ]
    const { dir, netlogPath } = await writeNetlog(events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    const [csp] = cspValues(archive.Requests['example.com'][url][0])
    assert.match(csp, /^script-src 'nonce-[A-Za-z0-9+/]+={0,2}' 'self'$/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('deterministic.js placeholder rendering', () => {
  it('replaces legacy and bare placeholders like wpr does', () => {
    const script = 'var seed = {{WPR_TIME_SEED_TIMESTAMP}}; var bare = WPR_TIME_SEED_TIMESTAMP; var rand = {{WPR_CONSTANT_RANDOM_RESULT}};'
    assert.strictEqual(replaceConstants(script, 123000, null), 'var seed = 123000; var bare = 123000; var rand = null;')
    assert.strictEqual(replaceConstants(script, 123000, 0.5), 'var seed = 123000; var bare = 123000; var rand = 0.5;')
  })

  it('archives carry the raw script and the time seed', () => {
    const archive = archiveFromExchanges([], new Map(), {
      injectedScripts: { 'deterministic.js': 'WPR_TIME_SEED_TIMESTAMP' },
      deterministicTimeSeedMs: 1000
    })
    assert.strictEqual(archive.DeterministicTimeSeedMs, 1000)
    assert.strictEqual(archive.InjectedScripts['deterministic.js'], 'WPR_TIME_SEED_TIMESTAMP')
    assert.strictEqual(archive.ConstantMathRandomResult, null)
    assert.strictEqual(archive.CurrentSessionId, 0)
    assert.strictEqual(archive.ServeResponseInChronologicalSequence, false)
    assert.strictEqual(archive.DisableFuzzyURLMatching, false)
    assert.deepStrictEqual(archive.Certs, {})
    assert.deepStrictEqual(archive.Requests, {})
  })
})
