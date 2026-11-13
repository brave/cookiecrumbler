import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ET, ST, PHASE, event, h2SentBytes, writeNetlog, makeExchange, decodeRequest, decodeResponse
} from './helpers/fixtures.mjs'
import { archiveFromExchanges } from '../src/archive.mjs'
import { parseNetLog } from '../src/netlog/exchanges.mjs'

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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols)
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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols)
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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols)
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

  it('writes Content-Length: 0 after the sorted headers like Go resp.Write', () => {
    // Go's transferWriter sends a zero Content-Length early only for
    // POST/PUT/PATCH; for every other method the late write (response.go)
    // places it after the sorted headers
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
      'Content-Type: text/plain',
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n'))
  })

  it('declares a zero Content-Length early for POST like Go resp.Write', () => {
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/posted',
      path: '/posted',
      method: 'POST',
      requestLine: 'POST /posted HTTP/1.1',
      userAgent: null,
      responseContentLength: 0,
      responseEntries: [['Content-Type', 'text/plain']],
      responseBody: Buffer.alloc(0)
    })], new Map())
    const response = Buffer.from(archive.Requests['example.com']['https://example.com/posted'][0].SerializedResponse, 'base64').toString('latin1')
    assert.strictEqual(response, [
      'HTTP/1.1 200 OK',
      'Content-Length: 0',
      'Content-Type: text/plain',
      '',
      ''
    ].join('\r\n'))
  })

  it('writes a HEAD response\'s zero Content-Length late and its absent length as Connection: close', () => {
    // ReadResponse re-parses the logged Content-Length for HEAD responses, so
    // a logged zero is a known zero (late write) while an absent one is an
    // unknown length, delimited by Connection: close
    const archive = archiveFromExchanges([
      makeExchange({
        url: 'https://example.com/head-empty',
        path: '/head-empty',
        method: 'HEAD',
        requestLine: 'HEAD /head-empty HTTP/1.1',
        responseContentLength: 0,
        responseEntries: [['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/head-unknown',
        path: '/head-unknown',
        method: 'HEAD',
        requestLine: 'HEAD /head-unknown HTTP/1.1',
        responseContentLength: null,
        responseEntries: [['Content-Type', 'text/plain']]
      })
    ], new Map())
    const requests = archive.Requests['example.com']
    assert.strictEqual(decodeResponse(requests['https://example.com/head-empty'][0]), [
      'HTTP/1.1 200 OK',
      'Content-Type: text/plain',
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/head-unknown'][0]), [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Content-Type: text/plain',
      '',
      ''
    ].join('\r\n'))
  })

  it('delimits a HEAD 204 without a logged length with Connection: close like Go resp.Write', () => {
    // Go zeroes the ContentLength of 204 responses, but for HEAD it re-parses
    // the logged value: absent means -1, and resp.Write sets Close for -1
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/head-204',
      path: '/head-204',
      method: 'HEAD',
      requestLine: 'HEAD /head-204 HTTP/1.1',
      responseStatusLine: 'HTTP/1.1 204 No Content',
      responseCode: 204,
      responseContentLength: null,
      responseEntries: []
    })], new Map())
    assert.strictEqual(decodeResponse(archive.Requests['example.com']['https://example.com/head-204'][0]), [
      'HTTP/1.1 204 No Content',
      'Connection: close',
      '',
      ''
    ].join('\r\n'))
  })

  it('writes no framing header for a 101 response', () => {
    // Go's bodyAllowedForStatus excludes 1xx: ReadResponse zeroes the length
    // and resp.Write emits no framing header, where an unknown-length
    // Connection: close body would be malformed for a protocol switch
    const archive = archiveFromExchanges([makeExchange({
      url: 'https://example.com/upgrade',
      path: '/upgrade',
      responseStatusLine: 'HTTP/1.1 101 Switching Protocols',
      responseCode: 101,
      responseContentLength: null,
      responseEntries: [['Upgrade', 'websocket']]
    })], new Map())
    assert.strictEqual(decodeResponse(archive.Requests['example.com']['https://example.com/upgrade'][0]), [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      '',
      ''
    ].join('\r\n'))
  })

  it('consumes a logged Connection: close header into the framing line like Go resp.Write', () => {
    // Go's ReadResponse deletes a Connection header carrying the close token
    // and sets Close; resp.Write emits the single Connection: close before
    // Content-Length and Transfer-Encoding
    const archive = archiveFromExchanges([
      makeExchange({
        url: 'https://example.com/closed-length',
        path: '/closed-length',
        responseContentLength: 5,
        responseBody: Buffer.from('hello'),
        responseEntries: [['Connection', 'close'], ['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/closed-eof',
        path: '/closed-eof',
        responseContentLength: null,
        responseBody: Buffer.from('body'),
        responseEntries: [['Connection', 'close'], ['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/closed-chunked',
        path: '/closed-chunked',
        responseChunked: true,
        responseBody: Buffer.from('hello'),
        responseEntries: [['Connection', 'close'], ['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/closed-empty',
        path: '/closed-empty',
        responseContentLength: 0,
        responseEntries: [['Connection', 'close'], ['Content-Type', 'text/plain']]
      })
    ], new Map())
    const requests = archive.Requests['example.com']
    assert.strictEqual(decodeResponse(requests['https://example.com/closed-length'][0]), [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Content-Length: 5',
      'Content-Type: text/plain',
      '',
      'hello'
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/closed-eof'][0]), [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Content-Type: text/plain',
      '',
      'body'
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/closed-chunked'][0]), [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Transfer-Encoding: chunked',
      'Content-Type: text/plain',
      '',
      '5\r\nhello\r\n0\r\n\r\n'
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/closed-empty'][0]), [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Content-Type: text/plain',
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n'))
  })

  it('keeps a Connection: keep-alive header and closes HTTP/1.0 responses like Go resp.Write', () => {
    // Go preserves a keep-alive-only Connection header and writes it from the
    // sorted subset; an HTTP/1.0 response closes the connection unless its
    // Connection header carries the keep-alive token, and a header carrying
    // both tokens is consumed into the single Connection: close
    const archive = archiveFromExchanges([
      makeExchange({
        url: 'https://example.com/keepalive',
        path: '/keepalive',
        responseContentLength: 5,
        responseBody: Buffer.from('hello'),
        responseEntries: [['Connection', 'keep-alive'], ['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/old',
        path: '/old',
        responseStatusLine: 'HTTP/1.0 200 OK',
        responseContentLength: 5,
        responseBody: Buffer.from('hello'),
        responseEntries: [['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/old-keepalive',
        path: '/old-keepalive',
        responseStatusLine: 'HTTP/1.0 200 OK',
        responseContentLength: 5,
        responseBody: Buffer.from('hello'),
        responseEntries: [['Connection', 'keep-alive'], ['Content-Type', 'text/plain']]
      }),
      makeExchange({
        url: 'https://example.com/mixed',
        path: '/mixed',
        responseContentLength: null,
        responseBody: Buffer.from('body'),
        responseEntries: [['Connection', 'keep-alive, close'], ['Content-Type', 'text/plain']]
      })
    ], new Map())
    const requests = archive.Requests['example.com']
    assert.strictEqual(decodeResponse(requests['https://example.com/keepalive'][0]), [
      'HTTP/1.1 200 OK',
      'Content-Length: 5',
      'Connection: keep-alive',
      'Content-Type: text/plain',
      '',
      'hello'
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/old'][0]), [
      'HTTP/1.0 200 OK',
      'Connection: close',
      'Content-Length: 5',
      'Content-Type: text/plain',
      '',
      'hello'
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/old-keepalive'][0]), [
      'HTTP/1.0 200 OK',
      'Content-Length: 5',
      'Connection: keep-alive',
      'Content-Type: text/plain',
      '',
      'hello'
    ].join('\r\n'))
    assert.strictEqual(decodeResponse(requests['https://example.com/mixed'][0]), [
      'HTTP/1.1 200 OK',
      'Connection: close',
      'Content-Type: text/plain',
      '',
      'body'
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
    const warnings = []
    const onWarning = (warning) => warnings.push(warning)
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath, { onWarning })
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols, { onWarning })
    assert.deepStrictEqual(warnings, [{
      code: 'TRUNCATED_BODY',
      url: 'http://example.com/short',
      message: 'logged Content-Length 10 does not match the 5 byte recovered body'
    }])
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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols)
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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols)
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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols)
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
    // No CAP_REACHED rejection: the file stays far below the threshold, and
    // the empty exchange list reaches the archive step (the NO_REQUESTS
    // error is thrown by the public entry point, see index.test.mjs)
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath, { maxNetlogBytes })
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(negotiatedProtocols, new Map())
    assert.deepStrictEqual(archiveFromExchanges(exchanges, negotiatedProtocols).Requests, {})
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
