import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderDeterministicScript } from '../src/deterministic.mjs'

describe('deterministic.js placeholder rendering', () => {
  it('replaces legacy and bare placeholders like wpr does', () => {
    const script = 'var seed = {{WPR_TIME_SEED_TIMESTAMP}}; var bare = WPR_TIME_SEED_TIMESTAMP; var rand = {{WPR_CONSTANT_RANDOM_RESULT}};'
    assert.strictEqual(renderDeterministicScript(script, 123000, null), 'var seed = 123000; var bare = 123000; var rand = null;')
    assert.strictEqual(renderDeterministicScript(script, 123000, 0.5), 'var seed = 123000; var bare = 123000; var rand = 0.5;')
  })

  it('renders an omitted Math.random result as null like a null one', () => {
    const script = 'var legacy = {{WPR_CONSTANT_RANDOM_RESULT}}; var bare = WPR_CONSTANT_RANDOM_RESULT;'
    assert.strictEqual(renderDeterministicScript(script, 123000), 'var legacy = null; var bare = null;')
  })

  it('renders a zero Math.random result as the number 0', () => {
    const script = 'var legacy = {{WPR_CONSTANT_RANDOM_RESULT}}; var bare = WPR_CONSTANT_RANDOM_RESULT;'
    assert.strictEqual(renderDeterministicScript(script, 123000, 0), 'var legacy = 0; var bare = 0;')
  })
})
