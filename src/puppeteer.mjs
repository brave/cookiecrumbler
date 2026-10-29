import { templateProfilePathForArgs } from './setupUtil.mjs'
import { NETLOG_CAP_MB } from './netlogConfig.mjs'

export const VIEWPORT_PRESETS = {
  '1080p': { width: 1920, height: 1080 },
  WQHD: { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 }
}

const DEFAULT_DISABLED_FEATURES = [
  'BraveAdblockCookieListDefault',
  'BraveAdblockMobileNotificationsListDefault',
  'AdblockDATCache'
]

export const REQUEST_DISABLE_FEATURES_ALLOWLIST = [
  'UseBraveUserAgent'
]

// Features force-disabled during WPR runs (record and replay) to keep the
// browser deterministic: shared dictionary compression is per-profile client
// state that can alter request/response encodings between record and replay
// runs. QUIC is disabled via the dedicated --disable-quic switch below.
const WPR_DISABLED_FEATURES = [
  'CompressionDictionaryTransport',
  'SharedDictionaryCache'
]

/**
 * Non-resolving URL used for check requests so the browser cannot fetch
 * component updates even when --allow-brave-component-update is set.
 * (.invalid is a reserved TLD that never resolves.)
 * Setup must keep default
 */
export const INVALID_COMPONENT_UPDATER_URL = 'https://localhost.invalid/'

const mergedDisableFeatures = (requestedFeatures, extraDisabledFeatures = []) => {
  const requestedAllowedFeatures = Array.isArray(requestedFeatures)
    ? requestedFeatures.filter(feature => REQUEST_DISABLE_FEATURES_ALLOWLIST.includes(feature))
    : []

  return [...new Set([...DEFAULT_DISABLED_FEATURES, ...requestedAllowedFeatures, ...extraDisabledFeatures])]
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

  // Check requests only: override the component updater so Brave cannot
  // download updates. Setup must not set invalidateComponentUpdater.
  if (args.invalidateComponentUpdater) {
    puppeteerArgs.args.push(`--component-updater=url-source=${INVALID_COMPONENT_UPDATER_URL}`)
  }

  if (args.wprGoPorts !== undefined) {
    puppeteerArgs.args.push(`--host-resolver-rules=MAP *:80 127.0.0.1:${args.wprGoPorts.http},MAP *:443 127.0.0.1:${args.wprGoPorts.https},EXCLUDE localhost`)
    puppeteerArgs.args.push('--ignore-certificate-errors-spki-list=PhrPvGIaAMmd29hj8BCZOq096yj7uMpRNHpn5PDxI6I=,2HcXCSKKJS0lEXLQEWhpHUfGuojiU0tiT5gOF9LP6IQ=')
  }

  // Dump the network log for offline traffic analysis; "Everything" capture
  // mode records request/response headers, socket bytes and TLS details. The
  // browser caps the file itself (--net-log-max-size-mb, overwriting older
  // data once reached) and writes NDJSON so events flush as they are logged.
  if (args.netlogPath !== undefined) {
    puppeteerArgs.args.push(`--log-net-log=${args.netlogPath}`)
    puppeteerArgs.args.push('--net-log-capture-mode=Everything')
    puppeteerArgs.args.push(`--net-log-max-size-mb=${NETLOG_CAP_MB}`)
    puppeteerArgs.args.push('--net-log-file-format=ndjson')
  }

  // netlogPath is set for record, wprGoPorts for replay
  const isWprRun = args.netlogPath !== undefined || args.wprGoPorts !== undefined

  const disabledFeatures = mergedDisableFeatures(
    args.disableFeatures,
    isWprRun ? WPR_DISABLED_FEATURES : []
  )
  puppeteerArgs.args.push(`--disable-features=${disabledFeatures.join(',')}`)

  // HTTP/3 (QUIC) responses carry no recoverable bytes in the netlog, so
  // the parser would silently drop those requests from the archive. QUIC
  // cannot be disabled via --disable-features (the "EnableQuic" feature
  // Chromium once defined no longer exists, verified against current
  // Chromium sources); the dedicated switch below is honored by the network
  // service (the network_session_configurator turns it into enable_quic=false).
  if (isWprRun) {
    puppeteerArgs.args.push('--disable-quic')
  }

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
