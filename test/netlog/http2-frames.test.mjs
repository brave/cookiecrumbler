import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  HTTP2_CONNECTION_PREFACE, extractH2DataFrames
} from '../../src/netlog/http2-frames.mjs'
import { h2SentBytes } from '../helpers/netlog-fixtures.mjs'

// Builds one frame: 3-byte length, type, flags, 4-byte stream id (clearing
// the reserved bit), payload
const frame = (type, flags, streamId, payload) => {
  const header = Buffer.alloc(9)
  header.writeUIntBE(payload.length, 0, 3)
  header[3] = type
  header[4] = flags
  header.writeUInt32BE(streamId, 5)
  return Buffer.concat([header, payload])
}

const HEADERS = 0x1
const DATA = 0x0
const PADDED = 0x8

const withPreface = (...frames) => Buffer.concat([HTTP2_CONNECTION_PREFACE, ...frames])

describe('extractH2DataFrames', () => {
  it('recovers the body after preface and HEADERS', () => {
    const body = Buffer.from('payload')
    const parsed = extractH2DataFrames(h2SentBytes(3, body))
    assert.strictEqual(parsed.hasPreface, true)
    assert.strictEqual(parsed.truncated, false)
    assert.deepStrictEqual(parsed.dataByStream.get(3), body)
  })

  it('concatenates DATA frames per stream and keeps streams separate', () => {
    const bytes = withPreface(
      frame(HEADERS, 0x4, 1, Buffer.alloc(5)),
      frame(DATA, 0x0, 1, Buffer.from('aaa')),
      frame(DATA, 0x0, 1, Buffer.from('bbb')),
      frame(DATA, 0x0, 2, Buffer.from('zzz'))
    )
    const parsed = extractH2DataFrames(bytes)
    assert.strictEqual(parsed.dataByStream.get(1), Buffer.concat([Buffer.from('aaa'), Buffer.from('bbb')]).equals(parsed.dataByStream.get(1)) ? parsed.dataByStream.get(1) : null)
    assert.ok(Buffer.from('aaabbb').equals(parsed.dataByStream.get(1)))
    assert.ok(Buffer.from('zzz').equals(parsed.dataByStream.get(2)))
    assert.strictEqual(parsed.truncated, false)
  })

  it('strips padding from PADDED DATA frames', () => {
    const bytes = withPreface(
      frame(DATA, PADDED, 7, Buffer.concat([Buffer.from([2]), Buffer.from('body'), Buffer.from('xx')]))
    )
    const parsed = extractH2DataFrames(bytes)
    assert.ok(Buffer.from('body').equals(parsed.dataByStream.get(7)))
    assert.strictEqual(parsed.truncated, false)
  })

  it('stops at an invalid pad length, keeping earlier frames', () => {
    const bytes = withPreface(
      frame(DATA, 0x0, 1, Buffer.from('good')),
      frame(DATA, PADDED, 2, Buffer.concat([Buffer.from([200]), Buffer.from('tiny')]))
    )
    const parsed = extractH2DataFrames(bytes)
    assert.ok(Buffer.from('good').equals(parsed.dataByStream.get(1)))
    assert.strictEqual(parsed.dataByStream.get(2), undefined)
    assert.strictEqual(parsed.truncated, true)
  })

  it('stops at an incomplete trailing frame, keeping earlier frames', () => {
    const bytes = withPreface(
      frame(DATA, 0x0, 1, Buffer.from('keep')),
      frame(DATA, 0x0, 2, Buffer.from('cut')) // header complete, payload short
    )
    const cut = bytes.subarray(0, bytes.length - 2)
    const parsed = extractH2DataFrames(cut)
    assert.ok(Buffer.from('keep').equals(parsed.dataByStream.get(1)))
    assert.strictEqual(parsed.dataByStream.get(2), undefined)
    assert.strictEqual(parsed.truncated, true)
  })

  it('flags a partial frame header as truncated', () => {
    const bytes = withPreface(frame(DATA, 0x0, 1, Buffer.from('x')))
    const parsed = extractH2DataFrames(bytes.subarray(0, bytes.length - 3))
    assert.strictEqual(parsed.truncated, true)
  })

  it('returns empty without the connection preface', () => {
    const parsed = extractH2DataFrames(frame(DATA, 0x0, 1, Buffer.from('no preface')))
    assert.deepStrictEqual([...parsed.dataByStream], [])
    assert.strictEqual(parsed.hasPreface, false)
    assert.strictEqual(parsed.truncated, false)
  })

  it('ignores DATA frames on stream 0', () => {
    const bytes = withPreface(
      frame(DATA, 0x0, 0, Buffer.from('bogus')),
      frame(DATA, 0x0, 3, Buffer.from('ok'))
    )
    const parsed = extractH2DataFrames(bytes)
    assert.strictEqual(parsed.dataByStream.get(0), undefined)
    assert.ok(Buffer.from('ok').equals(parsed.dataByStream.get(3)))
    assert.strictEqual(parsed.truncated, false)
  })

  it('ignores zero-length DATA frames', () => {
    const bytes = withPreface(frame(DATA, 0x0, 1, Buffer.alloc(0)))
    const parsed = extractH2DataFrames(bytes)
    assert.strictEqual(parsed.dataByStream.get(1), undefined)
    assert.strictEqual(parsed.truncated, false)
  })

  it('rejects a zero-length padded DATA frame as a protocol error', () => {
    // PADDED requires a pad length byte (RFC 9113 §6.1); a zero-length
    // payload has no room for it
    const bytes = withPreface(frame(DATA, PADDED, 1, Buffer.alloc(0)))
    const parsed = extractH2DataFrames(bytes)
    assert.strictEqual(parsed.dataByStream.get(1), undefined)
    assert.strictEqual(parsed.truncated, true)
  })

  it('accepts a zero-length padded DATA frame with an empty pad', () => {
    const bytes = withPreface(
      frame(DATA, PADDED, 2, Buffer.from([0])), // pad length 0, no data
      frame(DATA, 0x0, 3, Buffer.from('ok'))
    )
    const parsed = extractH2DataFrames(bytes)
    assert.strictEqual(parsed.dataByStream.get(2), undefined)
    assert.ok(Buffer.from('ok').equals(parsed.dataByStream.get(3)))
    assert.strictEqual(parsed.truncated, false)
  })
})
