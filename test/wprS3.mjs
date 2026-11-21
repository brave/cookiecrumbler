// Unit tests for the WprGo archive S3 storage: key derivation, capture
// classification and request validation helpers. The PSL is fetched from the
// same source prepareProfile uses when it is not on disk yet (CI fetches it
// through test.mjs's prepareProfile hook), so the PSL-dependent tests run
// wherever the list is reachable; without network they skip. The ministack
// integration test only runs when the S3 env vars point at a live endpoint.

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { describe, it } from 'node:test'

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

import { suffixInfoForHostname } from '../src/suffixInfo.mjs'
import { classifyCapture } from '../src/setupUtil.mjs'
import { ARCHIVE_OPTIONS, WprS3Error, archiveModeWantsS3, buildArchiveKey, createS3Client, uploadWprArchive, wprS3Enabled } from '../src/wprS3.mjs'

const pslPath = path.join(import.meta.dirname, '..', 'public_suffix_list.dat')

let pslAvailable = existsSync(pslPath)
if (!pslAvailable) {
  const tmpPath = `${pslPath}.wprS3-test`
  try {
    const response = await fetch('https://publicsuffix.org/list/public_suffix_list.dat', { signal: AbortSignal.timeout(15000) })
    if (response.ok) {
      // Atomic write: concurrent readers (test.mjs's own fetch) must never
      // see a truncated list
      await fs.writeFile(tmpPath, await response.text())
      await fs.rename(tmpPath, pslPath)
      pslAvailable = existsSync(pslPath)
    }
  } catch {
    await fs.rm(tmpPath, { force: true })
    // Skip the PSL-dependent tests below
  }
}
if (!pslAvailable) {
  console.log('public_suffix_list.dat unavailable; skipping PSL-dependent tests')
}

// 2026-11-18T04:11:22.123Z
const RECORDED_AT = Date.UTC(2026, 10, 18, 4, 11, 22, 123)

// Key layout: <class>/<domain components...>/<YYYY>/<MM>/<DD>/<filename>;
// the domain part itself contains slashes, so segments are parsed from the end
const parseKey = (key) => {
  const segments = key.split('/')
  const filename = segments.pop()
  const date = segments.splice(-3)
  const captureClass = segments.shift()
  return { captureClass, domainPart: segments.join('/'), date, filename }
}

const assertKey = (t, url, expectedDomainPart, { captureClass = 'full', recordedAt = RECORDED_AT } = {}) => {
  return buildArchiveKey({ captureClass, url, recordedAt }).then(key => {
    const parsed = parseKey(key)
    t.assert.strictEqual(parsed.captureClass, captureClass)
    t.assert.strictEqual(parsed.domainPart, expectedDomainPart)
    t.assert.deepStrictEqual(parsed.date, ['2026', '11', '18'])
    t.assert.match(parsed.filename, /^20261118T041122Z-[0-9a-f]{8}\.wpr$/)
    return key
  })
}

describe('suffixInfoForHostname', { skip: !pslAvailable }, () => {
  const cases = [
    // [hostname, suffix, official, isPrivate]
    ['example.com', 'com', true, false],
    ['www.example.com', 'com', true, false],
    ['news.bbc.co.uk', 'co.uk', true, false],
    ['bbc.uk', 'uk', true, false],
    ['police.uk', 'police.uk', true, false],
    ['foo.school.ck', 'school.ck', true, false],
    ['something.github.io', 'github.io', true, true],
    ['app.blogspot.com', 'blogspot.com', true, true],
    ['tenant.compute.amazonaws.com', 'tenant.compute.amazonaws.com', true, true],
    ['haha.whatisthis.global.prod.fastly.net', 'global.prod.fastly.net', true, true],
    ['münchen.de', 'de', true, false],
    // Implicit "*" fallback rule: matched, but not an official PSL entry
    ['localhost', 'localhost', false, false],
    ['foo.corp', 'corp', false, false],
    ['192.168.1.1', '1', false, false]
  ]

  for (const [hostname, suffix, official, isPrivate] of cases) {
    it(`classifies ${hostname}`, async (t) => {
      const info = await suffixInfoForHostname(hostname)
      t.assert.strictEqual(info.hostname, hostname === 'münchen.de' ? 'xn--mnchen-3ya.de' : hostname)
      t.assert.strictEqual(info.suffix, suffix)
      t.assert.strictEqual(info.official, official)
      t.assert.strictEqual(info.isPrivate, isPrivate)
    })
  }

  it('derives the registrable domain', async (t) => {
    const info = await suffixInfoForHostname('a.b.planespotters.net')
    t.assert.strictEqual(info.registrable, 'planespotters.net')
    t.assert.strictEqual((await suffixInfoForHostname('blogspot.com')).registrable, '')
  })
})

describe('buildArchiveKey', { skip: !pslAvailable }, () => {
  it('builds keys for the documented host table', async (t) => {
    const cases = [
      ['https://example.com/', 'com/example'],
      ['https://www.example.com/', 'com/example/www'],
      ['https://www.planespotters.net/', 'net/planespotters/www'],
      ['https://mobile.planespotters.net/', 'net/planespotters/mobile'],
      ['https://a.b.planespotters.net/', 'net/planespotters/b/a'],
      ['https://news.bbc.co.uk/', 'co.uk/bbc/news'],
      ['https://bbc.co.uk/', 'co.uk/bbc'],
      ['https://bbc.uk/', 'uk/bbc'],
      ['https://foo.org.uk/', 'org.uk/foo'],
      ['https://support.google.com.au/', 'com.au/google/support'],
      // Host is itself an official multi-label suffix
      ['https://police.uk/', 'police.uk'],
      ['https://foo.school.ck/', 'school.ck/foo'],
      ['https://www.ck/', 'ck/www'],
      // PRIVATE suffixes stay split, tld first
      ['https://something.github.io/', 'io/github/something'],
      ['https://github.io/', 'io/github'],
      ['https://app.blogspot.com/', 'com/blogspot/app'],
      ['https://blogspot.com/', 'com/blogspot'],
      ['https://haha.whatisthis.global.prod.fastly.net/', 'net/fastly/prod/global/whatisthis/haha'],
      ['https://tenant.compute.amazonaws.com/', 'com/amazonaws/compute/tenant'],
      // IDN
      ['https://münchen.de/', 'de/xn--mnchen-3ya']
    ]
    for (const [url, expected] of cases) {
      await assertKey(t, url, expected)
    }
  })

  it('refuses hostnames without a public suffix list domain', async (t) => {
    for (const url of ['http://192.168.1.1/', 'http://localhost/', 'http://foo.corp/', 'http://[::1]/']) {
      await t.assert.rejects(buildArchiveKey({ captureClass: 'full', url, recordedAt: RECORDED_AT }), WprS3Error)
    }
  })

  it('rejects unknown capture classes', async (t) => {
    await t.assert.rejects(
      buildArchiveKey({ captureClass: 'nope', url: 'https://example.com/', recordedAt: RECORDED_AT }),
      WprS3Error
    )
  })

  it('rejects invalid URLs', async (t) => {
    await t.assert.rejects(
      buildArchiveKey({ captureClass: 'full', url: '::', recordedAt: RECORDED_AT }),
      WprS3Error
    )
  })

  it('keeps keys far below the S3 1024-byte limit for maximum-length hostnames', async (t) => {
    // Four maximum-length labels (63 chars each) under a real TLD: 63*4 + 5 = 257 > 253,
    // so shorten the last label to stay DNS-navigable
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(52)}.net`
    const key = await buildArchiveKey({ captureClass: 'full', url: `https://${host}/`, recordedAt: RECORDED_AT })
    t.assert.ok(key.length <= 1024, `key too long: ${key.length}`)
    t.assert.ok(key.startsWith('full/'))
  })

  it('derives the date partition from recordedAt in UTC', async (t) => {
    const key = await buildArchiveKey({ captureClass: 'default', url: 'https://example.com/', recordedAt: Date.UTC(2026, 11, 24, 9, 30, 0) })
    const parsed = parseKey(key)
    t.assert.deepStrictEqual(parsed.date, ['2026', '12', '24'])
    t.assert.strictEqual(parsed.domainPart, 'com/example')
    t.assert.match(parsed.filename, /^20261224T093000Z-[0-9a-f]{8}\.wpr$/)
  })

  it('produces unique keys for repeated calls', async (t) => {
    const first = await buildArchiveKey({ captureClass: 'full', url: 'https://example.com/', recordedAt: RECORDED_AT })
    const second = await buildArchiveKey({ captureClass: 'full', url: 'https://example.com/', recordedAt: RECORDED_AT })
    t.assert.notStrictEqual(first, second)
  })
})

describe('classifyCapture', () => {
  const optionalListIds = ['listA', 'listB']
  // Catalog fixture: listA/listB are the exposed optional lists, the
  // default-filters component is hidden-but-toggleable, regional is an
  // off-by-default desktop list
  const listCatalog = [
    { list_text_component: { component_id: 'defaultFilters' }, default_enabled: true },
    { list_text_component: { component_id: 'regional' }, default_enabled: undefined }
  ]

  it('classifies an absent list configuration as default', () => {
    for (const adblockLists of [undefined, {}, { listA: true, listB: true }]) {
      if (classifyCapture({ adblockLists, optionalListIds, listCatalog }) !== 'default') {
        throw new Error(`expected default for ${JSON.stringify(adblockLists)}`)
      }
    }
  })

  it('classifies all-disabled as full', () => {
    if (classifyCapture({ adblockLists: { listA: false, listB: false }, optionalListIds, listCatalog }) !== 'full') {
      throw new Error('expected full')
    }
  })

  it('classifies partial configurations as custom', () => {
    for (const adblockLists of [{ listA: false }, { listB: false }, { listA: false, listB: true }, { listA: true, listB: false }]) {
      if (classifyCapture({ adblockLists, optionalListIds, listCatalog }) !== 'custom') {
        throw new Error(`expected custom for ${JSON.stringify(adblockLists)}`)
      }
    }
  })

  it('forces custom when a non-optional catalog entry deviates from its default', () => {
    const cases = [
      // Disabling the default filter lists is not a "default" capture
      { listA: true, listB: true, defaultFilters: false },
      // Enabling a regional list is not the replay-safe baseline
      { listA: false, listB: false, regional: true }
    ]
    for (const adblockLists of cases) {
      if (classifyCapture({ adblockLists, optionalListIds, listCatalog }) !== 'custom') {
        throw new Error(`expected custom for ${JSON.stringify(adblockLists)}`)
      }
    }
  })

  it('ignores explicit values that match a non-optional entry default', () => {
    if (classifyCapture({ adblockLists: { listA: false, listB: false, regional: false }, optionalListIds, listCatalog }) !== 'full') {
      throw new Error('expected full')
    }
    if (classifyCapture({ adblockLists: { defaultFilters: true }, optionalListIds, listCatalog }) !== 'default') {
      throw new Error('expected default')
    }
  })

  it('classifies additional filter rules as custom', () => {
    if (classifyCapture({ optionalListIds, listCatalog, additionalFilterRules: ['##.cookie-banner'] }) !== 'custom') {
      throw new Error('expected custom')
    }
  })

  it('classifies empty optional list sets as default', () => {
    if (classifyCapture({ adblockLists: { anything: false }, optionalListIds: [], listCatalog }) !== 'default') {
      throw new Error('expected default')
    }
  })

  it('ignores unknown list ids that the catalog patcher skips', () => {
    // patchListCatalog only applies ids present in the catalog, so a stale
    // or unknown id must not force the custom bucket
    for (const adblockLists of [
      { staleListId: true },
      { staleListId: false, listA: true, listB: true },
      { staleListId: true, listA: false, listB: false }
    ]) {
      const expected = adblockLists.listA === false && adblockLists.listB === false ? 'full' : 'default'
      if (classifyCapture({ adblockLists, optionalListIds, listCatalog }) !== expected) {
        throw new Error(`expected ${expected} for ${JSON.stringify(adblockLists)}`)
      }
    }
  })
})

describe('wpr.archive option helpers', () => {
  it('exposes exactly the documented option values', () => {
    if (JSON.stringify(ARCHIVE_OPTIONS) !== JSON.stringify(['', 'none', 'inline', 's3', 's3+inline'])) {
      throw new Error(`unexpected ARCHIVE_OPTIONS: ${JSON.stringify(ARCHIVE_OPTIONS)}`)
    }
  })

  it('maps s3 modes only', () => {
    for (const [archive, expected] of [['s3', true], ['s3+inline', true], ['inline', false], ['', false], ['none', false], [undefined, false]]) {
      if (archiveModeWantsS3(archive) !== expected) {
        throw new Error(`wantsS3(${String(archive)}) should be ${expected}`)
      }
    }
  })
})

describe('ministack integration', { skip: !pslAvailable || !wprS3Enabled() || !process.env.S3_ENDPOINT_URL }, () => {
  it('round-trips an upload through ListObjectsV2-visible storage', async (t) => {
    const key = await buildArchiveKey({ captureClass: 'full', url: 'https://example.com/', recordedAt: RECORDED_AT })
    const body = Buffer.from('1f8b0800000000000000', 'hex')
    await uploadWprArchive(body, key)

    // Same env handling as the upload path (createS3Client), fresh instance
    const client = createS3Client()
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: process.env.WPR_ARCHIVES_BUCKET, Key: key }))
      t.assert.strictEqual(head.ContentLength, body.length)
      const got = await client.send(new GetObjectCommand({ Bucket: process.env.WPR_ARCHIVES_BUCKET, Key: key }))
      t.assert.strictEqual(Buffer.compare(Buffer.from(await got.Body.transformToByteArray()), body), 0)
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: process.env.WPR_ARCHIVES_BUCKET, Key: key }))
      client.destroy()
    }
  })
})
