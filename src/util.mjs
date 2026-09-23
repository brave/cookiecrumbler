/**
 * @file Shared utility code that can be imported both from the host process and in page contexts.
 */

/**
 * Generate a random string between [a000000000, zzzzzzzzzz] (base 36)
 */
export function generateRandomToken () {
  const min = Number.parseInt('a000000000', 36)
  const max = Number.parseInt('zzzzzzzzzz', 36)
  return Math.floor(Math.random() * (max - min) + min).toString(36)
}

/**
 * Returns true when the given value is a string parseable as an http(s) URL.
 * Used to guard anything the headless browser may navigate to.
 */
export function isValidHttpUrl (url) {
  try {
    return new URL(url).protocol === 'http:' || new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
