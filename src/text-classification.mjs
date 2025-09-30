import process from 'process'

const MAX_LENGTH = 500

const llmClassifier = (innerText, llmProvider) => {
  let innerTextSnippet = innerText.slice(0, MAX_LENGTH)
  let ifTruncated = ''
  if (innerTextSnippet.length !== innerText.length) {
    innerTextSnippet += '...'
    ifTruncated = `the first ${MAX_LENGTH} characters of `
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
    return answer.match(/true/i)
  })
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
