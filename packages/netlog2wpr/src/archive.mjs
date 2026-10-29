// WprGo archive writing: converts reconstructed HTTP exchanges (see
// netlog/exchanges.mjs) into a WebPageReplay record archive. Messages are
// serialized exactly like wpr's Go code does: SerializedRequest is Go's
// http.Request.Write output (request line, Host, User-Agent, Content-Length,
// sorted headers, body) and SerializedResponse is Go's http.Response.Write
// output (status line, Content-Length when known or Connection: close when
// the length is unknown, sorted headers, still-content-encoded body).
// Deliberate divergences from wpr record: a Content-Length logged on a
// bodyless status is kept, where Go's resp.Write would drop it (see
// declaredResponseLength).

/** @typedef {import('./netlog/exchanges.mjs').Exchange} Exchange */
/** @typedef {import('./netlog/http-headers.mjs').HeaderEntry} HeaderEntry */

/**
 * A WprGo archive record (Archive in webpagereplay's archive.go).
 * @typedef {object} WprArchive
 * @property {Record<string, Record<string, WprMessage[]>>} Requests  authority -> url -> messages
 * @property {Record<string, never>} Certs  empty: replay mints fresh certificates per host
 * @property {Record<string, string>} NegotiatedProtocol
 * @property {number} DeterministicTimeSeedMs
 * @property {null} ConstantMathRandomResult
 * @property {boolean} ServeResponseInChronologicalSequence
 * @property {number} CurrentSessionId
 * @property {boolean} DisableFuzzyURLMatching
 * @property {string} Metadata
 * @property {Record<string, string>} InjectedScripts
 */

/** @typedef {{ SerializedRequest: string, SerializedResponse: string, LastServedSessionId: number }} WprMessage */

// Canonical reason phrases, copied from Go's net/http StatusText
// (src/net/http/status.go, BSD-3-Clause, Copyright The Go Authors): the
// netlog omits them for HTTP/2 status lines, and wpr replays exactly what
// resp.Write derived from Go's Status.
/** @type {Record<number, string>} */
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
/** @param {HeaderEntry[]} entries @returns {string[]} */
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
/** @param {Buffer} body @returns {Buffer} */
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
 * both); 'length' declares a known positive Content-Length before the sorted
 * headers; 'zero' is a known zero length (Go writes Content-Length: 0 early
 * for POST/PUT/PATCH and late for every other body-allowed status; 1xx/204/
 * 304 get no line for GET/HEAD); 'close' is an h2 response with unknown
 * length and 'eof' an h1 response with unknown length, both delimited by
 * Connection: close. For HEAD, ReadResponse re-parses the logged
 * Content-Length (net/http transfer.go), so an absent one is an unknown
 * length even on 1xx/204/304.
 * @typedef {{ kind: 'length', length: number } | { kind: 'chunked' } | { kind: 'close' } | { kind: 'eof' } | { kind: 'zero' }} ResponseFraming
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
 *
 * @param {Exchange} exchange
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

/**
 * @param {Exchange} exchange
 * @returns {ResponseFraming}
 */
const responseFraming = (exchange) => {
  if (exchange.responseChunked) return { kind: 'chunked' }
  const length = declaredResponseLength(exchange)
  if (length !== null && length > 0) return { kind: 'length', length }
  if (length === 0) return { kind: 'zero' }
  // An unknown length is ContentLength -1 in Go, which resp.Write delimits
  // with Connection: close. ReadResponse zeroes the length of 1xx/204/304
  // responses, so those serialize under the zero-length rules instead —
  // except HEAD, whose logged Content-Length ReadResponse re-parses
  // (transfer.go), making an absent one a real unknown length.
  if (!expectsResponseBody(exchange) && exchange.method !== 'HEAD') return { kind: 'zero' }
  return exchange.isHttp1 ? { kind: 'eof' } : { kind: 'close' }
}

// Go's bodyAllowedForStatus: 1xx, 204 and 304 responses carry no body
/** @param {number} status @returns {boolean} */
const bodyAllowedForStatus = (status) => status >= 200 && status !== 204 && status !== 304

/**
 * Serializes a request the way Go's http.Request.Write does (the format wpr
 * stores as SerializedRequest).
 * @param {Exchange} exchange
 * @returns {Buffer}
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
 * @param {Exchange} exchange
 * @returns {Buffer}
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
  // Go's ReadResponse consumes a Connection header carrying the close token
  // (shouldClose deletes the whole header and sets Close) and resp.Write
  // re-emits exactly one Connection: close in the framing block before
  // Content-Length and Transfer-Encoding; keep-alive-only values are kept
  // and written from the sorted subset. HTTP/1.0 responses close unless the
  // Connection header carries the keep-alive token.
  const tokens = connectionHeaderTokens(exchange.responseEntries)
  const loggedClose = tokens.includes('close')
  const entries = loggedClose
    ? exchange.responseEntries.filter(([name]) => name !== 'Connection')
    : exchange.responseEntries
  const close = framing.kind === 'eof' || framing.kind === 'close' || loggedClose ||
    (isHttp10(exchange) && !tokens.includes('keep-alive'))
  const lines = [statusLine]
  if (close) lines.push('Connection: close')
  if (framing.kind === 'length') lines.push(`Content-Length: ${framing.length}`)
  if (framing.kind === 'chunked') lines.push('Transfer-Encoding: chunked')
  // Go writes a known zero length early only for POST/PUT/PATCH
  // (shouldSendContentLength); every other method gets the late
  // Content-Length: 0 write (response.go), which bodyless statuses skip.
  const earlyZero = framing.kind === 'zero' && ['POST', 'PUT', 'PATCH'].includes(exchange.method)
  if (earlyZero) lines.push('Content-Length: 0')
  lines.push(...sortedHeaderLines(entries))
  if (framing.kind === 'zero' && !earlyZero && bodyAllowedForStatus(exchange.responseCode)) {
    lines.push('Content-Length: 0')
  }
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)
  // The body framing follows the same kind the head was built from: a chunked
  // response is re-chunked even when a Content-Length was also logged; a HEAD
  // response writes no body at all, not even the terminal chunk.
  if (framing.kind === 'chunked') {
    // Re-frame the de-chunked body exactly like Go's resp.Write
    return Buffer.concat([head, exchange.method === 'HEAD' ? Buffer.alloc(0) : chunkedBody(exchange.responseBody)])
  }
  return Buffer.concat([head, exchange.responseBody])
}

// Connection header tokens, lowercased (Go matches them case-insensitively)
/** @param {HeaderEntry[]} entries @returns {string[]} */
const connectionHeaderTokens = (entries) => entries
  .filter(([name]) => name === 'Connection')
  .flatMap(([, value]) => value.split(',').map(token => token.trim().toLowerCase()))

// HTTP/1.0 responses close the connection unless the Connection header
// carries the keep-alive token (Go's shouldClose)
/** @param {Exchange} exchange @returns {boolean} */
const isHttp10 = (exchange) =>
  exchange.isHttp1 && (exchange.responseStatusLine ?? '').startsWith('HTTP/1.0')

// HEAD, 1xx, 204 and 304 responses carry no body even when a length is
// logged (Go's bodyAllowedForStatus plus the HEAD method)
/** @param {Exchange} exchange @returns {boolean} */
const expectsResponseBody = (exchange) =>
  exchange.method !== 'HEAD' && bodyAllowedForStatus(exchange.responseCode)

// A successful 3xx hop: Chromium follows the Location without reading the
// redirect body, so the hop completes with an empty recovered body no matter
// what Content-Length was logged
/** @param {Exchange} exchange @returns {boolean} */
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
/** @param {Exchange} exchange @returns {boolean} */
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
 * @param {Exchange[]} exchanges
 * @param {Map<string, string>} negotiatedProtocols
 * @param {object} [options]
 * @param {Record<string, string>} [options.injectedScripts] map of script name to source,
 *   embedded in the archive like wpr record embeds --inject-scripts
 * @param {number} [options.deterministicTimeSeedMs] time seed for the archive
 * @param {string} [options.metadata] free-form metadata stored in the
 *   archive; wpr-go replay targets are unaffected by it
 * @param {function({ code: string, url: string, message: string }): void} [options.onWarning]
 *   called for every dropped exchange
 * @returns {WprArchive}
 */
export const archiveFromExchanges = (exchanges, negotiatedProtocols, { injectedScripts = {}, deterministicTimeSeedMs = 0, metadata = '', onWarning } = {}) => {
  /** @type {Map<string, Map<string, WprMessage[]>>} */
  const requests = new Map() // authority -> Map(url -> [message])
  for (const exchange of exchanges) {
    // Aborted transfers are dropped exactly where the browser itself fails
    // them; see isTruncatedHttp1Body.
    if (isTruncatedHttp1Body(exchange)) {
      onWarning?.({ code: 'TRUNCATED_BODY', url: exchange.url, message: `logged Content-Length ${exchange.responseContentLength} does not match the ${exchange.responseBody.length} byte recovered body` })
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
    Metadata: metadata,
    InjectedScripts: injectedScripts
  }
}
