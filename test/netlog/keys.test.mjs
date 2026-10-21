import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { sourceKey, sourceKeyOf, depKey } from '../../src/netlog/keys.mjs'

describe('netlog source keys', () => {
  it('builds "<type>:<id>" keys', () => {
    assert.strictEqual(sourceKey(1, 100), '1:100')
    assert.strictEqual(sourceKey(4, 2), '4:2')
  })

  it('sourceKeyOf returns null for missing id, missing type, and undefined', () => {
    assert.strictEqual(sourceKeyOf({ id: 1, type: 2 }), '2:1')
    assert.strictEqual(sourceKeyOf({ type: 2 }), null)
    assert.strictEqual(sourceKeyOf({ id: 1 }), null)
    assert.strictEqual(sourceKeyOf({}), null)
    assert.strictEqual(sourceKeyOf(undefined), null)
  })

  it('depKey keys the source_dependency param, or null without one', () => {
    assert.strictEqual(depKey({ source_dependency: { id: 3, type: 2 } }), '2:3')
    assert.strictEqual(depKey({}), null)
    assert.strictEqual(depKey(undefined), null)
    // either part missing → null
    assert.strictEqual(depKey({ source_dependency: { id: 3 } }), null)
  })
})
