/**
 * Error thrown for all parser/reader failures. Wrapping another error keeps
 * it as the cause.
 */
export class NetLogError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor (message, options) {
    super(message, options)
    this.name = 'NetLogError'
  }
}
