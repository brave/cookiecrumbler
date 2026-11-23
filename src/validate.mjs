// Shared request validation middleware: parses the request with a zod schema
// and either stashes the parsed data (defaults applied) on ctx.state.body for
// the handler, or responds 400. `error` names the first violated rule so the
// shape API clients and the UI already consume stays informative; `issues` is
// additive detail listing every violated rule with its request path.

const MAX_ISSUES = 10
const MAX_KEYS = 50

const formatIssues = (error) => error.issues.slice(0, MAX_ISSUES).map(issue => ({
  path: issue.path.join('.'),
  code: issue.code,
  message: issue.keys
    ? `unrecognized keys: ${issue.keys.slice(0, MAX_KEYS).join(', ')}${issue.keys.length > MAX_KEYS ? `, +${issue.keys.length - MAX_KEYS} more` : ''}`
    : issue.message,
  // unrecognized_keys issues name the offending fields for programmatic use
  ...(issue.keys ? { keys: issue.keys.slice(0, MAX_KEYS) } : {})
}))

// Unknown field names get echoed in 400 responses; capping their length here keeps every echo small without response-side truncation
const MAX_KEY_LENGTH = 500

// Only the top level and one nesting level down (wprGo, adblockLists) carry
// strict-object keys, so a shallow walk cannot be blown up by deep nesting
const hasOversizedKey = (value, depth = 0) => {
  if (depth > 1 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.keys(value).some(key => key.length > MAX_KEY_LENGTH || hasOversizedKey(value[key], depth + 1))
}

export const validateBody = (schema) => async (ctx, next) => {
  if (hasOversizedKey(ctx.request.body)) {
    ctx.status = 400
    ctx.body = { error: `Bad Request: field names must be at most ${MAX_KEY_LENGTH} characters` }
    return
  }
  const result = schema.safeParse(ctx.request.body)
  if (!result.success) {
    // Build the primary error from the formatted first issue so it inherits
    // the same truncation as the detail list (e.g. an unrecognized_keys
    // issue's raw message embeds every offending key, unbounded)
    const issues = formatIssues(result.error)
    const [first] = issues
    const detail = first.path ? `${first.path}: ${first.message}` : first.message
    const more = result.error.issues.length > 1 ? ` (+${result.error.issues.length - 1} more)` : ''
    ctx.status = 400
    ctx.body = {
      error: `Bad Request: ${detail}${more}`,
      issues
    }
    return
  }
  ctx.state.body = result.data
  await next()
}
