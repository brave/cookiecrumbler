// HTTP header parsing helpers, mirroring how Chromium logs header lists and
// how Go's textproto canonicalizes keys.

/**
 * A "name: value" pair as stored on exchanges ([canonicalName, value]).
 * @typedef {[name: string, value: string]} HeaderEntry
 */

// RFC 7230 tchar, plus the characters Go treats as valid header field bytes
const TOKEN_CHARS = "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * Canonical MIME header key casing, like Go's textproto.CanonicalMIMEHeaderKey.
 * Go returns the key unchanged when it contains a byte that is not a valid
 * header token character (e.g. a space), and so do we.
 * @param {string} key
 * @returns {string}
 */
export const canonicalHeaderKey = (key) => {
  for (const char of key) {
    if (!TOKEN_CHARS.includes(char)) return key
  }
  return key.split('-').map(part => (part === '' ? '' : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())).join('-')
}

/**
 * Splits a logged "name: value" header line at the first colon. Both parts
 * are trimmed, matching how the header list lines are logged.
 * @param {string} line
 * @returns {[string, string]|null} [rawName, value], or null without a colon
 */
export const splitHeaderLine = (line) => {
  const idx = line.indexOf(':')
  if (idx === -1) return null
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()]
}

/**
 * Logged request lines carry a trailing CRLF that is not part of the line.
 * @param {string} line
 * @returns {string}
 */
export const stripLineEnding = (line) => line.replace(/\r?\n$/, '')

/**
 * Reads a header value from a logged "name: value" header list: the first
 * line whose canonical name matches.
 * @param {string[]} lines
 * @param {string} name
 * @returns {string|null}
 */
export const headerValue = (lines, name) => {
  const canonical = canonicalHeaderKey(name)
  for (const line of lines) {
    const parts = splitHeaderLine(line)
    if (parts === null) continue
    if (canonicalHeaderKey(parts[0]) === canonical) return parts[1]
  }
  return null
}

/**
 * Strict Content-Length parsing: the trimmed value must be digits. Chromium
 * rejects mismatched duplicate Content-Length headers itself, so a comma
 * list never reaches the parser as a valid length.
 * @param {string|null} value
 * @returns {number|null}
 */
export const parseContentLength = (value) => {
  if (value === null) return null
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null
}

/**
 * Transfer-Encoding carries a comma-separated coding list; only the last
 * coding determines the framing (RFC 9112 §6.1: recipients must check the
 * final encoding). Case-insensitive match, as logged capitalization varies.
 * @param {string|null} value
 * @returns {boolean}
 */
export const isChunkedTransferEncoding = (value) => {
  if (value === null) return false
  const codings = value.split(',')
  const last = codings[codings.length - 1] ?? ''
  return last.trim().toLowerCase() === 'chunked'
}

/**
 * Parses a request line ("METHOD target HTTP/x.y"). The target may be origin
 * form (/path) or absolute form (GET http://host/path, relevant for proxy
 * recording). The line must not carry its CRLF (see stripLineEnding).
 * @param {string} line
 * @returns {{ method: string, target: string, version: string }|null}
 */
export const parseRequestLine = (line) => {
  const match = /^(\S+) (\S+) (HTTP\/\d(?:\.\d+)?)$/.exec(line)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null
  return { method: match[1], target: match[2], version: match[3] }
}

/**
 * How a parsed request reports its Content-Length and Transfer-Encoding.
 * @typedef {object} ParsedRequestHeaders
 * @property {string|null} method
 * @property {string|null} path
 * @property {string|null} authority
 * @property {string|null} userAgent
 * @property {number|null} contentLength
 * @property {boolean} chunked
 * @property {HeaderEntry[]} entries   canonical names, without Host/User-Agent/Content-Length/Transfer-Encoding
 */

/**
 * Parses a logged request header list ("name: value" strings; HTTP/2 lists
 * include pseudo-headers).
 * @param {string[]} lines
 * @returns {ParsedRequestHeaders}
 */
export const parseRequestHeaders = (lines) => {
  let method = null
  let path = null
  let pseudoAuthority = null
  let hostAuthority = null
  let userAgent = null
  let contentLength = null
  let chunked = false
  const entries = []
  for (const line of lines) {
    if (line.startsWith(':')) {
      // HTTP/2 pseudo-header: ":name: value"
      const sep = line.indexOf(':', 1)
      if (sep === -1) continue
      const rawName = line.slice(0, sep)
      const value = line.slice(sep + 1).trim()
      if (rawName === ':method') method = value
      else if (rawName === ':path') path = value
      else if (rawName === ':authority') pseudoAuthority = value
      // :scheme/:protocol and other pseudo-headers are dropped
      continue
    }
    const parts = splitHeaderLine(line)
    if (parts === null) continue
    const [rawName, value] = parts
    const name = canonicalHeaderKey(rawName)
    if (name === 'Host') {
      hostAuthority = value
      continue
    }
    if (name === 'User-Agent') {
      userAgent = value
      continue
    }
    if (name === 'Content-Length') {
      contentLength = parseContentLength(value)
      continue
    }
    if (name === 'Transfer-Encoding') {
      chunked = isChunkedTransferEncoding(value)
      continue
    }
    entries.push(/** @type {HeaderEntry} */ ([name, value]))
  }
  return {
    method,
    path,
    // RFC 9113 §8.3.1: when both are present, :authority takes precedence
    // (Chromium never sends both)
    authority: pseudoAuthority ?? hostAuthority,
    userAgent,
    contentLength,
    chunked,
    entries
  }
}

/**
 * How a parsed response reports its Content-Length and Transfer-Encoding.
 * @typedef {object} ParsedResponseHeaders
 * @property {string} statusLine
 * @property {number} code
 * @property {number|null} contentLength
 * @property {boolean} chunked
 * @property {HeaderEntry[]} entries   canonical names, without Content-Length/Transfer-Encoding
 */

/**
 * Parses a logged response header list (first entry is the status line).
 * Returns null for an empty list or an unparsable status line; a serialized
 * code of 0 would mislead the archive writer.
 * @param {string[]} lines
 * @returns {ParsedResponseHeaders|null}
 */
export const parseResponseHeaders = (lines) => {
  const statusLine = lines[0]
  if (statusLine === undefined) return null
  const match = /^(HTTP\/\d(?:\.\d)?) (\d{3})(?: (.*))?$/.exec(statusLine)
  if (match === null || match[2] === undefined) return null
  const code = parseInt(match[2], 10)
  let chunked = false
  let contentLength = null
  const entries = []
  for (const line of lines.slice(1)) {
    const parts = splitHeaderLine(line)
    if (parts === null) continue
    const [rawName, value] = parts
    const name = canonicalHeaderKey(rawName)
    if (name === 'Content-Length') {
      contentLength = parseContentLength(value)
      continue
    }
    if (name === 'Transfer-Encoding') {
      chunked = isChunkedTransferEncoding(value)
      continue
    }
    entries.push(/** @type {HeaderEntry} */ ([name, value]))
  }
  return { statusLine, code, contentLength, chunked, entries }
}
