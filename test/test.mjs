import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
import path from 'path'
import { before, describe, it } from 'node:test'
import { cpus } from 'os'

import { checkPage, prepareProfile } from '../src/lib.mjs'

// Get browser path from environment variables with fallbacks
const browserPath = process.env.BRAVE_BINARY || '/usr/bin/brave'
console.log('Using browser executable:', browserPath)

const args = {
  seconds: 0,
  executablePath: browserPath,
  adblockLists: {
    eaokkjgnlhceblfhbhpeoebmfldocmnc: false,
    adcocjohghhfpidemphmcmlmhnfgikei: false,
    cdbbhgbmjhfnhnmgeddbliobbofkgdhe: false,
    bfpgedeaaibpoidldhjcknekahbikncb: false
  }
}
// Calculate concurrency based on available CPU cores
const CONCURRENCY = Math.max(1, Math.floor(cpus().length / 2))
console.log(`Running tests with concurrency: ${CONCURRENCY}`)

async function testPage (t, testCasePath, expectedCookieNotice, expectedScrollBlocking) {
  const url = pathToFileURL(path.join(import.meta.dirname, 'data', testCasePath, 'index.html')).href
  const r = await checkPage({ url, hostOverride: testCasePath, blockNonHttpRequests: false, ...args })

  if (r.error) {
    throw new Error(`[${testCasePath}] ERROR: ${r.error}`)
  }

  let markupHash
  if (r.identified) {
    markupHash = createHash('sha256').update(r.markupInner).digest('base64')
  }

  if (expectedCookieNotice === undefined) {
    await t.test('should not detect notice', async (t) => {
      t.assert.strictEqual(markupHash, expectedCookieNotice,
        `unexpectedly found cookie notice with markup hash "${markupHash}"`)
    })
  } else {
    const [expectedMarkupHash, expectedRange] = expectedCookieNotice
    await t.test('should detect notice', async (t) => {
      t.assert.strictEqual(markupHash, expectedMarkupHash,
        `expected cookie notice hash "${expectedMarkupHash}" did not match result "${markupHash}"`)
      t.assert.strictEqual(r.hideableElementRange, expectedRange,
        `expected cookie notice range "${expectedRange}" did not match result "${r.hideableElementRange}"`)
    })
  }

  await t.test('scroll blocking detection', async (t) => {
    if (expectedScrollBlocking === undefined) {
      t.todo('scroll blocking test ignored')
    } else {
      t.assert.strictEqual(r.scrollBlocked, expectedScrollBlocking,
        `expected scroll blocking result [${expectedScrollBlocking}] did not match detected result [${r.scrollBlocked}]`)
    }
  })
}

const testCases = [
  ['2021.rca.ac.uk', ['fOBTu1EHcX9tzkrWM343dsu2kqDUM9w+cMbTc5tm2oc=', 1], false],
  ['abxxx.com', undefined, false],
  ['bongacams.com', undefined, false],
  ['brave.com', undefined, false],
  ['cam4.com', ['O+Y60jG333dyHi6a3W1ZodZ7phKLk1Pr0SzhRHcKSps=', 1], false],
  ['cleveradvertising.com', undefined, false],
  ['copilot.microsoft.com', undefined, false],
  ['docs.base.org', ['n7VghBvQo9fKfh5nqf8XLRdgA5KpZc2xjjIla8XHO+k=', 1], false],
  ['drpc.org', ['59blMPXMrimFarphox8PzbXUl7EGzBkqQXlb2DjMJYU=', 1], false],
  ['euronews.com', ['00Qf2C8vDmh5NYlIspQWh06S9rkUgq37TTrzAP+Odtg=', 3], false],
  ['fortune.com', ['a1+3zJekpAmX/usMwCHTBbpo/osoiNAJpGCKuOBzoLE=', 1], false],
  ['freevideo.cz', undefined, false],
  ['github.com', undefined, false],
  ['goibibo.com', undefined, false],
  ['goodreads.com', undefined, false],
  ['gostateparks.hawaii.gov', ['JBYwuwip4exVrQIqPUVGz+FWrjnVqwLj8vqq8TXAGs0=', 1], false],
  ['jamieoliver.com', undefined, false],
  ['jetsmart.com', undefined, false],
  ['liu.se', undefined, false],
  ['login.libero.it', ['EFDuHT+cKspFIMwPpsLit5MBkADL4cFifJSluFLUu6k=', 1], false],
  ['mamba.ru', ['3Cyijp+TBuq8kMOT+yFakpK3GUdgBw3dH5M9x5gLbok=', 2], false],
  ['massagerepublic.com', undefined, false],
  ['moovitapp.com', ['yHJeNokduuywPXOjaF6MP9CJ4CBlF+X2H2u28UzLU6Y=', 2], false],
  ['myworldfix.com', undefined, false],
  ['nordarun.com', ['3hfzlWrqxNkDKbXjcST9vWASCuPWUfA1e41DXZMZ82o=', 3], false],
  ['opensource.fb.com', ['+5qjgLXR5vQPllW7bnKVkb97tTv4xG8TdAHJXmhiH2E=', 1], false],
  ['pleo.io', ['DRv+MeADAubtGiWXFF9agr8Wk9IkZmCZEoUVvK3CqAs=', 1], false],
  ['primor.eu', ['Gp7z9GqoTBMAwsgh9GKMrcNpQtXY+LCzL6miyu9TvdQ=', 3], false],
  ['privatekeys.pw', ['UCeiNrGF2DKp4gRogdcWQlWSrKi93/o6SsJkFpAb20U=', 1], false],
  ['sendgrid.com', ['WJ1cN7pc6ZMZkOUS+7qmrTn+AtlUMLKZONI8/eVhddc=', 1], false],
  ['stripchatgirls.com', ['O87YRCJw7yJGJVXqcPcWzgCuEFcva+67/ZChFxR0ULk=', 1], false],
  ['supabase.com', ['fyNq/gQyR53P46zGnFaQmzAcXthZrNTPgpjE5Qp+coE=', 2], false],
  ['tabelog.com', undefined, false],
  ['temporal.cloud', ['bMYtB8cqUekB8ICfqzhjKDjkvqLxMMrfVEJsH55J+Pc=', 1], false],
  ['temporal.io', ['yOY8MZfiQ7cLtdQNOHeOgGlYP6AfZrRRmeZyjCLDIp4=', 1], false],
  ['videosdemadurasx.com', undefined, false],
  ['vine.co', undefined, false],
  ['voximplant.com', ['eibP8jYZYDWd1gOydbPONk71HShOp8TeCxdcrY37weI=', 1], false],
  ['withpersona.com', ['BttgC24/jLdzla0v9kPROTNRLx/guLNXvIJQcGlX0+g=', 2], false],
  ['worldoftanks.eu', undefined, false],
  ['www.arnotts.com', ['+/BFJe+enU6qj0ZxCjZRR54Nvc1UHk4dSJ5othAycE0=', 1], false],
  ['www.asdatyres.co.uk', ['Qc9jfsaR6bbwRxt3Zgy7TmZpBjKPAOFCTf3D3ddzYoc=', 1], false],
  ['www.ashemaletube.com', undefined, false],
  ['www.epiphone.com', ['xBn4GTL8C3TLWkLdf1iDPXXSWC0Y/QfnTmr6M5bK4sI=', 1], false],
  ['www.escort.club', undefined, false],
  ['www.finance-magazin.de', ['jA+itzKHMdXEReaEUaNOKbEWnuzTajy8UqdzzfWI1Po=', 3], false],
  ['www.finn.no', ['YLqo3cOckIQCrg0TY5cvEVYKVjguJDBcJTRdZsrrLDM=', 1], true],
  ['www.france24.com', ['36uVkl4m+wUMPRZrHDdZDnrnK6/lz+ETsDoZArrbeNY=', 3], false],
  ['www.g-star.com', ['tElFyJc98b8e1eIcMu7T4AyOR6b0mIaNvOAU6wwcPdU=', 2], false],
  ['www.gov.br', ['2jP5ZkNOLK185bl96B/kXsg1SScsGjOzbSdy8VdLnZg=', 2], false],
  ['www.heise.de', ['ILZYIEAu9Dh3pcdm7FS9EhQ3RKU8z7cfKVLp3h3NchI=', 1], true],
  ['www.intelligems.io', undefined, false],
  ['www.kafijasdraugs.lv', ['PNqCk+fE2Az2o+hzvNXiqe+HHWh23mmAzrZNd9zeHzo=', 2], false],
  ['www.kellanova.com', ['aZxeT/PGvgW5wcPMCkeXGJlXw88lC/GfEEJY+0bUXBU=', 2], false],
  ['www.lyrath.com', ['k2lGP0argaS6Iu+9XWZxDgNim2kFpq6JQGy5o7b6BHc=', 1], false],
  ['www.meld.io', ['SrMn/AlL+1vb9Ob9MneGIdHzuDVdK0QzOfBpLbBatCQ=', 1], false],
  ['www.meteomatics.com', ['6Ps/8TBEuIaGYIyKkGiWhCO06jOtFFBwZkpvt2MES5w=', 1], false],
  ['www.mytime.mk', ['tOFLQjiyjNl9dtaePfbDtKWouVwXBY7lxmakEVQK208=', 1], true],
  ['www.myway.com', undefined, false],
  ['www.nerdwallet.com', undefined, false],
  ['www.newsflare.com', ['A1REDzJ4zCkWa3pUNGFFmChRUyObXuXONKwF/QA1s7A=', 1], false],
  ['www.northcoast.com', ['agltnUgo6/v/bKDMe116cck0BQqmYn17Ma8G1R3ZVm0=', 1], false],
  ['www.outdooractive.com', ['TFZ0mmoCPPMzbEMynO5ldHJqTTjto4jXA4SXpwFD5mU=', 1], false],
  ['www.pibank.com', ['/R/SbX32j2pKrsl33C+CGURTgOWeC2kNe1PW9VMh098=', 1], false],
  ['www.plannedparenthood.org', ['MTBXRXupEgImCJ6PURX2LZ3fqceWDu2mmZDqB8pCj5w=', 1], false],
  ['www.promod.fr', undefined, true],
  ['www.rebelmouse.com', undefined, false],
  ['www.refinery29.com', ['+bdOjXMDngBgmjcnMxUSgSVBw9y0YCBZaGlrmJe9HF8=', 1], true],
  ['www.rfi.fr', ['t8byePWKBspylgvPO568uEjwI4czAJ0ujhE3XfS2ur4=', 3], false],
  ['www.ryanair.com', ['1aXesNIeRzje8VpkE6hjGYCeBYPk1nnVpNynB1YCQY8=', 1], false],
  ['www.unilad.com', ['/PXxl4ws/HZVHq2wBHQVO9PtKFNSHHrl1wfCfmoaZ9w=', 1], true],
  ['www.wardvillage.com', ['RiDcFOm/YVgP1DuCErIfD5/Va9KAXFoem+Pdcn2qZLA=', 1], false],
  ['www.whatnot.com', undefined, false],
  ['zora.co', ['ZQGVsHwN2dm4XfAmUeYQeV2b0eJxM45CFdQtDyeVjU0=', 2], false]
]

describe('Cookie consent tests', { concurrency: CONCURRENCY }, () => {
  // Setup profile once before all tests
  before(async () => {
    await prepareProfile(args)
  })

  for (const [testCasePath, expectedHash, expectedScrollBlocking] of testCases) {
    it(testCasePath, async (t) => {
      await testPage(t, testCasePath, expectedHash, expectedScrollBlocking)
    })
  }
})
