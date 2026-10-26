// WprGo archive writing: converts reconstructed HTTP exchanges (see
// netlog/index.mjs) into a WebPageReplay record archive. Messages are serialized
// exactly like wpr's Go code does: SerializedRequest is Go's
// http.Request.Write output (request line, Host, User-Agent, Content-Length,
// sorted headers, body) and SerializedResponse is Go's http.Response.Write
// output (status line, Content-Length when known or Connection: close when
// the length is unknown, sorted headers, still-content-encoded body). Before
// serialization, the Content-Security-Policy headers of HTML 200 responses
// are seeded with a replay nonce so that wpr's replay-time script injection
// is authorized without wpr's 'unsafe-inline' fallback (see
// seedCspReplayNonce). Deliberate divergences from wpr record: a
// Content-Length logged on a bodyless status is kept, where Go's resp.Write
// would drop it (see declaredResponseLength); enforced CSP values are
// normalized for wpr's parser (whitespace, keyword case, duplicate
// directives, comma-separated policies become their own header entries);
// directives whose recorded inline permissions a seeded nonce would revoke
// are mirrored into explicit script-src-attr / style-src directives.

import crypto from 'node:crypto'

import { NetLogError, buildExchangesFromNetLog } from './netlog/index.mjs'

// Canonical reason phrases, copied from Go's net/http StatusText
// (src/net/http/status.go): the netlog omits them for HTTP/2 status lines,
// and wpr replays exactly what resp.Write derived from Go's Status.
const HTTP_REASONS = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Request Entity Too Large',
  414: 'Request URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Requested Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required'
}

// Sort by canonical name byte-wise; ties keep wire order (stable sort).
// Returns "Name: value" strings without line endings.
const sortedHeaderLines = (entries) => {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byName = a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : 0
      return byName !== 0 ? byName : a.index - b.index
    })
    .map(({ entry }) => `${entry[0]}: ${entry[1]}`)
}

// Frames a body with chunked transfer encoding like Go's resp.Write; empty
// bodies get only the terminal chunk.
const chunkedBody = (body) => {
  const chunks = body.length === 0
    ? [Buffer.from('0\r\n\r\n')]
    : [Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n0\r\n\r\n')]
  return Buffer.concat(chunks)
}

/**
 * How the serialized response delimits its body (mirrors Go's resp.Write):
 * 'chunked' re-frames the de-chunked body with Transfer-Encoding: chunked and
 * takes priority over a logged Content-Length (Chromium and Go's
 * http.ReadResponse both frame by Transfer-Encoding when a response carries
 * both); 'length' declares Content-Length; 'close' is an h2 response with
 * unknown length, delimited by Connection: close; 'eof' is an h1 response
 * with unknown length, also delimited by Connection: close (Go sets Close
 * and keeps the logged HTTP/1.x version); 'none' is a known zero length
 * (Content-Length: 0 on a body-allowed status) or a no-body status such as
 * 204/304, which serializes no framing header.
 * @typedef {{ kind: 'length', length: number } | { kind: 'chunked' } | { kind: 'close' } | { kind: 'eof' } | { kind: 'none' }} ResponseFraming
 */

/**
 * Content-Length the archive must declare, or null when unknown. Chromium
 * accepts h2 bodies shorter than the logged header (END_STREAM frames them),
 * so for h2 the recovered length is authoritative. The same holds for a
 * followed h1 redirect: the browser never reads the redirect body, so the
 * recovered length is all the archive can frame the response by (see
 * isTruncatedHttp1Body).
 *
 * A logged length is declared even for bodyless statuses (1xx/204/304),
 * unlike Go's resp.Write: its ReadResponse zeroes the ContentLength field of
 * those statuses and its write path excludes the Content-Length header, so
 * wpr record archives them without the line. The netlog logged what the
 * server actually sent: the value is RFC 9110-permitted revalidation
 * metadata, the replaying browser ignores it for framing, and dropping it
 * would discard recorded information, so the logged value is kept. HEAD
 * responses are the same case for Go, which preserves their ContentLength
 * field, so no divergence exists there.
 * @returns {number|null}
 */
const declaredResponseLength = (exchange) => {
  if (exchange.responseContentLength === null) return null
  if (!exchange.isHttp1 && expectsResponseBody(exchange)) return exchange.responseBody.length
  if (isRedirect(exchange) && expectsResponseBody(exchange) &&
    exchange.responseContentLength !== exchange.responseBody.length) {
    return exchange.responseBody.length
  }
  return exchange.responseContentLength
}

/** @returns {ResponseFraming} */
const responseFraming = (exchange) => {
  if (exchange.responseChunked) return { kind: 'chunked' }
  const length = declaredResponseLength(exchange)
  if (length !== null && length > 0) return { kind: 'length', length }
  if (length === null) {
    // An unknown length only delimits a body on a body-allowed status: wpr's
    // Go ReadResponse gives no-body statuses (HEAD/204/304) a zero length and
    // Close=false, so they serialize without any framing header.
    if (!expectsResponseBody(exchange)) return { kind: 'none' }
    return exchange.isHttp1 ? { kind: 'eof' } : { kind: 'close' }
  }
  return { kind: 'none' }
}

/** @param {ResponseFraming} framing @returns {string|null} */
const framingHeader = (framing, exchange) => {
  switch (framing.kind) {
    case 'length': return `Content-Length: ${framing.length}`
    case 'chunked': return 'Transfer-Encoding: chunked'
    case 'close': return 'Connection: close'
    // Go marks an EOF-delimited body by setting Close: the status line keeps
    // its logged HTTP/1.x version and resp.Write emits Connection: close.
    case 'eof': return 'Connection: close'
    // A known zero length on a body-allowed status writes Content-Length: 0;
    // no-body statuses carry no framing header at all.
    case 'none': return expectsResponseBody(exchange) ? 'Content-Length: 0' : null
  }
}

/**
 * Serializes a request the way Go's http.Request.Write does (the format wpr
 * stores as SerializedRequest).
 */
const serializeRequest = (exchange) => {
  const lines = []
  if (exchange.isHttp1) {
    lines.push(exchange.requestLine)
  } else {
    lines.push(`${exchange.method} ${exchange.path ?? '/'} HTTP/1.1`)
  }
  lines.push(`Host: ${exchange.authority}`)
  if (exchange.userAgent !== null) {
    lines.push(`User-Agent: ${exchange.userAgent}`)
  }
  // Go's transferWriter: Content-Length when the length is known and > 0,
  // or when a POST/PUT/PATCH carries a zero length. Chunked h1 requests are
  // not recovered (see the parser): Chromium does not send them, so no
  // Transfer-Encoding branch is needed here.
  const bodyLength = exchange.requestBody.length
  const lengthBearing = ['POST', 'PUT', 'PATCH'].includes(exchange.method)
  const hasLength = bodyLength > 0 || (exchange.requestContentLength === 0 && lengthBearing)
  if (hasLength) {
    lines.push(`Content-Length: ${bodyLength}`)
  }
  lines.push(...sortedHeaderLines(exchange.requestEntries))
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)
  return Buffer.concat([head, exchange.requestBody])
}

/**
 * Serializes a response the way Go's http.Response.Write does.
 */
const serializeResponse = (exchange) => {
  const framing = responseFraming(exchange)
  let statusLine
  if (exchange.isHttp1) {
    // HTTP/1.x: keep the logged status line (Go does not downgrade
    // EOF-delimited responses to HTTP/1.0; it sets Close instead)
    statusLine = exchange.responseStatusLine ?? ''
  } else {
    // Go's h2 transport builds resp.Status from the raw :status pseudo-header
    // value plus " " + StatusText(code) ("599 " for an unknown code), and
    // Response.Write derives the reason text by trimming "<code> " from
    // Status: an unknown code therefore serializes as "HTTP/2.0 599 " (with
    // the trailing space from the %03d %s status-line format), matching
    // exactly what wpr record would have stored.
    const reason = HTTP_REASONS[exchange.responseCode]
    statusLine = `HTTP/2.0 ${exchange.responseCode} ${reason ?? ''}`
  }
  const lines = [statusLine]
  const framingHeaderValue = framingHeader(framing, exchange)
  if (framingHeaderValue !== null) lines.push(framingHeaderValue)
  lines.push(...sortedHeaderLines(exchange.responseEntries))
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)
  // The body framing follows the same kind the head was built from: a chunked
  // response is re-chunked even when a Content-Length was also logged.
  if (framing.kind === 'chunked') {
    // Re-frame the de-chunked body exactly like Go's resp.Write
    return Buffer.concat([head, chunkedBody(exchange.responseBody)])
  }
  return Buffer.concat([head, exchange.responseBody])
}

// CSP directive tokens as browsers read them: whitespace-separated, with
// case-insensitive names and keyword spellings (CSP spec). wpr's
// transformers.go splits values on literal spaces and matches lowercase
// prefixes, so values are normalized before any directive reasoning (see
// normalizeScriptDirective).
const cspDirectiveTokens = (directive) => directive.trim().split(/\s+/).filter(Boolean)

const cspDirectiveName = (directive) => cspDirectiveTokens(directive)[0]?.toLowerCase() ?? ''

// 'script-src' also prefix-matches script-src-elem/script-src-attr, exactly
// like wpr's HasPrefix(directive, "script-src") checks
const isScriptDirectiveName = (name) => name === 'default-src' || name.startsWith('script-src')

const cspHasUnsafeInline = (directive) => cspDirectiveTokens(directive).some(token => token.toLowerCase() === "'unsafe-inline'")

const cspHasSha = (directive) => cspDirectiveTokens(directive).some(token => /^'sha(?:256|384|512)-/i.test(token))

const cspHasNonce = (directive) => cspDirectiveTokens(directive).some(token => /^'nonce-/i.test(token))

/**
 * Lowercases the spellings wpr pattern-matches in a script-governing
 * directive: its name ('script-src*' / 'default-src') and the keyword tokens
 * it compares against ('none', 'unsafe-inline', the 'nonce-' and
 * 'sha256-…' prefixes). Browsers read all of these case-insensitively while
 * wpr matches lowercase literals, so the normalized form is what wpr can
 * recognize (CSP keyword values like the nonce base64 keep their case). The
 * directive's leading/trailing whitespace is preserved.
 */
const normalizeScriptDirective = (directive) => {
  const body = cspDirectiveTokens(directive).map((token, index) => {
    if (index === 0) return token.toLowerCase()
    if (/^'nonce-/i.test(token)) return `'nonce-${token.slice("'nonce-".length)}`
    if (/^'sha(?:256|384|512)-/i.test(token)) {
      const dash = token.indexOf('-')
      return token.slice(0, dash + 1).toLowerCase() + token.slice(dash + 1)
    }
    if (/^'(?:unsafe-inline|none)'$/i.test(token)) return token.toLowerCase()
    return token
  }).join(' ')
  return directive.slice(0, directive.length - directive.trimStart().length) + body +
    directive.slice(directive.trimEnd().length)
}

/**
 * Splits an enforced CSP value into its policies' directive lists. A value
 * may carry comma-separated policies, which browsers enforce as separate
 * policies while wpr's transformers treat the whole value as one
 * semicolon-split blob — a nonce on the first comma-policy would leave the
 * others blocking wpr's injected script. Each policy becomes its own header
 * entry, and within a policy whitespace runs collapse to single spaces
 * (browsers read any whitespace; wpr splits on literal ones).
 * @param {string} value
 * @returns {string[][]} one directive list per policy
 */
const parseCspPolicies = (value) => value.replace(/\s+/g, ' ').split(',')
  .map(policy => policy.split(';').filter(directive => directive.trim() !== ''))
  .filter(policy => policy.length > 0)
  .map(policy => policy.map(directive => isScriptDirectiveName(cspDirectiveName(directive))
    ? normalizeScriptDirective(directive)
    : directive))

/**
 * Seeds the enforced Content-Security-Policy headers of an HTML 200 exchange
 * with a fresh nonce so that wpr's replay-time script injection is
 * authorized without wpr relaxing the site's policy. Returns the (possibly
 * new) entries array; the input is never written to, and values already in
 * canonical form come back byte-identical.
 *
 * At replay, wpr injects deterministic.js into every archived HTML 200
 * response and rewrites the served CSP: its transformers pick the first
 * 'script-src'-prefixed directive of the first CSP header (falling back to
 * the header's last 'default-src') as both the nonce source for the injected
 * tag and the rewrite target, and a target carrying neither a nonce nor a
 * hash gets 'unsafe-inline' appended — un-blocking the site's own inline
 * scripts that the live site (and this recording) blocked. When the archived
 * headers instead carry a nonce on that directive, wpr copies it onto the
 * injected tag and leaves the policy intact, so only the injected script
 * gains permission and CSP-blocked site scripts stay blocked on both sides
 * of record/replay.
 *
 * The reasoning runs per policy on two directives:
 *
 * - the element directive governing wpr's <script> element, resolved along
 *   the script-src-elem → script-src → default-src fallback chain. A
 *   shadowed script-src never applies to elements, and script-src-attr only
 *   governs event handlers, so neither triggers seeding on its own.
 * - wpr's directive, which must both carry the nonce and govern the tag.
 *
 * Seeding is needed when some policy's element directive blocks the tag. It
 * is permission-neutral for the site: the added nonce matches nothing the
 * site ships, and a directive admitting inline scripts via 'unsafe-inline'
 * keeps its original bytes unless another enforced policy blocks arbitrary
 * inline scripts anyway (the conjunction already blocked them at record
 * time, and wpr then needs the nonce from the first script-governing
 * directive to tag its script).
 *
 * Seeding is permission-neutral for inline event handlers too: an attribute
 * directive admitting handlers is never seeded (the nonce would revoke its
 * 'unsafe-inline'), and a seeded directive that served as the handlers'
 * fallback (script-src, or default-src where the policy has no script-src)
 * has its original form copied verbatim into an explicit script-src-attr
 * appended to the policy. The same mirroring keeps a seeded default-src from
 * revoking recorded inline-style permissions through an explicit style-src.
 * The copies are a deliberate byte divergence from wpr record, which
 * archives neither. Since the appended attribute directive would otherwise
 * become wpr's nonce source without carrying a nonce, the element-governing
 * directive is moved ahead of it (or an explicit seeded script-src is
 * inserted before it) — directive order is insignificant to browsers.
 */
const seedCspReplayNonce = (exchange, nonce) => {
  if (exchange.responseCode !== 200) return exchange.responseEntries
  const contentType = exchange.responseEntries.find(([name]) => name === 'Content-Type')
  if (contentType === undefined || !contentType[1].toLowerCase().startsWith('text/html')) return exchange.responseEntries
  const cspIndexes = []
  exchange.responseEntries.forEach(([name], index) => {
    if (name === 'Content-Security-Policy') cspIndexes.push(index)
  })
  if (cspIndexes.length === 0) return exchange.responseEntries

  const nonceToken = `'nonce-${nonce}'`
  const hasOurNonce = (directive) => cspDirectiveTokens(directive).includes(nonceToken)
  // Mutable directive lists per enforced header, one per comma-separated policy
  const cspPolicies = cspIndexes.map(index => parseCspPolicies(exchange.responseEntries[index][1]))

  // wpr reads only the first CSP header (Go's Header.Get): its nonce source
  // and rewrite target come from the first policy's wpr directive
  const wprDirectiveIndex = (directives) => {
    const script = directives.findIndex(directive => cspDirectiveName(directive).startsWith('script-src'))
    if (script !== -1) return script
    return directives.map(cspDirectiveName).lastIndexOf('default-src')
  }
  const firstPolicy = cspPolicies[0]?.[0]
  let tagSource = null
  if (firstPolicy !== undefined) {
    const index = wprDirectiveIndex(firstPolicy)
    if (index !== -1) tagSource = { directives: firstPolicy, index }
  }

  // The directive governing <script> elements: the script-src-elem →
  // script-src → default-src fallback chain (CSP effective-directive rules)
  const elementDirectiveIndex = (directives) => {
    const names = directives.map(cspDirectiveName)
    for (const name of ['script-src-elem', 'script-src', 'default-src']) {
      const index = names.indexOf(name)
      if (index !== -1) return index
    }
    return -1
  }
  const isTagSource = (directives, index) =>
    tagSource !== null && directives === tagSource.directives && index === tagSource.index

  // Whether the directive admits wpr's injected <script> element. The tag
  // carries the tag source's own nonce (wpr copies the first nonce it finds)
  // or wpr's script hash (appended to its sha-carrying rewrite target), so
  // the tag source admits the tag through either; every other directive must
  // carry our replay nonce or admit arbitrary inline scripts.
  const admitsTag = (directives, index) => {
    const directive = directives[index]
    if (hasOurNonce(directive) || cspHasUnsafeInline(directive)) return true
    return isTagSource(directives, index) && (cspHasNonce(directive) || cspHasSha(directive))
  }

  const seed = ({ directives, index }) => {
    const original = cspDirectiveTokens(directives[index])
    const kept = original.filter(token => token.toLowerCase() !== "'none'")
    if (!kept.includes(nonceToken)) kept.splice(1, 0, nonceToken)
    directives[index] = kept.join(' ')
    // The added nonce makes browsers ignore 'unsafe-inline' in the seeded
    // directive, revoking the inline permissions it granted as a fallback.
    // Mirror the original into explicit sub-directives so the recorded
    // permissions survive: script-src-attr for event handlers and style-src
    // for inline styles. script-src-elem never governs either, so seeding it
    // adds no mirror; a directive that already carried a nonce or a hash had
    // its 'unsafe-inline' ignored before seeding too.
    const revokesUnsafeInline = cspHasUnsafeInline(original.join(' ')) &&
      !cspHasNonce(original.join(' ')) && !cspHasSha(original.join(' '))
    if (!revokesUnsafeInline) return
    const name = original[0].toLowerCase()
    const names = directives.map(cspDirectiveName)
    if (name === 'default-src') {
      if (!names.includes('style-src')) directives.push(`style-src ${original.slice(1).join(' ')}`)
      if (!names.includes('script-src') && !names.includes('script-src-attr')) {
        directives.push(`script-src-attr ${original.slice(1).join(' ')}`)
      }
    } else if (name === 'script-src' && !names.includes('script-src-attr')) {
      directives.push(`script-src-attr ${original.slice(1).join(' ')}`)
    }
  }

  const needsSeed = cspPolicies.some(policies => policies.some(directives => {
    const index = elementDirectiveIndex(directives)
    return index !== -1 && !admitsTag(directives, index)
  }))

  if (needsSeed && tagSource !== null) {
    // Seeding the tag source puts our nonce first, so wpr tags its injected
    // script with it; the conjunction already blocked what it admits at
    // record time (needsSeed means some enforced policy blocks the tag). An
    // attribute directive admitting inline handlers is never seeded — the
    // nonce would revoke its 'unsafe-inline' — so the post-pass below moves
    // the element-governing directive ahead of it instead.
    const directive = tagSource.directives[tagSource.index]
    if (!(cspDirectiveName(directive) === 'script-src-attr' && cspHasUnsafeInline(directive))) {
      seed(tagSource)
    }
    // Every policy's element directive must admit the seeded tag: a foreign
    // nonce would block it (ours coexists with the site's), a blocking one
    // would be relaxed by wpr. Directives already admitting arbitrary inline
    // scripts are left alone — seeding would revoke that permission.
    cspPolicies.forEach(policies => policies.forEach(directives => {
      const index = elementDirectiveIndex(directives)
      if (index === -1) return
      const directive = directives[index]
      if (hasOurNonce(directive) || cspHasUnsafeInline(directive)) return
      seed({ directives, index })
    }))
  }

  // wpr's rewrite target can itself be a script-src-attr directive (its name
  // starts with 'script-src'): a target carrying neither a nonce, a hash nor
  // 'unsafe-inline' would get 'unsafe-inline' appended at replay, un-blocking
  // handlers the recording had blocked. Seed the replay nonce into such
  // targets to leave wpr's rewrite idle — handler attributes can never carry
  // a nonce, so the policy keeps blocking handlers exactly as before. This
  // runs whether or not needsSeed: when the element directives already admit
  // the tag, the attribute target is the only thing wpr would still relax.
  // These directives don't govern the injected tag, so they are not seeded
  // as element directives.
  cspPolicies.forEach(policies => policies.forEach(directives => {
    const index = wprDirectiveIndex(directives)
    if (index === -1) return
    const directive = directives[index]
    if (cspDirectiveName(directive) !== 'script-src-attr') return
    if (cspHasNonce(directive) || cspHasSha(directive) || cspHasUnsafeInline(directive)) return
    seed({ directives, index })
  }))

  // Make wpr's nonce source element-governing: after seeding, the first
  // 'script-src'-prefixed directive must carry our nonce for the tag to be
  // admitted, and an attribute directive never does (it only carries one
  // when seeded above, which never applies here). When a seeded element
  // directive is shadowed behind a nonce-less script-src-attr — a
  // pre-existing one admitting handlers, or the mirror appended by seed() —
  // move the element directive ahead of it, or insert an explicit seeded
  // script-src cloned from the seeded default-src where the policy has no
  // script-src of its own. Without this, wpr would read its nonce from the
  // attribute directive, find none, and its injected script would stay
  // blocked.
  cspPolicies.forEach(policies => policies.forEach(directives => {
    if (!directives.some(hasOurNonce)) return
    const first = directives.findIndex(directive => cspDirectiveName(directive).startsWith('script-src'))
    if (first === -1 || cspDirectiveName(directives[first]) !== 'script-src-attr') return
    if (hasOurNonce(directives[first])) return
    const elem = elementDirectiveIndex(directives)
    if (elem === -1 || !hasOurNonce(directives[elem])) return
    if (cspDirectiveName(directives[elem]) === 'default-src') {
      directives.splice(first, 0, `script-src ${cspDirectiveTokens(directives[elem]).slice(1).join(' ')}`)
    } else {
      const [elementDirective] = directives.splice(elem, 1)
      directives.splice(directives.findIndex(directive => cspDirectiveName(directive) === 'script-src-attr'), 0, elementDirective)
    }
  }))

  // Rebuild the entries: each comma-separated policy becomes its own header
  // entry, all other entries (and their tuples) are reused as-is. Untouched
  // values come back byte-identical.
  const rebuilt = exchange.responseEntries.flatMap((entry, index) => {
    const cspIndex = cspIndexes.indexOf(index)
    if (cspIndex === -1) return [entry]
    return cspPolicies[cspIndex].map(directives => [entry[0], directives.join(';')])
  })
  const unchanged = rebuilt.length === exchange.responseEntries.length && rebuilt.every((entry, index) => {
    const original = exchange.responseEntries[index]
    return entry === original || (entry[0] === original[0] && entry[1] === original[1])
  })
  return unchanged ? exchange.responseEntries : rebuilt
}

// HEAD, 204 and 304 responses carry no body even when a length is logged
const expectsResponseBody = (exchange) =>
  exchange.method !== 'HEAD' && exchange.responseCode !== 204 && exchange.responseCode !== 304

// A successful 3xx hop: Chromium follows the Location without reading the
// redirect body, so the hop completes with an empty recovered body no matter
// what Content-Length was logged
const isRedirect = (exchange) => exchange.responseCode >= 300 && exchange.responseCode < 400

// An aborted transfer recovers a body shorter than the logged
// Content-Length. Exchanges are dropped exactly where the browser itself
// fails them with an explicit error, which is a property of the transfer
// framing: HTTP/1.x frames the body by counting Content-Length bytes, so
// a connection close before that count makes the browser fail the request
// with ERR_CONTENT_LENGTH_MISMATCH (http_stream_parser.cc), and a
// truncated chunked body fails with ERR_INCOMPLETE_CHUNKED_ENCODING.
// Chromium's HTTP/2 stack has no such check: the response is framed by
// END_STREAM, so a stream ending cleanly with fewer DATA bytes than
// Content-Length is accepted (IsResponseBodyComplete() is just
// stream_closed_), and the exchange is kept as-is.
// Chunked and EOF-delimited HTTP/1.x bodies are delimited without a
// length, and HEAD/204/304 responses carry no body even when a length is
// logged. A followed redirect is a successful hop, not a failed transfer:
// the browser never reads its body, so the mismatch only means the
// recovered length frames the archived response (see
// declaredResponseLength).
const isTruncatedHttp1Body = (exchange) =>
  exchange.isHttp1 &&
  !exchange.responseChunked &&
  expectsResponseBody(exchange) &&
  exchange.responseContentLength !== null &&
  exchange.responseContentLength !== exchange.responseBody.length &&
  !isRedirect(exchange)

/**
 * Builds a WprGo archive object (see Archive in webpagereplay's archive.go)
 * from reconstructed exchanges. Fields follow the struct order so the output
 * matches archives written by wpr record.
 *
 * Note: Certs is left empty; netlog-recorded archives cannot carry wpr-minted
 * certificates, so replay mints fresh ones per host (the check browser trusts
 * them via --ignore-certificate-errors-spki-list).
 *
 * @param {object[]} exchanges
 * @param {Map<string, string>} negotiatedProtocols
 * @param {object} [options]
 * @param {object} [options.injectedScripts]
 * @param {number} [options.deterministicTimeSeedMs]
 * @param {string} [options.replayNonce] base64 CSP replay nonce; a fresh
 *   random one is generated when omitted
 */
export const archiveFromExchanges = (exchanges, negotiatedProtocols, { injectedScripts = {}, deterministicTimeSeedMs = 0, replayNonce = crypto.randomBytes(16).toString('base64') } = {}) => {
  const seeded = exchanges.map(exchange => ({ ...exchange, responseEntries: seedCspReplayNonce(exchange, replayNonce) }))
  const requests = new Map() // authority -> Map(url -> [message])
  for (const exchange of seeded) {
    // Aborted transfers are dropped exactly where the browser itself fails
    // them; see isTruncatedHttp1Body.
    if (isTruncatedHttp1Body(exchange)) {
      console.warn(`Skipping ${exchange.url}: logged Content-Length ${exchange.responseContentLength} does not match the ${exchange.responseBody.length} byte recovered body`)
      continue
    }
    const message = {
      SerializedRequest: serializeRequest(exchange).toString('base64'),
      SerializedResponse: serializeResponse(exchange).toString('base64'),
      LastServedSessionId: 0
    }
    let urlMap = requests.get(exchange.authority)
    if (urlMap === undefined) requests.set(exchange.authority, urlMap = new Map())
    const messages = urlMap.get(exchange.url)
    if (messages === undefined) {
      urlMap.set(exchange.url, [message])
    } else {
      messages.push(message)
    }
  }

  return {
    Requests: Object.fromEntries([...requests.entries()].map(([authority, urlMap]) => [
      authority, Object.fromEntries(urlMap)
    ])),
    Certs: {},
    NegotiatedProtocol: Object.fromEntries(negotiatedProtocols),
    DeterministicTimeSeedMs: deterministicTimeSeedMs,
    ConstantMathRandomResult: null,
    ServeResponseInChronologicalSequence: false,
    CurrentSessionId: 0,
    DisableFuzzyURLMatching: false,
    Metadata: '',
    InjectedScripts: injectedScripts
  }
}

/**
 * Parses a netlog file into a WprGo archive object.
 *
 * @param {string} netlogPath path of the netlog JSON file
 * @param {object} options
 * @param {object} [options.injectedScripts] map of script name to source,
 *   embedded in the archive like wpr record embeds --inject-scripts
 * @param {number} [options.deterministicTimeSeedMs] time seed for the archive
 * @param {string} [options.replayNonce] base64 CSP replay nonce; a fresh
 *   random one is generated when omitted
 */
export const buildArchiveFromNetLog = async (netlogPath, options = {}) => {
  let parsed
  try {
    parsed = await buildExchangesFromNetLog(netlogPath, options)
  } catch (error) {
    throw error instanceof NetLogError ? error : new NetLogError(`failed to parse netlog: ${error.message}`, { cause: error })
  }
  if (parsed.exchanges.length === 0) {
    throw new NetLogError('netlog contains no recorded requests')
  }
  const archive = archiveFromExchanges(parsed.exchanges, parsed.negotiatedProtocols, options)
  // Filtering can drop every reconstructed exchange (truncated HTTP/1
  // bodies); reporting success would hide a capture with nothing replayable
  if (Object.keys(archive.Requests).length === 0) {
    throw new NetLogError('every recorded request was dropped as unreplayable')
  }
  return archive
}
