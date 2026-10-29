import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createRecordingContext } from '../src/recording.mjs'
import { renderDeterministicScript } from '../src/deterministic.mjs'

const SCRIPT = 'var seed = {{WPR_TIME_SEED_TIMESTAMP}}; var bare = WPR_TIME_SEED_TIMESTAMP; var rand = {{WPR_CONSTANT_RANDOM_RESULT}};'

describe('createRecordingContext', () => {
  it('floors the time seed to whole seconds like wpr record', () => {
    const { timeSeedMs } = createRecordingContext({ deterministicScript: SCRIPT, now: 1234567 })
    assert.strictEqual(timeSeedMs, 1234000)
  })

  it('renders the record-time injection with a null Math.random result', () => {
    const { timeSeedMs, injectScript } = createRecordingContext({ deterministicScript: SCRIPT, now: 1234567 })
    // At record time the constant must stay unpinned, so it renders as null
    assert.strictEqual(injectScript, 'var seed = 1234000; var bare = 1234000; var rand = null;')
    assert.strictEqual(injectScript, renderDeterministicScript(SCRIPT, timeSeedMs, null))
  })

  it('returns archive options embedding the unrendered script and the time seed', () => {
    const { archiveOptions } = createRecordingContext({ deterministicScript: SCRIPT, now: 1234567 })
    assert.deepStrictEqual(archiveOptions, {
      injectedScripts: { 'deterministic.js': SCRIPT },
      deterministicTimeSeedMs: 1234000
    })
  })

  it('defaults now to Date.now() and produces a whole-second time seed', () => {
    const before = Date.now()
    const { timeSeedMs } = createRecordingContext({ deterministicScript: SCRIPT })
    assert.strictEqual(timeSeedMs % 1000, 0)
    assert.ok(timeSeedMs >= before - 1000)
    assert.ok(timeSeedMs <= Date.now())
  })
})
