# netlog2wpr

Converts Chromium NetLog captures (recorded with the "Everything" capture
mode) into WebPageReplay (wpr-go) record-format archive objects. Capture
(Chromium flags, browser launch) and replay stay in the embedding app.

Requires Node >= 24. ESM only.

## API

- `netlogToWprArchive(netlogPath, options)` → `Promise<{ archive, stats, warnings }>`:
  parses a netlog file and serializes the reconstructed exchanges into a
  WprGo archive. Throws `NetLogError` with `code: 'NO_REQUESTS'` when the
  netlog contains no recorded requests and `code: 'ALL_DROPPED'` when
  serialization dropped every exchange (truncated HTTP/1 bodies).
- `parseNetLog(netlogPath, options)` → `Promise<{ exchanges, negotiatedProtocols, stats }>`:
  netlog file → chronological HTTP exchanges.
- `archiveFromExchanges(exchanges, negotiatedProtocols, options)` → archive
  object: exchanges → WprGo archive (`Requests`, `Certs`, `InjectedScripts`, …).
- `isInternalRequest(startJobParams)`: whether a URL_REQUEST START_JOB belongs
  to browser-internal traffic (updater, Safe Browsing, telemetry, spellcheck).
- `createRecordingContext({ deterministicScript, now })` → `{ timeSeedMs, injectScript, archiveOptions }`:
  record-time deterministic.js injection plus the archive options embedding
  the unrendered script for replay.
- `renderDeterministicScript(script, timeSeedMs, constantMathRandomResult)`:
  renders the deterministic.js placeholders exactly like wpr does.
- `NetLogError`: error class thrown for parser/serializer failures; carries a
  `code` (`INVALID`, `CAP_REACHED`, `TRUNCATED`, `MISSING_CONSTANTS`,
  `CHUNKED_UPLOAD`, `NO_REQUESTS`, `ALL_DROPPED`).
- `DEFAULT_NETLOG_CAP_MB`: default `maxNetlogBytes` (300).

```js
import { netlogToWprArchive } from 'netlog2wpr'

const { archive, stats, warnings } = await netlogToWprArchive('netlog.ndjson', {
  maxNetlogBytes: 300 * 1024 * 1024,
  metadata: JSON.stringify({ originalUrl: 'https://example.com/', recordedAt: new Date().toISOString() })
})
```

## Capture requirements

- record with `--net-log-capture-mode=Everything`
- NDJSON format: `--net-log-file-format=ndjson`
- `--disable-quic` (QUIC responses carry no recoverable body bytes in the
  netlog)
- `CompressionDictionaryTransport` and `SharedDictionaryCache` disabled
- a cold browser profile
- pass `maxNetlogBytes` equal to the browser's `--net-log-max-size-mb` (the
  parser rejects files at 90% of that cap because bounded mode rotates older
  events away)

## The deterministic-script gap

Record-time injection via `createRecordingContext().injectScript` +
`page.evaluateOnNewDocument` runs in every document and ignores CSP, while
replay-time wpr injection only covers `text/html` 200 responses and is
subject to CSP. `seedCspReplayNonce` — applied automatically by
`archiveFromExchanges` via `replayNonce` — covers the CSP part of that gap.

## Target

Targets the wpr fork
`brave-experiments/webpagereplay@e1c683f26a53fa7923e9987d0d35fcbe081b65c3`.

## Privacy

Archives contain cookies and auth headers. Do not share unredacted archives.
