import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Server as ProxyServer } from 'proxy-chain'
import puppeteer from 'puppeteer-core'
import { checkPage } from '../src/lib.mjs'
import { WprGoSession } from '../src/wpr.mjs'

async function createLaunchFixture (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-launch-test-'))
  const remove = fs.rm
  t.after(() => remove(root, { recursive: true, force: true }))

  const temp = path.join(root, 'temp')
  const template = path.join(root, 'template')
  const catalog = path.join(template, 'gkboaolpopklhgplhaaiboijnklogmbc', '999.999')
  const executablePath = path.join(root, 'non-executable')
  await fs.mkdir(temp)
  await fs.mkdir(catalog, { recursive: true })
  await fs.writeFile(path.join(catalog, 'list_catalog.json'), '[]')
  await fs.writeFile(executablePath, '', { mode: 0o600 })
  t.mock.method(os, 'tmpdir', () => temp)

  return {
    temp,
    args: {
      url: 'https://example.test/',
      pathForProfile: template,
      executablePath
    }
  }
}

describe('Failed browser launch cleanup', () => {
  it('removes the working profile on each failed launch', async (t) => {
    const { args, temp } = await createLaunchFixture(t)
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.assert.rejects(checkPage(args), /Failed to launch the browser process/)
    }
    t.assert.deepStrictEqual(await fs.readdir(temp), [])
  })

  it('closes the proxy and preserves the launch error when profile removal fails', async (t) => {
    const { args } = await createLaunchFixture(t)
    const originalAuth = process.env.PROXY_AUTH
    process.env.PROXY_AUTH = 'fixture:fixture'
    t.after(() => {
      if (originalAuth === undefined) delete process.env.PROXY_AUTH
      else process.env.PROXY_AUTH = originalAuth
    })

    const listen = t.mock.method(ProxyServer.prototype, 'listen')
    t.after(async () => {
      for (const call of listen.mock.calls) {
        if (call.this.server?.listening) await call.this.close(true)
      }
    })
    const launchError = new Error('fixture launch failure')
    let server
    t.mock.method(puppeteer, 'launch', async () => {
      server = listen.mock.calls[0].this.server
      throw launchError
    })
    const remove = t.mock.method(fs, 'rm', async () => { throw new Error('fixture removal failure') })

    await t.assert.rejects(checkPage({ ...args, location: '127.0.0.1' }), error => error === launchError)
    t.assert.strictEqual(listen.mock.callCount(), 1)
    t.assert.strictEqual(server.listening, false)
    t.assert.strictEqual(remove.mock.callCount(), 1)
  })

  it('runs WPR cleanup even if stopping the session fails', async (t) => {
    const { args, temp } = await createLaunchFixture(t)
    t.mock.method(WprGoSession.prototype, 'prepare', async () => ({}))
    t.mock.getter(WprGoSession.prototype, 'ports', () => ({ http: 1, https: 2 }))
    const stop = t.mock.method(WprGoSession.prototype, 'stop', async () => { throw new Error('fixture stop failure') })
    const cleanup = t.mock.method(WprGoSession.prototype, 'cleanup')

    await t.assert.rejects(checkPage({ ...args, wprGo: { action: 'record' } }), /Failed to launch the browser process/)
    t.assert.strictEqual(stop.mock.callCount(), 1)
    t.assert.strictEqual(cleanup.mock.callCount(), 1)
    t.assert.deepStrictEqual(await fs.readdir(temp), [])
  })
})
