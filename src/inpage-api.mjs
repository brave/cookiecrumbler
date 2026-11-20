// Exposed functions serialize their arguments as JSON. Resolve iframe references
// in the page instead of passing DOM nodes through that boundary.
export async function exposeInPageAPI (page, randomToken, api) {
  await page.exposeFunction(randomToken, async (name, ...args) => {
    if (name !== 'extractFrameText') {
      return api[name](...args)
    }

    const [frameId] = args
    const handle = await page.evaluateHandle((token, id) => {
      return window[token].resolveFrameElement?.(id)
    }, randomToken, frameId)
    try {
      const iframe = handle.asElement()
      if (!iframe || !await iframe.evaluate(element => element.isConnected)) {
        return ''
      }
      const frame = await iframe.contentFrame()
      if (!frame || frame.detached) {
        return ''
      }
      try {
        return await frame.evaluate(() => document.documentElement?.innerText ?? '')
      } catch (error) {
        // A page can remove an iframe while its text is being read.
        if (frame.detached) {
          return ''
        }
        throw error
      }
    } finally {
      await handle.dispose()
    }
  })
}
