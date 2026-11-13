'use strict'

import { existsSync, readdirSync, mkdirSync, writeFileSync, constants as fsConstants } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { setTimeout } from 'node:timers/promises'

import vanillaPuppeteer from 'puppeteer-core'

import { puppeteerConfigForArgs } from './puppeteer.mjs'
import {
  checkAllComponentsRegistered,
  getExtensionVersion,
  getOptionalDefaultComponentIds,
  isValidChromeComponentId,
  isKeeplistedComponentId,
  parseListCatalogComponentIds,
  replaceVersion,
  templateProfilePathForArgs
} from './setupUtil.mjs'

const LIST_CATALOG_COMPONENT_ID = 'gkboaolpopklhgplhaaiboijnklogmbc'
// Filter list components that never register or download on desktop builds:
// their catalog entries are scoped to other platforms (`platforms`, see
// FilterListCatalogEntry::SupportsCurrentPlatform) or marked `hidden`, so
// brave skips them. Force-provision their payloads anyway by dropping those
// keys, and drop `default_enabled` as well so they ship disabled by default
// (an absent key means disabled; delete is a no-op for keys a newer entry no
// longer has). The pre-session flip below still enables all lists, including
// these, so their payloads get downloaded.
const NON_DESKTOP_LIST_COMPONENT_IDS = new Set([
  'eaokkjgnlhceblfhbhpeoebmfldocmnc' // Brave IOS-Specific Filters
])

const forceProvisionNonDesktopLists = entries => {
  for (const entry of entries) {
    if (NON_DESKTOP_LIST_COMPONENT_IDS.has(entry.list_text_component.component_id)) {
      delete entry.hidden
      delete entry.platforms
      delete entry.default_enabled
    }
  }
}

// Click every "Check for update" button on brave://components until every
// watched component reports a completed update. The button set is re-read
// every round, so components that register late are still picked up; a
// missing or still-empty status span counts as pending. Without
// expectedIds all clicked components are watched (used for the initial
// setup session, where only the default-enabled lists are registered).
const UPDATE_COMPLETE_STATES = ['Component already up to date', 'Up-to-date', 'Component updated']

const updateComponents = async (updatePage, { expectedIds = null, timeout = 180000 } = {}) => {
  await updatePage.goto('brave://components', { waitUntil: 'domcontentloaded' })
  const clicked = new Set()
  const deadline = Date.now() + timeout
  while (true) {
    const buttons = await updatePage.$$('.button-check-update')
    for (const button of buttons) {
      let buttonId = null
      try {
        buttonId = await updatePage.evaluate(el => el.getAttribute('id'), button)
      } catch {
        continue // Element handle went stale after a re-render; retried next round
      }
      if (buttonId && !clicked.has(buttonId)) {
        console.log('Updating component:', buttonId)
        clicked.add(buttonId)
        await button.click()
        await setTimeout(100) // Wait for 100ms between clicks
      }
    }

    const watchIds = expectedIds ?? [...clicked]
    const statuses = await updatePage.evaluate(ids =>
      Object.fromEntries(ids.map(id => [id, document.getElementById(`status-${id}`)?.innerText.trim() ?? ''])),
    watchIds)
    const pending = watchIds.filter(id => !UPDATE_COMPLETE_STATES.includes(statuses[id]))
    if (pending.length === 0) {
      break
    }
    if (Date.now() > deadline) {
      throw new Error(`Component updates incomplete after ${timeout}ms: ${pending.join(', ')}`)
    }
    await setTimeout(1000)
  }
  console.log('Components updated')
}

// Wait until every expected component id shows up as registered on
// brave://components, throwing if they do not all appear in time.
const waitForRegistrations = async (page, expectedIds, { maxAttempts = 60, label = '' } = {}) => {
  const prefix = label ? `${label} ` : ''
  const pending = new Set(expectedIds)
  for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt++) {
    await page.goto('brave://components', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.button-check-update')
    const registered = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.button-check-update')).map(button => button.id).filter(id => id !== '')
    )
    for (const id of registered) {
      pending.delete(id)
    }
    console.log(`${prefix}Attempt ${attempt + 1}: ${registered.length} registered, ${pending.size} expected components missing`)
    if (pending.size > 0) {
      await setTimeout(3000)
    }
  }
  if (pending.size > 0) {
    throw new Error(`Components did not register in time: ${[...pending].join(', ')}`)
  }
}

// Check runs block the component updater with an invalid URL, so list
// payloads that are not shipped in the template can never be fetched at
// runtime. Force-download every list in the catalog: temporarily flip
// default_enabled to true for all entries (so the updater registers and
// records every list as installed), let it fetch all payloads, then restore
// the original catalog payload so the template ships proper defaults. The
// installation state recorded by the updater is what makes lists
// activatable from disk at runtime; shipping payload files alone is not
// sufficient.
const forceDownloadCatalogLists = async ({ args, tmpProfile }) => {
  const catalogDir = path.join(tmpProfile, LIST_CATALOG_COMPONENT_ID)
  const catalogVersionDir = getExtensionVersion(catalogDir)
  const catalogPath = path.join(catalogDir, catalogVersionDir, 'list_catalog.json')
  const entries = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  forceProvisionNonDesktopLists(entries)
  // Record the shipped defaults (keyed by component id). Entries without a
  // default_enabled key restore to absent, since JSON.stringify drops
  // undefined values. Also collect the component ids that must end up
  // registered and updated in the forced session.
  // Regional lists (entries with at least one lang) keep their shipped
  // default_enabled and are not force-downloaded, so they don't register
  // or update in the forced session.
  const regionalIds = new Set(
    entries
      .filter(entry => Array.isArray(entry.langs) && entry.langs.length > 0)
      .map(entry => entry.list_text_component.component_id)
  )
  const originalDefaults = Object.fromEntries(
    entries
      .filter(entry => !regionalIds.has(entry.list_text_component.component_id))
      .map(entry => [entry.list_text_component.component_id, entry.default_enabled])
  )
  const expectedIds = new Set(
    entries
      .filter(entry => !regionalIds.has(entry.list_text_component.component_id))
      .map(entry => entry.list_text_component.component_id)
  )
  await fs.writeFile(catalogPath, JSON.stringify(entries.map(entry => regionalIds.has(entry.list_text_component.component_id) ? entry : { ...entry, default_enabled: true })))

  console.log('Force-downloading all catalog lists...')
  // Same flags as the runtime flow (puppeteerConfigForArgs), except the
  // invalid component updater URL: the updater must reach the real update
  // server here to download every list payload.
  const forcedArgs = await puppeteerConfigForArgs({ ...args, pathForProfile: tmpProfile })
  const forcedBrowser = await vanillaPuppeteer.launch(forcedArgs)
  const forcedPage = await forcedBrowser.newPage()
  // The flipped catalog enables every list at once, so all of its
  // components are expected to register and to finish updating.
  await waitForRegistrations(forcedPage, expectedIds, { label: 'Forced download' })
  await updateComponents(forcedPage, { expectedIds: [...expectedIds] })
  await forcedPage.close()
  await forcedBrowser.close()

  // Restore the original catalog payload. If the updater fetched a newer
  // catalog version during the forced session, write the original defaults
  // into that newest version dir so the template ships proper defaults.
  const shippedCatalogVersionDir = getExtensionVersion(catalogDir)
  const shippedCatalogPath = path.join(catalogDir, shippedCatalogVersionDir, 'list_catalog.json')
  const shippedCatalog = JSON.parse(await fs.readFile(shippedCatalogPath, 'utf8'))
  forceProvisionNonDesktopLists(shippedCatalog)
  const restoredCatalog = shippedCatalog.map(entry => ({
    ...entry,
    default_enabled: entry.list_text_component.component_id in originalDefaults
      ? originalDefaults[entry.list_text_component.component_id]
      : entry.default_enabled
  }))
  await fs.writeFile(shippedCatalogPath, JSON.stringify(restoredCatalog))
  console.log('Restored catalog defaults')
}

// Assemble the template profile from the provisioned setup profile: keep only
// adblock components (and Brave User Agent, see keeplist), pin the List
// Catalog to 999.999 for the runtime flow, and record the optional default
// component ids for adblock_lists.json.
const buildTemplateProfile = async ({ args, tmpProfile }) => {
  const templateProfile = templateProfilePathForArgs(args)
  const adblockComponents = parseListCatalogComponentIds({ profileDir: tmpProfile })

  // Clean up stale Singleton Lock
  await fs.rm(`${tmpProfile}/SingletonLock`, { force: true })
  // Clean up crx caches so cached component state cannot leak into runs
  await fs.rm(`${tmpProfile}/component_crx_cache`, { force: true, recursive: true })
  await fs.rm(`${tmpProfile}/extensions_crx_cache`, { force: true, recursive: true })

  for (const fileName of readdirSync(tmpProfile)) {
    // check if valid component id and not in keeplist
    if (isValidChromeComponentId({ id: fileName }) && !isKeeplistedComponentId({ id: fileName, additionalComponentList: adblockComponents })) {
      if (fileName === LIST_CATALOG_COMPONENT_ID) {
        // Ship the List Catalog under a patched 999.999 version: the runtime
        // flow reads it from that path and the updater treats it as installed
        const extensionDir = path.join(tmpProfile, fileName)
        const versionDir = getExtensionVersion(extensionDir)
        const srcManifest = path.join(extensionDir, versionDir, 'manifest.json')
        const destPath = path.join(templateProfile, fileName, '999.999')
        replaceVersion({ fileName: srcManifest })
        mkdirSync(destPath, { recursive: true })
        await fs.cp(path.join(extensionDir, versionDir), destPath, { recursive: true, mode: fsConstants.COPYFILE_FICLONE })
        continue
      }
      // Only adblock components (and Brave User Agent, see keeplist) are
      // shipped in the template profile: drop everything else (e.g. NTP
      // Background Images, Brave WebMCP Tool Scripts, Query Filter) so test
      // runs stay deterministic. The browser is prevented from
      // re-downloading them during check requests via invalidateComponentUpdater.
      console.log('removing non-adblock component: ', fileName)
      await fs.rm(path.join(tmpProfile, fileName), { recursive: true })
      continue
    }
    // copy all other files in profile directory, as well as keeplisted components
    const destPath = path.join(templateProfile, fileName)
    await fs.cp(`${tmpProfile}/${fileName}`, destPath, { recursive: true, mode: fsConstants.COPYFILE_FICLONE })
  }

  const optionalDefaultComponents = getOptionalDefaultComponentIds({ profileDir: tmpProfile })
  writeFileSync(path.join(import.meta.dirname, '..', 'adblock_lists.json'), JSON.stringify(optionalDefaultComponents, null, 2))
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
  // Use the same flags as the runtime flow (puppeteerConfigForArgs), except
  // the invalid component updater URL (see forceDownloadCatalogLists): the
  // updater must be able to download components during setup.
  const puppeteerArgs = await puppeteerConfigForArgs({ ...args, pathForProfile: tmpProfile })

  const browser = await vanillaPuppeteer.launch(puppeteerArgs)

  const page = await browser.newPage()
  // Give the browser some time to register/download adblock components
  console.log('Wait until all components are registered')
  await checkAllComponentsRegistered(page)
  await updateComponents(page)

  await page.close()

  await browser.close()

  await forceDownloadCatalogLists({ args, tmpProfile })
  await buildTemplateProfile({ args, tmpProfile })

  await fs.rm(tmpProfile, { recursive: true })
  console.log('Done. Profile has been prepared for future use.')
}
