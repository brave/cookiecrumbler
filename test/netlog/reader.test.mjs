import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { readNetLog } from '../../src/netlog/reader.mjs'
import { event, ST, writeNetlog, writeRawNetlog } from '../helpers/netlog-fixtures.mjs'

describe('readNetLog', () => {
  it('reads the legacy single-JSON format', async (t) => {
    const events = [event(ST.URL_REQUEST, 1, 2, { url: 'https://example.com/' })]
    const netlogPath = await writeNetlog(t, events)
    const netlog = await readNetLog(netlogPath)
    assert.deepStrictEqual(netlog.events, events)
    assert.strictEqual(netlog.constants.logCaptureMode, 'Everything')
  })

  it('reads the NDJSON format, ignoring polledData and end lines', async (t) => {
    const events = [event(ST.URL_REQUEST, 1, 2, { url: 'https://example.com/' })]
    const netlogPath = await writeNetlog(t, events, { format: 'ndjson' })
    const netlog = await readNetLog(netlogPath)
    assert.deepStrictEqual(netlog.events, events)
    assert.strictEqual(netlog.constants.logCaptureMode, 'Everything')
  })

  it('rejects truncated legacy JSON', async (t) => {
    const netlogPath = await writeRawNetlog(t, '{"constants": {}, "events": [')
    await assert.rejects(readNetLog(netlogPath), { name: 'NetLogError' })
  })

  it('rejects an NDJSON stream missing its end record', async (t) => {
    // A browser killed between lines leaves a file that parses cleanly but is
    // missing everything it never got to write
    const netlogPath = await writeRawNetlog(t, [
      JSON.stringify({ type: 'constants', constants: { logEventTypes: {}, logSourceType: {} } }),
      JSON.stringify({ type: 'event', event: event(ST.URL_REQUEST, 1, 2, { url: 'https://example.com/' }) })
    ].join('\n') + '\n', 'netlog.ndjson')
    await assert.rejects(readNetLog(netlogPath), {
      name: 'NetLogError',
      message: /ended without its end record/
    })
  })

  it('rejects an NDJSON stream missing its constants record', async (t) => {
    const netlogPath = await writeRawNetlog(t, [
      JSON.stringify({ type: 'event', event: event(ST.URL_REQUEST, 1, 2, { url: 'https://example.com/' }) }),
      JSON.stringify({ type: 'end' })
    ].join('\n') + '\n', 'netlog.ndjson')
    await assert.rejects(readNetLog(netlogPath), {
      name: 'NetLogError',
      message: /missing its constants record/
    })
  })

  it('rejects a file at the size limit with the exact message', async (t) => {
    const maxNetlogBytes = 100
    // Bounded mode stitches a file at or below the browser cap; the parser
    // rejects already at 90% of the cap, so a full 100-byte cap file fails
    const netlogPath = await writeRawNetlog(t, 'x'.repeat(100), 'netlog.ndjson')
    await assert.rejects(readNetLog(netlogPath, { maxNetlogBytes }), {
      name: 'NetLogError',
      message: `netlog file (100 bytes) reached the 90 byte limit (90% of the ${maxNetlogBytes} byte browser cap); earlier traffic was dropped`
    })
  })

  it('rejects a missing file', async () => {
    await assert.rejects(readNetLog('/cookiecrumbler-test/does-not-exist.ndjson'), { name: 'NetLogError' })
  })
})
