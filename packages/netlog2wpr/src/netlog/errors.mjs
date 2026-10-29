/**
 * Classifies the failure an error reports: bad input, a reached cap, a
 * truncated log, and so on.
 * @typedef {'INVALID'|'CAP_REACHED'|'TRUNCATED'|'MISSING_CONSTANTS'|'CHUNKED_UPLOAD'|'NO_REQUESTS'|'ALL_DROPPED'} NetLogErrorCode
 */

/**
 * Error thrown for all parser/reader failures. Wrapping another error keeps
 * it as the cause; the optional code classifies the failure.
 */
export class NetLogError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: NetLogErrorCode, cause?: unknown }} [options]
   */
  constructor (message, { code, cause } = {}) {
    super(message, { cause })
    this.name = 'NetLogError'
    /** @type {NetLogErrorCode|undefined} */
    this.code = code
  }
}
