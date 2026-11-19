/**
 * A small JSON Schema checker for record stages.
 *
 * It covers the part of JSON Schema a record's *shape* needs — type,
 * required, properties, additionalProperties: false, items, enum, const,
 * minItems/maxItems, minimum/maximum, minLength, pattern — and nothing else.
 * No `$ref`, no `oneOf`. That is deliberate: a machine's real rules (windows,
 * floors, coverage) live in its validator command, which can be any program,
 * so the schema only has to say what fields exist. Keeping it dependency-free
 * also means the app never reinstalls `node_modules` for it.
 *
 * Returns a list of failures, each a sentence a worker can act on. Empty
 * means the value fits.
 */
export function check(schema, value, at = 'record') {
  const out = []
  walk(schema ?? {}, value, at, out)
  return out
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)

function fits(type, v) {
  const t = typeOf(v)
  return type === t || (type === 'number' && t === 'integer')
}

function walk(s, v, at, out) {
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    if (!types.some((t) => fits(t, v))) {
      out.push(`${at} must be ${types.join(' or ')}, but is ${typeOf(v)}`)
      return
    }
  }
  if (s.const !== undefined && v !== s.const) out.push(`${at} must be ${JSON.stringify(s.const)}`)
  if (s.enum && !s.enum.includes(v)) out.push(`${at} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}, but is ${JSON.stringify(v)}`)

  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at} must be at least ${s.minimum}, but is ${v}`)
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at} must be at most ${s.maximum}, but is ${v}`)
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${at} must be at least ${s.minLength} characters`)
    if (s.pattern && !new RegExp(s.pattern).test(v)) out.push(`${at} must match ${s.pattern}`)
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at} needs at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}, but has ${v.length}`)
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at} may have at most ${s.maxItems} items, but has ${v.length}`)
    if (s.items) v.forEach((item, i) => walk(s.items, item, `${at}[${i}]`, out))
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const key of s.required ?? []) if (v[key] === undefined) out.push(`${at}.${key} is required`)
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (v[key] !== undefined) walk(sub, v[key], `${at}.${key}`, out)
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(v)) if (!(key in (s.properties ?? {}))) out.push(`${at}.${key} is not a field of this record`)
    }
  }
}
