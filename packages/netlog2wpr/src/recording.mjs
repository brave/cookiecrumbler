// Recording-time context for wpr-style captures: renders deterministic.js
// for injection into the recording browser and builds the archiveFromExchanges
// options that embed the unrendered script for replay-time injection (see
// README.md for the record/replay injection gap).

import { renderDeterministicScript } from './deterministic.mjs'

/**
 * Builds the recording-time context for a wpr-style capture. deterministic.js
 * is rendered with a whole-second time seed for injection into the recording
 * browser, and the unrendered script plus the same seed are returned as
 * archiveFromExchanges options, mirroring what wpr record does with
 * --inject-scripts and its time seed.
 *
  * @param {{ deterministicScript: string, now?: number }} options
  * options.deterministicScript is the source of deterministic.js and
  * options.now the current time in milliseconds (defaults to Date.now())
  * @returns {{ timeSeedMs: number, injectScript: string, archiveOptions: {
  *   injectedScripts: Record<string, string>, deterministicTimeSeedMs: number } }}
  *   timeSeedMs is the whole-second time seed, injectScript is the rendered
  *   script to inject at record time and archiveOptions are the
  *   archiveFromExchanges options embedding the unrendered script
  */
export const createRecordingContext = ({ deterministicScript, now = Date.now() }) => {
  // Mirrors wpr record, which seeds deterministic.js with
  // 1000 * time.Now().Unix()
  const timeSeedMs = 1000 * Math.floor(now / 1000)
  // At record time the script must not pin a Math.random value into the
  // replay archive, so the injected rendering renders the constant as null
  const injectScript = renderDeterministicScript(deterministicScript, timeSeedMs, null)
  // The unrendered script is embedded in the archive for replay-time
  // injection, like wpr record's --inject-scripts
  const archiveOptions = {
    injectedScripts: { 'deterministic.js': deterministicScript },
    deterministicTimeSeedMs: timeSeedMs
  }
  return { timeSeedMs, injectScript, archiveOptions }
}
