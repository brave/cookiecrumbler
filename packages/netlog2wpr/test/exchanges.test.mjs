// Reconstruction tests for src/netlog/exchanges.mjs: synthetic netlog in, HTTP
// exchanges out. The archive serialization of those exchanges is covered by
// test/archive.test.mjs (serializer PR).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseNetLog, isInternalRequest } from '../src/netlog/exchanges.mjs'
import { ET, fixtureConstants, PHASE, ST, event, h2SentBytes, writeNetlog, writeRawNetlog } from './helpers/fixtures.mjs'

describe('parseNetLog', () => {
  for (const format of ['json', 'ndjson']) {
    it(`reconstructs an h2 exchange (${format} netlog)`, async (t) => {
      const url = 'https://example.com/page?a=1'
      const requestHeaders = [
        ':method: GET',
        ':authority: example.com',
        ':scheme: https',
        ':path: /page?a=1',
        'user-agent: UA/1.0',
        'accept: text/html'
      ]
      const events = [
        event(ST.URL_REQUEST, 100, ET.REQUEST_ALIVE, { url }),
        event(ST.URL_REQUEST, 100, ET.URL_REQUEST_START_JOB, { method: 'GET', url }),
        event(ST.HTTP_STREAM_JOB, 101, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
        event(ST.URL_REQUEST, 100, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 101, type: ST.HTTP_STREAM_JOB } }),
        event(ST.URL_REQUEST, 100, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
        event(ST.URL_REQUEST, 100, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, {
          headers: ['HTTP/1.1 200', 'content-type: text/html', 'set-cookie: a=1', 'set-cookie: b=2']
        }),
        // gzip'd response: the raw (still content-encoded) chunk is preferred
        // over the post-filter chunk
        event(ST.URL_REQUEST, 100, ET.URL_REQUEST_JOB_BYTES_READ, { byte_count: 10, bytes: Buffer.from('wire-bytes').toString('base64') }),
        event(ST.URL_REQUEST, 100, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 20, bytes: Buffer.from('decoded-bytes-xxxxx').toString('base64') })
      ]
      const { exchanges, negotiatedProtocols, stats } = await parseNetLog(await writeNetlog(t, events, { format }))
      assert.strictEqual(exchanges.length, 1)
      const exchange = exchanges[0]
      assert.strictEqual(exchange.url, url)
      assert.strictEqual(exchange.method, 'GET')
      assert.strictEqual(exchange.path, '/page?a=1')
      assert.strictEqual(exchange.authority, 'example.com')
      assert.strictEqual(exchange.userAgent, 'UA/1.0')
      assert.strictEqual(exchange.isHttp1, false)
      assert.strictEqual(exchange.requestLine, null)
      assert.deepStrictEqual(exchange.requestEntries, [['Accept', 'text/html']])
      assert.strictEqual(exchange.responseCode, 200)
      assert.strictEqual(exchange.responseStatusLine, 'HTTP/1.1 200')
      assert.deepStrictEqual(exchange.responseEntries, [
        ['Content-Type', 'text/html'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']
      ])
      assert.strictEqual(exchange.responseContentLength, null)
      assert.strictEqual(exchange.responseChunked, false)
      assert.strictEqual(exchange.responseBody.toString(), 'wire-bytes')
      assert.strictEqual(exchange.negotiatedProtocol, 'h2')
      assert.deepStrictEqual([...negotiatedProtocols], [['example.com', 'h2']])
      assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
    })
  }

  it('recovers h2 request bodies from the session DATA frames', async (t) => {
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
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 1)
    assert.deepStrictEqual(exchanges[0].requestBody, body)
    assert.strictEqual(exchanges[0].method, 'POST')
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('recovered h2 bodies follow send order when two requests log identical header lists', async (t) => {
    // Two beacons with byte-identical header lists on one session: matching
    // them against the session's SEND_HEADERS blocks only works when the
    // requests are processed in the order they were sent, which is the netlog
    // position of the send-headers event, not the position within their own
    // source. Request A's source logs two cache events before sending, so its
    // per-source index is the larger one although it sent first.
    const requestHeaders = [
      ':method: POST',
      ':authority: example.com',
      ':scheme: https',
      ':path: /collect',
      'content-type: text/plain'
    ]
    const events = [
      event(ST.URL_REQUEST, 900, ET.REQUEST_ALIVE, { url: 'https://example.com/collect' }),
      event(ST.URL_REQUEST, 900, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'https://example.com/collect' }),
      event(ST.URL_REQUEST, 900, ET.HTTP_CACHE_READ_DATA, {}),
      event(ST.URL_REQUEST, 900, ET.HTTP_CACHE_READ_DATA, {}),
      event(ST.HTTP_STREAM_JOB, 901, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.HTTP_STREAM_JOB, 901, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.HTTP_STREAM_JOB, 901, ET.HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET, { source_dependency: { id: 903, type: ST.HTTP2_SESSION } }),
      event(ST.URL_REQUEST, 900, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 901, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 900, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 900, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 204'] }),
      event(ST.URL_REQUEST, 910, ET.REQUEST_ALIVE, { url: 'https://example.com/collect' }),
      event(ST.URL_REQUEST, 910, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'https://example.com/collect' }),
      event(ST.HTTP_STREAM_JOB, 911, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.HTTP_STREAM_JOB, 911, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.HTTP_STREAM_JOB, 911, ET.HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET, { source_dependency: { id: 903, type: ST.HTTP2_SESSION } }),
      event(ST.URL_REQUEST, 910, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 911, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 910, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders }),
      event(ST.URL_REQUEST, 910, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 204'] }),
      event(ST.SOCKET, 902, ET.SSL_SOCKET_BYTES_SENT, {
        byte_count: 100,
        bytes: Buffer.concat([
          h2SentBytes(3, Buffer.from('first-body')),
          h2SentBytes(5, Buffer.from('second-body'), { preface: false })
        ]).toString('base64')
      }),
      event(ST.HTTP2_SESSION, 903, ET.HTTP2_SESSION_INITIALIZED, { protocol: 'h2', source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.HTTP2_SESSION, 903, ET.HTTP2_SESSION_SEND_HEADERS, { headers: requestHeaders, stream_id: 3 }),
      event(ST.HTTP2_SESSION, 903, ET.HTTP2_SESSION_SEND_HEADERS, { headers: requestHeaders, stream_id: 5 })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 2)
    assert.deepStrictEqual(exchanges.map(e => e.requestBody.toString()), ['first-body', 'second-body'])
    assert.deepStrictEqual(stats, { exchanges: 2, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('reconstructs an h1 exchange and recovers its request body from the socket bytes', async (t) => {
    const url = 'http://example.com/a'
    const events = [
      event(ST.URL_REQUEST, 300, ET.REQUEST_ALIVE, { url }),
      event(ST.URL_REQUEST, 300, ET.URL_REQUEST_START_JOB, { method: 'POST', url }),
      event(ST.HTTP_STREAM_JOB, 301, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, 301, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 302, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, 300, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 301, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 300, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, {
        line: 'POST /a HTTP/1.1\r\n',
        headers: ['Host: example.com', 'content-length: 5', 'accept: */*']
      }),
      event(ST.URL_REQUEST, 300, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, {
        headers: ['HTTP/1.1 200 OK', 'content-type: text/plain', 'content-length: 10']
      }),
      // identity response: only the filtered event carries the body
      event(ST.URL_REQUEST, 300, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { byte_count: 10, bytes: Buffer.from('plain-body').toString('base64') }),
      // cleartext HTTP/1.1 request bytes on the socket (SOCKET_BYTES_SENT)
      event(ST.SOCKET, 302, ET.SOCKET_BYTES_SENT, {
        byte_count: 62,
        bytes: Buffer.from('POST /a HTTP/1.1\r\nHost: example.com\r\ncontent-length: 5\r\naccept: */*\r\n\r\nhello').toString('base64')
      })
    ]
    const { exchanges, negotiatedProtocols, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 1)
    const exchange = exchanges[0]
    assert.strictEqual(exchange.isHttp1, true)
    assert.strictEqual(exchange.requestLine, 'POST /a HTTP/1.1')
    assert.deepStrictEqual(exchange.requestEntries, [['Accept', '*/*']])
    assert.strictEqual(exchange.requestContentLength, 5)
    assert.strictEqual(exchange.requestBody.toString(), 'hello')
    assert.strictEqual(exchange.responseStatusLine, 'HTTP/1.1 200 OK')
    assert.strictEqual(exchange.responseContentLength, 10)
    assert.strictEqual(exchange.responseBody.toString(), 'plain-body')
    assert.deepStrictEqual([...negotiatedProtocols], [['example.com', 'http/1.1']])
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('attributes keep-alive h1 bodies in wire order when a redirect hop logs more events', async (t) => {
    // The POST /api exchange is the second hop of a redirect: its send-headers
    // event sits late within its own URL_REQUEST source, while the
    // independent POST /api below it only logs three events before sending.
    // Ordering the body recovery by that per-source index sends B to the
    // front, and on this keep-alive socket B then matches A's request line
    // first: with identical request lines the two bodies swap.
    const postHeaders = ['Host: example.com', 'content-length: 5']
    const events = [
      event(ST.URL_REQUEST, 800, ET.REQUEST_ALIVE, { url: 'http://example.com/redirect-me' }),
      event(ST.URL_REQUEST, 800, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'http://example.com/redirect-me' }),
      event(ST.HTTP_STREAM_JOB, 801, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, 801, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 802, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, 800, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 801, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 800, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /redirect-me HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 800, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 302 Found'] }),
      event(ST.URL_REQUEST, 800, ET.URL_REQUEST_REDIRECTED, { location: 'http://example.com/api' }),
      event(ST.URL_REQUEST, 810, ET.REQUEST_ALIVE, { url: 'http://example.com/api' }),
      event(ST.URL_REQUEST, 810, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'http://example.com/api' }),
      event(ST.HTTP_STREAM_JOB, 811, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, 811, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 802, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, 800, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'POST /api HTTP/1.1\r\n', headers: postHeaders }),
      event(ST.URL_REQUEST, 810, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 811, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 810, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'POST /api HTTP/1.1\r\n', headers: postHeaders }),
      event(ST.URL_REQUEST, 800, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] }),
      event(ST.URL_REQUEST, 810, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] }),
      // keep-alive socket: the redirect's GET, then the two identical POSTs
      event(ST.SOCKET, 802, ET.SOCKET_BYTES_SENT, {
        byte_count: 180,
        bytes: Buffer.from(
          'GET /redirect-me HTTP/1.1\r\nHost: example.com\r\n\r\n' +
          'POST /api HTTP/1.1\r\nHost: example.com\r\ncontent-length: 5\r\n\r\nAAAAA' +
          'POST /api HTTP/1.1\r\nHost: example.com\r\ncontent-length: 5\r\n\r\nBBBBB'
        ).toString('base64')
      })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 3)
    assert.deepStrictEqual(exchanges.map(e => e.requestLine), [
      'GET /redirect-me HTTP/1.1', 'POST /api HTTP/1.1', 'POST /api HTTP/1.1'
    ])
    assert.deepStrictEqual(exchanges.map(e => e.requestBody.toString()), ['', 'AAAAA', 'BBBBB'])
    assert.deepStrictEqual(stats, { exchanges: 3, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('keeps a completed redirect hop when the destination fails before sending headers', async (t) => {
    // The 302 hop is done once its response is logged. The destination job
    // then fails while connecting: its net_error events arrive while `hop`
    // would still point at the completed redirect hop, which must not be
    // marked failed and dropped.
    const events = [
      event(ST.URL_REQUEST, 530, ET.REQUEST_ALIVE, { url: 'http://example.com/redirect-me' }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 530, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'http://example.com/redirect-me' }, PHASE.PHASE_BEGIN),
      event(ST.HTTP_STREAM_JOB, 531, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.URL_REQUEST, 530, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 531, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 530, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /redirect-me HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 530, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 302 Found'] }),
      event(ST.URL_REQUEST, 530, ET.URL_REQUEST_REDIRECTED, { location: 'http://example.com/dead-end' }),
      event(ST.URL_REQUEST, 530, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'http://example.com/dead-end' }, PHASE.PHASE_BEGIN),
      // the destination job fails before any request headers are sent
      event(ST.URL_REQUEST, 530, ET.URL_REQUEST_START_JOB, { net_error: -105 }, PHASE.PHASE_END),
      event(ST.URL_REQUEST, 530, ET.REQUEST_ALIVE, { net_error: -105 }, PHASE.PHASE_END)
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => e.url), ['http://example.com/redirect-me'])
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('attaches body reads logged after the START_JOB end event', async (t) => {
    // Real captures log every event with a numeric phase resolved from
    // constants.logEventPhase, and the URL_REQUEST_START_JOB end event fires
    // once the response starts: after the response headers and before the
    // body events. The end event must not seal the hop, or every body read
    // is dropped.
    const url = 'http://example.com/page'
    const events = [
      event(ST.URL_REQUEST, 960, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 960, ET.URL_REQUEST_START_JOB, { method: 'GET', url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 960, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /page HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 960, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] }),
      event(ST.URL_REQUEST, 960, ET.URL_REQUEST_START_JOB, {}, PHASE.PHASE_END),
      event(ST.URL_REQUEST, 960, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { bytes: Buffer.from('body').toString('base64') })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 1)
    assert.strictEqual(exchanges[0].responseBody.toString(), 'body')
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('drops an exchange whose body read failed with a net_error', async (t) => {
    // The REQUEST_ALIVE end carries net_error when the job failed mid-body:
    // the hop is still in flight (only a job start seals it), so the failure
    // marks it and the truncated exchange is dropped.
    const url = 'http://example.com/truncated'
    const events = [
      event(ST.URL_REQUEST, 970, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 970, ET.URL_REQUEST_START_JOB, { method: 'GET', url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 970, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /truncated HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 970, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK', 'content-length: 100'] }),
      event(ST.URL_REQUEST, 970, ET.URL_REQUEST_START_JOB, {}, PHASE.PHASE_END),
      event(ST.URL_REQUEST, 970, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { bytes: Buffer.from('partial').toString('base64') }),
      event(ST.URL_REQUEST, 970, ET.REQUEST_ALIVE, { net_error: -354 }, PHASE.PHASE_END)
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(stats, { exchanges: 0, dropped: { failed: 1, unparsable: 0, internalRequests: 0 } })
  })

  it('does not bind a surviving request to a failed stream with identical headers', async (t) => {
    // Two identical-header POSTs share one session: the first stream fails
    // (its URL_REQUEST logs net_error), the second succeeds. The failed hop
    // never becomes an exchange, but its session header block must still be
    // consumed so the survivor binds to its own stream and body.
    const requestHeaders = [
      ':method: POST',
      ':authority: example.com',
      ':scheme: https',
      ':path: /collect',
      'content-type: text/plain'
    ]
    const failedSource = (sourceId, jobSourceId) => [
      event(ST.URL_REQUEST, sourceId, ET.REQUEST_ALIVE, { url: 'https://example.com/collect' }),
      event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'https://example.com/collect' }),
      event(ST.HTTP_STREAM_JOB, jobSourceId, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'h2' }),
      event(ST.HTTP_STREAM_JOB, jobSourceId, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.HTTP_STREAM_JOB, jobSourceId, ET.HTTP2_SESSION_POOL_IMPORTED_SESSION_FROM_SOCKET, { source_dependency: { id: 903, type: ST.HTTP2_SESSION } }),
      event(ST.URL_REQUEST, sourceId, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: jobSourceId, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: requestHeaders })
    ]
    const events = [
      // the request on stream 3 fails without a response
      ...failedSource(920, 921),
      event(ST.URL_REQUEST, 920, ET.REQUEST_ALIVE, { net_error: -324 }, PHASE.PHASE_END),
      // the request on stream 5 succeeds, body differs from the failed one
      ...failedSource(930, 931),
      event(ST.URL_REQUEST, 930, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 204'] }),
      event(ST.SOCKET, 902, ET.SSL_SOCKET_BYTES_SENT, {
        byte_count: 100,
        bytes: Buffer.concat([
          h2SentBytes(3, Buffer.from('failed-body')),
          h2SentBytes(5, Buffer.from('ok-body'), { preface: false })
        ]).toString('base64')
      }),
      event(ST.HTTP2_SESSION, 903, ET.HTTP2_SESSION_INITIALIZED, { protocol: 'h2', source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.HTTP2_SESSION, 903, ET.HTTP2_SESSION_SEND_HEADERS, { headers: requestHeaders, stream_id: 3 }),
      event(ST.HTTP2_SESSION, 903, ET.HTTP2_SESSION_SEND_HEADERS, { headers: requestHeaders, stream_id: 5 })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 1)
    assert.strictEqual(exchanges[0].requestBody.toString(), 'ok-body')
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 1, unparsable: 0, internalRequests: 0 } })
  })

  it('does not bind a surviving h1 request to a failed request with identical headers', async (t) => {
    // Two identical POST /api requests share one keep-alive socket: the
    // first fails after its response (net_error), the second succeeds. The
    // failed hop never becomes an exchange, but its request bytes are on the
    // wire: the cursor walk must consume them so the survivor matches its
    // own body.
    const line = 'POST /api HTTP/1.1\r\n'
    const headers = ['Host: example.com', 'content-length: 5']
    const sentSource = (sourceId, jobSourceId) => [
      event(ST.URL_REQUEST, sourceId, ET.REQUEST_ALIVE, { url: 'http://example.com/api' }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'http://example.com/api' }, PHASE.PHASE_BEGIN),
      event(ST.HTTP_STREAM_JOB, jobSourceId, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, jobSourceId, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 902, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, sourceId, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: jobSourceId, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line, headers }),
      event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] })
    ]
    const events = [
      // the first request fails after its response, its body was fully
      // drained and the socket reused
      ...sentSource(940, 941),
      event(ST.URL_REQUEST, 940, ET.REQUEST_ALIVE, { net_error: -330 }, PHASE.PHASE_END),
      // the identical second request on the same socket succeeds
      ...sentSource(950, 951),
      event(ST.SOCKET, 902, ET.SOCKET_BYTES_SENT, {
        byte_count: 200,
        bytes: Buffer.from(
          'POST /api HTTP/1.1\r\nHost: example.com\r\ncontent-length: 5\r\n\r\nAAAAA' +
          'POST /api HTTP/1.1\r\nHost: example.com\r\ncontent-length: 5\r\n\r\nBBBBB'
        ).toString('base64')
      })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 1)
    assert.strictEqual(exchanges[0].requestBody.toString(), 'BBBBB')
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 1, unparsable: 0, internalRequests: 0 } })
  })

  it('splits redirect hops into one exchange per URL', async (t) => {
    const firstUrl = 'http://example.com/redirect-me'
    const secondUrl = 'http://example.com/finally'
    const headers = (path) => [':method: GET', ':authority: example.com', ':scheme: http', `:path: ${path}`]
    const events = [
      event(ST.URL_REQUEST, 400, ET.REQUEST_ALIVE, { url: firstUrl }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 400, ET.URL_REQUEST_START_JOB, { method: 'GET', url: firstUrl }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: headers('/redirect-me') }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 302'] }),
      event(ST.URL_REQUEST, 400, ET.URL_REQUEST_REDIRECTED, { location: secondUrl }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, { headers: headers('/finally') }),
      event(ST.URL_REQUEST, 400, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => [e.url, e.responseCode, e.path]), [
      [firstUrl, 302, '/redirect-me'],
      [secondUrl, 200, '/finally']
    ])
    assert.deepStrictEqual(stats, { exchanges: 2, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('drops hops the browser failed with a net_error, keeping completed redirect hops', async (t) => {
    const events = []
    const addExchange = (sourceId, url, { status = 'HTTP/1.1 200 OK' } = {}) => {
      const path = new URL(url).pathname
      events.push(
        event(ST.URL_REQUEST, sourceId, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
        event(ST.URL_REQUEST, sourceId, ET.URL_REQUEST_START_JOB, { method: 'GET', url }, PHASE.PHASE_BEGIN),
        event(ST.HTTP_STREAM_JOB, sourceId + 1, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: sourceId + 1, type: ST.HTTP_STREAM_JOB } }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: `GET ${path} HTTP/1.1\r\n`, headers: ['Host: example.com'] }),
        event(ST.URL_REQUEST, sourceId, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: [status] })
      )
    }
    addExchange(500, 'http://example.com/good')
    // the START_JOB end carries net_error only when the job genuinely failed
    addExchange(510, 'http://example.com/failed')
    events.push(event(ST.URL_REQUEST, 510, ET.URL_REQUEST_START_JOB, { net_error: -354 }, PHASE.PHASE_END))
    // redirect chain: hop 1 completes (302), hop 2 is aborted by the browser
    addExchange(520, 'http://example.com/redirect-me', { status: 'HTTP/1.1 302 Found' })
    events.push(event(ST.URL_REQUEST, 520, ET.URL_REQUEST_REDIRECTED, { location: 'http://example.com/aborted' }))
    addExchange(520, 'http://example.com/aborted')
    events.push(event(ST.URL_REQUEST, 520, ET.URL_REQUEST_START_JOB, { net_error: -354 }, PHASE.PHASE_END))
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => e.url), [
      'http://example.com/good', 'http://example.com/redirect-me'
    ])
    assert.deepStrictEqual(stats, { exchanges: 2, dropped: { failed: 2, unparsable: 0, internalRequests: 0 } })
  })

  it('ignores net_error events that are not the START_JOB or REQUEST_ALIVE end', async (t) => {
    // HttpCache transactions log their own failures to the URL_REQUEST
    // source: a cache write failure after the response arrived must not drop
    // the good exchange.
    const url = 'http://example.com/cached'
    const events = [
      event(ST.URL_REQUEST, 980, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 980, ET.URL_REQUEST_START_JOB, { method: 'GET', url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 980, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /cached HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 980, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] }),
      event(ST.URL_REQUEST, 980, ET.URL_REQUEST_JOB_FILTERED_BYTES_READ, { bytes: Buffer.from('body').toString('base64') }),
      event(ST.URL_REQUEST, 980, ET.HTTP_CACHE_WRITE_DATA, { net_error: -2 }, PHASE.PHASE_END)
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.strictEqual(exchanges.length, 1)
    assert.strictEqual(exchanges[0].responseBody.toString(), 'body')
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('orders exchanges chronologically, not by first-seen source', async (t) => {
    // Request B's source is created before request A's, but A's headers hit
    // the wire first (B was still resolving): the returned order follows the
    // send-headers events, not the order the sources first appear in
    const events = [
      event(ST.URL_REQUEST, 950, ET.REQUEST_ALIVE, { url: 'http://example.com/b' }),
      event(ST.URL_REQUEST, 950, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'http://example.com/b' }),
      event(ST.URL_REQUEST, 940, ET.REQUEST_ALIVE, { url: 'http://example.com/a' }),
      event(ST.URL_REQUEST, 940, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'http://example.com/a' }),
      event(ST.URL_REQUEST, 940, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /a HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 940, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] }),
      event(ST.URL_REQUEST, 950, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /b HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 950, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => e.path), ['/a', '/b'])
    assert.deepStrictEqual(stats, { exchanges: 2, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('reports an unparsable status line through onWarning and drops the exchange', async (t) => {
    const url = 'http://example.com/garbled'
    const events = [
      event(ST.URL_REQUEST, 610, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 610, ET.URL_REQUEST_START_JOB, { method: 'GET', url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 610, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /garbled HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 610, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['garbled response', 'content-type: text/plain'] })
    ]
    const warnings = []
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events), { onWarning: warning => warnings.push(warning) })
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(warnings, [{ code: 'UNPARSABLE_STATUS', url, message: 'unparsable status line' }])
    assert.deepStrictEqual(stats, { exchanges: 0, dropped: { failed: 0, unparsable: 1, internalRequests: 0 } })
  })

  // Browser-internal fixtures from real capture shapes: an updater-style
  // request with an empty ("null null") isolation key and a Safe Browsing-style
  // request with an anonymized ("null [internally: ...]") anonymization key
  const internalKeyedSources = () => [
    // browser-internal: component-updater style request with no page frame
    event(ST.URL_REQUEST, 601, ET.REQUEST_ALIVE, { url: 'https://localhost.invalid/' }, PHASE.PHASE_BEGIN),
    event(ST.URL_REQUEST, 601, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'https://localhost.invalid/', network_isolation_key: 'null null' }, PHASE.PHASE_BEGIN),
    event(ST.URL_REQUEST, 601, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
      headers: [':method: POST', ':authority: localhost.invalid', ':scheme: https', ':path: /']
    }),
    event(ST.URL_REQUEST, 601, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 404'] }),
    // browser-internal with an 'internally' anonymization key variant
    event(ST.URL_REQUEST, 602, ET.REQUEST_ALIVE, { url: 'https://safebrowsing.example.com/list' }, PHASE.PHASE_BEGIN),
    event(ST.URL_REQUEST, 602, ET.URL_REQUEST_START_JOB, { method: 'GET', url: 'https://safebrowsing.example.com/list', network_anonymization_key: 'null [internally: ...]' }, PHASE.PHASE_BEGIN),
    event(ST.URL_REQUEST, 602, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
      headers: [':method: GET', ':authority: safebrowsing.example.com', ':scheme: https', ':path: /list']
    }),
    event(ST.URL_REQUEST, 602, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] })
  ]

  // A browser-internal streamed upload on a captured socket: its chunked
  // request body rejects the capture when the source is not dropped before
  // body correlation
  const internalChunkedUploadSource = () => [
    event(ST.URL_REQUEST, 603, ET.REQUEST_ALIVE, { url: 'https://localhost.invalid/upload' }, PHASE.PHASE_BEGIN),
    event(ST.URL_REQUEST, 603, ET.URL_REQUEST_START_JOB, { method: 'POST', url: 'https://localhost.invalid/upload', network_isolation_key: 'null null' }, PHASE.PHASE_BEGIN),
    event(ST.HTTP_STREAM_JOB, 613, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
    event(ST.HTTP_STREAM_JOB, 613, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 614, type: ST.SOCKET } }),
    event(ST.URL_REQUEST, 603, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 613, type: ST.HTTP_STREAM_JOB } }),
    event(ST.URL_REQUEST, 603, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, {
      line: 'POST /upload HTTP/1.1\r\n',
      headers: ['Host: localhost.invalid', 'transfer-encoding: chunked']
    }),
    event(ST.URL_REQUEST, 603, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] }),
    event(ST.SOCKET, 614, ET.SOCKET_BYTES_SENT, {
      byte_count: 56,
      bytes: Buffer.from('POST /upload HTTP/1.1\r\nHost: localhost.invalid\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n').toString('base64')
    })
  ]

  it('drops browser-internal traffic by default (isolation key, anonymization key, chunked upload)', async (t) => {
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, [...internalKeyedSources(), ...internalChunkedUploadSource()]))
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(stats, { exchanges: 0, dropped: { failed: 0, unparsable: 0, internalRequests: 3 } })
  })

  it('keeps browser-internal traffic when dropInternalRequests is false', async (t) => {
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, internalKeyedSources()), { dropInternalRequests: false })
    assert.deepStrictEqual(exchanges.map(e => [e.url, e.method]), [
      ['https://localhost.invalid/', 'POST'],
      ['https://safebrowsing.example.com/list', 'GET']
    ])
    assert.deepStrictEqual(stats, { exchanges: 2, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('throws on a chunked internal upload only when internal requests are kept', async (t) => {
    const netlogPath = await writeNetlog(t, internalChunkedUploadSource())
    // dropped by default, before any wire-level parsing
    const { exchanges, stats } = await parseNetLog(netlogPath)
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(stats, { exchanges: 0, dropped: { failed: 0, unparsable: 0, internalRequests: 1 } })
    // kept with the flag off: the chunked upload rejects the capture like any
    // other request
    await assert.rejects(parseNetLog(netlogPath, { dropInternalRequests: false }), {
      name: 'NetLogError',
      code: 'CHUNKED_UPLOAD',
      message: 'unexpected chunked HTTP/1 request body on https://localhost.invalid/upload: streamed uploads are not supported'
    })
  })

  it('drops a request whose anonymization key starts with null despite a real isolation key', async (t) => {
    // The isolation and anonymization keys are checked independently: a real
    // site key on one of them does not keep the request when the other one is
    // anonymized
    const url = 'https://example.com/telemetry'
    const events = [
      event(ST.URL_REQUEST, 620, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 620, ET.URL_REQUEST_START_JOB, {
        method: 'POST',
        url,
        network_isolation_key: 'https://example.com https://example.com',
        network_anonymization_key: 'null https://example.com'
      }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 620, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: POST', ':authority: example.com', ':scheme: https', ':path: /telemetry']
      }),
      event(ST.URL_REQUEST, 620, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 204'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(stats, { exchanges: 0, dropped: { failed: 0, unparsable: 0, internalRequests: 1 } })
  })

  it('drops a not-an-origin initiator with a non-navigation request_type', async (t) => {
    // spellcheck-dictionary style request: browser-issued ("not an origin"
    // initiator) non-navigation request_type
    const url = 'https://dictionary.example.com/list'
    const events = [
      event(ST.URL_REQUEST, 630, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 630, ET.URL_REQUEST_START_JOB, { method: 'GET', url, initiator: 'not an origin', request_type: 'other' }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 630, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: GET', ':authority: dictionary.example.com', ':scheme: https', ':path: /list']
      }),
      event(ST.URL_REQUEST, 630, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges, [])
    assert.deepStrictEqual(stats, { exchanges: 0, dropped: { failed: 0, unparsable: 0, internalRequests: 1 } })
  })

  it('keeps a not-an-origin initiator main-frame request', async (t) => {
    const url = 'https://example.com/refresh'
    const events = [
      event(ST.URL_REQUEST, 631, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 631, ET.URL_REQUEST_START_JOB, { method: 'GET', url, initiator: 'not an origin', request_type: 'main frame' }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 631, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: GET', ':authority: example.com', ':scheme: https', ':path: /refresh']
      }),
      event(ST.URL_REQUEST, 631, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => e.url), [url])
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('keeps a not-an-origin initiator request without a request_type', async (t) => {
    const url = 'https://example.com/probe'
    const events = [
      event(ST.URL_REQUEST, 632, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 632, ET.URL_REQUEST_START_JOB, { method: 'GET', url, initiator: 'not an origin' }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 632, ET.HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS, {
        headers: [':method: GET', ':authority: example.com', ':scheme: https', ':path: /probe']
      }),
      event(ST.URL_REQUEST, 632, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => e.url), [url])
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('keeps a request without isolation or anonymization keys', async (t) => {
    const url = 'http://example.com/plain'
    const events = [
      event(ST.URL_REQUEST, 640, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 640, ET.URL_REQUEST_START_JOB, { method: 'GET', url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 640, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, { line: 'GET /plain HTTP/1.1\r\n', headers: ['Host: example.com'] }),
      event(ST.URL_REQUEST, 640, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] })
    ]
    const { exchanges, stats } = await parseNetLog(await writeNetlog(t, events))
    assert.deepStrictEqual(exchanges.map(e => e.url), [url])
    assert.deepStrictEqual(stats, { exchanges: 1, dropped: { failed: 0, unparsable: 0, internalRequests: 0 } })
  })

  it('throws on a chunked h1 request (a streamed upload)', async (t) => {
    // Page-load traffic does not stream request bodies: a chunked request is
    // rejected outright instead of being kept with a body that cannot be
    // recovered, or seeing its upload bytes attributed to later requests on
    // the same socket
    const url = 'http://example.com/streamed-upload'
    const events = [
      event(ST.URL_REQUEST, 700, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 700, ET.URL_REQUEST_START_JOB, { method: 'POST', url }, PHASE.PHASE_BEGIN),
      event(ST.HTTP_STREAM_JOB, 701, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.HTTP_STREAM_JOB, 701, ET.SOCKET_POOL_BOUND_TO_SOCKET, { source_dependency: { id: 702, type: ST.SOCKET } }),
      event(ST.URL_REQUEST, 700, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 701, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, {
        line: 'POST /streamed-upload HTTP/1.1\r\n',
        headers: ['Host: example.com', 'transfer-encoding: chunked']
      }),
      event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] }),
      event(ST.SOCKET, 702, ET.SOCKET_BYTES_SENT, {
        byte_count: 56,
        bytes: Buffer.from('POST /streamed-upload HTTP/1.1\r\nHost: example.com\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n').toString('base64')
      })
    ]
    const netlogPath = await writeNetlog(t, events)
    await assert.rejects(parseNetLog(netlogPath), {
      name: 'NetLogError',
      code: 'CHUNKED_UPLOAD',
      message: 'unexpected chunked HTTP/1 request body on http://example.com/streamed-upload: streamed uploads are not supported'
    })
  })

  it('throws on a chunked h1 request whose wire bytes were not captured', async (t) => {
    // The socket-level walk only sees captured wire bytes; the exchange
    // construction rejects the same request from the logged headers
    const url = 'http://example.com/streamed-upload'
    const events = [
      event(ST.URL_REQUEST, 700, ET.REQUEST_ALIVE, { url }, PHASE.PHASE_BEGIN),
      event(ST.URL_REQUEST, 700, ET.URL_REQUEST_START_JOB, { method: 'POST', url }, PHASE.PHASE_BEGIN),
      event(ST.HTTP_STREAM_JOB, 701, ET.HTTP_STREAM_REQUEST_PROTO, { proto: 'http/1.1' }),
      event(ST.URL_REQUEST, 700, ET.HTTP_STREAM_REQUEST_BOUND_TO_JOB, { source_dependency: { id: 701, type: ST.HTTP_STREAM_JOB } }),
      event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_SEND_REQUEST_HEADERS, {
        line: 'POST /streamed-upload HTTP/1.1\r\n',
        headers: ['Host: example.com', 'transfer-encoding: chunked']
      }),
      event(ST.URL_REQUEST, 700, ET.HTTP_TRANSACTION_READ_RESPONSE_HEADERS, { headers: ['HTTP/1.1 200 OK'] })
    ]
    const netlogPath = await writeNetlog(t, events)
    await assert.rejects(parseNetLog(netlogPath), {
      name: 'NetLogError',
      code: 'CHUNKED_UPLOAD',
      message: 'unexpected chunked HTTP/1 request body on http://example.com/streamed-upload: streamed uploads are not supported'
    })
  })

  it('throws when the netlog carries no constants', async (t) => {
    const netlogPath = await writeRawNetlog(t, JSON.stringify({ events: [] }))
    await assert.rejects(parseNetLog(netlogPath), {
      name: 'NetLogError',
      code: 'MISSING_CONSTANTS',
      message: 'netlog is missing the event/source type or phase constants'
    })
  })

  it('throws when the events contain a non-object entry', async (t) => {
    // A null in the legacy events array must raise a NetLogError, not crash
    // with a TypeError while reading the event's source
    const netlogPath = await writeRawNetlog(t, JSON.stringify({ constants: fixtureConstants(), events: [null] }))
    await assert.rejects(parseNetLog(netlogPath), {
      name: 'NetLogError',
      code: 'INVALID',
      message: 'netlog events contain a non-object entry'
    })
  })
})

describe('isInternalRequest', () => {
  it('matches a "null"-prefixed isolation or anonymization key, independently', () => {
    assert.strictEqual(isInternalRequest({ network_isolation_key: 'null' }), true)
    assert.strictEqual(isInternalRequest({ network_isolation_key: 'null null' }), true)
    assert.strictEqual(isInternalRequest({ network_anonymization_key: 'null [internally: ...]' }), true)
    // either key alone decides
    assert.strictEqual(isInternalRequest({
      network_isolation_key: 'https://example.com https://example.com',
      network_anonymization_key: 'null https://example.com'
    }), true)
    assert.strictEqual(isInternalRequest({
      network_isolation_key: 'https://example.com https://example.com',
      network_anonymization_key: 'https://example.com https://example.com'
    }), false)
  })

  it('matches a not-an-origin initiator only with a present non-navigation request_type', () => {
    assert.strictEqual(isInternalRequest({ initiator: 'not an origin', request_type: 'other' }), true)
    assert.strictEqual(isInternalRequest({ initiator: 'not an origin', request_type: 'main frame' }), false)
    assert.strictEqual(isInternalRequest({ initiator: 'not an origin' }), false)
  })

  it('keeps requests without keys or initiator, and tolerates missing params', () => {
    assert.strictEqual(isInternalRequest({}), false)
    assert.strictEqual(isInternalRequest(undefined), false)
  })
})
