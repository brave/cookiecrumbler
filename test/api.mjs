import { once } from 'node:events'
import fs from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/api.mjs'

process.env.MAX_CONCURRENCY = '1'
process.env.MAX_CONCURRENCY_WAIT_MS = '50'
const app = createApp({ browserBinaryPath: 'unused-browser' })

describe('POST /check errors', () => {
  let server
  const validRequest = JSON.stringify({ url: 'https://example.test/' })

  before(async () => {
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
  })

  after(async () => {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })

  function post (body, contentType = 'application/json', route = '/check') {
    return fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(5000)
    })
  }

  async function assertJsonError (t, response, status, body) {
    t.assert.strictEqual(response.status, status)
    t.assert.match(response.headers.get('content-type'), /^application\/json\b/)
    t.assert.deepStrictEqual(await response.json(), body)
  }

  function assertUrlValidationError (t, response) {
    return assertJsonError(t, response, 400, {
      error: 'Bad Request: url: url must be a valid http or https URL',
      issues: [{ path: 'url', code: 'custom', message: 'url must be a valid http or https URL' }]
    })
  }

  it('formats malformed JSON errors from the body parser', async (t) => {
    await assertJsonError(t, await post('{'), 400, {
      error: 'Bad Request',
      identified: false
    })
  })

  it('preserves the body parser status when the request is too large', async (t) => {
    const response = await post('field=' + 'x'.repeat(64 * 1024), 'application/x-www-form-urlencoded')
    await assertJsonError(t, response, 413, {
      error: 'Payload Too Large',
      identified: false
    })
  })

  it('keeps the existing URL validation error', async (t) => {
    await assertUrlValidationError(t, await post('{"url":"file:///fixture"}'))
  })

  it('reports a check failure without exposing the exception to the client', async (t) => {
    const failure = new Error('timeout')
    t.mock.method(fs, 'mkdtemp', async () => { throw failure })
    const emit = t.mock.method(app, 'emit')

    await assertJsonError(t, await post(validRequest), 500, {
      error: 'Internal Server Error',
      identified: false
    })
    t.assert.ok(emit.mock.calls.some(({ arguments: args }) => args[0] === 'error' && args[1] === failure))
  })

  it('returns 429 when waiting for a check slot times out', async (t) => {
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.mock.method(fs, 'mkdtemp', async () => {
      started.resolve()
      await release.promise
      throw new Error('fixture check failed')
    })

    const first = post(validRequest)
    try {
      await Promise.race([
        started.promise,
        first.then(() => t.assert.fail('First request completed without acquiring a check slot'))
      ])
      await assertJsonError(t, await post(validRequest), 429, {
        error: 'Too Many Requests: server is at capacity'
      })
    } finally {
      release.resolve()
      const response = await first
      await response.body.cancel()
    }
  })

  it('formats malformed JSON before streaming headers are sent', async (t) => {
    await assertJsonError(t, await post('{', 'application/json', '/check/stream'), 400, {
      error: 'Bad Request',
      identified: false
    })
  })

  it('keeps streaming-route validation errors in JSON', async (t) => {
    await assertUrlValidationError(t, await post('{"url":"file:///fixture"}', 'application/json', '/check/stream'))
  })

  it('keeps check failures in-band after streaming headers are sent', async (t) => {
    const failure = new Error('fixture streamed failure')
    const release = Promise.withResolvers()
    t.mock.method(fs, 'mkdtemp', async () => {
      await release.promise
      throw failure
    })

    try {
      const response = await post(validRequest, 'application/json', '/check/stream')
      t.assert.strictEqual(response.status, 200)
      t.assert.match(response.headers.get('content-type'), /^text\/event-stream\b/)
      release.resolve()
      const body = await response.text()
      t.assert.match(body, /event: progress\ndata: .*"phase":"queued"/)
      const errorEvent = body.match(/event: error\ndata: (.*)\n/)
      t.assert.ok(errorEvent)
      t.assert.strictEqual(typeof JSON.parse(errorEvent[1]).error, 'string')
      t.assert.notStrictEqual(JSON.parse(errorEvent[1]).error, '')
      t.assert.doesNotMatch(body, /event: report\n/)
    } finally {
      release.resolve()
    }
  })

  it('keeps capacity timeouts in-band on the streaming route', async (t) => {
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.mock.method(fs, 'mkdtemp', async () => {
      started.resolve()
      await release.promise
      throw new Error('fixture check failed')
    })

    const first = post(validRequest)
    try {
      await Promise.race([
        started.promise,
        first.then(() => t.assert.fail('First request completed without acquiring a check slot'))
      ])
      const response = await post(validRequest, 'application/json', '/check/stream')
      t.assert.strictEqual(response.status, 200)
      t.assert.match(response.headers.get('content-type'), /^text\/event-stream\b/)
      const body = await response.text()
      const errorEvent = body.match(/event: error\ndata: (.*)\n/)
      t.assert.ok(errorEvent)
      t.assert.deepStrictEqual(JSON.parse(errorEvent[1]), {
        error: 'Too Many Requests: server is at capacity'
      })
      t.assert.doesNotMatch(body, /event: report\n/)
    } finally {
      release.resolve()
      const response = await first
      await response.body.cancel()
    }
  })
})
