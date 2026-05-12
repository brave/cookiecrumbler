import { templateProfilePathForArgs } from './setupUtil.mjs'

export const VIEWPORT_PRESETS = {
  '1080p': { width: 1920, height: 1080 },
  WQHD: { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 }
}

const DEFAULT_DISABLED_FEATURES = [
  'BraveAdblockCookieListDefault',
  'BraveAdblockMobileNotificationsListDefault'
]

export const REQUEST_DISABLE_FEATURES_ALLOWLIST = [
  'UseBraveUserAgent'
]

const mergedDisableFeatures = (requestedFeatures) => {
  const requestedAllowedFeatures = Array.isArray(requestedFeatures)
    ? requestedFeatures.filter(feature => REQUEST_DISABLE_FEATURES_ALLOWLIST.includes(feature))
    : []

  return [...new Set([...DEFAULT_DISABLED_FEATURES, ...requestedAllowedFeatures])]
}

export const puppeteerConfigForArgs = async (args) => {
  const puppeteerArgs = {
    defaultViewport: null,
    timeout: 0,
    userDataDir: args.pathForProfile || templateProfilePathForArgs(args),
    args: [
      '--disable-brave-update',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--allow-brave-component-update',
      '--disable-component-update'
    ],
    executablePath: args.executablePath,
    ignoreDefaultArgs: [
      '--disable-sync'
    ],
    headless: !(args.interactive ?? false)
  }

  const disabledFeatures = mergedDisableFeatures(args.disableFeatures)
  puppeteerArgs.args.push(`--disable-features=${disabledFeatures.join(',')}`)

  // If viewport preset is specified, set window size, and screen info
  if (args.viewport && VIEWPORT_PRESETS[args.viewport]) {
    const preset = VIEWPORT_PRESETS[args.viewport]
    puppeteerArgs.args.push(`--window-size=${preset.width},${preset.height}`)
    // Set the virtual screen dimensions (Chrome 135+): https://issues.chromium.org/issues/423334494
    puppeteerArgs.args.push(`--screen-info={${preset.width}x${preset.height}}`)
  }

  if (args.debugLevel === 'verbose') {
    puppeteerArgs.args.push('--enable-logging=stderr')
    puppeteerArgs.args.push('--v=1')
    puppeteerArgs.dumpio = true
  }

  if (args.proxyServer) {
    puppeteerArgs.args.push(`--proxy-server=${args.proxyServer}`)
  }

  if (args.extraArgs) {
    puppeteerArgs.args.push(...args.extraArgs)
  }

  return puppeteerArgs
}
