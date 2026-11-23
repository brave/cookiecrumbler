// S3 storage for recorded WprGo archives: the opt-in destination for record
// captures (wpr.archive: 's3' | 's3+inline'), with archive keys derived from
// the capture's URL and filter-list class so the bucket layout answers
// ListObjectsV2 prefix queries directly (per domain, per class, per date).
// Storage is auxiliary to the check itself: every failure here is reported,
// never fatal for the captured archive.

import { randomBytes } from 'node:crypto'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

import { suffixInfoForHostname } from './suffixInfo.mjs'

export class WprS3Error extends Error {}

// Requested archive handling for record captures (wpr.archive). Absent,
// '' and 'none' keep today's behavior: the archive is returned inline and
// nothing is stored.
export const ARCHIVE_OPTIONS = ['', 'none', 'inline', 's3', 's3+inline']

export const archiveModeWantsS3 = (archive) => {
  return archive === 's3' || archive === 's3+inline'
}

export const wprS3Enabled = () => {
  return Boolean(process.env.WPR_ARCHIVES_BUCKET)
}

export const wprS3Bucket = () => {
  return process.env.WPR_ARCHIVES_BUCKET
}

let clientPromise

// Built fresh per call by tests and once per process (getClient) for
// uploads. Credentials are never configured here: the SDK's default
// credential chain resolves them per environment (AWS_* environment
// variables, shared credentials/config profiles, IAM roles, SSO). Only the
// endpoint is overridable, for S3-compatible hosts like the ministack dev
// emulator; forcePathStyle pairs with it.
// defaultsMode 'auto' tunes defaults per environment, but probes the EC2
// metadata service (up to 1s) when the region must be inferred — with an
// explicit endpoint there is nothing to discover, so plain 'standard'
// applies there.
export const createS3Client = () => {
  return new S3Client({
    ...(process.env.S3_ENDPOINT_URL ? { endpoint: process.env.S3_ENDPOINT_URL, forcePathStyle: true } : {}),
    region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    defaultsMode: process.env.S3_ENDPOINT_URL ? 'standard' : 'auto',
    // Node's HTTP handler has no default request timeout: a stalled endpoint
    // would hold the check's concurrency slot forever
    requestHandler: { connectionTimeout: 3000, requestTimeout: 300000 }
  })
}

const getClient = () => {
  if (clientPromise === undefined) {
    clientPromise = Promise.resolve(createS3Client())
  }
  return clientPromise
}

/**
 * Derives the archive object key for one capture:
 *
 *   <class>/<domain-part>/<YYYY>/<MM>/<DD>/<YYYYMMDDTHHMMSSZ>-<rand8>.wpr
 *
 * The domain part reverses the hostname's labels (deepest label last), with
 * the matched public suffix collapsed into one dotted component for official
 * (ICANN) multi-label suffixes ("news.bbc.co.uk" -> "co.uk/bbc/news") while
 * PRIVATE platform suffixes stay split ("something.github.io" ->
 * "io/github/something"). Apex captures file directly under the registrant:
 * only labels actually present in the hostname appear, none are invented
 * (www.example.com files under com/example/www, example.com under
 * com/example). The zero-padded UTC date partitions keep
 * lexicographic key order chronological. Caveat: subdomain labels are not
 * escaped, so a numeric subdomain can look like a date folder
 * ("18.11.2026.mobile.example.net" lands under ".../mobile/2026/11/18/");
 * parse keys from the end (class, domain, date, filename) to stay unambiguous.
 *
 * Throws WprS3Error for hostnames the public suffix list does not recognize
 * (IP addresses, "localhost", unlisted TLDs): nothing is archived for them.
 */
export const buildArchiveKey = async ({ captureClass, url, recordedAt }) => {
  if (!['full', 'default', 'custom'].includes(captureClass)) {
    throw new WprS3Error(`unknown capture class: ${captureClass}`)
  }

  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new WprS3Error(`invalid URL: ${url}`)
  }

  const info = await suffixInfoForHostname(hostname)
  if (info.hostname === '' || !info.official) {
    throw new WprS3Error(`refusing to archive ${url}: ${info.hostname || hostname} has no public suffix list domain`)
  }
  // The parser truncates hostnames beyond 255 characters and URL parsing
  // does not enforce DNS label rules; either would yield keys derived from
  // a mangled hostname
  const labels = info.hostname.split('.')
  if (info.hostname.length > 253 || labels.some(label => label.length === 0 || label.length > 63)) {
    throw new WprS3Error(`refusing to archive ${url}: ${info.hostname} is not a navigable hostname`)
  }

  const parts = labels.slice().reverse()
  const suffixLabels = info.suffix.split('.').length
  if (!info.isPrivate && suffixLabels >= 2) {
    // The reversed suffix occupies the first components; collapse it back
    // into its natural dotted form ("uk", "co" -> "co.uk")
    parts.splice(0, suffixLabels, parts.slice(0, suffixLabels).reverse().join('.'))
  }

  const recorded = new Date(recordedAt)
  if (Number.isNaN(recorded.getTime())) {
    throw new WprS3Error(`invalid recordedAt: ${recordedAt}`)
  }
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = recorded.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const key = [
    captureClass,
    parts.join('/'),
    String(recorded.getUTCFullYear()),
    pad(recorded.getUTCMonth() + 1),
    pad(recorded.getUTCDate()),
    `${stamp}-${randomBytes(4).toString('hex')}.wpr`
  ].join('/')

  // S3 object keys are limited to 1024 UTF-8 bytes, prefixes included. DNS
  // bounds hostnames at ~253 ASCII bytes, so real keys stay far below; the
  // check documents the constraint and guards pathological inputs.
  if (Buffer.byteLength(key) > 1024) {
    throw new WprS3Error(`archive key exceeds the S3 1024-byte limit (${Buffer.byteLength(key)} bytes)`)
  }

  return key
}

/**
 * Uploads one archive (gzipped WprGo JSON) under the given key. The bucket
 * must exist beforehand; a missing bucket surfaces as a rejected upload.
 */
export const uploadWprArchive = async (body, key) => {
  const bucket = process.env.WPR_ARCHIVES_BUCKET
  if (!bucket) {
    throw new WprS3Error('WPR_ARCHIVES_BUCKET is not configured')
  }
  const client = await getClient()
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/gzip'
  }))
}
