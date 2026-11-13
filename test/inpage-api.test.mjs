import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import puppeteer from 'puppeteer-core'

import { exposeInPageAPI } from '../src/inpage-api.mjs'

const bundle = await readFile(new URL('../bundles/index.js', import.meta.url), 'utf8')
const fixture = await readFile(new URL('./data/iframe-api/index.html', import.meta.url), 'utf8')
const notice = content => `<main>Page content</main><div id="notice" style="position:fixed;bottom:0;width:320px;height:120px">${content}</div>`
const token = 'cookiecrumblerTestAPI'

describe('In-page iframe API', { concurrency: false }, () => {
  let browser, profile, origin, crossOrigin
  const servers = []

  before(async (t) => {
    for (let i = 0; i < 2; i++) {
      const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost')
        response.setHeader('Content-Type', 'text/html')
        if (url.pathname === '/circular') {
          response.end(fixture)
        } else if (url.pathname === '/frame') {
          const text = url.searchParams.get('text') === 'Cookie notice' ? 'Cookie notice' : 'Other content'
          response.end(`<html><body><p>${text}</p></body></html>`)
        } else {
          response.end('<html><body><main>Page content</main></body></html>')
        }
      })
      servers.push(server)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
    }
    ;[origin, crossOrigin] = servers.map(server => `http://127.0.0.1:${server.address().port}`)
    profile = await mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-iframe-test-'))
    browser = await puppeteer.launch({
      executablePath: process.env.BRAVE_BINARY || '/usr/bin/brave',
      headless: true,
      userDataDir: profile,
    })
    t.diagnostic(`Browser PID ${browser.process().pid}: ${await browser.version()}`)
  })

  after(async () => {
    try {
      if (browser) {
        const proc = browser.process()
        await browser.close()
        assert(proc.exitCode !== null || proc.signalCode !== null, 'browser should exit')
      }
    } finally {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
      if (profile) await rm(profile, { recursive: true, force: true })
    }
  })

  async function openPage (t, api = {}) {
    const page = await browser.newPage()
    const handles = []
    t.after(async () => {
      try {
        assert(handles.every(handle => handle.disposed), 'all bridge handles should be disposed before closing the page')
      } finally {
        await page.close()
      }
    })
    await page.goto(origin, { waitUntil: 'load' })
    const texts = []
    await exposeInPageAPI(page, token, {
      getETLDP1: host => host,
      classifyCookieNoticeText: text => {
        texts.push(text)
        return { classifier: 'fixture', classification: text === 'Cookie notice' }
      },
      classifyBrowserNoticeText: () => ({ classifier: 'fixture', classification: false }),
      ...api,
    })

    // Observe the actual handles acquired by the production bridge.
    const evaluateHandle = page.evaluateHandle.bind(page)
    page.evaluateHandle = async (...args) => {
      const handle = await evaluateHandle(...args)
      handles.push(handle)
      return handle
    }
    return { page, texts, handles }
  }

  async function runRoutine (page) {
    return page.evaluate(async (code, token) => {
      const module = { exports: {} }
      // eslint-disable-next-line no-eval
      eval(code)
      const result = await module.exports.inPageRoutine(token)
      return {
        notices: result.cookieNotices.map(notice => notice.hideableIds),
        classifiers: [...result.classifiersUsed],
      }
    }, bundle, token)
  }

  async function assertResolverCleared (page) {
    assert.equal(await page.evaluate(token => Object.hasOwn(window[token], 'resolveFrameElement'), token), false)
  }

  it('keeps ordinary notice classification unchanged', async (t) => {
    const { page, handles } = await openPage(t)
    await page.setContent(notice('Cookie notice'))
    assert.deepEqual(await runRoutine(page), { notices: [['notice']], classifiers: ['fixture'] })
    assert.equal(handles.length, 0)
    await assertResolverCleared(page)
  })

  it('classifies a same-origin iframe with circular DOM properties (#404)', async (t) => {
    const { page, texts, handles } = await openPage(t)
    await page.goto(`${origin}/circular`, { waitUntil: 'load' })
    assert.equal(await page.evaluate(() => {
      const iframe = document.querySelector('iframe')
      return iframe.selfReference === iframe && iframe.contentDocument.body.innerText === 'Cookie notice'
    }), true)
    assert.deepEqual(await runRoutine(page), { notices: [['notice']], classifiers: ['fixture'] })
    assert.deepEqual(texts, ['Cookie notice'])
    assert.equal(handles.length, 1)
    await assertResolverCleared(page)
  })

  it('reads a cross-origin iframe without relying on parent DOM access', async (t) => {
    const { page, texts } = await openPage(t)
    await page.setContent(notice(`<iframe src="${crossOrigin}/frame?text=Cookie%20notice"></iframe>`), { waitUntil: 'load' })
    assert.equal(await page.evaluate(() => document.querySelector('iframe').contentDocument), null)
    assert.deepEqual((await runRoutine(page)).notices, [['notice']])
    assert.deepEqual(texts, ['Cookie notice'])
  })

  it('preserves identity for multiple iframes with identical URLs', async (t) => {
    const { page, texts, handles } = await openPage(t)
    await page.setContent(notice('<iframe srcdoc="Other content"></iframe><iframe srcdoc="Cookie notice"></iframe>'), { waitUntil: 'load' })
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('iframe')].map(iframe => iframe.contentWindow.location.href)), ['about:srcdoc', 'about:srcdoc'])
    assert.deepEqual((await runRoutine(page)).notices, [['notice']])
    assert.deepEqual(texts, ['Other content', 'Cookie notice'])
    assert.equal(handles.length, 2)
    await assertResolverCleared(page)
  })

  it('resolves an iframe inside an open shadow root', async (t) => {
    const { page, texts } = await openPage(t)
    await page.evaluate(() => {
      const host = document.createElement('div')
      document.body.append(host)
      host.attachShadow({ mode: 'open' }).innerHTML = '<div id="notice" style="position:fixed;bottom:0;width:320px;height:120px"><iframe></iframe></div>'
      const iframe = host.shadowRoot.querySelector('iframe')
      iframe.selfReference = iframe
      iframe.contentDocument.body.textContent = 'Cookie notice'
    })
    assert.deepEqual((await runRoutine(page)).notices, [['notice']])
    assert.deepEqual(texts, ['Cookie notice'])
  })

  it('keeps concurrent notice checks associated with their own iframe', async (t) => {
    const { page, texts, handles } = await openPage(t)
    await page.setContent('<main>Page content</main><div id="other" style="position:fixed;top:0"><iframe srcdoc="Other content"></iframe></div><div id="notice" style="position:fixed;bottom:0"><iframe srcdoc="Cookie notice"></iframe></div>', { waitUntil: 'load' })
    assert.deepEqual((await runRoutine(page)).notices, [['notice']])
    assert.deepEqual(texts.sort(), ['Cookie notice', 'Other content'])
    assert.equal(handles.length, 2)
    await assertResolverCleared(page)
  })

  it('skips empty iframe text', async (t) => {
    const { page, texts, handles } = await openPage(t)
    await page.setContent(notice('<iframe></iframe>'), { waitUntil: 'load' })
    assert.deepEqual(await runRoutine(page), { notices: [], classifiers: [] })
    assert.deepEqual(texts, [])
    assert.equal(handles.length, 1)
    await assertResolverCleared(page)
  })

  it('skips missing, expired, detached and non-frame references', async (t) => {
    const { page, handles } = await openPage(t)
    await page.evaluate(token => {
      const detached = document.createElement('iframe')
      const nonFrame = document.createElement('div')
      document.body.append(nonFrame)
      window[token].resolveFrameElement = id => ({ detached, nonFrame })[id]
    }, token)
    for (const id of ['missing', 'detached', 'nonFrame']) {
      assert.equal(await page.evaluate((token, id) => window[token]('extractFrameText', id), token, id), '')
    }
    await page.evaluate(token => { delete window[token].resolveFrameElement }, token)
    assert.equal(await page.evaluate(token => window[token]('extractFrameText', 'expired'), token), '')
    assert.equal(handles.length, 4)
  })

  it('cleans up and propagates unexpected frame-read failures', async (t) => {
    const { page, handles } = await openPage(t)
    await page.setContent(notice('<iframe></iframe>'), { waitUntil: 'load' })
    await page.evaluate(() => {
      Object.defineProperty(document.querySelector('iframe').contentDocument.documentElement, 'innerText', {
        get () { throw new Error('frame read failed') },
      })
    })
    await assert.rejects(runRoutine(page), /frame read failed/)
    assert.equal(handles.length, 1)
    await assertResolverCleared(page)
  })

  it('skips a frame detached during text extraction', { timeout: 5000 }, async (t) => {
    const { page, handles } = await openPage(t)
    await page.setContent(notice('<iframe srcdoc="Cookie notice"></iframe>'), { waitUntil: 'load' })
    const frame = page.frames().find(frame => frame !== page.mainFrame())
    const evaluate = frame.evaluate.bind(frame)
    // Remove a real frame at the read boundary, rather than faking its error.
    frame.evaluate = async (...args) => {
      const detached = once(page, 'framedetached')
      await page.evaluate(() => document.querySelector('iframe').remove())
      await detached
      return evaluate(...args)
    }
    assert.deepEqual(await runRoutine(page), { notices: [], classifiers: [] })
    assert.equal(frame.detached, true)
    assert.equal(handles.length, 1)
    await assertResolverCleared(page)
  })

  it('clears page references when classification fails', async (t) => {
    const { page, handles } = await openPage(t, {
      classifyCookieNoticeText: () => { throw new Error('classifier failed') },
    })
    await page.setContent(notice('<iframe srcdoc="Cookie notice"></iframe>'), { waitUntil: 'load' })
    await assert.rejects(runRoutine(page), /classifier failed/)
    assert.equal(handles.length, 1)
    await assertResolverCleared(page)
  })
})
