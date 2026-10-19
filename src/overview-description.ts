import { redactAccount } from './federation/poolconfig.js'

/** Display-only account redaction; machine selectors and declaration text remain untouched. */
export function redactOverviewDescription(description: string, seeds: readonly { readonly id: string }[]): string {
  const ids = [...new Set(seeds.map(seed => seed.id).filter(id => id.length > 0 && !id.startsWith('acct:')))]
    .sort((a, b) => b.length - a.length)
  const escaped = ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  let result = escaped.length === 0 ? description : description.replace(
    new RegExp(`(?<![A-Za-z0-9_.-])(?:${escaped.join('|')})(?![A-Za-z0-9_.-])`, 'g'),
    id => redactAccount(id),
  )
  // Only identifiers immediately following an explicit account label are eligible.
  // Numeric versions/counts and ordinary words are not account evidence.
  result = result.replace(
    /((?:账号(?:档案|\s*(?:ID|UID))?|account(?:\s+(?:id|uid))?)\s*[:：=]?\s*)([A-Za-z0-9][A-Za-z0-9._@+-]*)/gi,
    (match, prefix: string, candidate: string) => {
      if (candidate === 'acct' || candidate.startsWith('acct:')) return match
      const punctuation = candidate.match(/\.+$/)?.[0] ?? ''
      candidate = punctuation.length === 0 ? candidate : candidate.slice(0, -punctuation.length)
      if (/^\d+(?:\.\d+)+$/.test(candidate)) return match
      const email = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(candidate)
      const numeric = /^\d{5,}$/.test(candidate)
      const uid = /[A-Za-z]/.test(candidate) && /\d{4,}/.test(candidate)
      const explicitId = /(?:ID|UID)\s*[:：=]?\s*$/i.test(prefix)
      return email || numeric || uid || explicitId ? prefix + redactAccount(candidate) + punctuation : match
    },
  )
  return result
}
