import { once } from 'node:events'
import fs from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'

process.env.MAX_CONCURRENCY = '1'
process.env.MAX_CONCURRENCY_WAIT_MS = '50'
const { app } = await import('../src/api.mjs')

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

  function post (body, contentType = 'application/json') {
    return fetch(`http://127.0.0.1:${server.address().port}/check`, {
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
    await assertJsonError(t, await post('{"url":"file:///fixture"}'), 400, {
      error: 'Bad Request: url must be a valid http or https URL'
    })
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
})
