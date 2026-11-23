// Validation coverage for the check request contract. The schema factory is
// exercised with synthetic catalogs, and the real HTTP boundary runs through
// the app itself: invalid bodies must answer 400 with per-issue details
// before any crawler work happens, on both check routes.

import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { describe, it, before, after } from 'node:test'
import path from 'node:path'

import { createApp } from '../src/api.mjs'
import { createCheckRequestSchema } from '../src/schemas/check.mjs'

// The boundary suite boots the real app, which reads the List Catalog from
// the provisioned template profile at startup: fail with instructions
// instead of a bare ENOENT when the setup flow has not run (fresh checkouts)
const templateProfilePath = path.join(import.meta.dirname, '..', 'profile')
if (!existsSync(templateProfilePath)) {
  throw new Error(`browser profile is missing: run 'pnpm run setup ${process.env.BRAVE_BINARY ?? '/usr/bin/brave-browser'}' to provision it first`)
}

const validAdblockLists = ['list-a', 'list-b']

const schema = createCheckRequestSchema({
  validProxies: ['proxy-a'],
  validDevices: ['Device A'],
  validViewports: ['1200x800'],
  validDisableFeatures: ['FeatureX'],
  validAdblockLists
})

const issuesAt = (result, path) => result.error?.issues.filter(issue => issue.path.join('.') === path) ?? []

const messagesAt = (result, path) => issuesAt(result, path).map(issue => issue.message)

describe('check request schema', () => {
  it('applies the documented defaults', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/' })
    t.assert.strictEqual(result.success, true)
    t.assert.strictEqual(result.data.seconds, 4)
    t.assert.strictEqual(result.data.url, 'https://example.com/')
  })

  it('accepts the documented field shapes', (t) => {
    const result = schema.safeParse({
      url: 'https://example.com/',
      seconds: 8,
      adblockLists: { 'list-a': true },
      additionalFilterRules: ['##.cookie-banner'],
      screenshot: 'fullPage',
      markup: true,
      slowCheck: true,
      userAgent: 'agent',
      disableFeatures: ['FeatureX'],
      wprGo: { action: 'record' }
    })
    t.assert.strictEqual(result.success, true)
  })

  it('accepts empty strings for unset dropdown fields', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/', device: '', viewport: '', location: '' })
    t.assert.strictEqual(result.success, true)
  })

  it('bounds seconds to 1-60 and integers', (t) => {
    for (const seconds of [0, -1, 61, 2.5, '4']) {
      const result = schema.safeParse({ url: 'https://example.com/', seconds })
      t.assert.strictEqual(result.success, false, `seconds ${seconds}`)
      t.assert.strictEqual(issuesAt(result, 'seconds').length, 1, `seconds ${seconds}`)
    }
  })

  it('rejects both device and viewport with the combined message', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/', device: 'Device A', viewport: '1200x800' })
    t.assert.deepStrictEqual(messagesAt(result, ''), ['cannot specify both device and viewport'])
  })

  it('names unknown devices, viewports and locations', (t) => {
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'https://example.com/', device: 'Nope' }), 'device'),
      ['unknown device']
    )
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'https://example.com/', viewport: '1x1' }), 'viewport'),
      ['unknown viewport preset']
    )
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'https://example.com/', location: 'nope' }), 'location'),
      ['invalid location']
    )
  })

  it('rejects unsupported disableFeatures without leaking data fields', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/', disableFeatures: ['Nope'] })
    t.assert.strictEqual(result.success, false)
    t.assert.deepStrictEqual(messagesAt(result, 'disableFeatures'), ['disableFeatures contains unsupported values'])
    t.assert.strictEqual(Object.keys(result.error ?? {}).includes('invalidFeatures'), false)
  })

  it('requires adblockLists values to be booleans and ids to be known', (t) => {
    t.assert.strictEqual(issuesAt(schema.safeParse({ url: 'https://example.com/', adblockLists: { 'list-a': 'yes' } }), 'adblockLists.list-a').length, 1)
    // unknown component ids are rejected instead of being silently ignored:
    // the client would otherwise believe a list was toggled when it was not
    const unknownList = schema.safeParse({ url: 'https://example.com/', adblockLists: { 'not-a-list': true } })
    const [issue] = unknownList.error.issues
    t.assert.strictEqual(issue.code, 'unrecognized_keys')
    t.assert.deepStrictEqual(issue.keys, ['not-a-list'])
  })

  it('requires additionalFilterRules to be a string array', (t) => {
    // checkPage joins this field; a wrong type previously crashed as a 500
    for (const additionalFilterRules of ['##.rule', [1], {}]) {
      const result = schema.safeParse({ url: 'https://example.com/', additionalFilterRules })
      t.assert.strictEqual(result.success, false, JSON.stringify(additionalFilterRules))
      // Element-level failures report their index as a second path segment
      t.assert.strictEqual(
        result.error.issues.filter(issue => issue.path[0] === 'additionalFilterRules').length, 1
      )
    }
  })

  it('caps list sizes before parsing elements', (t) => {
    // A body within the 200mb json limit could otherwise fan out into one
    // zod issue per element; a single total issue proves the size gates
    // reject before any element or record entry is parsed
    const oversizedRules = schema.safeParse({ url: 'https://example.com/', additionalFilterRules: Array(1001).fill(0) })
    t.assert.strictEqual(oversizedRules.error.issues.length, 1)
    t.assert.match(oversizedRules.error.issues[0].message, /at most 1000 rules/)

    // every entry must be in the allowlist, so exceeding its size can
    // never validate
    const oversizedFeatures = schema.safeParse({ url: 'https://example.com/', disableFeatures: ['FeatureX', 'FeatureX'] })
    t.assert.strictEqual(oversizedFeatures.error.issues.length, 1)
    t.assert.match(oversizedFeatures.error.issues[0].message, /at most 1 values/)

    // unknown list ids collapse into a single unrecognized_keys issue,
    // however many of them a body carries
    const manyUnknownLists = schema.safeParse({
      url: 'https://example.com/',
      adblockLists: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`list${index}`, 'yes']))
    })
    t.assert.strictEqual(manyUnknownLists.error.issues.length, 1)
    t.assert.strictEqual(manyUnknownLists.error.issues[0].code, 'unrecognized_keys')
  })

  it('restricts screenshot to the documented values', (t) => {
    for (const screenshot of [true, false, 'always', 'fullPage']) {
      t.assert.strictEqual(schema.safeParse({ url: 'https://example.com/', screenshot }).success, true, String(screenshot))
    }
    t.assert.strictEqual(issuesAt(schema.safeParse({ url: 'https://example.com/', screenshot: 'yes' }), 'screenshot').length, 1)
  })

  it('validates the url scheme', (t) => {
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'ftp://example.com/' }), 'url'),
      ['url must be a valid http or https URL']
    )
  })

  it('requires a url unless replaying an uploaded archive', (t) => {
    t.assert.deepStrictEqual(messagesAt(schema.safeParse({}), 'url'), ['url is required'])
    t.assert.deepStrictEqual(messagesAt(schema.safeParse({ url: '' }), 'url'), ['url is required'])
    t.assert.strictEqual(schema.safeParse({ wprGo: { action: 'replay', data: 'abc' } }).success, true)
    // Replay without data still needs a url: there is nothing to take one from
    t.assert.deepStrictEqual(messagesAt(schema.safeParse({ wprGo: { action: 'replay' } }), 'url'), ['url is required'])
  })

  it('validates wprGo actions and data', (t) => {
    t.assert.strictEqual(issuesAt(schema.safeParse({ url: 'https://example.com/', wprGo: { action: 'nope' } }), 'wprGo.action').length, 1)
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'https://example.com/', wprGo: { action: 'record', data: 'abc' } }), 'wprGo.data'),
      ['wprGo.data is only supported for replay action']
    )
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'https://example.com/', wprGo: { action: 'replay', data: '' } }), 'wprGo.data'),
      ['wprGo.data must be a non-empty base64 string']
    )
    // without data there is no archive to replay: WprGoSession would throw
    // mid-check and the routes would return an error report instead of 400
    t.assert.deepStrictEqual(
      messagesAt(schema.safeParse({ url: 'https://example.com/', wprGo: { action: 'replay' } }), 'wprGo.data'),
      ['wprGo.data is required for replay action']
    )
  })

  it('rejects server-local wprGo paths with the upload hint', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/', wprGo: { action: 'replay', path: '/etc/passwd' } })
    t.assert.deepStrictEqual(messagesAt(result, 'wprGo.path'), ['wprGo.path is not supported; upload the archive via wprGo.data'])
  })

  it('names unknown fields instead of dropping them', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/', wpr: { action: 'record' }, extra: 1 })
    t.assert.strictEqual(result.success, false)
    const unrecognized = result.error.issues.filter(issue => issue.code === 'unrecognized_keys')
    t.assert.deepStrictEqual(unrecognized.flatMap(issue => issue.keys ?? []), ['wpr', 'extra'])
    t.assert.strictEqual(issuesAt(result, 'wprGo').length, 0)
  })

  it('names unknown wprGo fields', (t) => {
    const result = schema.safeParse({ url: 'https://example.com/', wprGo: { action: 'record', captureInfo: {} } })
    t.assert.strictEqual(issuesAt(result, 'wprGo').length, 1)
  })
})

describe('check API request boundary', () => {
  let server
  let baseUrl

  before(async () => {
    // These tests only exercise the validation boundary, so the browser
    // binary is never launched; any placeholder works
    server = createApp({ browserBinaryPath: process.env.BRAVE_BINARY ?? 'unused-placeholder' }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  const post = (route, body) => fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })

  it('answers both check routes with 400 and per-issue details', async (t) => {
    for (const route of ['/check', '/check/stream']) {
      const response = await post(route, { device: 'Nope', viewport: 'Nope' })
      t.assert.strictEqual(response.status, 400)
      const body = await response.json()
      // device, viewport, the device+viewport exclusivity and the required
      // url: four issues, summarized after the first
      t.assert.strictEqual(body.error, 'Bad Request: device: unknown device (+3 more)')
      const paths = body.issues.map(issue => issue.path)
      t.assert.ok(paths.includes('device'), JSON.stringify(body))
      t.assert.ok(paths.includes('url'), JSON.stringify(body))
    }
  })

  it('answers invalid streams as JSON 400, not an event stream', async (t) => {
    const response = await post('/check/stream', {})
    t.assert.strictEqual(response.status, 400)
    t.assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    t.assert.ok((await response.json()).issues.some(issue => issue.message === 'url is required'))
  })

  it('names unknown fields at the HTTP boundary', async (t) => {
    // 'wpr' is the post-rename field name and must not be accepted on this
    // contract; the strict schema names it instead of silently dropping it
    const response = await post('/check', { url: 'https://example.com/', wpr: { action: 'record' } })
    t.assert.strictEqual(response.status, 400)
    const body = await response.json()
    t.assert.deepStrictEqual(
      body.issues.filter(issue => issue.code === 'unrecognized_keys').flatMap(issue => issue.keys ?? []),
      ['wpr']
    )
  })

  it('caps the issues detail list', async (t) => {
    const response = await post('/check', {
      url: 'https://example.com/',
      additionalFilterRules: Array.from({ length: 25 }, (_, index) => index)
    })
    t.assert.strictEqual(response.status, 400)
    const body = await response.json()
    t.assert.strictEqual(body.issues.length, 10)
    t.assert.match(body.error, /\(\+24 more\)$/)
  })

  it('caps the keys list of unrecognized-field issues', async (t) => {
    const response = await post('/check', {
      url: 'https://example.com/',
      ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, 1]))
    })
    t.assert.strictEqual(response.status, 400)
    const body = await response.json()
    const unknown = body.issues.find(issue => issue.code === 'unrecognized_keys')
    t.assert.strictEqual(unknown.keys.length, 50)
    t.assert.match(unknown.message, /\+10 more$/)
    // the primary error must inherit the truncation, not embed all 60 keys
    t.assert.match(body.error, /\+10 more/)
    t.assert.ok(!body.error.includes('field59'), body.error)
  })

  it('rejects oversized field names without echoing them', async (t) => {
    // otherwise a megabyte-sized unknown field name would ride into the
    // response three times (error, message and keys)
    const oversized = 'x'.repeat(4096)
    for (const body of [
      { url: 'https://example.com/', [oversized]: 1 },
      { url: 'https://example.com/', adblockLists: { [oversized]: true } }
    ]) {
      const response = await post('/check', body)
      t.assert.strictEqual(response.status, 400)
      const raw = await response.text()
      t.assert.match(JSON.parse(raw).error, /field names must be at most 500 characters/)
      t.assert.ok(raw.length < 300, raw)
    }
  })

  it('requires wprGo.data for replay before the check starts', async (t) => {
    // otherwise the routes would launch the check and answer with an error
    // report produced by WprGoSession throwing mid-run
    const response = await post('/check', { url: 'https://example.com/', wprGo: { action: 'replay' } })
    t.assert.strictEqual(response.status, 400)
    const body = await response.json()
    t.assert.deepStrictEqual(body.issues.map(issue => issue.path), ['wprGo.data'])
    t.assert.match(body.error, /wprGo\.data is required for replay action/)
  })
})
