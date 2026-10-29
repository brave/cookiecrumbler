import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ET, ST, event, writeNetlog, makeExchange, decodeResponse } from './helpers/fixtures.mjs'
import { archiveFromExchanges } from '../src/archive.mjs'
import { parseNetLog } from '../src/netlog/exchanges.mjs'

// Base64 of 16 zero bytes; used where a fixed nonce must not change
const FIXED_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA=='

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
    const { exchanges, negotiatedProtocols } = await parseNetLog(netlogPath)
    const archive = archiveFromExchanges(exchanges, negotiatedProtocols, { replayNonce: FIXED_NONCE })
    const [csp] = cspValues(archive.Requests['example.com'][url][0])
    assert.strictEqual(csp, `script-src 'nonce-${FIXED_NONCE}' 'self'`)
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

  it('seeds a shadowed script-src rewrite target that wpr would relax', () => {
    // The element directive (script-src-elem 'unsafe-inline') already admits
    // the injected tag, so needsSeed is false — but wpr's rewrite target is
    // the first 'script-src'-prefixed directive, here the shadowed
    // script-src 'self', which would get 'unsafe-inline' appended at replay,
    // un-blocking the event handlers that fall back to it. Seeding the nonce
    // there is permission-neutral ('self' coexists with it, handlers stay
    // blocked since they cannot carry one) and leaves wpr's rewrite idle.
    const archive = build([exchange([['Content-Security-Policy', "script-src 'self'; script-src-elem 'unsafe-inline'"]])])
    const [csp] = cspValues(archive.Requests['example.com']['https://example.com/'][0])
    const nonce = /'nonce-([^']+)'/.exec(csp)[1]
    assert.deepStrictEqual(csp.split(';').map(directive => directive.trim()), [
      `script-src 'nonce-${nonce}' 'self'`,
      "script-src-elem 'unsafe-inline'"
    ])
  })

  it('normalizes CSP whitespace so wpr recognizes existing nonces', () => {
    // wpr splits directive tokens on literal spaces, so a tab-separated
    // nonce is invisible to it and it would rewrite the policy into one that
    // blocks the tag; browsers read any whitespace, so the value is
    // collapsed and left unseeded
    const archive = build([exchange([['Content-Security-Policy', "script-src\t'nonce-abc'"]])])
    assert.deepStrictEqual(cspValues(archive.Requests['example.com']['https://example.com/'][0]), ["script-src 'nonce-abc'"])
  })

  it('produces byte-identical archives for the same fixed replayNonce', () => {
    const exchanges = () => [exchange([
      ['Content-Security-Policy', "script-src 'self' 'unsafe-inline'; script-src-elem 'self' 'nonce-abc'"]
    ])]
    const first = archiveFromExchanges(exchanges(), new Map(), { replayNonce: FIXED_NONCE })
    const second = archiveFromExchanges(exchanges(), new Map(), { replayNonce: FIXED_NONCE })
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second))
  })
})
