'use strict'

import { existsSync, readdirSync, cpSync, mkdirSync, writeFileSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import nodeUrl from 'node:url'
import { setTimeout } from 'node:timers/promises'

import suffixList from '@gorhill/publicsuffixlist'
import rehypeFormat from 'rehype-format'
import rehypeParse from 'rehype-parse'
import rehypeStringify from 'rehype-stringify'
import { unified } from 'unified'
import * as Sentry from '@sentry/node'

import OpenAI from 'openai'
import proxyChain from 'proxy-chain'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { KnownDevices } from 'puppeteer-core'

import { puppeteerConfigForArgs } from './puppeteer.mjs'
import { templateProfilePathForArgs, parseListCatalogComponentIds, isValidChromeComponentId, isKeeplistedComponentId, getExtensionVersion, getOptionalDefaultComponentIds, replaceVersion, toggleAdblocklists, proxyUrlWithAuth, checkAllComponentsRegistered, fixupBundleStackTrace, getBundlePaths } from './setupUtil.mjs'
import { generateRandomToken } from './util.mjs'

import { cookieNoticeClassifier } from './text-classification.mjs'

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1',
  apiKey: process.env.OPENAI_API_KEY || 'ollama'
})

const inPageAPI = {
  extractFrameText: (iframeHandle) => {
    return iframeHandle.contentFrame().then(frameDoc => frameDoc.evaluate(() => document.documentElement.innerText))
  },
  classifyCookieNoticeText: (innerText) => {
    return cookieNoticeClassifier(innerText, openai)
  },
  getETLDP1: (() => {
    let init
    return (hostname) => {
      if (init === undefined) {
        init = new Promise(resolve => {
          fs.readFile(path.join(import.meta.dirname, '..', 'public_suffix_list.dat'), 'utf8')
            .then(data => {
              suffixList.parse(data, nodeUrl.domainToASCII)
              resolve(true)
            })
        })
      }
      return init.then(() => suffixList.getDomain(hostname))
    }
  })()
}

const shouldBlockRequest = (request) => {
  const url = request.url()

  // Block non-http/https/data URLs
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
    console.log(`Blocked URL: ${url}`)
    return true
  }

  return false
}

export const checkPage = async (args) => {
  const url = args.url
  const includeScreenshot = args.screenshot ?? true
  const includeMarkup = args.markup ?? true
  const slowCheck = args.slowCheck ?? false
  const blockNonHttpRequests = args.blockNonHttpRequests ?? true
  const deviceName = args.device
  const mhtmlMode = args.mhtmlMode ?? 'full'
  const includeMhtml = args.includeMhtml ?? 'never'

  const report = {
    originalUrl: url,
    timestamp: Date.now(),
    scriptSources: new Set()
  }

  const templateProfile = templateProfilePathForArgs(args)
  // Only operate on a copy of the template profile
  const workingProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-profile-'))

  try {
    await fs.cp(templateProfile, workingProfile, { recursive: true })
  } catch (err) {
    await fs.rm(workingProfile, { recursive: true })
    report.error = err.stack
    return report
  }
  const listCatalogPath = path.join(workingProfile, 'gkboaolpopklhgplhaaiboijnklogmbc', '999.999', 'list_catalog.json')
  toggleAdblocklists(listCatalogPath, args.adblockLists)

  let proxyUrl
  if (args.location) {
    proxyUrl = await proxyChain.anonymizeProxy(proxyUrlWithAuth(args.location))
    console.log(`Started local proxy server: ${proxyUrl}`)
  }
  const puppeteerArgs = await puppeteerConfigForArgs({ ...args, pathForProfile: workingProfile, proxyServer: proxyUrl })

  const browser = await Sentry.startSpan({ name: 'Launch Browser' }, () => {
    return puppeteer.use(StealthPlugin()).launch(puppeteerArgs)
  })

  const page = await browser.newPage()

  try {
    if (blockNonHttpRequests) {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('Blocked non-HTTP(S) request')
      }

      let blockError
      await page.setRequestInterception(true)
      page.on('request', (request) => {
        if (shouldBlockRequest(request)) {
          request.abort()
          blockError = new Error('Blocked non-HTTP(S) request')
        } else {
          request.continue()
        }
      })
      if (blockError) {
        throw blockError
      }
    }

    // Track all domains that scripts are loaded from
    page.on('response', (response) => {
      const domain = new URL(response.url()).hostname
      if (['script', 'fetch', 'xhr'].includes(response.request().resourceType())) {
        report.scriptSources.add(domain)
      }
    })

    // Emulate the device if the device name is set
    if (deviceName) {
      const device = KnownDevices[deviceName]
      await page.emulate(device)
    }

    await Sentry.startSpan({ name: 'domcontentloaded' }, () => {
      return page.goto(url, { waitUntil: 'domcontentloaded' })
    })

    const waitTimeMs = args.seconds * 1000

    if (slowCheck) {
      console.log('Performing slow check, waiting for network to settle.')
      try {
        await page.waitForNavigation({ waitUntil: ['load', 'networkidle2'], timeout: 30000 })
        console.log('Network settled')
      } catch (error) {
        console.warn('Navigation timed out or failed:', error.message)
      }
      await setTimeout(waitTimeMs) // wait longer for slow check
    }

    await setTimeout(waitTimeMs)

    const randomToken = generateRandomToken()
    await page.exposeFunction(randomToken, (name, ...args) => inPageAPI[name](...args))

    // Bundled code is in CommonJS format.
    // CJS is not normally intended for in-browser use. Why choose it over ESM?
    // - ESM can be imported natively via inline `data:` URLs
    // - but evaluation of `data:` URLs can be blocked by pages with strict CSP
    // - ESM's import/export semantics cannot be polyfilled
    // - Disabling CSP is not ideal because it can reveal use of puppeteer
    // Instead,
    // - CJS uses `module.exports`, which doesn't exist in-browser
    // - `module.exports` semantics can be polyfilled with the small wrapper script below
    const inpageBundle = getBundlePaths('index.js')

    const bundleCode = await fs.readFile(inpageBundle.code, 'utf8')

    const inpageWrapper = async (bundleCode, ...args) => {
      const module = { exports: {} }
      // eslint-disable-next-line
      eval(`"use strict";\n${bundleCode}`)
      const { inPageRoutine } = module.exports
      try {
        return await inPageRoutine(...args)
      } catch (e) {
        return e
      }
    }

    const inPageResult = await page.evaluateHandle(inpageWrapper, bundleCode, randomToken, args.hostOverride)

    try {
      if (await inPageResult.evaluate(async e => (await e) instanceof Error)) {
        const error = await inPageResult.evaluate(e => { return { message: e.message, stack: e.stack } })
        error.stack = await fixupBundleStackTrace(error, inpageBundle.sourcemap)
        throw error
      }

      const l = await inPageResult.evaluate(r => r.cookieNotices.length)
      const cookieNoticeDetected = l === 1

      // Capture MHTML if requested
      if (includeMhtml === 'always' || (includeMhtml === 'onDetection' && cookieNoticeDetected)) {
        const session = await page.target().createCDPSession()
        try {
          // Limited to 256MB
          // https://source.chromium.org/chromium/chromium/src/+/main:content/browser/devtools/devtools_http_handler.cc;l=97?q=kSendBufferSizeForDevTools&ss=chromium
          const mhtmlData = await session.send('Page.captureSnapshot', { format: 'mhtml' })

          if (mhtmlMode === 'optimized') {
            // TODO: Implement optimization logic here
            console.warn('MHTML optimization not yet implemented')
          }

          report.mhtml = mhtmlData.data
        } finally {
          await session.detach()
        }
      }

      report.url = page.url()

      if (l > 1) {
        throw new Error('Too many candidate cookie notice elements detected (' + l + ')')
      }
      if (l === 1) {
        report.identified = true
        const cookieNotice = {
          innermostHideableElement: await inPageResult.evaluateHandle(r => r.cookieNotices[0].innermostHideableElement),
          outermostHideableElement: await inPageResult.evaluateHandle(r => r.cookieNotices[0].outermostHideableElement),
          hideableElementRange: await inPageResult.evaluate(r => r.cookieNotices[0].hideableElementRange),
          hideableIds: await inPageResult.evaluate(r => r.cookieNotices[0].hideableIds)
        }
        const boundingBox = await cookieNotice.innermostHideableElement.boundingBox()
        if (boundingBox.height === 0 || boundingBox.width === 0) {
          // it won't work for a screenshot. Find another element to capture, somehow
        } else if (includeScreenshot && includeScreenshot !== 'fullPage') {
          const screenshotB64 = await cookieNotice.innermostHideableElement.screenshot({ omitBackground: true, optimizeForSpeed: true, encoding: 'base64' })
          report.screenshot = screenshotB64
        }
        if (includeMarkup) {
          report.markup = String(await unified()
            .use(rehypeParse, { fragment: true })
            .use(rehypeFormat)
            .use(rehypeStringify)
            .process(await cookieNotice.outermostHideableElement.evaluate(e => e.outerHTML))).trim()
          report.markupInner = String(await unified()
            .use(rehypeParse, { fragment: true })
            .use(rehypeFormat)
            .use(rehypeStringify)
            .process(await cookieNotice.innermostHideableElement.evaluate(e => e.outerHTML))).trim()
        }
        report.hideableIds = cookieNotice.hideableIds
        report.hideableElementRange = cookieNotice.hideableElementRange
      }
      report.classifiersUsed = await inPageResult.evaluate(r => r.classifiersUsed)
      // Add full page screenshot if explicitly requested or if no element was detected and screenshot is set to "always"
      if (['always', 'fullPage'].includes(includeScreenshot) && !report.screenshot) {
        // TODO: scroll to bottom to trigger lazy-loaded elements
        const screenshotB64 = await page.screenshot({ fullPage: true, omitBackground: true, optimizeForSpeed: true, encoding: 'base64' })
        report.screenshot = screenshotB64
      }
      report.scrollBlocked = ((await inPageResult.evaluate(r => r.scrollBlocked)) === true)
    } catch (err) {
      report.error = err.stack
    } finally {
      await inPageResult.dispose()
    }
  } catch (err) {
    report.error = err.stack
  } finally {
    await page.close()

    await browser.close()
    if (args.location) {
      await proxyChain.closeAnonymizedProxy(proxyUrl, true)
      console.log('Proxy closed')
    }

    await fs.rm(workingProfile, { recursive: true })
  }

  report.scriptSources = Array.from(report.scriptSources) // Convert Set to Array
  return report
}

export const prepareProfile = async (args) => {
  const tmpProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'cookiecrumbler-setup-profile-'))
  const templateProfile = templateProfilePathForArgs(args)

  if (existsSync(templateProfile)) {
    // Template profile already exists; return early
    console.log('profile directory already exists')
    return
  } else {
    // Create template profile directory
    await fs.mkdir(templateProfile)
  }

  await fetch('https://publicsuffix.org/list/public_suffix_list.dat')
    .then(resp => resp.text())
    .then(body => fs.writeFile(path.join(import.meta.dirname, '..', 'public_suffix_list.dat'), body))

  console.log('Performing initial profile setup...')
  const puppeteerArgs = await puppeteerConfigForArgs({ ...args, pathForProfile: tmpProfile })

  const browser = await puppeteer.launch(puppeteerArgs)

  const page = await browser.newPage()
  // Give the browser some time to register/download adblock components
  console.log('Wait until all components are registered')
  await checkAllComponentsRegistered(page)

  console.log('Updating Brave components')
  await page.goto('brave://components', { waitUntil: 'domcontentloaded' })
  const buttons = await page.$$('.button-check-update')
  for (const button of buttons) {
    const buttonId = await page.evaluate(el => el.getAttribute('id'), button)
    if (buttonId) {
      console.log('Updating component:', buttonId)
      await button.click()
      await setTimeout(100) // Wait for 100ms between clicks
    }
  }

  console.log('Waiting for components to update...')
  await setTimeout(500)
  await page.waitForFunction(() => {
    const elements = document.querySelectorAll('span[jscontent="status"]')
    return Array.from(elements)
      .map(el => el.innerText.trim())
      .filter(text => text !== '')
      .every(spanText => ['Component already up to date', 'Up-to-date', 'Component updated'].includes(spanText))
  }, { timeout: 60000 })
  console.log('Components updated')

  await page.close()

  await browser.close()

  // Clean up stale Singleton Lock
  await fs.rm(`${tmpProfile}/SingletonLock`, { force: true })
  // Clean up crx cache
  await fs.rm(`${tmpProfile}/component_crx_cache`, { force: true, recursive: true })

  const adblockComponents = parseListCatalogComponentIds({ profileDir: tmpProfile })

  readdirSync(tmpProfile).forEach(fileName => {
    // check if valid component id and not in keeplist
    if (isValidChromeComponentId({ id: fileName }) && !isKeeplistedComponentId({ id: fileName, additionalComponentList: adblockComponents })) {
      console.log('patching component: ', fileName)
      const extensionDir = path.join(tmpProfile, fileName)
      const versionDir = getExtensionVersion(extensionDir)
      const srcManifest = path.join(extensionDir, versionDir, 'manifest.json')
      const destPath = path.join(templateProfile, fileName, '999.999')
      replaceVersion({ fileName: srcManifest })
      mkdirSync(destPath, { recursive: true })
      if (fileName === 'gkboaolpopklhgplhaaiboijnklogmbc') {
        // copy List Catalog files after modifying version
        cpSync(path.join(extensionDir, versionDir), destPath, { recursive: true })
      } else {
        // only copy the manifest for all other components
        cpSync(srcManifest, path.join(destPath, 'manifest.json'))
      }
    } else {
      // copy all other files in profile directory, as well as keeplisted components
      cpSync(`${tmpProfile}/${fileName}`, `${templateProfile}/${fileName}`, { recursive: true })
    }
  })

  const optionalDefaultComponents = getOptionalDefaultComponentIds({ profileDir: tmpProfile })
  writeFileSync(path.join(import.meta.dirname, '..', 'adblock_lists.json'), JSON.stringify(optionalDefaultComponents, null, 2))

  await fs.rm(tmpProfile, { recursive: true })
  console.log('Done. Profile has been prepared for future use.')
}
