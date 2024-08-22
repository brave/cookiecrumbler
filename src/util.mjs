import path from 'path'
import { readFileSync, readdirSync, writeFileSync } from 'fs'

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

const getListCatalog = ({ profileDir }) => {
  const extensionDir = path.join(profileDir, 'gkboaolpopklhgplhaaiboijnklogmbc')
  const versionDir = getExtensionVersion(extensionDir)
  // gkboaolpopklhgplhaaiboijnklogmbc/1.0.60/list_catalog.json
  const data = readFileSync(path.join(extensionDir, versionDir, 'list_catalog.json'), 'utf8')
  return JSON.parse(data)
}

export const parseListCatalogComponentIds = ({ profileDir }) => {
  const catalog = getListCatalog({ profileDir })

  // Extract the component_id values
  const componentIds = catalog.map(item => item.list_text_component.component_id)

  return componentIds
}

export const getOptionalDefaultComponentIds = ({ profileDir }) => {
  const catalog = getListCatalog({ profileDir })

  // Extract the component_id values
  const components = catalog
    .filter(item => item.list_text_component.component_id !== 'iodkpdagapdfkphljnddpjlldadblomo' && (item.default_enabled === true))
    .reduce((acc, item) => {
      acc[item.list_text_component.component_id] = item.title
      return acc
    }, {})

  return components
}

export const isKeeplistedComponentId = ({ id, additionalComponentList }) => {
  const allowlist = [
    'afalakplffnnnlkncjhbmahjfjhmlkal', // Brave Local Data Updater
    // 'gkboaolpopklhgplhaaiboijnklogmbc', // Brave Ad Block List Catalog, managed separately
    // 'iodkpdagapdfkphljnddpjlldadblomo', // Brave Ad Block Updater, included in list catalog
    'mfddibmblmbccpadfndgakiopmmhebop' // Brave Ad Block Resources Library
  ].concat(additionalComponentList)
  return allowlist.includes(id)
}

export const toggleAdblocklists = (listCatalogPath, adblockLists) => {
  // read and parse adblock_lists.json
  const listCatalog = JSON.parse(readFileSync(listCatalogPath), 'utf8')

  listCatalog.forEach(item => {
    if (item.list_text_component.component_id in adblockLists) {
      item.default_enabled = Boolean(adblockLists[item.list_text_component.component_id])
    }
  })

  writeFileSync(listCatalogPath, JSON.stringify(listCatalog, null, 2))
}

export const proxyUrlWithAuth = (proxyHost) => {
  const proxyAuth = process.env.PROXY_AUTH
  if (!proxyAuth) {
    throw new Error('PROXY_AUTH not configured')
  }
  return `http://${proxyAuth}@${proxyHost}:8080`
}
