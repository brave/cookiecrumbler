// Entrypoint for the API server.

import fs from 'fs/promises'
import { existsSync } from 'fs'
import zlib from 'zlib'
import { PassThrough } from 'stream'
import path from 'path'
import process from 'process'
import os from 'os'
import { STATUS_CODES } from 'node:http'

import './instrument.mjs'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import compress from 'koa-compress'
import * as Sentry from '@sentry/node'
import Router from '@koa/router'
import { Semaphore, withTimeout } from 'async-mutex'

import { checkPage } from './lib.mjs'
import { getFilteredKnownDevices } from './setupUtil.mjs'
import { isValidHttpUrl } from './util.mjs'
import { VIEWPORT_PRESETS, REQUEST_DISABLE_FEATURES_ALLOWLIST } from './puppeteer.mjs'

// Calculate default max concurrency based on available memory
const totalMemoryMB = os.totalmem() / (1024 * 1024)
const DEFAULT_MAX_CONCURRENCY = Math.floor(totalMemoryMB / 256)

const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY
const maxConcurrencyWaitMs = parseInt(process.env.MAX_CONCURRENCY_WAIT_MS) || 2000
// Capacity-timeout sentinel: withTimeout rejects the queue wait with this
// exact object, so match by identity, never by message. The message doubles
// as the user-facing error text both response paths send.
const CAPACITY_ERROR = new Error('Too Many Requests: server is at capacity')
const semaphore = withTimeout(new Semaphore(maxConcurrency), maxConcurrencyWaitMs, CAPACITY_ERROR)

const browserBinaryPath = process.argv[2] || '/usr/bin/brave'
const port = process.argv[3] || 3000

export const app = new Koa()
app.use(async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    if (ctx.headerSent || !ctx.writable) {
      throw error
    }

    const err = error instanceof Error ? error : new Error('Unhandled request error', { cause: error })
    const status = err.status || err.statusCode
    ctx.status = typeof status === 'number' && status >= 400 && STATUS_CODES[status] ? status : 500
    ctx.type = 'json'
    ctx.body = { error: STATUS_CODES[ctx.status], identified: false }
    ctx.app.emit('error', err, ctx)
  }
})
// Raised json limit: WprGo replay archives are uploaded base64-encoded in the JSON body
app.use(bodyParser({ jsonLimit: '200mb' }))
// Z_SYNC_FLUSH flushes the compressor on every write, so streamed bodies
// arrive incrementally instead of buffering until the stream ends.
// threshold 0 keeps even tiny bodies compressed; brotli stays off (slower
// on the large report bodies, and zstd/gzip already cover every client).
app.use(compress({
  threshold: 0,
  gzip: { flush: zlib.constants.Z_SYNC_FLUSH },
  deflate: { flush: zlib.constants.Z_SYNC_FLUSH },
  zstd: { flush: zlib.constants.Z_SYNC_FLUSH },
  br: false
}))

Sentry.setupKoaErrorHandler(app)

const version = process.env.GIT_COMMIT ? process.env.GIT_COMMIT.slice(0, 6) : 'unknown'

const proxyList = process.env.PROXY_LIST ? JSON.parse(process.env.PROXY_LIST) : {}
const validProxies = Object.keys(proxyList).reduce((acc, region) => {
  const countries = proxyList[region]
  Object.keys(countries).forEach(country => {
    const cities = countries[country]
    Object.keys(cities).forEach(city => {
      acc.push(cities[city])
    })
  })
  return acc
}, [])

function proxyToLocation (location, proxyList) {
  for (const region in proxyList) {
    for (const country in proxyList[region]) {
      for (const city in proxyList[region][country]) {
        if (location === proxyList[region][country][city]) {
          return `${region} / ${country} / ${city}`
        }
      }
    }
  }
}

const STREAM_HEARTBEAT_MS = 15000

// Explicit allowlist: spreading the request body would let API clients inject
// internal options that checkPage and puppeteerConfigForArgs read, like
// executablePath, extraArgs or onProgress
const CHECK_API_FIELDS = [
  'url',
  'seconds',
  'adblockLists',
  'additionalFilterRules',
  'screenshot',
  'markup',
  'location',
  'slowCheck',
  'device',
  'viewport',
  'userAgent',
  'disableFeatures',
  'wprGo'
]
const buildCheckArgs = (body) => ({
  ...Object.fromEntries(CHECK_API_FIELDS.map(field => [field, body[field]])),
  seconds: body.seconds || 4,
  executablePath: browserBinaryPath
})

/**
 * Runs a check under the concurrency semaphore and stamps the report fields
 * both response paths need.
 */
const runCheck = async (checkArgs, hooks = {}) => {
  const report = await semaphore.runExclusive(() => checkPage({ ...checkArgs, ...hooks }))
  report.version = version
  report.location = proxyToLocation(checkArgs.location, proxyList)
  return report
}

/**
 * Validates the request body and builds checkPage args, or writes the
 * validation error to the response and returns undefined.
 */
const parseCheckRequest = (ctx) => {
  const invalid = validateCheckRequest(ctx.request.body)
  if (invalid !== null) {
    ctx.status = invalid.status
    ctx.body = invalid.body
    return undefined
  }
  return buildCheckArgs(ctx.request.body)
}

/**
 * Streams a check as a text/event-stream response for the /check/stream
 * route (SSE framing over fetch, since EventSource cannot POST): `progress`
 * events carry scan phases, `screenshot` events carry base64 webp interim
 * frames, and the final `report` event is byte-identical to the buffered
 * JSON response (base64 screenshot included, so no transformation is needed).
 *
 * Compression: koa-compress wraps the PassThrough body with the negotiated
 * compressor (zstd/gzip, Z_SYNC_FLUSH per write via the middleware options),
 * so every written event is flushed to the socket immediately. ctx.compress =
 * true keeps streaming bodies compressed regardless of body size. TCP_NODELAY
 * is required because flushed events are small enough that Nagle would
 * otherwise hold each one until the next write lands.
 */
const streamCheckProgress = (ctx, checkArgs) => {
  ctx.compress = true
  // a flushed event sits in the socket until the peer ACKs; without NODELAY
  // Nagle delays it until the next event (or the closing chunk) is written
  ctx.res.socket?.setNoDelay(true)
  ctx.status = 200
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
  ctx.set('Cache-Control', 'no-cache')

  const stream = new PassThrough()
  ctx.body = stream

  let open = true
  const sendEvent = (event, data) => {
    if (!open) {
      return
    }
    // JSON.stringify never emits raw newlines, so data is always a single
    // SSE data line
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // ALB closes connections that carry no traffic for its idle timeout (60s by
  // default); SSE comments keep the stream alive across quiet phases
  const heartbeat = setInterval(() => stream.write(': ping\n\n'), STREAM_HEARTBEAT_MS)
  const close = () => {
    if (!open) {
      return
    }
    open = false
    clearInterval(heartbeat)
    // ending an already-destroyed stream only emits an error asynchronously,
    // swallowed by the empty handler below
    stream.end()
  }
  // writes into a destroyed stream raise unhandled errors; the client
  // disconnecting must not take down the process
  stream.on('error', () => {})
  // Koa destroys the body both when the client disconnects and after a normal
  // finish, so 'close' covers every teardown path without racing the setup
  stream.once('close', close)

  sendEvent('progress', { t: 0, phase: 'queued' })
  // The handler must return before the scan finishes: Koa only wires
  // ctx.body to the socket after the middleware chain resolves, so awaiting
  // the scan here would buffer every event inside the PassThrough and deliver
  // the whole response in one burst when the check completes.
  runCheck(checkArgs, {
    onProgress: (event) => sendEvent('progress', event),
    onScreenshot: (data, { seq, t }) => sendEvent('screenshot', { t, seq, data })
  })
    .then(report => {
      sendEvent('report', report)
      close()
    })
    .catch(error => {
      // .then(...).catch(...) (not .then(ok, err)) so a throw while sending
      // the report - e.g. JSON.stringify bailing on a multi-hundred-MB report
      // - still lands here instead of leaving the stream open forever
      try {
        // headers are already streaming, so the error must travel as an event
        // instead of a status code; Sentry still needs to see it
        if (error === CAPACITY_ERROR) {
          sendEvent('error', { error: CAPACITY_ERROR.message })
        } else {
          Sentry.captureException(error)
          sendEvent('error', { error: error?.stack ?? String(error) })
        }
      } finally {
        close()
      }
    })
}

// Create a new router
const router = new Router()

// Define routes
router.get('/', async (ctx) => {
  // no-store so UI updates (like this progress stream) are never masked by a
  // cached stale page
  ctx.set('Cache-Control', 'no-store')
  ctx.body = await fs.readFile(path.join(import.meta.dirname, 'index.html'))
  ctx.response.type = 'html'
})

router.get('/version', async (ctx) => {
  ctx.body = version
  ctx.response.type = 'text'
})

router.get('/adblock_lists.json', async (ctx) => {
  ctx.body = await fs.readFile(path.join(import.meta.dirname, '..', 'adblock_lists.json'))
  ctx.response.type = 'json'
})

router.get('/proxy_list.json', async (ctx) => {
  ctx.body = proxyList
  ctx.response.type = 'json'
})

const filteredDevices = getFilteredKnownDevices()

router.get('/options.json', async (ctx) => {
  ctx.body = {
    devices: filteredDevices,
    viewports: Object.keys(VIEWPORT_PRESETS),
    disableFeatures: REQUEST_DISABLE_FEATURES_ALLOWLIST
  }
  ctx.response.type = 'json'
})

// Returns { status, body } for the first failed constraint, or null when the
// request is well-formed.
const validateCheckRequest = (body) => {
  const {
    device,
    viewport,
    location,
    disableFeatures,
    wprGo,
    url
  } = body

  // Validate device name
  if (device && !filteredDevices.includes(device)) {
    return { status: 400, body: { error: 'Bad Request: unknown device' } }
  }

  // Validate viewport preset
  if (viewport && !Object.keys(VIEWPORT_PRESETS).includes(viewport)) {
    return { status: 400, body: { error: 'Bad Request: unknown viewport preset' } }
  }

  // Ensure device and viewport are not both set (mutually exclusive)
  if (device && viewport) {
    return { status: 400, body: { error: 'Bad Request: cannot specify both device and viewport' } }
  }

  // Ensure location is in the configured proxy list
  if (location && !validProxies.includes(location)) {
    return { status: 400, body: { error: 'Bad Request: invalid location' } }
  }

  if (disableFeatures !== undefined) {
    if (!Array.isArray(disableFeatures) || disableFeatures.some(feature => typeof feature !== 'string')) {
      return { status: 400, body: { error: 'Bad Request: disableFeatures must be an array of strings' } }
    }

    const invalidFeatures = disableFeatures.filter(
      feature => !REQUEST_DISABLE_FEATURES_ALLOWLIST.includes(feature)
    )
    if (invalidFeatures.length) {
      return {
        status: 400,
        body: {
          error: 'Bad Request: disableFeatures contains unsupported values',
          invalidFeatures
        }
      }
    }
  }

  // Validate WprGo options
  if (wprGo !== undefined) {
    if (typeof wprGo !== 'object' || wprGo === null || Array.isArray(wprGo)) {
      return { status: 400, body: { error: 'Bad Request: wprGo must be an object' } }
    }

    if (wprGo.action !== 'record' && wprGo.action !== 'replay') {
      return { status: 400, body: { error: 'Bad Request: wprGo.action must be "record" or "replay"' } }
    }

    // Server-local archive paths are rejected at the API boundary: they let API
    // clients make wpr read arbitrary files. Upload the archive via wprGo.data
    // instead (materialized under a randomized server-side tmp path).
    if (wprGo.path !== undefined) {
      return { status: 400, body: { error: 'Bad Request: wprGo.path is not supported; upload the archive via wprGo.data' } }
    }

    if (wprGo.data !== undefined && (typeof wprGo.data !== 'string' || !wprGo.data)) {
      return { status: 400, body: { error: 'Bad Request: wprGo.data must be a non-empty base64 string' } }
    }

    if (wprGo.data !== undefined && wprGo.action !== 'replay') {
      return { status: 400, body: { error: 'Bad Request: wprGo.data is only supported for replay action' } }
    }
  }

  // URL is only optional when replaying a WprGo archive (a URL is then taken
  // from the archive itself)
  if (!url && !(wprGo?.action === 'replay' && wprGo.data !== undefined)) {
    return { status: 400, body: { error: 'Bad Request: url is required' } }
  }

  // Only http(s) URLs are navigable by the check browser (blocks file://, etc.)
  if (url !== undefined && url !== '' && !isValidHttpUrl(url)) {
    return { status: 400, body: { error: 'Bad Request: url must be a valid http or https URL' } }
  }

  return null
}

router.post('/check', async (ctx) => {
  const checkArgs = parseCheckRequest(ctx)
  if (checkArgs === undefined) {
    return
  }

  try {
    const report = await runCheck(checkArgs)
    ctx.body = JSON.stringify(report)
    ctx.response.type = 'json'
  } catch (error) {
    if (error === CAPACITY_ERROR) {
      ctx.status = 429
      ctx.body = { error: CAPACITY_ERROR.message }
      return
    }
    throw error
  }
})

router.post('/check/stream', async (ctx) => {
  const checkArgs = parseCheckRequest(ctx)
  if (checkArgs === undefined) {
    return
  }
  streamCheckProgress(ctx, checkArgs)
})

app.use(router.routes())
app.use(router.allowedMethods())

if (import.meta.main) {
  if (!existsSync(browserBinaryPath)) {
    console.error(`Path ${browserBinaryPath} does not exist.`)
    console.error('Please specify an alternative on the command line.')
    process.exit(-1)
  }

  console.log(`Browser binary: ${browserBinaryPath}`)
  console.log(`Port: ${port}`)
  app.listen(port)
}
