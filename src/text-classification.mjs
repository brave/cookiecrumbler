import process from 'process'

const MAX_LENGTH_COOKIE_NOTICE = 500
const MAX_LENGTH_BROWSER_NOTICE = 1000

/**
 * Sends a boolean classification prompt to the LLM and returns whether the response matches "true"
 */
const booleanLlmQuery = (systemPrompt, prompt, llmProvider) => {
  return llmProvider.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'llama3',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    // We only need enough tokens for "true" or "false"
    max_tokens: 2,
    // Fixed seed and zero temperature to avoid randomized responses
    seed: 1,
    temperature: 0,
    // Only consider the single most likely next token
    top_p: 0
  }).then(response => {
    const answer = response.choices[0].message.content
    return /true/i.test(answer)
  })
}

const llmClassifier = (innerText, llmProvider) => {
  let innerTextSnippet = innerText.slice(0, MAX_LENGTH_COOKIE_NOTICE)
  let ifTruncated = ''
  if (innerTextSnippet.length !== innerText.length) {
    innerTextSnippet += '...'
    ifTruncated = `the first ${MAX_LENGTH_COOKIE_NOTICE} characters of `
  }
  const systemPrompt = `Your task is to classify text from the innerText property of HTML overlay elements.

An overlay element is considered to be a "cookie consent notice" if it meets all of these criteria:
1. it explicitly notifies the user of the site's use of cookies or other storage technology, such as: "We use cookies...", "This site uses...", etc.
2. it offers the user choices for the usage of cookies on the site, such as: "Accept", "Reject", "Learn More", etc., or informs the user that their use of the site means they accept the usage of cookies.

Note: This definition does not include adult content notices or any other type of notice that is primarily focused on age verification or content restrictions. Cookie consent notices are specifically intended to inform users about the website's use of cookies and obtain their consent for such use.

Note: A cookie consent notice should specifically relate to the site's use of cookies or other storage technology that stores data on the user's device, such as HTTP cookies, local storage, or session storage. Requests for permission to access geolocation information, camera, microphone, etc., do not fall under this category.

Note: Do NOT classify a website header or footer as a "cookie consent notice". Website headers or footers may contain a list of links, possibly including a privacy policy, cookie policy, or terms of service document, but their primary purpose is navigational rather than informational.
`
  const prompt = `
The following text was captured from ${ifTruncated}the innerText of an HTML overlay element:

\`\`\`
${innerTextSnippet}
\`\`\`

Is the overlay element above considered to be a "cookie consent notice"? Provide your answer as a boolean.
`
  return booleanLlmQuery(systemPrompt, prompt, llmProvider)
}

const keywordClassifier = (innerText) => {
  const keywords = [
    'cookies',
    'consent',
    'privacy',
    'analytics',
    'accept',
    'only necessary',
    'reject'
  ]
  const lower = innerText.toLowerCase()
  for (const keyword of keywords) {
    if (lower.includes(keyword)) {
      return true
    }
  }
  return false
}

export function cookieNoticeClassifier (innerText, llmProvider) {
  return llmClassifier(innerText, llmProvider)
    .then(classification => {
      return {
        classifier: 'llm',
        classification
      }
    })
    .catch(e => {
      console.error('LLM classification failed:', e)
      return {
        classifier: 'keyword',
        classification: keywordClassifier(innerText)
      }
    })
}

const browserLlmClassifier = (innerText, llmProvider) => {
  let innerTextSnippet = innerText.slice(0, MAX_LENGTH_BROWSER_NOTICE)
  let ifTruncated = ''
  if (innerTextSnippet.length !== innerText.length) {
    innerTextSnippet += '...'
    ifTruncated = `the first ${MAX_LENGTH_BROWSER_NOTICE} characters of `
  }
  const systemPrompt = `Your task is to classify text from the innerText property of HTML elements.

An element is considered an "unsupported browser notice" if it meets any of these criteria:
1. It explicitly tells the user that their browser is not supported, unsupported, outdated, or no longer supported.
2. It instructs or urges the user to upgrade, update, or switch to a supported or newer browser.
3. It lists supported browsers (e.g. Chrome, Firefox, Safari, Edge) and implies the user's current browser is not among them.
4. It blocks or restricts access because of the user's browser version or type.

Do NOT classify as unsupported browser notice: cookie consent banners, age verification, login prompts, generic error messages, or notices about JavaScript being disabled (unless they also say the browser is unsupported).`
  const prompt = `
The following text was captured from ${ifTruncated} the element:

\`\`\`
${innerTextSnippet}
\`\`\`

Is the overlay element above an "unsupported browser notice" (telling the user their browser is not supported and/or they need to upgrade)? Provide your answer as a boolean.
`
  return booleanLlmQuery(systemPrompt, prompt, llmProvider)
}

export function browserNoticeClassifier (innerText, llmProvider) {
  return browserLlmClassifier(innerText, llmProvider)
    .then(classification => {
      return {
        classifier: 'llm',
        classification
      }
    })
    .catch(e => {
      console.error('LLM unsupported-browser classification failed:', e)
    })
}
