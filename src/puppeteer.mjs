import { templateProfilePathForArgs } from './setupUtil.mjs'

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
      '--disable-features=BraveAdblockCookieListDefault,BraveAdblockMobileNotificationsListDefault',
      '--allow-brave-component-update',
      '--disable-component-update'
    ],
    executablePath: args.executablePath,
    ignoreDefaultArgs: [
      '--disable-sync'
    ],
    headless: !(args.interactive ?? false)
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
