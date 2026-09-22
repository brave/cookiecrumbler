// Entrypoint for the API server.

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import process from 'process'
import os from 'os'

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
const semaphore = withTimeout(new Semaphore(maxConcurrency), maxConcurrencyWaitMs)

const browserBinaryPath = process.argv[2] || '/usr/bin/brave'
const port = process.argv[3] || 3000

if (!existsSync(browserBinaryPath)) {
  console.error(`Path ${browserBinaryPath} does not exist.`)
  console.error('Please specify an alternative on the command line.')
  process.exit(-1)
}

console.log(`Browser binary: ${browserBinaryPath}`)
console.log(`Port: ${port}`)

const app = new Koa()
// Raised json limit: WprGo replay archives are uploaded base64-encoded in the JSON body
app.use(bodyParser({ jsonLimit: '200mb' }))
app.use(compress())

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

// Create a new router
const router = new Router()

// Define routes
router.get('/', async (ctx) => {
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

router.post('/check', async (ctx) => {
  const {
    url,
    seconds,
    adblockLists,
    additionalFilterRules,
    screenshot,
    markup,
    location,
    slowCheck,
    device,
    mhtmlMode,
    includeMhtml,
    viewport,
    userAgent,
    disableFeatures,
    wprGo
  } = ctx.request.body

  // Validate device name
  if (device && !filteredDevices.includes(device)) {
    ctx.status = 400
    ctx.body = { error: 'Bad Request: unknown device' }
    return
  }

  // Validate viewport preset
  if (viewport && !Object.keys(VIEWPORT_PRESETS).includes(viewport)) {
    ctx.status = 400
    ctx.body = { error: 'Bad Request: unknown viewport preset' }
    return
  }

  // Ensure device and viewport are not both set (mutually exclusive)
  if (device && viewport) {
    ctx.status = 400
    ctx.body = { error: 'Bad Request: cannot specify both device and viewport' }
    return
  }

  // Ensure location is in the configured proxy list
  if (location && !validProxies.includes(location)) {
    ctx.status = 400
    ctx.body = { error: 'Bad Request: invalid location' }
    return
  }

  if (disableFeatures !== undefined) {
    if (!Array.isArray(disableFeatures) || disableFeatures.some(feature => typeof feature !== 'string')) {
      ctx.status = 400
      ctx.body = { error: 'Bad Request: disableFeatures must be an array of strings' }
      return
    }

    const invalidFeatures = disableFeatures.filter(
      feature => !REQUEST_DISABLE_FEATURES_ALLOWLIST.includes(feature)
    )
    if (invalidFeatures.length) {
      ctx.status = 400
      ctx.body = {
        error: 'Bad Request: disableFeatures contains unsupported values',
        invalidFeatures
      }
      return
    }
  }

  // Validate WprGo options
  if (wprGo !== undefined) {
    if (typeof wprGo !== 'object' || wprGo === null || Array.isArray(wprGo)) {
      ctx.status = 400
      ctx.body = { error: 'Bad Request: wprGo must be an object' }
      return
    }

    if (wprGo.action !== 'record' && wprGo.action !== 'replay') {
      ctx.status = 400
      ctx.body = { error: 'Bad Request: wprGo.action must be "record" or "replay"' }
      return
    }

    // Server-local archive paths are rejected at the API boundary: they let API
    // clients make wpr read arbitrary files. Upload the archive via wprGo.data
    // instead (materialized under a randomized server-side tmp path).
    if (wprGo.path !== undefined) {
      ctx.status = 400
      ctx.body = { error: 'Bad Request: wprGo.path is not supported; upload the archive via wprGo.data' }
      return
    }

    if (wprGo.data !== undefined && (typeof wprGo.data !== 'string' || !wprGo.data)) {
      ctx.status = 400
      ctx.body = { error: 'Bad Request: wprGo.data must be a non-empty base64 string' }
      return
    }

    if (wprGo.data !== undefined && wprGo.action !== 'replay') {
      ctx.status = 400
      ctx.body = { error: 'Bad Request: wprGo.data is only supported for replay action' }
      return
    }
  }

  // URL is only optional when replaying a WprGo archive (a URL is then taken
  // from the archive itself)
  if (!url && !(wprGo?.action === 'replay' && wprGo.data !== undefined)) {
    ctx.status = 400
    ctx.body = { error: 'Bad Request: url is required' }
    return
  }

  // Only http(s) URLs are navigable by the check browser (blocks file://, etc.)
  if (url !== undefined && url !== '' && !isValidHttpUrl(url)) {
    ctx.status = 400
    ctx.body = { error: 'Bad Request: url must be a valid http or https URL' }
    return
  }

  try {
    const report = await semaphore.runExclusive(async () => {
      return await checkPage({
        url,
        seconds: seconds || 4,
        executablePath: browserBinaryPath,
        adblockLists,
        additionalFilterRules,
        // debugLevel: 'verbose',
        screenshot,
        markup,
        location,
        slowCheck,
        device,
        mhtmlMode,
        includeMhtml,
        viewport,
        userAgent,
        disableFeatures,
        wprGo
      })
    })

    report.version = version
    report.location = proxyToLocation(location, proxyList)
    ctx.body = JSON.stringify(report)
    ctx.response.type = 'json'
  } catch (error) {
    if (error.message === 'timeout') {
      ctx.status = 429
      ctx.body = { error: 'Too Many Requests: server is at capacity' }
      return
    }
    throw error
  }
})

app.use(router.routes())
app.use(router.allowedMethods())

app.listen(port)
