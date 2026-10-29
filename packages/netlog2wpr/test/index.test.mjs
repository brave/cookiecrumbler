import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ET, ST, event, writeNetlog } from './helpers/fixtures.mjs'
import { netlogToWprArchive } from '../src/index.mjs'

describe('netlog to WprGo archive conversion', () => {
  it('converts a netlog into a WprGo archive with stats and warnings', async (t) => {
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
    const { archive, stats, warnings } = await netlogToWprArchive(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']), [url])
    assert.strictEqual(stats.hosts, 1)
    assert.strictEqual(stats.exchanges, 1)
    assert.deepStrictEqual(stats.dropped, { failed: 0, unparsable: 0, internalRequests: 0, truncatedBodies: 0 })
    assert.deepStrictEqual(warnings, [])
  })

  it('throws when the netlog contains no recorded requests', async (t) => {
    const netlogPath = await writeNetlog(t, [])
    await assert.rejects(netlogToWprArchive(netlogPath), { name: 'NetLogError', message: 'netlog contains no recorded requests', code: 'NO_REQUESTS' })
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
    await assert.rejects(netlogToWprArchive(netlogPath), { name: 'NetLogError', message: 'every recorded request was dropped as unreplayable', code: 'ALL_DROPPED' })
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
    const { archive } = await netlogToWprArchive(netlogPath)
    assert.deepStrictEqual(Object.keys(archive.Requests), ['example.com'])
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']), [firstUrl, secondUrl])
    assert.strictEqual(archive.Requests['example.com'][firstUrl][0].SerializedResponse, Buffer.from([
      'HTTP/2.0 302 Found',
      'Connection: close',
      '',
      ''
    ].join('\r\n')).toString('base64'))
  })

  it('collects warnings in the returned array and forwards them to onWarning', async (t) => {
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
    addExchange(1500, 'http://example.com/good')
    // aborted transfer: headers logged a 10-byte body, only 5 bytes recovered
    addExchange(1510, 'http://example.com/short', { contentLength: 10, body: 'short' })
    const netlogPath = await writeNetlog(t, events)
    const forwarded = []
    const { archive, stats, warnings } = await netlogToWprArchive(netlogPath, {
      onWarning: (warning) => forwarded.push(warning)
    })
    const expected = [{
      code: 'TRUNCATED_BODY',
      url: 'http://example.com/short',
      message: 'logged Content-Length 10 does not match the 5 byte recovered body'
    }]
    assert.deepStrictEqual(warnings, expected)
    assert.deepStrictEqual(forwarded, expected)
    assert.deepStrictEqual(Object.keys(archive.Requests['example.com']), ['http://example.com/good'])
    assert.strictEqual(stats.dropped.truncatedBodies, 1)
  })
})
