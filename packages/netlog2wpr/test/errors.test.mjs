import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { NetLogError } from '../src/netlog/errors.mjs'
import { readNetLog } from '../src/netlog/reader.mjs'

describe('NetLogError', () => {
  it('carries name and message', () => {
    const error = new NetLogError('something went wrong')
    assert.strictEqual(error.name, 'NetLogError')
    assert.strictEqual(error.message, 'something went wrong')
    assert.ok(error instanceof Error)
    assert.ok(error instanceof NetLogError)
  })

  it('propagates the wrapped error as cause', () => {
    const cause = new Error('ENOENT: no such file')
    const error = new NetLogError('invalid netlog data: ENOENT: no such file', { cause })
    assert.strictEqual(error.cause, cause)
  })

  it('rejects a missing netlog path with a NetLogError', async () => {
    await assert.rejects(readNetLog('/cookiecrumbler-test/does-not-exist.ndjson'), { name: 'NetLogError', code: 'INVALID' })
  })

  it('carries the given code', () => {
    assert.strictEqual(new NetLogError('x', { code: 'INVALID' }).code, 'INVALID')
  })

  it('leaves the code undefined when omitted', () => {
    assert.strictEqual(new NetLogError('x').code, undefined)
  })
})
