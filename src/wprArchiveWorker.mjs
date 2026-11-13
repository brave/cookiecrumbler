// Worker entry: converts a finished netlog into a gzipped WprGo archive.
// Runs in its own thread with a capped V8 heap, so an out-of-memory abort
// fails a single request instead of the API process. One worker is spawned
// per conversion; the parent serializes conversions with its own semaphore.

import { parentPort } from 'node:worker_threads'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { netlogToWprArchive } from 'netlog2wpr'
import { NETLOG_CAP_BYTES } from './netlogConfig.mjs'

const gzip = promisify(zlib.gzip)

parentPort.once('message', async ({ netlogPath, options }) => {
  try {
    const { archive, stats } = await netlogToWprArchive(netlogPath, {
      ...options,
      maxNetlogBytes: NETLOG_CAP_BYTES,
      dropInternalRequests: true
    })
    // The multi-hundred-MB JSON string never leaves this thread; only the
    // gzipped archive crosses back. No transferList: zlib output is backed by
    // Node's pooled (resizable) ArrayBuffer, which cannot be transferred, and
    // the clone copy of the compressed bytes is cheap.
    const gz = await gzip(JSON.stringify(archive))
    parentPort.postMessage({ ok: true, gz, stats })
  } catch (error) {
    // Error class identity does not survive the thread boundary; report
    // name/code/message and let the parent re-map it onto WprGoError.
    parentPort.postMessage({ ok: false, name: error.name, code: error.code, message: error.message })
  }
})
