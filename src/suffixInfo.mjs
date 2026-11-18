// Public Suffix List singleton: the shipped public_suffix_list.dat is parsed
// once (via @gorhill/publicsuffixlist) and reused for both the inpage eTLD+1
// lookups and the WprGo archive-key derivation, so no second trie is built.
// The parser answers "what is the public suffix / registrable domain"; the
// raw file's section markers additionally classify a matched suffix as ICANN
// (official registry suffix) or PRIVATE (platform suffix), which the parser
// itself does not expose (see its node flags). The sets also detect implicit
// "*" fallback matches: a suffix the parser invents for unknown hostnames
// (localhost, IP labels, unlisted TLDs) is in neither section.

import fs from 'fs/promises'
import path from 'path'
import nodeUrl from 'node:url'

import suffixList from '@gorhill/publicsuffixlist'

const PSL_PATH = path.join(import.meta.dirname, '..', 'public_suffix_list.dat')

let init

export const ensurePsl = () => {
  if (init === undefined) {
    init = fs.readFile(PSL_PATH, 'utf8').then(data => {
      suffixList.parse(data, nodeUrl.domainToASCII)
      return buildSuffixSets(data)
    }).catch(error => {
      // A failed load (e.g. the list was not fetched yet) must not be cached
      // until restart
      init = undefined
      throw error
    })
  }
  return init
}

// Raw eTLD+1 lookup for the inpage API, which passes URL hosts verbatim
// (including ports) and relies on the parser's behavior for them; no
// normalization and no suffix classification on this hot path.
export const pslGetDomain = (hostname) => {
  return ensurePsl().then(() => suffixList.getDomain(hostname))
}

// Punycodes a rule line exactly like the parser does: only when it contains
// non-ASCII characters, lowercased first. Returns '' when the conversion
// fails (the caller skips such lines), mirroring the parser's leniency.
const punycodeRule = (line) => {
  if (/[^*a-z0-9.-]/.test(line)) {
    return nodeUrl.domainToASCII(line.toLowerCase())
  }
  return line
}

// Mirrors the parser's line handling (comment stripping, trimming, IDN
// punycoding) over one PSL section, collecting the suffixes it can produce:
// - exact: plain entries, plus the implied suffix of exception entries
//   ("!www.ck" makes "ck" the public suffix for "www.ck")
// - wildcards: the fixed part of wildcard entries ("*.ck" -> "ck"); a
//   wildcard-matched suffix always ends in the fixed part
const buildSectionSets = (section) => {
  const exact = new Set()
  const wildcards = []
  for (let line of section.split('\n')) {
    const comment = line.indexOf('//')
    if (comment !== -1) {
      line = line.slice(0, comment)
    }
    line = line.trim()
    if (line.length === 0) {
      continue
    }
    if (line.startsWith('!')) {
      const implied = punycodeRule(line.slice(1))
      const dot = implied.indexOf('.')
      if (dot !== -1) {
        exact.add(implied.slice(dot + 1))
      }
      continue
    }
    const rule = punycodeRule(line)
    if (rule === '') {
      continue
    }
    if (rule.startsWith('*.')) {
      wildcards.push(rule.slice(2))
    } else {
      exact.add(rule)
    }
  }
  return { exact, wildcards }
}

const buildSuffixSets = (data) => {
  const begin = data.indexOf('// ===BEGIN PRIVATE DOMAINS===')
  const end = data.indexOf('// ===END PRIVATE DOMAINS===')
  return {
    icann: buildSectionSets(begin === -1 ? data : data.slice(0, begin)),
    private: buildSectionSets(begin === -1 || end === -1 ? '' : data.slice(begin, end))
  }
}

const matchesSets = (sets, suffix) => {
  return sets.exact.has(suffix) || sets.wildcards.some(part => suffix.endsWith(`.${part}`))
}

/**
 * Suffix metadata for a hostname (IDN-safe: punycoded via domainToASCII).
 * Returns { hostname, suffix, registrable, official, isPrivate }:
 * - suffix: matched public suffix ('' when the hostname has no labels)
 * - official: the suffix derives from an explicit PSL entry (plain, wildcard
 *   or exception rule). The parser's implicit "*" fallback rule does not
 *   count as official, so captures of unknown-TLD hostnames, single-label
 *   hosts and IP addresses can be told apart from real registrable domains.
 * - registrable: eTLD+1 ('' when the hostname is itself a public suffix)
 */
export const suffixInfoForHostname = async (hostname) => {
  const sets = await ensurePsl()
  const ascii = (nodeUrl.domainToASCII(hostname) || '').toLowerCase().replace(/\.$/, '')
  const suffix = ascii === '' ? '' : suffixList.getPublicSuffix(ascii)
  const registrable = ascii === '' ? '' : suffixList.getDomain(ascii)
  const official = matchesSets(sets.icann, suffix) || matchesSets(sets.private, suffix)
  return {
    hostname: ascii,
    suffix,
    registrable,
    official,
    isPrivate: official && matchesSets(sets.private, suffix)
  }
}
