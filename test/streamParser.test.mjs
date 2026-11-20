// Unit tests for the SSE parser embedded in src/index.html.
// The parser must stay a single inline script (the UI ships as one HTML
// file), so these tests slice it out verbatim between the BEGIN/END marker
// comments and import it as a data: URL module. That guarantees the tested
// code is exactly the code the browser runs.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const html = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'index.html'), 'utf8')
const beginMarker = '// BEGIN SSE stream parser'
const endMarker = '// END SSE stream parser'
const begin = html.indexOf(beginMarker)
const end = html.indexOf(endMarker)
assert.notEqual(begin, -1, 'BEGIN marker missing from src/index.html')
assert.notEqual(end, -1, 'END marker missing from src/index.html')
const snippet = html.slice(html.indexOf('\n', begin) + 1, end)
const { sseBlocks, parseSseBlock } = await import(
  'data:text/javascript,' + encodeURIComponent(`${snippet}\nexport { sseBlocks, parseSseBlock }`)
)

const buildWire = () => {
  const events = [
    { t: 0, phase: 'queued' },
    { t: 41, seq: 1, data: Buffer.from('frame-one-data').toString('base64') },
    { t: 99, seq: 2, data: Buffer.from('frame-two').toString('base64') },
    { url: 'https://example.com', result: 'phishing' }
  ]
  const wire = Buffer.from([
    ': ping\n\n',
    `event: progress\ndata: ${JSON.stringify(events[0])}\n\n`,
    `event: screenshot\ndata: ${JSON.stringify(events[1])}\n\n`,
    `event: screenshot\ndata: ${JSON.stringify(events[2])}\n\n`,
    `event: report\ndata: ${JSON.stringify(events[3])}\n\n`
  ].join(''), 'utf8')
  return { wire, events }
}

const collect = async (wire, chunkSize) => {
  let sent = 0
  const stream = new ReadableStream({
    pull (controller) {
      if (sent >= wire.length) {
        controller.close()
        return
      }
      controller.enqueue(wire.subarray(sent, Math.min(sent + chunkSize, wire.length)))
      sent += chunkSize
    }
  })
  const blocks = []
  for await (const block of sseBlocks(stream)) {
    blocks.push(block)
  }
  return blocks
}

test('parses the streamed check response shape at every chunk size', async () => {
  const { wire, events } = buildWire()
  const expectations = [
    { event: 'message', data: '' }, // comment lines (heartbeats) yield no data
    { event: 'progress', data: JSON.stringify(events[0]) },
    { event: 'screenshot', data: JSON.stringify(events[1]) },
    { event: 'screenshot', data: JSON.stringify(events[2]) },
    { event: 'report', data: JSON.stringify(events[3]) }
  ]
  for (const chunkSize of [1, 2, 3, 5, 7, 11, 64, 4096, wire.length]) {
    const blocks = await collect(wire, chunkSize)
    assert.equal(blocks.length, expectations.length, `chunk size ${chunkSize}`)
    expectations.forEach((expected, index) => {
      const parsed = parseSseBlock(blocks[index])
      assert.deepEqual(parsed, expected, `chunk size ${chunkSize}, block ${index}`)
    })
  }
})

test('parses SSE fields per the event-stream grammar', () => {
  assert.deepEqual(
    parseSseBlock('event: progress\ndata: {"phase":"queued"}'),
    { event: 'progress', data: '{"phase":"queued"}' }
  )
  // only one space is stripped after the colon (SSE spec)
  assert.deepEqual(parseSseBlock('event:  progress'), { event: ' progress', data: '' })
  // multi-line data joins with \n
  assert.deepEqual(parseSseBlock('data: line-one\ndata: line-two'), { event: 'message', data: 'line-one\nline-two' })
  // comment lines (heartbeats) are ignored
  assert.deepEqual(parseSseBlock(': ping'), { event: 'message', data: '' })
  // fields without a colon are ignored
  assert.deepEqual(parseSseBlock('garbage\ndata: x'), { event: 'message', data: 'x' })
  // the default event name is message
  assert.deepEqual(parseSseBlock('data: {}'), { event: 'message', data: '{}' })
})

test('handles \\n\\n split across every chunk boundary position', async () => {
  // stream the terminator in every possible split: '...\n' | '\n...' and
  // '\n' | '\n...' variants, with an event before and after
  const wire = Buffer.from('event: progress\ndata: {"a":1}\n\nevent: report\ndata: {"b":2}\n\n', 'utf8')
  for (const chunkSize of [1, 2, 3, 4, 5, 6, 7]) {
    const blocks = await collect(wire, chunkSize)
    assert.deepEqual(
      blocks.map(parseSseBlock),
      [
        { event: 'progress', data: '{"a":1}' },
        { event: 'report', data: '{"b":2}' }
      ],
      `chunk size ${chunkSize}`
    )
  }
})

test('handles a multi-megabyte event without quadratic copying', async () => {
  // a 16MB base64 report payload: joined exactly once when its terminator
  // arrives, so the test would time out under an O(n²) implementation
  const megabyte = 'x'.repeat(1024 * 1024)
  const wire = Buffer.from(
    `event: progress\ndata: {"phase":"queued"}\n\nevent: report\ndata: "${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}${megabyte}"\n\n`,
    'utf8'
  )
  const started = performance.now()
  const blocks = await collect(wire, 65536)
  const elapsed = performance.now() - started
  assert.equal(blocks.length, 2)
  assert.equal(parseSseBlock(blocks[1]).data.length, 16 * 1024 * 1024 + 2) // +2 quotes
  // linear implementation finishes in well under a second; the quadratic
  // one took tens of seconds (threshold picked with generous headroom)
  assert.ok(elapsed < 5000, `parsing took ${elapsed.toFixed(0)}ms`)
})
