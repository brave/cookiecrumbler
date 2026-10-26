import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ET, ST, PHASE, event, h2SentBytes, writeNetlog, makeExchange, decodeRequest, decodeResponse
} from '../helpers/netlog-fixtures.mjs'
import { replaceConstants } from '../../src/deterministic.mjs'
import { buildArchiveFromNetLog, archiveFromExchanges } from '../../src/wpr-archive.mjs'

describe('netlog to WprGo archive conversion', () => {
  it('converts h2 request/response pairs into the wpr record format', async (t) => {
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
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive), [
      'Requests', 'Certs', 'NegotiatedProtocol', 'DeterministicTimeSeedMs',
      'ConstantMathRandomResult', 'ServeResponseInChronologicalSequence',
      'CurrentSessionId', 'DisableFuzzyURLMatching', 'Metadata', 'InjectedScripts'
    ])
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    const message = archive.Requests['example.com'][url][0]
    assert.strictEqual(message.LastServedSessionId, 0)
    assert.strictEqual(decodeRequest(message), [
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
    assert.strictEqual(decodeResponse(message), [
      'HTTP/2.0 200 OK',
      'Connection: close',
      'Content-Type: text/html',
      'Set-Cookie: a=1',
      'Set-Cookie: b=2',
      '',
      'wire-bytes'
    ].join('\r\n'))
    assert.deepStrictEqual(archive.NegotiatedProtocol, { 'example.com': 'h2' })
  })

  it('recovers h2 request bodies from DATA frames and serializes POSTs with Content-Length', async (t) => {
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
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.strictEqual(decodeRequest(archive.Requests['example.com'][url][0]), [
      'POST /collect HTTP/1.1',
      'Host: example.com',
      'Content-Length: 7',
      'Content-Type: text/plain',
      '',
      'payload'
    ].join('\r\n'))
  })

  it('reconstructs HTTP/1.1 exchanges; identity responses log their body via the filtered event', async (t) => {
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
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    const message = archive.Requests['example.com'][url][0]
    // No User-Agent in the logged headers: none is serialized
    assert.strictEqual(decodeRequest(message), [
      'GET /a HTTP/1.1',
      'Host: example.com',
      'Accept: */*',
      '',
      ''
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(message), [
      'HTTP/1.1 200 OK',
      'Content-Length: 10',
      'Content-Type: text/plain',
      '',
      'plain-body'
    ].join('\r\n'))
    assert.deepStrictEqual(archive.NegotiatedProtocol, { 'example.com': 'http/1.1' })
  })

  it('re-frames chunked response bodies like Go resp.Write, including empty ones', (t) => {
    const chunkedExchange = (path, body) => makeExchange({
      url: `https://example.com${path}`,
      path,
      userAgent: null,
      isHttp1: false,
      requestLine: null,
      responseStatusLine: null,
      responseEntries: [['Content-Type', 'text/plain']],
      responseChunked: true,
      responseBody: body
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

  it('re-chunks a chunked response that also logs a Content-Length', () => {
    // Such responses exist on the wire and Chromium accepts them, with the
    // chunked framing taking priority over the Content-Length; a head that
    // declares the length over a chunked body would corrupt the archive.
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/stream',
      path: '/stream',
      userAgent: null,
      responseEntries: [['Content-Type', 'text/event-stream']],
      responseChunked: true,
      responseContentLength: 5,
      responseBody: Buffer.from('hello')
    })], new Map())
    const response = Buffer.from(archive.Requests['example.com']['https://example.com/stream'][0].SerializedResponse, 'base64').toString('latin1')
    assert.strictEqual(response, [
      'HTTP/1.1 200 OK',
      'Transfer-Encoding: chunked',
      'Content-Type: text/event-stream',
      '',
      '5\r\nhello\r\n0\r\n\r\n'
    ].join('\r\n'))
  })

  it('delimits unknown-length h1 bodies with Connection: close like Go resp.Write', () => {
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/eof',
      path: '/eof',
      userAgent: null,
      responseContentLength: null,
      responseEntries: [['Content-Type', 'text/plain']],
      responseBody: Buffer.from('body')
    })], new Map())
    const response = Buffer.from(archive.Requests['example.com']['https://example.com/eof'][0].SerializedResponse, 'base64').toString('latin1')
    assert.strictEqual(response, [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Content-Type: text/plain',
      '',
      'body'
    ].join('\r\n'))
  })

  it('declares Content-Length: 0 for a body-allowed zero-length response', () => {
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/empty',
      path: '/empty',
      userAgent: null,
      responseContentLength: 0,
      responseEntries: [['Content-Type', 'text/plain']],
      responseBody: Buffer.alloc(0)
    })], new Map())
    const response = Buffer.from(archive.Requests['example.com']['https://example.com/empty'][0].SerializedResponse, 'base64').toString('latin1')
    assert.strictEqual(response, [
      'HTTP/1.1 200 OK',
      'Content-Length: 0',
      'Content-Type: text/plain',
      '',
      ''
    ].join('\r\n'))
  })

  it('writes no framing header for no-body statuses with unknown length', () => {
    const archive = archiveFromExchanges([
      makeExchange({
        url: 'https://example.com/no-content',
        path: '/no-content',
        userAgent: null,
        responseStatusLine: 'HTTP/1.1 204 No Content',
        responseCode: 204,
        responseContentLength: null,
        responseEntries: [],
        responseBody: Buffer.alloc(0)
      }),
      makeExchange({
        url: 'https://example.com/not-modified',
        path: '/not-modified',
        userAgent: null,
        responseStatusLine: 'HTTP/1.1 304 Not Modified',
        responseCode: 304,
        responseContentLength: null,
        responseEntries: [],
        responseBody: Buffer.alloc(0)
      })
    ], new Map())
    const requests = archive.Requests['example.com']
    assert.strictEqual(Buffer.from(requests['https://example.com/no-content'][0].SerializedResponse, 'base64').toString('latin1'), 'HTTP/1.1 204 No Content\r\n\r\n')
    assert.strictEqual(Buffer.from(requests['https://example.com/not-modified'][0].SerializedResponse, 'base64').toString('latin1'), 'HTTP/1.1 304 Not Modified\r\n\r\n')
  })

  it('keeps the logged Content-Length of a bodyless response as metadata', () => {
    // Go's ReadResponse zeroes the ContentLength field of bodyless statuses
    // (1xx/204/304) and resp.Write excludes the header from its output, so
    // wpr record archives a 304 that carried `Content-Length: 12345` without
    // the line. The netlog logged what the server actually sent: the value is
    // RFC 9110-permitted revalidation metadata and the replaying browser
    // ignores it for framing, so the converter keeps the logged value.
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/stale',
      path: '/stale',
      userAgent: null,
      responseStatusLine: 'HTTP/1.1 304 Not Modified',
      responseCode: 304,
      responseContentLength: 12345,
      responseEntries: [],
      responseBody: Buffer.alloc(0)
    })], new Map())
    const response = Buffer.from(archive.Requests['example.com']['https://example.com/stale'][0].SerializedResponse, 'base64').toString('latin1')
    assert.strictEqual(response, 'HTTP/1.1 304 Not Modified\r\nContent-Length: 12345\r\n\r\n')
  })

  it('serializes h2 status lines with Go\'s StatusText phrases', () => {
    const archive = archiveFromExchanges([
      makeExchange({
        url: 'https://example.com/too-large',
        path: '/too-large',
        isHttp1: false,
        requestLine: null,
        responseCode: 413,
        responseBody: Buffer.from('x')
      }),
      makeExchange({
        url: 'https://example.com/unprocessable',
        path: '/unprocessable',
        isHttp1: false,
        requestLine: null,
        responseCode: 422,
        responseBody: Buffer.from('y')
      })
    ], new Map())
    assert.strictEqual(
      decodeResponse(archive.Requests['example.com']['https://example.com/too-large'][0]), [
        'HTTP/2.0 413 Request Entity Too Large',
        'Connection: close',
        'Content-Type: text/html',
        '',
        'x'
      ].join('\r\n'))
    assert.strictEqual(
      decodeResponse(archive.Requests['example.com']['https://example.com/unprocessable'][0]), [
        'HTTP/2.0 422 Unprocessable Entity',
        'Connection: close',
        'Content-Type: text/html',
        '',
        'y'
      ].join('\r\n'))
  })

  it('drops exchanges whose recovered body does not match the logged Content-Length', async (t) => {
    const events = []
    const addExchange = (sourceId, url, { method = 'GET', status = 'HTTP/1.1 200 OK', contentLength = null, body = '' } = {}) => {
      const path = new URL(url).pathname
      const headerList = [status, ...(contentLength === null ? [] : [`content-length: ${contentLength}`])]
      events.push(
        event(ST.URL_REQUEST, sourceId, ET.REQUEST_ALIVE, { url }),
        event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_START_JOB, { method, url }),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: sourceId + 2, type: ST.SOCKET } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: sourceId + 1, type: ST.HTTP_STREAM_JOB } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: `${method} ${path} HTTP/1.1\r\n`, headers: ['Host: example.com'] }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: headerList }),
        ...(body.length > 0 ? [event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: body.length, bytes: Buffer.from(body).toString('base64') })] : [])
      )
    }
    addExchange(1000, 'http://example.com/good', { contentLength: 10, body: 'plain-body' })
    // aborted transfer: headers logged a 10-byte body, only 5 bytes recovered
    addExchange(1010, 'http://example.com/short', { contentLength: 10, body: 'short' })
    // HEAD/304 responses carry no body even when a length is logged: kept
    addExchange(1020, 'http://example.com/head', { method: 'HEAD', contentLength: 5, body: '' })
    addExchange(1030, 'http://example.com/not-modified', { status: 'HTTP/1.1 304 Not Modified', contentLength: 12345, body: '' })
    // HTTP/2 frames its body with END_STREAM, not Content-Length: Chromium
    // accepts a clean stream with fewer DATA bytes than the header, keep it
    const h2Url = 'https://example.com/h2-short'
    const h2Headers = [':method: GET', ':authority: example.com', ':scheme: https', ':path: /h2-short']
    events.push(
      event(ST.URL_REQUEST, 1050, ET.REQUEST_ALIVE, { url: h2Url }),
      event(ST.URL_REQUEST, 1050, ET.URL_REQUEST_START_JOB, { method: 'GET', url: h2Url }),
      event(ST.HTTP_STREAM_JOB, 1051, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.URL_REQUEST, 1050, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 1051, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 1050, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: h2Headers }),
      event(ST.URL_REQUEST, 1050, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200', 'content-length: 10'] }),
      event(ST.URL_REQUEST, 1050, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 5, bytes: Buffer.from('short').toString('base64') })
    )
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']).sort(), [
      'http://example.com/good', 'http://example.com/head', 'http://example.com/not-modified', h2Url
    ])
    assert.strictEqual(decodeResponse(archive.Requests['example.com']['http://example.com/good'][0]), [
      'HTTP/1.1 200 OK',
      'Content-Length: 10',
      '',
      'plain-body'
    ].join('\r\n'))
    // HTTP/2 bodies shorter than the logged Content-Length are kept, but
    // serialized with the recovered length (Go's http.ReadResponse would hit
    // an unexpected EOF replaying the logged length)
    assert.strictEqual(decodeResponse(archive.Requests['example.com'][h2Url][0]), [
      'HTTP/2.0 200 OK',
      'Content-Length: 5',
      '',
      'short'
    ].join('\r\n'))
  })

  it('drops hops the browser failed with a net_error, keeping completed redirect hops', async (t) => {
    const events = []
    const addExchange = (sourceId, url, { status = 'HTTP/1.1 200 OK', contentLength = 10, body = 'plain-body' } = {}) => {
      const path = new URL(url).pathname
      events.push(
        event(ST.URL_REQUEST, sourceId, ET.REQUEST_ALIVE, { url }),
        event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: sourceId + 2, type: ST.SOCKET } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: sourceId + 1, type: ST.HTTP_STREAM_JOB } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: `GET ${path} HTTP/1.1\r\n`, headers: ['Host: example.com'] }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: [status, `content-length: ${contentLength}`] }),
        ...(body.length > 0 ? [event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: body.length, bytes: Buffer.from(body).toString('base64') })] : [])
      )
    }
    addExchange(1300, 'http://example.com/good')
    // the START_JOB end carries net_error only when the job genuinely failed
    // (here: connection closed mid-download, ERR_CONTENT_LENGTH_MISMATCH)
    addExchange(1310, 'http://example.com/failed')
    events.push(event(ST.URL_REQUEST, 1310, ET.URL_REQUEST_START_JOB, { net_error: -354 }, PHASE.PHASE_END))
    // redirect chain: hop 1 completes (302), hop 2 is aborted by the browser
    addExchange(1320, 'http://example.com/redirect-me', { status: 'HTTP/1.1 302 Found', contentLength: null, body: '' })
    events.push(event(ST.URL_REQUEST, 1320, ET.URL_REQUEST_REDIRECTED, { location: 'http://example.com/aborted' }))
    addExchange(1320, 'http://example.com/aborted', { contentLength: 10, body: 'short' })
    events.push(event(ST.URL_REQUEST, 1320, ET.URL_REQUEST_START_JOB, { net_error: -354 }, PHASE.PHASE_END))
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']).sort(), [
      'http://example.com/good', 'http://example.com/redirect-me'
    ])
  })

  it('keeps successful redirect hops whose body the browser never read', async (t) => {
    // Chromium follows the Location without consuming a redirect's
    // Content-Length-framed body: the hop succeeds with an empty recovered
    // body and must stay in the archive, framed by the recovered length
    const events = []
    const addExchange = (sourceId, url, { status = 'HTTP/1.1 200 OK', contentLength = 10, body = 'plain-body' } = {}) => {
      const path = new URL(url).pathname
      events.push(
        event(ST.URL_REQUEST, sourceId, ET.REQUEST_ALIVE, { url }),
        event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: sourceId + 2, type: ST.SOCKET } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: sourceId + 1, type: ST.HTTP_STREAM_JOB } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: `GET ${path} HTTP/1.1\r\n`, headers: ['Host: example.com'] }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: [status, `content-length: ${contentLength}`] }),
        ...(body.length > 0 ? [event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: body.length, bytes: Buffer.from(body).toString('base64') })] : [])
      )
    }
    addExchange(1400, 'http://example.com/start', { status: 'HTTP/1.1 301 Moved Permanently', contentLength: 5, body: '' })
    events.push(event(ST.URL_REQUEST, 1400, ET.URL_REQUEST_REDIRECTED, { location: 'http://example.com/landing' }))
    addExchange(1400, 'http://example.com/landing', { contentLength: 10, body: 'plain-body' })
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']).sort(), [
      'http://example.com/landing', 'http://example.com/start'
    ])
    assert.strictEqual(decodeResponse(archive.Requests['example.com']['http://example.com/start'][0]), [
      'HTTP/1.1 301 Moved Permanently',
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n'))
  })

  it('splits redirect hops into one message per URL and filters browser-internal traffic', async (t) => {
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
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']), [firstUrl, secondUrl])
    assert.strictEqual(archive.Requests['example.com'][firstUrl][0].SerializedResponse, Buffer.from([
      'HTTP/2.0 302 Found',
      'Connection: close',
      '',
      ''
    ].join('\r\n')).toString('base64'))
  })

  it('throws when the netlog contains no recorded requests', async (t) => {
    const netlogPath = await writeNetlog(t, [])
    await assert.rejects(buildArchiveFromNetLog(netlogPath), { name: 'NetLogError', message: 'netlog contains no recorded requests' })
  })

  it('rejects a netlog whose every recorded request is dropped as truncated', async (t) => {
    // Filtering drops aborted HTTP/1 transfers; converting must not report
    // success with an archive that has nothing replayable
    const url = 'http://example.com/short'
    const events = [
      event(ST.URL_REQUEST, 900, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 900, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
      event(ST.HTTP_STREAM_JOB, 901, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, 901, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, 900, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 901, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 900, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /short HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 900, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK', 'content-length: 10'] }),
      event(ST.URL_REQUEST, 900, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 5, bytes: Buffer.from('short').toString('base64') })
    ]
    const netlogPath = await writeNetlog(t, events)
    await assert.rejects(buildArchiveFromNetLog(netlogPath), { name: 'NetLogError', message: 'every recorded request was dropped as unreplayable' })
  })

  it('parses the NDJSON format written with --net-log-file-format=ndjson', async (t) => {
    const url = 'https://example.com/nd'
    const requestHeaders = [':method: GET', ':authority: example.com', ':scheme: https', ':path: /nd']
    const events = [
      event(ST.URL_REQUEST, 700, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 700, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
      event(ST.HTTP_STREAM_JOB, 701, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] }),
      event(ST.URL_REQUEST, 700, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 3, bytes: Buffer.from('abc').toString('base64') })
    ]
    const netlogPath = await writeNetlog(t, events, { format: 'ndjson' })
    const archive = await buildArchiveFromNetLog(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    const message = archive.Requests['example.com'][url][0]
    assert.strictEqual(decodeResponse(message), [
      'HTTP/2.0 200 OK',
      'Connection: close',
      '',
      'abc'
    ].join('\r\n'))
  })

  it('parses a netlog that stayed below the 90% rejection threshold', async (t) => {
    const netlogPath = await writeNetlog(t, [])
    const maxNetlogBytes = 1024 * 1024
    await assert.rejects(buildArchiveFromNetLog(netlogPath, { maxNetlogBytes }), {
      name: 'NetLogError',
      message: 'netlog contains no recorded requests'
    })
  })
})

describe('CSP replay-nonce seeding', () => {
  const exchange = (responseHeaders, { path = '/', status = 200, contentType = 'text/html' } = {}) => makeExchange({
    url: `https://example.com${path}`,
    path,
    responseStatusLine: `HTTP/1.1 ${status} OK`,
    responseCode: status,
    responseEntries: [['Content-Type', contentType], ...responseHeaders]
  })

  const build = (exchanges) => archiveFromExchanges(exchanges, new Map())

  const responseHeaderLines = (message) => {
    const lines = decodeResponse(message).split('\r\n')
    return lines.slice(1, lines.indexOf(''))
  }

  const cspValues = (message) => responseHeaderLines(message)
    .filter(line => line.startsWith('Content-Security-Policy: '))
    .map(line => line.slice('Content-Security-Policy: '.length))

  it('does not mutate the caller\'s exchanges when seeding CSP headers', () => {
    const input = exchange([['Content-Security-Policy', "script-src 'self'"]])
    const entriesBefore = structuredClone(input.responseEntries)
    archiveFromExchanges([input], new Map())
    assert.deepStrictEqual(input.responseEntries, entriesBefore)
  })

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

  it('leaves a policy whose script-src already admits inline scripts untouched', () => {
    // Seeding the script-src would revoke its 'unsafe-inline' (a nonce makes
    // browsers ignore it), blocking the site's own inline scripts on replay
    // that ran during recording; and script-src-attr never applies to wpr's
    // injected element, so it must not trigger seeding either.
    const archive = build([
      exchange([['Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'"]], { path: '/a' }),
      exchange([['Content-Security-Policy', "script-src 'self' 'unsafe-inline'; script-src-attr 'none'"]], { path: '/b' })
    ])
    const requests = archive.Requests['example.com']
    assert.deepStrictEqual(cspValues(requests['https://example.com/a'][0]), ["default-src 'self'; script-src 'self' 'unsafe-inline'"])
    assert.deepStrictEqual(cspValues(requests['https://example.com/b'][0]), ["script-src 'self' 'unsafe-inline'; script-src-attr 'none'"])
  })

  it('seeds an unsafe-inline policy only when another enforced policy blocks inline scripts', () => {
    // The blocking default-src needs the nonce (wpr would otherwise relax it
    // with 'unsafe-inline'), and the tag nonce is read from the first
    // script-governing directive; the conjunction blocked inline scripts at
    // record time already, so narrowing the unsafe-inline policy is neutral.
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'self' 'unsafe-inline'"],
      ['Content-Security-Policy', "default-src 'self'"]
    ])])
    const [first, second] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    // the seeded script-src is its policy's handler fallback and admitted
    // handlers via 'unsafe-inline', so seeding mirrors it into an explicit
    // script-src-attr; value2's default-src still blocks the handlers overall
    const firstMatch = /^script-src 'nonce-([^']+)' 'self' 'unsafe-inline';script-src-attr 'self' 'unsafe-inline'$/.exec(first)
    const secondMatch = /^default-src 'nonce-([^']+)' 'self'$/.exec(second)
    assert.notStrictEqual(firstMatch, null, first)
    assert.notStrictEqual(secondMatch, null, second)
    assert.strictEqual(firstMatch[1], secondMatch[1])
  })

  it('keeps a handler fallback\'s unsafe-inline permission in an explicit script-src-attr', () => {
    // Seeding script-src revokes its 'unsafe-inline' for handlers (a nonce
    // makes browsers ignore it), so the original directive is mirrored into
    // an explicit script-src-attr: onclick= handlers ran during recording and
    // must keep running on replay. script-src-elem never governs handlers, so
    // seeding it adds no copy.
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'self' 'unsafe-inline'; script-src-elem 'self' 'nonce-abc'"]
    ])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^script-src 'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src 'nonce-${nonce}' 'self' 'unsafe-inline'`,
      `script-src-elem 'nonce-${nonce}' 'self' 'nonce-abc'`,
      'script-src-attr \'self\' \'unsafe-inline\''
    ])
  })

  it('leaves an existing script-src-attr untouched instead of appending a second one', () => {
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'self' 'unsafe-inline'; script-src-elem 'self' 'nonce-abc'; script-src-attr 'self'"]
    ])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^script-src 'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src 'nonce-${nonce}' 'self' 'unsafe-inline'`,
      `script-src-elem 'nonce-${nonce}' 'self' 'nonce-abc'`,
      "script-src-attr 'self'"
    ])
  })

  it('adds no script-src-attr when the seeded fallback never admitted handlers', () => {
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'self'; script-src-elem 'self' 'nonce-abc'"]
    ])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^script-src 'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src 'nonce-${nonce}' 'self'`,
      `script-src-elem 'nonce-${nonce}' 'self' 'nonce-abc'`
    ])
  })

  it('seeds a script-src-attr that wpr would relax into unsafe-inline', () => {
    // wpr's rewrite picks the first directive starting with 'script-src',
    // which matches script-src-attr: a target with neither nonce, hash nor
    // 'unsafe-inline' (here 'none') would get 'unsafe-inline' appended at
    // replay, running handlers the recording had blocked. Event-handler
    // attributes can never carry a nonce, so seeding it blocks handlers
    // exactly as before and leaves wpr's rewrite idle.
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src-attr 'none'; script-src 'unsafe-inline'"]
    ])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^script-src-attr 'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src-attr 'nonce-${nonce}'`,
      "script-src 'unsafe-inline'"
    ])
  })

  it('leaves a script-src-attr rewrite target that already admits handlers untouched', () => {
    // wpr appends nothing to a target that already has 'unsafe-inline'
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src-attr 'unsafe-inline'; script-src 'unsafe-inline'"]
    ])])
    assert.deepStrictEqual(cspValues(archive.Requests['example.com']['https://example.com/'][0]), ["script-src-attr 'unsafe-inline'; script-src 'unsafe-inline'"])
  })

  it('seeds only the policy whose rewrite target is a script-src-attr', () => {
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src 'unsafe-inline'"],
      ['Content-Security-Policy', "script-src-attr 'none'; script-src 'unsafe-inline'"]
    ])])
    const [first, second] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^script-src-attr 'nonce-([^']+)'/.exec(second)[1]
    assert.strictEqual(first, "script-src 'unsafe-inline'")
    assert.deepStrictEqual(second.split(';').map(directive => directive.trim()), [
      `script-src-attr 'nonce-${nonce}'`,
      "script-src 'unsafe-inline'"
    ])
  })

  it('seeds a blocking policy with a script-src-attr rewrite target through needsSeed', () => {
    // needsSeed is true (script-src 'self' blocks the injected tag), the
    // rewrite target is the attribute directive and wpr's directive search
    // picks it as tag source, so both directives get the same replay nonce
    // and no handler copy is added
    const archive = build([exchange([
      ['Content-Security-Policy', "script-src-attr 'none'; script-src 'self'"]
    ])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^script-src-attr 'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src-attr 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}' 'self'`
    ])
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

  it('seeds through the full netlog pipeline', async (t) => {
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
    const netlogPath = await writeNetlog(t, events)
    const archive = await buildArchiveFromNetLog(netlogPath)
    const [csp] = cspValues(archive.Requests['example.com'][url][0])
    assert.match(csp, /^script-src 'nonce-[A-Za-z0-9+/]+={0,2}' 'self'$/)
  })

  it('recognizes directive names case-insensitively and normalizes them for wpr', () => {
    // Browsers read directive names case-insensitively, so ScRiPt-SrC 'self'
    // blocks the injected script just like script-src; wpr matches lowercase
    // prefixes, so the name is normalized and the policy seeded like any
    // other blocking script-src
    const archive = build([exchange([['Content-Security-Policy', "ScRiPt-SrC 'self'"]])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    assert.match(csp, /^script-src 'nonce-[A-Za-z0-9+/]+={0,2}' 'self'$/)
  })

  it('reads CSP keyword spellings case-insensitively and normalizes them for wpr', () => {
    // Browsers match 'unsafe-inline' and the nonce prefix without regard to
    // case, so these policies already admit the injected script; wpr only
    // recognizes lowercase spellings, so the values are normalized without
    // seeding
    const archive = build([
      exchange([['Content-Security-Policy', "script-src 'UNSAFE-INLINE'"]], { path: '/inline' }),
      exchange([['Content-Security-Policy', "script-src 'NONCE-abc'"]], { path: '/nonce' })
    ])
    const requests = archive.Requests['example.com']
    assert.deepStrictEqual(cspValues(requests['https://example.com/inline'][0]), ["script-src 'unsafe-inline'"])
    assert.deepStrictEqual(cspValues(requests['https://example.com/nonce'][0]), ["script-src 'nonce-abc'"])
  })

  it('honors only the first duplicate directive when deciding whether to seed', () => {
    // Browsers enforce the first occurrence of a directive name: the
    // shadowed script-src 'self' must not trigger seeding, which would add a
    // nonce to the effective first directive and disable its 'unsafe-inline',
    // blocking site scripts that ran during recording
    const archive = build([exchange([['Content-Security-Policy', "script-src 'unsafe-inline'; script-src 'self'"]])])
    assert.deepStrictEqual(cspValues(archive.Requests['example.com']['https://example.com/'][0]), ["script-src 'unsafe-inline'; script-src 'self'"])
  })

  it('resolves the effective element directive before seeding', () => {
    // script-src-elem takes over for <script> elements, so the shadowed
    // script-src 'self' must not trigger seeding of the permissive
    // script-src-elem: a nonce there would disable its 'unsafe-inline' and
    // block site scripts that ran during recording
    const archive = build([exchange([['Content-Security-Policy', "script-src-elem 'unsafe-inline'; script-src 'self'"]])])
    assert.deepStrictEqual(cspValues(archive.Requests['example.com']['https://example.com/'][0]), ["script-src-elem 'unsafe-inline'; script-src 'self'"])
  })

  it('mirrors a seeded default-src fallback into an explicit style-src', () => {
    // Seeding default-src with a nonce makes browsers ignore its
    // 'unsafe-inline' for styles too, blocking inline styles that ran during
    // recording; the original directive is mirrored into an explicit
    // style-src. The script-src-attr mirror would otherwise become wpr's
    // nonce source without carrying one, so an explicit seeded script-src is
    // inserted ahead of it.
    const archive = build([exchange([
      ['Content-Security-Policy', "default-src 'self' 'unsafe-inline'"],
      ['Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'"]
    ])])
    const [first, second] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /^default-src 'nonce-([^']+)'/.exec(first)[1]
    assert.deepStrictEqual(first.split(';').map(directive => directive.trim()), [
      `default-src 'nonce-${nonce}' 'self' 'unsafe-inline'`,
      "style-src 'self' 'unsafe-inline'",
      `script-src 'nonce-${nonce}' 'self' 'unsafe-inline'`,
      "script-src-attr 'self' 'unsafe-inline'"
    ])
    assert.deepStrictEqual(second.split(';').map(directive => directive.trim()), [
      `default-src 'nonce-${nonce}' 'self'`,
      "style-src 'unsafe-inline'"
    ])
  })

  it('keeps an unsafe-inline script-src-attr and makes the element directive wpr\'s nonce source', () => {
    // Seeding the attribute directive would revoke its 'unsafe-inline' and
    // block handlers that ran during recording; instead the element
    // directive is seeded and moved ahead of it, so wpr reads its nonce from
    // the script-src and the attribute permission stays untouched
    const archive = build([exchange([['Content-Security-Policy', "script-src-attr 'unsafe-inline'; script-src 'self'"]])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src 'nonce-${nonce}' 'self'`,
      "script-src-attr 'unsafe-inline'"
    ])
  })

  it('splits comma-separated policies into separately seeded entries', () => {
    // wpr's transformers treat the whole value as one semicolon-split blob,
    // so a nonce on the first comma-policy leaves the second blocking the
    // injected script; splitting them into their own header entries seeds
    // both
    const archive = build([exchange([['Content-Security-Policy', "script-src 'self', script-src 'self'"]])])
    const values = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    assert.strictEqual(values.length, 2)
    const nonce = /^script-src 'nonce-([^']+)' 'self'$/.exec(values[0])[1]
    assert.strictEqual(values[1], `script-src 'nonce-${nonce}' 'self'`)
  })

  it('normalizes CSP whitespace so wpr recognizes existing nonces', () => {
    // wpr splits directive tokens on literal spaces, so a tab-separated
    // nonce is invisible to it and it would rewrite the policy into one that
    // blocks the tag; browsers read any whitespace, so the value is
    // collapsed and left unseeded
    const archive = build([exchange([['Content-Security-Policy', "script-src\t'nonce-abc'"]])])
    assert.deepStrictEqual(cspValues(archive.Requests['example.com']['https://example.com/'][0]), ["script-src 'nonce-abc'"])
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
