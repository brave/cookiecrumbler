import fs from 'fs/promises'
import path from 'path'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
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

// The catalog component ships two catalogs: list_catalog.json drives the
// default filter lists engine and regional_catalog.json the additional
// engine. Regional entries are currently a subset of the list_catalog
// entries. Regional lists are not exercised by the tests yet and
// provisioning all of them measurably slows setup down, so they are
// disabled by default: setup strips the regional catalog from the template
// and runtime removes it from the working profile, leaving list_catalog.json
// alone in charge. Set COOKIECRUMBLER_REGIONAL_LISTS=1 to provision, ship
// and require them instead.
export const INCLUDE_REGIONAL_LISTS = process.env.COOKIECRUMBLER_REGIONAL_LISTS === '1'

export const CATALOG_FILE_NAMES = INCLUDE_REGIONAL_LISTS
  ? ['list_catalog.json', 'regional_catalog.json']
  : ['list_catalog.json']

const readListCatalogs = ({ profileDir }) => {
  const extensionDir = path.join(profileDir, 'gkboaolpopklhgplhaaiboijnklogmbc')
  const versionDir = getExtensionVersion(extensionDir)
  const catalogDir = path.join(extensionDir, versionDir)
  const catalogs = CATALOG_FILE_NAMES
    .filter(fileName => existsSync(path.join(catalogDir, fileName)))
    .map(fileName => ({ fileName, entries: JSON.parse(readFileSync(path.join(catalogDir, fileName), 'utf8')) }))
  return { catalogDir, catalogs }
}

export const parseListCatalogComponentIds = ({ profileDir }) => {
  const { catalogs } = readListCatalogs({ profileDir })

  // Extract the component_id values
  return [...new Set(catalogs.flatMap(({ entries }) => entries.map(item => item.list_text_component.component_id)))]
}

export const getOptionalDefaultComponentIds = ({ profileDir }) => {
  const { catalogs } = readListCatalogs({ profileDir })

  // Extract the component_id values
  return catalogs
    .flatMap(({ entries }) => entries)
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
  // Patch the working profile's catalogs. A missing list_catalog.json is fatal;
  // a missing regional catalog only fails when COOKIECRUMBLER_REGIONAL_LISTS=1.
  const catalogDir = path.dirname(listCatalogPath)
  const regionalCatalogPath = path.join(catalogDir, 'regional_catalog.json')
  if (!INCLUDE_REGIONAL_LISTS) {
    // Regional lists are disabled at runtime (e.g. provisioned during setup
    // only): strip the additional-engine catalog from the working profile so
    // list_catalog.json alone governs.
    rmSync(regionalCatalogPath, { force: true })
  } else if (!existsSync(regionalCatalogPath)) {
    throw new Error('COOKIECRUMBLER_REGIONAL_LISTS=1 but the template profile is missing the regional catalog; rerun setup with COOKIECRUMBLER_REGIONAL_LISTS=1')
  }
  if (!existsSync(listCatalogPath)) {
    throw new Error(`Broken template profile: missing ${listCatalogPath}`)
  }
  patchListCatalog(listCatalogPath, adblockLists)
  if (INCLUDE_REGIONAL_LISTS) {
    patchListCatalog(regionalCatalogPath, adblockLists)
  }
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
