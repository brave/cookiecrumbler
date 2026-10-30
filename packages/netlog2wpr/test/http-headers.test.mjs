import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalHeaderKey, splitHeaderLine, stripLineEnding, headerValue,
  parseContentLength, isChunkedTransferEncoding, parseRequestLine,
  parseRequestHeaders, parseResponseHeaders
} from '../src/netlog/http-headers.mjs'

describe('canonicalHeaderKey', () => {
  it('title-cases hyphen-separated token chars', () => {
    assert.strictEqual(canonicalHeaderKey('content-type'), 'Content-Type')
    assert.strictEqual(canonicalHeaderKey('x-FOO-bar'), 'X-Foo-Bar')
    assert.strictEqual(canonicalHeaderKey('a--b'), 'A--B')
    assert.strictEqual(canonicalHeaderKey(''), '')
  })

  it('returns non-token keys unchanged, like Go', () => {
    assert.strictEqual(canonicalHeaderKey('bad key'), 'bad key')
    assert.strictEqual(canonicalHeaderKey('a(b)'), 'a(b)')
  })
})

describe('splitHeaderLine', () => {
  it('splits at the first colon and trims both parts', () => {
    assert.deepStrictEqual(splitHeaderLine('a: b'), ['a', 'b'])
    assert.deepStrictEqual(splitHeaderLine('a : b '), ['a', 'b'])
  })

  it('keeps colons in the value', () => {
    assert.deepStrictEqual(splitHeaderLine('a:b:c'), ['a', 'b:c'])
  })

  it('returns null without a colon', () => {
    assert.strictEqual(splitHeaderLine('no colon'), null)
  })
})

describe('stripLineEnding', () => {
  it('strips CRLF and LF endings once', () => {
    assert.strictEqual(stripLineEnding('GET / HTTP/1.1\r\n'), 'GET / HTTP/1.1')
    assert.strictEqual(stripLineEnding('GET / HTTP/1.1\n'), 'GET / HTTP/1.1')
    assert.strictEqual(stripLineEnding('GET / HTTP/1.1'), 'GET / HTTP/1.1')
  })
})

describe('headerValue', () => {
  it('returns the first matching value, canonical compare', () => {
    assert.strictEqual(headerValue(['content-length: 10', 'content-length: 99'], 'Content-Length'), '10')
    assert.strictEqual(headerValue(['transfer-encoding: chunked'], 'TRANSFER-ENCODING'), 'chunked')
    assert.strictEqual(headerValue(['a: b'], 'b'), null)
  })
})

describe('parseContentLength', () => {
  it('accepts digits only', () => {
    assert.strictEqual(parseContentLength('10'), 10)
    assert.strictEqual(parseContentLength(' 10 '), 10)
    assert.strictEqual(parseContentLength('0'), 0)
  })

  it('rejects anything else', () => {
    assert.strictEqual(parseContentLength('10abc'), null)
    assert.strictEqual(parseContentLength('-1'), null)
    assert.strictEqual(parseContentLength('1e3'), null)
    assert.strictEqual(parseContentLength(''), null)
    // Chromium rejects mismatched duplicate Content-Length headers itself,
    // so a comma list is never a valid length
    assert.strictEqual(parseContentLength('10, 10'), null)
    assert.strictEqual(parseContentLength(null), null)
  })
})

describe('isChunkedTransferEncoding', () => {
  it('checks the last coding of the list', () => {
    assert.strictEqual(isChunkedTransferEncoding('chunked'), true)
    assert.strictEqual(isChunkedTransferEncoding('Chunked'), true)
    assert.strictEqual(isChunkedTransferEncoding('gzip, chunked'), true)
    assert.strictEqual(isChunkedTransferEncoding('chunked, gzip'), false)
    assert.strictEqual(isChunkedTransferEncoding('notchunked'), false)
    assert.strictEqual(isChunkedTransferEncoding(null), false)
  })
})

describe('parseRequestLine', () => {
  it('parses origin-form lines', () => {
    assert.deepStrictEqual(parseRequestLine('GET /a HTTP/1.1'), { method: 'GET', target: '/a', version: 'HTTP/1.1' })
  })

  it('parses absolute-form lines (proxy recording)', () => {
    assert.deepStrictEqual(parseRequestLine('GET http://x/a HTTP/1.1'), { method: 'GET', target: 'http://x/a', version: 'HTTP/1.1' })
  })

  it('parses HTTP/1.0', () => {
    assert.deepStrictEqual(parseRequestLine('GET / HTTP/1.0').version, 'HTTP/1.0')
  })

  it('returns null for garbage', () => {
    assert.strictEqual(parseRequestLine('GET /'), null)
    assert.strictEqual(parseRequestLine('HTTP/1.1 200 OK'), null)
    assert.strictEqual(parseRequestLine(''), null)
  })
})

describe('parseRequestHeaders', () => {
  it('parses h2 pseudo-headers and drops :scheme', () => {
    const parsed = parseRequestHeaders([
      ':method: POST',
      ':authority: example.com',
      ':scheme: https',
      ':path: /collect',
      'content-type: text/plain'
    ])
    assert.strictEqual(parsed.method, 'POST')
    assert.strictEqual(parsed.path, '/collect')
    assert.strictEqual(parsed.authority, 'example.com')
    assert.deepStrictEqual(parsed.entries, [['Content-Type', 'text/plain']])
  })

  it('parses h1 Host', () => {
    const parsed = parseRequestHeaders(['Host: example.com', 'Accept: */*'])
    assert.strictEqual(parsed.authority, 'example.com')
    assert.deepStrictEqual(parsed.entries, [['Accept', '*/*']])
  })

  it('prefers :authority over Host when both are present (RFC 9113)', () => {
    const parsed = parseRequestHeaders([
      ':authority: pseudo.example.com',
      ':method: GET',
      ':path: /',
      'host: h1.example.com'
    ])
    assert.strictEqual(parsed.authority, 'pseudo.example.com')
  })

  it('reports Content-Length and Transfer-Encoding in fields but excludes them from entries', () => {
    const parsed = parseRequestHeaders([
      ':method: POST',
      ':authority: example.com',
      ':path: /',
      'content-length: 7',
      'transfer-encoding: chunked',
      'content-type: text/plain'
    ])
    assert.strictEqual(parsed.contentLength, 7)
    assert.strictEqual(parsed.chunked, true)
    assert.deepStrictEqual(parsed.entries, [['Content-Type', 'text/plain']])
  })

  it('extracts User-Agent', () => {
    const parsed = parseRequestHeaders(['User-Agent: UA/1.0'])
    assert.strictEqual(parsed.userAgent, 'UA/1.0')
    assert.deepStrictEqual(parsed.entries, [])
  })

  it('preserves header order in entries', () => {
    const parsed = parseRequestHeaders(['accept: text/html', 'accept-encoding: gzip', 'x-b: 2'])
    assert.deepStrictEqual(parsed.entries, [['Accept', 'text/html'], ['Accept-Encoding', 'gzip'], ['X-B', '2']])
  })
})

describe('parseResponseHeaders', () => {
  it('parses Chromium\'s h2 form without a reason phrase', () => {
    assert.deepStrictEqual(parseResponseHeaders(['HTTP/1.1 200', 'content-type: text/html']), {
      statusLine: 'HTTP/1.1 200',
      code: 200,
      contentLength: null,
      chunked: false,
      entries: [['Content-Type', 'text/html']]
    })
  })

  it('parses a reason phrase', () => {
    const parsed = parseResponseHeaders(['HTTP/1.1 404 Not Found'])
    assert.strictEqual(parsed.code, 404)
    assert.strictEqual(parsed.statusLine, 'HTTP/1.1 404 Not Found')
  })

  it('parses Content-Length and chunked', () => {
    const parsed = parseResponseHeaders(['HTTP/1.1 200 OK', 'content-length: 10', 'transfer-encoding: gzip, chunked'])
    assert.strictEqual(parsed.contentLength, 10)
    assert.strictEqual(parsed.chunked, true)
    assert.deepStrictEqual(parsed.entries, [])
  })

  it('returns null for garbage and empty lists', () => {
    assert.strictEqual(parseResponseHeaders(['garbage']), null)
    assert.strictEqual(parseResponseHeaders(['HTTP/x 200']), null)
    assert.strictEqual(parseResponseHeaders([]), null)
  })
})
