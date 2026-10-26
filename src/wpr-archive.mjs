// WprGo archive writing: converts reconstructed HTTP exchanges (see
// netlog/index.mjs) into a WebPageReplay record archive. Messages are serialized
// exactly like wpr's Go code does: SerializedRequest is Go's
// http.Request.Write output (request line, Host, User-Agent, Content-Length,
// sorted headers, body) and SerializedResponse is Go's http.Response.Write
// output (status line, Content-Length when known or Connection: close when
// the length is unknown, sorted headers, still-content-encoded body).
// Before serialization, the Content-Security-Policy headers of HTML 200
// responses are seeded with a replay nonce so that wpr's replay-time script
// injection is authorized without wpr's 'unsafe-inline' fallback (see
// seedCspReplayNonce).

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
 * so for h2 the recovered length is authoritative.
 * @returns {number|null}
 */
const declaredResponseLength = (exchange) => {
  if (exchange.responseContentLength === null) return null
  if (!exchange.isHttp1 && expectsResponseBody(exchange)) return exchange.responseBody.length
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

// CSP directive keyword tokens as wpr's transformers.go matches them:
// case-sensitive, single-quote wrapped, whitespace separated.
const cspDirectiveTokens = (directive) => directive.trim().split(/\s+/).filter(Boolean)

const cspFirstNonce = (directive) => {
  for (const token of cspDirectiveTokens(directive)) {
    if (token.startsWith("'nonce-")) return token.slice("'nonce-".length).replace(/'$/, '')
  }
  return ''
}

const cspHasUnsafeInline = (directive) => cspDirectiveTokens(directive).includes("'unsafe-inline'")

const cspHasSha = (directive) => cspDirectiveTokens(directive).some(token => /^'sha(256|384|512)-/.test(token))

/**
 * Seeds the enforced Content-Security-Policy headers of an HTML 200 exchange
 * with a fresh nonce so that wpr's replay-time script injection cannot relax
 * the site's policy. Returns the (possibly new) entries array; the input is
 * never written to.
 *
 * At replay, wpr injects deterministic.js into every archived HTML 200
 * response and rewrites the served CSP: a script-src (fallback default-src)
 * directive with neither a nonce nor a hash gets 'unsafe-inline' appended,
 * which would un-block the site's own inline scripts that the live site (and
 * this recording) blocked. When the archived headers instead carry a nonce,
 * wpr copies the first nonce it finds onto its injected script tag and leaves
 * the policy intact, so only the injected script gains permission and
 * CSP-blocked site scripts stay blocked on both sides of record/replay.
 *
 * Seeding is permission-neutral for the site: the added nonce matches nothing
 * the site ships, and a directive that admits inline scripts via
 * 'unsafe-inline' keeps its original bytes unless another enforced policy
 * blocks arbitrary inline scripts anyway (wpr then needs the nonce from the
 * first script-governing directive to tag its script, and the conjunction
 * already blocked those scripts at record time).
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

  // Raw directive lists per enforced header value; untouched directives keep
  // their original bytes.
  const valueDirectives = cspIndexes.map(index => exchange.responseEntries[index][1].split(';'))

  // wpr's getCSPDirective scans the enforced headers for the first directive
  // whose trimmed form starts with 'script-src', falling back to
  // 'default-src'; the first nonce found there is copied onto its injected
  // script tag. Seeding that directive controls the tag's nonce.
  let tagSource = null
  for (const name of ['script-src', 'default-src']) {
    for (const directives of valueDirectives) {
      const index = directives.findIndex(directive => directive.trim().startsWith(name))
      if (index !== -1) {
        tagSource = { directives, index }
        break
      }
    }
    if (tagSource !== null) break
  }
  if (tagSource === null) return exchange.responseEntries

  // Per value, wpr's getUpdatedSingleCSPHeader rewrites the first
  // 'script-src'-prefixed directive, else the last 'default-src'-prefixed
  // one; rewritten sha directives get wpr's script hash appended.
  const rewrittenIndex = valueDirectives.map(directives => {
    let index = -1
    for (let i = 0; i < directives.length; i++) {
      const trimmed = directives[i].trim()
      if (trimmed.startsWith('script-src') || trimmed.startsWith('default-src')) {
        index = i
        if (trimmed.startsWith('script-src')) break
      }
    }
    return index
  })

  // All script-element-restricting directives across the enforced policies:
  // 'script-src' and 'script-src-elem' govern <script> elements, and
  // 'default-src' only restricts scripts when the policy has neither (its
  // script-src takes over for scripts). 'script-src-attr' governs
  // event-handler attributes and never applies to the injected element, so it
  // is left out: seeding it could not authorize the tag, and rewriting it
  // would only alter the site's own permissions.
  const restricted = []
  valueDirectives.forEach((directives, valueIndex) => {
    const names = directives.map(directive => directive.trim().split(/\s+/)[0] ?? '')
    const elementScoped = names.some(name => name === 'script-src' || name === 'script-src-elem')
    directives.forEach((directive, index) => {
      const name = names[index]
      if (name === 'script-src' || name === 'script-src-elem' ||
        (name === 'default-src' && !elementScoped)) {
        restricted.push({ directives, index, rewritten: index === rewrittenIndex[valueIndex] })
      }
    })
  })

  const tagNonce = cspFirstNonce(tagSource.directives[tagSource.index])
  const isTagSource = entry => entry.directives === tagSource.directives && entry.index === tagSource.index
  const nonceToken = `'nonce-${nonce}'`
  const seed = ({ directives, index }) => {
    const kept = cspDirectiveTokens(directives[index]).filter(token => token !== "'none'")
    if (!kept.includes(nonceToken)) kept.splice(1, 0, nonceToken)
    directives[index] = kept.join(' ')
  }

  // Seeding is needed when any directive would block wpr's injected script or
  // be relaxed by wpr with 'unsafe-inline'.
  const needsSeed = restricted.some(({ directives, index, rewritten }) => {
    const firstNonce = cspFirstNonce(directives[index])
    if (firstNonce !== '') return firstNonce !== tagNonce
    if (cspHasSha(directives[index])) return !rewritten
    if (cspHasUnsafeInline(directives[index])) return false
    return true
  })
  if (!needsSeed) return exchange.responseEntries

  seed(tagSource)
  for (const entry of restricted) {
    if (isTagSource(entry)) continue
    const directive = entry.directives[entry.index]
    if (cspFirstNonce(directive) !== '') {
      seed(entry) // a foreign nonce would block the seeded tag; ours coexists
    } else if (cspHasSha(directive) && entry.rewritten) {
      continue // wpr appends its script hash here, authorizing the tag
    } else if (!cspHasSha(directive) && cspHasUnsafeInline(directive)) {
      continue // already admits any inline script, including wpr's
    } else {
      seed(entry) // wpr would relax it with 'unsafe-inline', or it blocks the tag
    }
  }

  // Rebuild the entries: CSP values may have been rewritten, all other
  // entries (and their tuples) are reused as-is
  return exchange.responseEntries.map((entry, index) => {
    const cspIndex = cspIndexes.indexOf(index)
    return cspIndex === -1 ? entry : [entry[0], valueDirectives[cspIndex].join(';')]
  })
}

// HEAD, 204 and 304 responses carry no body even when a length is logged
const expectsResponseBody = (exchange) =>
  exchange.method !== 'HEAD' && exchange.responseCode !== 204 && exchange.responseCode !== 304

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
// logged.
const isTruncatedHttp1Body = (exchange) =>
  exchange.isHttp1 &&
  !exchange.responseChunked &&
  expectsResponseBody(exchange) &&
  exchange.responseContentLength !== null &&
  exchange.responseContentLength !== exchange.responseBody.length

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
    // logged.
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
  return archiveFromExchanges(parsed.exchanges, parsed.negotiatedProtocols, options)
}
