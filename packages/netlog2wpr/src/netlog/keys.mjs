/**
 * Source keys identify a netlog source across the parser's maps as
 * "<type>:<id>". Source ids are partitioned per source type, so the type is
 * part of the key. Branded so ordinary strings cannot be passed where a key
 * is expected.
 * @typedef {string & { readonly __brand: 'SourceKey' }} SourceKey
 */

/**
 * Builds the key of a source type/id pair.
 * @param {number} type
 * @param {number} id
 * @returns {SourceKey}
 */
export const sourceKey = (type, id) => /** @type {SourceKey} */ (`${type}:${id}`)

/**
 * Key of a { id, type } source ref, or null when either part is missing.
 * @param {{ id?: number, type?: number }|undefined} source
 * @returns {SourceKey|null}
 */
export const sourceKeyOf = (source) => {
  const { id, type } = source ?? {}
  if (id === undefined || type === undefined) return null
  return sourceKey(type, id)
}

/**
 * Key of params.source_dependency, or null.
 * @param {{ source_dependency?: { id?: number, type?: number } }|undefined} params
 * @returns {SourceKey|null}
 */
export const depKey = (params) => sourceKeyOf(params?.source_dependency)
