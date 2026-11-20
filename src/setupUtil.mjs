import fs from 'fs/promises'
import path from 'path'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { setTimeout } from 'timers/promises'
import { KnownDevices } from 'puppeteer-core'
import ErrorStackParser from 'error-stack-parser'
import SourceMap from 'source-map'

const chromeComponentIdPattern = /^[a-p]{32}$/

export const templateProfilePathForArgs = ({ pathForProfile }) => {
  let templateProfile = pathForProfile
  if (templateProfile === undefined) {
    templateProfile = path.join(import.meta.dirname, '..', 'profile')
  }
  return templateProfile
}

// Create an empty NTP sponsored images component directory (campaigns.json
// with no campaigns) inside the profile and return its path. Pointing Brave
// at it via --ntp-sponsored-images-component-path keeps sponsored campaigns
// from loading during deterministic runs.
export const ensureEmptyNtpSponsoredImagesComponent = async ({ profileDir }) => {
  const componentDir = path.join(profileDir, 'ntp-sponsored-images')
  await fs.mkdir(componentDir, { recursive: true })
  await fs.writeFile(path.join(componentDir, 'campaigns.json'), '{}')
  return componentDir
}

/**
 * Function to check if the given ID is a valid Chrome component ID
 * @param {string} id - The ID to validate
 * @returns {boolean} - Returns true if the ID is valid, otherwise false
 */
export const isValidChromeComponentId = ({ id }) => {
  return chromeComponentIdPattern.test(id)
}

export const getExtensionVersion = (extensionDir) => {
  const versions = readdirSync(extensionDir)
  const sortedVersions = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return sortedVersions[sortedVersions.length - 1]
}

export const replaceVersion = ({ fileName }) => {
  const manifestData = JSON.parse(readFileSync(fileName, 'utf8'))
  // Insert the new key/value pair
  manifestData.version = '999.999'
  const modifiedManifest = JSON.stringify(manifestData, null, 2)
  writeFileSync(fileName, modifiedManifest)
}

// gkboaolpopklhgplhaaiboijnklogmbc/1.0.60/list_catalog.json
const getListCatalog = ({ profileDir }) => {
  const extensionDir = path.join(profileDir, 'gkboaolpopklhgplhaaiboijnklogmbc')
  const versionDir = getExtensionVersion(extensionDir)
  const data = readFileSync(path.join(extensionDir, versionDir, 'list_catalog.json'), 'utf8')
  return JSON.parse(data)
}

export const parseListCatalogComponentIds = ({ profileDir }) => {
  const catalog = getListCatalog({ profileDir })

  // Extract the component_id values
  return catalog.map(item => item.list_text_component.component_id)
}

export const getOptionalDefaultComponentIds = ({ profileDir }) => {
  const catalog = getListCatalog({ profileDir })

  // Extract the component_id values
  return catalog
    .filter(item => item.list_text_component.component_id !== 'iodkpdagapdfkphljnddpjlldadblomo' && (item.default_enabled === true))
    .reduce((acc, item) => {
      acc[item.list_text_component.component_id] = item.title
      return acc
    }, {})
}

export const isKeeplistedComponentId = ({ id, additionalComponentList }) => {
  const allowlist = [
    'afalakplffnnnlkncjhbmahjfjhmlkal', // Brave Local Data Updater
    // 'gkboaolpopklhgplhaaiboijnklogmbc', // Brave Ad Block List Catalog, managed separately
    // 'iodkpdagapdfkphljnddpjlldadblomo', // Brave Ad Block Updater, included in list catalog
    'mfddibmblmbccpadfndgakiopmmhebop', // Brave Ad Block Resources Library
    'nlpaeekllejnmhoonlpcefpfnpbajbpe' // Brave User Agent
  ].concat(additionalComponentList)
  return allowlist.includes(id)
}

const patchListCatalog = (catalogPath, adblockLists) => {
  const listCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'))

  listCatalog.forEach(item => {
    if (item.list_text_component.component_id in adblockLists) {
      item.default_enabled = Boolean(adblockLists[item.list_text_component.component_id])
    }
  })

  writeFileSync(catalogPath, JSON.stringify(listCatalog, null, 2))
}

export const toggleAdblocklists = (listCatalogPath, adblockLists) => {
  // Patch list_catalog.json in the working profile; it drives the default
  // filter lists engine. A missing catalog means a broken template and
  // must fail loudly.
  if (!existsSync(listCatalogPath)) {
    throw new Error(`Broken template profile: missing ${listCatalogPath}`)
  }
  patchListCatalog(listCatalogPath, adblockLists)
}

export const proxyUrlWithAuth = (proxyHost) => {
  const proxyAuth = process.env.PROXY_AUTH
  if (!proxyAuth) {
    throw new Error('PROXY_AUTH not configured')
  }
  return `http://${proxyAuth}@${proxyHost}:8080`
}

export const checkAllComponentsRegistered = async (page) => {
  const maxAttempts = 10
  const defaultListsComponentId = 'iodkpdagapdfkphljnddpjlldadblomo'
  let previousComponentCount = 0

  await setTimeout(3000)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await page.goto('brave://components', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.button-check-update')

    const currentComponents = await page.evaluate(() => {
      const buttons = document.querySelectorAll('.button-check-update')
      return Array.from(buttons)
        .filter(button => button.id !== '')
        .map(button => button.id)
    })

    console.log(`Attempt ${attempt + 1}: ${currentComponents.length} components registered`)
    // If the number of components is the same as the previous check and the default lists component is registered, return the current components
    if (currentComponents.length === previousComponentCount && currentComponents.includes(defaultListsComponentId)) {
      console.log('All components registered:')
      console.log(currentComponents.join(', '))
      return new Set(currentComponents)
    }

    previousComponentCount = currentComponents.length
    await setTimeout(3000) // Wait for 3 seconds between checks
  }

  throw new Error('Max attempts reached. Some components might not be registered.')
}

export function getFilteredKnownDevices () {
  return Object.keys(KnownDevices).filter(key => {
    const deviceName = KnownDevices[key].name
    return deviceName && (deviceName.includes('iPhone 15 Pro Max') || deviceName.includes('Pixel 5') || deviceName.includes('Galaxy S9'))
  })
}

export function getBundlePaths (name) {
  const code = path.join(import.meta.dirname, '..', 'bundles', name)
  const sourcemap = code + '.map'
  return {
    code,
    sourcemap
  }
}

// Replace stack trace frames from a dynamically imported module data: URL
// into human-readable locations according to the corresponding source map
export async function fixupBundleStackTrace (error, sourcemapPath) {
  const sourcemap = await new SourceMap.SourceMapConsumer(await fs.readFile(sourcemapPath, 'utf8'))
  const mappedTrace = ErrorStackParser.parse(error).map(frame => {
    if (frame.fileName.startsWith('pptr:')) {
      return undefined
    }

    const newLocation = sourcemap.originalPositionFor({
      line: frame.lineNumber,
      column: frame.columnNumber
    })

    if (newLocation.line === null || newLocation.column === null) {
      return undefined
    }

    return {
      ...frame,
      functionName: newLocation.name ?? frame.functionName,
      fileName: newLocation.source,
      lineNumber: newLocation.line,
      columnNumber: newLocation.column
    }
  })
  const originalTraceLines = error.stack.split('\n')
  let fixedTrace = originalTraceLines[0]
  for (let i = 0; i < mappedTrace.length; i++) {
    if (mappedTrace[i] !== undefined) {
      const frame = mappedTrace[i]
      fixedTrace += `\n    at ${frame.functionName}(${frame.fileName}):${frame.lineNumber}:${frame.columnNumber}`
    } else {
      fixedTrace += '\n' + originalTraceLines[i + 1]
    }
  }
  console.log(fixedTrace)
  return fixedTrace
}
