// WprGo (WebPageReplay) integration: binary/asset resolution, archive
// decoding/validation, and child process lifecycle management.

import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import net from 'node:net'
import zlib from 'node:zlib'
import { setTimeout } from 'node:timers/promises'

import { isValidHttpUrl } from './util.mjs'

const gunzip = promisify(zlib.gunzip)
const gzip = promisify(zlib.gzip)

// The Docker image installs wpr under /usr/local; locally-built binaries and
// webpagereplay checkouts at the app root take precedence when present.
const appRoot = path.join(import.meta.dirname, '..')
const wprGoBinaryPath = existsSync(path.join(appRoot, 'wpr')) ? path.join(appRoot, 'wpr') : '/usr/local/bin/wpr'
const wprGoAssetsDir = existsSync(path.join(appRoot, 'webpagereplay')) ? path.join(appRoot, 'webpagereplay') : '/usr/local/share/webpagereplay'

// Upper bound for decompressed WprGo archives, guarding against gzip bombs
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024

export class WprGoError extends Error {}

/**
 * Decode and sanity-check raw WprGo archive bytes (gzipped JSON with a
 * top-level Requests map; see archive.go in webpagereplay).
 */
const decodeArchiveBuffer = async (buf) => {
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new WprGoError('archive is not gzip-compressed')
  }
  let parsed
  try {
    parsed = JSON.parse((await gunzip(buf, { maxOutputLength: MAX_ARCHIVE_BYTES })).toString('utf8'))
  } catch (error) {
    throw new WprGoError(`invalid archive data: ${error.message}`)
  }
  if (parsed.Requests === null || typeof parsed.Requests !== 'object') {
    throw new WprGoError('archive is missing the Requests map')
  }
  return parsed
}

/**
 * Reserve a usable port from the OS for later use.
 */
class PortReservation {
  constructor () {
    this._server = net.createServer()
    this._taken = false

    this._ready = new Promise((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(0, '127.0.0.1', () => {
        this._server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /**
   * Returns the reserved port number and simultaneously releases it.
   * The port should be bound immediately to limit race conditions.
   *
   * @returns {Promise<number>}
   */
  async take () {
    if (this._taken) {
      throw new Error('Reserved port has already been taken.')
    }

    await this._ready

    this._taken = true
    const { port } = this._server.address()

    await new Promise((resolve, reject) => {
      this._server.close(err => (err ? reject(err) : resolve()))
    })

    return port
  }
}

/**
 * Manages the lifecycle of a single wpr process (record or replay).
 *
 * Archive files are materialized server-side under randomized names in
 * mkdtemp'ed directories; client input never determines filesystem paths.
 */
export class WprGoSession {
  constructor ({ action, data } = {}) {
    if (action !== 'record' && action !== 'replay') {
      throw new WprGoError(`Unknown WprGo action: ${action}`)
    }
    if (action === 'replay' && data === undefined) {
      throw new WprGoError('wprGo.data is required for replay action')
    }

    this._action = action
    this._data = data
    this._archivePath = undefined
    this._archive = undefined
    this._tmpDirs = []
    this._process = undefined
    this._ports = undefined
    this._url = undefined
  }

  get action () {
    return this._action
  }

  get ports () {
    return this._ports
  }

  /**
   * Validates archive data, materializes the archive file, reserves ports and
   * spawns wpr. Returns { firstUrl }: the first http(s) URL found in the
   * archive (for replay), or undefined (for record).
   */
  async prepare ({ url } = {}) {
    if (!existsSync(wprGoBinaryPath)) {
      throw new WprGoError(`WprGo binary not found at ${wprGoBinaryPath}`)
    }
    if (!existsSync(wprGoAssetsDir)) {
      throw new WprGoError(`WprGo assets directory not found at ${wprGoAssetsDir}`)
    }

    this._url = url
    this._recordedAt = Date.now()

    let firstUrl
    if (this._action === 'record') {
      this._archivePath = await this._materializeArchivePath()
    } else {
      // Replay: the archive is uploaded as base64 and always materialized
      // server-side under a randomized name
      const buf = Buffer.from(this._data, 'base64')
      const archive = await decodeArchiveBuffer(buf)
      this._archive = archive
      this._archivePath = await this._materializeArchivePath()
      await fs.writeFile(this._archivePath, buf)
      firstUrl = this._extractFirstUrl(archive)
    }

    const httpPortRes = new PortReservation()
    const httpsPortRes = new PortReservation()
    const [http, https] = await Promise.all([httpPortRes.take(), httpsPortRes.take()])
    this._ports = { http, https }

    const extraArgs = [
      // wpr resolves default cert/script paths relative to its cwd; pass absolute ones instead
      `--https-cert-file=${path.join(wprGoAssetsDir, 'wpr_cert.pem')},${path.join(wprGoAssetsDir, 'ecdsa_cert.pem')}`,
      `--https-key-file=${path.join(wprGoAssetsDir, 'wpr_key.pem')},${path.join(wprGoAssetsDir, 'ecdsa_key.pem')}`,
    ]
    if (this._action === 'replay') {
      extraArgs.push('--inject-archive-scripts=true')
      // wpr rejects duplicate script names: archives recorded via wpr embed
      // deterministic.js in InjectedScripts, so only pass the file when absent
      if (!this._archive?.InjectedScripts?.['deterministic.js']) {
        extraArgs.push(`--inject-scripts=${path.join(wprGoAssetsDir, 'deterministic.js')}`)
      }
    } else {
      // wpr embeds the script into the recorded archive for later replay
      extraArgs.push(`--inject-scripts=${path.join(wprGoAssetsDir, 'deterministic.js')}`)
    }

    const args = [this._action, ...extraArgs, `--http-port=${this._ports.http}`, `--https-port=${this._ports.https}`, this._archivePath]
    console.log(`Spawning WprGo: ${wprGoBinaryPath} ${args.map(arg => JSON.stringify(arg)).join(' ')}`)

    // Give wpr a writable scratch cwd in case it dumps files there
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-wprgo-cwd-'))
    this._tmpDirs.push(cwd)

    this._process = spawn(wprGoBinaryPath, args, { stdio: 'inherit', cwd })
    this._process.on('error', error => {
      console.error(`WprGo failed to start: ${error.message}`)
    })
    this._process.on('exit', (code, signal) => {
      console.log(`WprGo exited (code: ${code}, signal: ${signal})`)
    })
    // TODO delay here is hacky but we must wait for wpr to become ready
    await setTimeout(500)

    return { firstUrl }
  }

  /**
   * Allocates a tmp directory and returns a randomized archive file path in it.
   */
  async _materializeArchivePath () {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-wprgo-archive-'))
    this._tmpDirs.push(dir)
    return path.join(dir, `${randomUUID()}.wprgo`)
  }

  _extractFirstUrl (archive) {
    // Archives written by cookiecrumbler carry the original URL in Metadata
    try {
      const { originalUrl } = JSON.parse(archive.Metadata)
      if (isValidHttpUrl(originalUrl)) {
        return originalUrl
      }
    } catch {
      // No or unparsable metadata
    }
    // Go serializes maps with sorted keys, so this is deterministic but not
    // necessarily the chronologically-first recorded URL.
    for (const urls of Object.values(archive.Requests)) {
      for (const url of Object.keys(urls)) {
        if (isValidHttpUrl(url)) {
          return url
        }
      }
    }
    return undefined
  }

  /**
   * Gracefully terminates wpr and returns the base64-encoded archive when
   * recording. Throws WprGoError on premature exit or shutdown failure.
   */
  async stop () {
    const process = this._process
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new WprGoError(`WprGo process exited prematurely (code: ${process.exitCode}, signal: ${process.signalCode ?? 'none'})`)
    }

    const exited = once(process, 'close')
    process.kill('SIGINT')

    try {
      const killTimeoutSeconds = 10
      await Promise.race([
        exited,
        async (_, reject) => {
          await setTimeout(killTimeoutSeconds * 1000)
          reject(new Error(`WprGo process failed to exit within ${killTimeoutSeconds} seconds`))
        },
      ])

      if (this._action === 'record') {
        // timeout is hacky but there isn't a reliable way to wait for WprGo to finish write-on-exit
        await setTimeout(1000)
        return await this._readRecordedArchive()
      }
    } catch (error) {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL')
      }
      await exited
      throw new WprGoError(`WprGo failure: ${error.message}`)
    }
  }

  /**
   * Reads the recorded archive and stamps cookiecrumbler metadata (the original
   * URL) into it before returning it as base64, so replay can recover the URL
   * deterministically (wpr record has no --metadata flag).
   */
  async _readRecordedArchive () {
    console.log(`Reading from ${this._archivePath}`)
    const archive = await decodeArchiveBuffer(await fs.readFile(this._archivePath))
    archive.Metadata = JSON.stringify({
      originalUrl: this._url,
      recordedAt: this._recordedAt,
    })
    const archiveData = (await gzip(JSON.stringify(archive))).toString('base64')
    console.log(`Read ${archiveData.length} bytes`)
    return archiveData
  }

  async cleanup () {
    await Promise.all(this._tmpDirs.map(dir => fs.rm(dir, { recursive: true, force: true })))
  }
}
