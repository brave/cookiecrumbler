// Zod schema for the check request body: the single source of truth for the
// /check and /check/stream contract. The factory closes over the runtime
// catalogs the request is validated against (proxy locations, devices,
// viewports, feature flags), so the schema stays testable with synthetic
// catalogs. Parse failures are surfaced by the validateBody middleware as
// 400 responses carrying per-issue { path, code, message } details.

import { z } from 'zod'

import { isValidHttpUrl } from '../util.mjs'

const MAX_FILTER_RULES = 1000

export function createCheckRequestSchema ({ validProxies, validDevices, validViewports, validDisableFeatures, validAdblockLists }) {
  // The UI submits empty strings for "unset" dropdowns; only truthy values
  // must come from the configured catalog
  const inList = list => (value) => !value || list.includes(value)

  const wprGoSchema = z.object({
    action: z.enum(['record', 'replay']),
    data: z.string().min(1, 'wprGo.data must be a non-empty base64 string').optional(),
    // Server-local archive paths are rejected at the API boundary: they let
    // wpr read arbitrary files. Upload the archive via wprGo.data instead
    // (materialized under a randomized server-side tmp path). never +
    // optional: only fails when a value is actually supplied
    path: z.never({ message: 'wprGo.path is not supported; upload the archive via wprGo.data' }).optional()
  }).strict().superRefine((wprGo, ctx) => {
    if (wprGo.action === 'replay' && wprGo.data === undefined) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'wprGo.data is required for replay action' })
    }
    if (wprGo.data !== undefined && wprGo.action !== 'replay') {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'wprGo.data is only supported for replay action' })
    }
  })

  return z.object({
    // Only http(s) URLs are navigable by the check browser (blocks file://);
    // '' behaves like an absent url in the required-url rule below.
    // Refinements attach before .optional(): in zod v4 a check appended to
    // an optional schema also runs for absent values
    url: z.string().refine(
      url => url === '' || isValidHttpUrl(url),
      { message: 'url must be a valid http or https URL' }
    ).optional(),
    seconds: z.number().int()
      .min(1, 'seconds must be at least 1')
      .max(60, 'seconds must be at most 60')
      .optional()
      .default(4),
    // Strict object of the known list ids (from adblock_lists.json): unknown
    // ids collapse into a single unrecognized_keys issue, so the issue count
    // stays bounded by the catalog size however many keys a body carries
    adblockLists: z.object(
      Object.fromEntries(validAdblockLists.map(id => [id, z.boolean().optional()]))
    ).strict().optional(),
    additionalFilterRules: z.array(z.string()).max(MAX_FILTER_RULES, { message: `additionalFilterRules supports at most ${MAX_FILTER_RULES} rules` }).optional(),
    screenshot: z.union([z.boolean(), z.literal('always'), z.literal('fullPage')]).optional(),
    markup: z.boolean().optional(),
    location: z.string().refine(inList(validProxies), { message: 'invalid location' }).optional(),
    slowCheck: z.boolean().optional(),
    device: z.string().refine(inList(validDevices), { message: 'unknown device' }).optional(),
    viewport: z.string().refine(inList(validViewports), { message: 'unknown viewport preset' }).optional(),
    userAgent: z.string().optional(),
    disableFeatures: z.array(z.string())
      // every entry must be in the allowlist, so an oversized array can
      // never validate: reject on size before any element is parsed
      .max(validDisableFeatures.length, { message: `disableFeatures supports at most ${validDisableFeatures.length} values` })
      .refine(
        features => features.every(feature => validDisableFeatures.includes(feature)),
        { message: 'disableFeatures contains unsupported values' }
      )
      .optional(),
    wprGo: wprGoSchema.optional()
  }).strict().superRefine((body, ctx) => {
    if (body.device && body.viewport) {
      ctx.addIssue({ code: 'custom', path: [], message: 'cannot specify both device and viewport' })
    }
    // URL is only optional when replaying a WprGo archive (a URL is then
    // taken from the archive itself)
    if (!body.url && !(body.wprGo?.action === 'replay' && body.wprGo.data !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'url is required' })
    }
  })
}
