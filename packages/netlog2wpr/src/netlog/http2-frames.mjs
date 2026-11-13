// HTTP/2 frame parsing over the logged TLS payload plaintext of one
// connection. Only DATA frames matter: they carry the request bodies that
// header blocks alone cannot recover.

export const HTTP2_CONNECTION_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')
export const HTTP2_FRAME_HEADER_LENGTH = 9
export const FRAME_TYPE_DATA = 0x0
export const FLAG_PADDED = 0x8

/**
 * Parsed DATA frame payloads of one connection. truncated means parsing
 * stopped early (incomplete or malformed frame); frames parsed before that
 * are kept in dataByStream.
 * @typedef {object} H2DataFrames
 * @property {Map<number, Buffer>} dataByStream  concatenated DATA payloads per stream id
 * @property {boolean} hasPreface
 * @property {boolean} truncated
 */

/**
 * Collects HTTP/2 DATA frame payloads per stream from the client→server
 * plaintext of one connection.
 * @param {Buffer} bytes
 * @returns {H2DataFrames}
 */
export const extractH2DataFrames = (bytes) => {
  if (!bytes.subarray(0, HTTP2_CONNECTION_PREFACE.length).equals(HTTP2_CONNECTION_PREFACE)) {
    // Without the preface this is not a parsed h2 client stream: for a TLS
    // socket without SSL plaintext events it would be ciphertext (the socket
    // byte-source selection is a parser concern, see backlog B3.3)
    return { dataByStream: new Map(), hasPreface: false, truncated: false }
  }
  const chunks = new Map() // streamId -> [payload]
  let truncated = false
  let offset = HTTP2_CONNECTION_PREFACE.length
  while (offset + HTTP2_FRAME_HEADER_LENGTH <= bytes.length) {
    const length = bytes.readUIntBE(offset, 3)
    const type = bytes.readUInt8(offset + 3)
    const flags = bytes.readUInt8(offset + 4)
    const streamId = bytes.readUInt32BE(offset + 5) & 0x7fffffff
    const payloadStart = offset + HTTP2_FRAME_HEADER_LENGTH
    if (payloadStart + length > bytes.length) {
      truncated = true // incomplete trailing frame
      break
    }
    if (type === FRAME_TYPE_DATA) {
      let payload = bytes.subarray(payloadStart, payloadStart + length)
      if ((flags & FLAG_PADDED) !== 0) {
        // Pad length + its own byte must fit inside the payload
        // (RFC 9113 §6.1); larger values are a protocol error. A zero-length
        // payload has no room even for the pad length byte.
        const padLength = payload[0] ?? 0
        if (padLength + 1 > payload.length) {
          truncated = true
          break
        }
        payload = payload.subarray(1, payload.length - padLength)
      }
      // DATA on stream 0 is a protocol error (RFC 9113 §6.1): ignored; empty
      // payloads carry no body bytes
      if (streamId !== 0 && payload.length > 0) {
        let streamChunks = chunks.get(streamId)
        if (streamChunks === undefined) chunks.set(streamId, streamChunks = [])
        streamChunks.push(payload)
      }
    }
    offset = payloadStart + length
  }
  // Leftover bytes: a partial frame header or payload at the end
  truncated ||= offset < bytes.length
  // One concat per stream; the subarrays share the (then collectable) source
  const dataByStream = new Map(
    [...chunks].map(([streamId, streamChunks]) => [streamId, Buffer.concat(streamChunks)])
  )
  return { dataByStream, hasPreface: true, truncated }
}
