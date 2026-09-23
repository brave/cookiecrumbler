// WprGo archive writing: converts reconstructed HTTP exchanges (see
// netlog.mjs) into a WebPageReplay record archive. Messages are serialized
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

import { NetLogError, buildExchangesFromNetLog } from './netlog.mjs'

export { NetLogError, MAX_NETLOG_BYTES, replaceConstants } from './netlog.mjs'

// Canonical reason phrases; the netlog omits them for HTTP/2 status lines
const HTTP_REASONS = {
  100: 'Continue',
  101: 'Switching Protocols',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  418: "I'm a teapot",
  421: 'Misdirected Request',
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
    ? []
    : [Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n0\r\n\r\n')]
  return Buffer.concat(chunks)
}

/**
 * Serializes a request the way Go's http.Request.Write does (the format wpr
 * stores as SerializedRequest).
 */
const serializeRequest = (exchange) => {
  const lines = []
  if (exchange.isHttp1) {
    lines.push(exchange.requestLine.replace(/\r?\n$/, ''))
  } else {
    lines.push(`${exchange.method} ${exchange.path ?? '/'} HTTP/1.1`)
  }
  lines.push(`Host: ${exchange.authority}`)
  if (exchange.userAgent !== null) {
    lines.push(`User-Agent: ${exchange.userAgent}`)
  }
  // Go's transferWriter: Content-Length when the length is known and > 0,
  // or when a POST/PUT/PATCH carries a zero length
  const bodyLength = exchange.requestBody.length
  const loggedLength = exchange.requestContentLength === null ? NaN : parseInt(exchange.requestContentLength, 10)
  const lengthBearing = ['POST', 'PUT', 'PATCH'].includes(exchange.method)
  const hasLength = !exchange.requestChunked && (bodyLength > 0 || (loggedLength === 0 && lengthBearing))
  if (hasLength) {
    lines.push(`Content-Length: ${bodyLength}`)
  }
  if (exchange.requestChunked && bodyLength > 0) {
    lines.push('Transfer-Encoding: chunked')
  }
  lines.push(...sortedHeaderLines(exchange.requestEntries))
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)
  if (exchange.requestChunked && bodyLength > 0) {
    return Buffer.concat([head, chunkedBody(exchange.requestBody)])
  }
  return Buffer.concat([head, exchange.requestBody])
}

/**
 * Serializes a response the way Go's http.Response.Write does.
 */
const serializeResponse = (exchange) => {
  let statusLine
  if (exchange.isHttp1) {
    // HTTP/1.x: keep the logged status line
    statusLine = exchange.responseStatusLine ?? ''
    const unknownLength = !exchange.responseChunked && exchange.responseContentLength === null
    if (unknownLength) {
      // Go downgrades EOF-delimited HTTP/1.x responses to HTTP/1.0
      statusLine = statusLine.replace(/^HTTP\/1\.1/, 'HTTP/1.0')
    }
  } else {
    const reason = HTTP_REASONS[exchange.responseCode] ?? ''
    statusLine = `HTTP/2.0 ${exchange.responseCode}${reason === '' ? '' : ` ${reason}`}`
  }
  const lines = [statusLine]
  const contentLength = exchange.responseContentLength === null ? NaN : parseInt(exchange.responseContentLength, 10)
  if (contentLength > 0) {
    lines.push(`Content-Length: ${contentLength}`)
  } else if (exchange.responseChunked) {
    lines.push('Transfer-Encoding: chunked')
  } else if (!exchange.isHttp1 && exchange.responseContentLength === null) {
    // HTTP/2 responses with unknown length have no framing of their own once
    // captured; Go delimits them with Connection: close
    lines.push('Connection: close')
  }
  lines.push(...sortedHeaderLines(exchange.responseEntries))
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`)
  if (exchange.responseChunked) {
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
 * (exchange.responseEntries, edited in place) with a fresh nonce so that
 * wpr's replay-time script injection cannot relax the site's policy.
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
 * the site ships, and directives that already admit wpr's tag on their own
 * (nonce, hash, 'unsafe-inline') keep their original bytes.
 */
const seedCspReplayNonce = (exchange, nonce) => {
  if (exchange.responseCode !== 200) return
  const contentType = exchange.responseEntries.find(([name]) => name === 'Content-Type')
  if (contentType === undefined || !contentType[1].toLowerCase().startsWith('text/html')) return
  const cspIndexes = []
  exchange.responseEntries.forEach(([name], index) => {
    if (name === 'Content-Security-Policy') cspIndexes.push(index)
  })
  if (cspIndexes.length === 0) return

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
  if (tagSource === null) return

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

  // All script-restricting directives across the enforced policies.
  const restricted = []
  valueDirectives.forEach((directives, valueIndex) => {
    directives.forEach((directive, index) => {
      const trimmed = directive.trim()
      if (trimmed.startsWith('script-src') || trimmed.startsWith('default-src')) {
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
  if (!needsSeed) return

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

  valueDirectives.forEach((directives, i) => {
    exchange.responseEntries[cspIndexes[i]][1] = directives.join(';')
  })
}

/**
 * Builds a WprGo archive object (see Archive in webpagereplay's archive.go)
 * from reconstructed exchanges. Fields follow the struct order so the output
 * matches archives written by wpr record.
 *
 * Note: Certs is left empty; netlog-recorded archives cannot carry wpr-minted
 * certificates, so replay mints fresh ones per host (the check browser trusts
 * them via --ignore-certificate-errors-spki-list).
 */
export const archiveFromExchanges = (exchanges, negotiatedProtocols, { injectedScripts = {}, deterministicTimeSeedMs = 0 } = {}) => {
  // One nonce per archive; see seedCspReplayNonce.
  const replayNonce = crypto.randomBytes(16).toString('base64')
  for (const exchange of exchanges) seedCspReplayNonce(exchange, replayNonce)
  const requests = new Map() // authority -> Map(url -> [message])
  for (const exchange of exchanges) {
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
 */
export const buildArchiveFromNetLog = async (netlogPath, options = {}) => {
  let parsed
  try {
    parsed = await buildExchangesFromNetLog(netlogPath, options)
  } catch (error) {
    throw error instanceof NetLogError ? error : new NetLogError(`failed to parse netlog: ${error.message}`)
  }
  if (parsed.exchanges.length === 0) {
    throw new NetLogError('netlog contains no recorded requests')
  }
  return archiveFromExchanges(parsed.exchanges, parsed.negotiatedProtocols, options)
}
