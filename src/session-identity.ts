/** Read only route names from host history; never return prompts or credentials. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const name = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

export function externalSessionIdentity(log: { header?: unknown; events?: readonly { type: string; data: unknown }[] }) {
  let route = object(object(log.header).config)
  let source = 'request/header'
  // The latest request wins over a historical assistant response or a pending selection.
  for (const event of log.events ?? []) {
    if (event.type !== 'request/header') continue
    const candidate = object(object(object(event.data).header).config)
    if (name(candidate.provider)) route = candidate
  }
  if (!name(route.provider)) {
    for (const event of log.events ?? []) {
      if (event.type === 'assistant/message') {
        const observed = object(object(object(event.data).message).source)
        if (name(observed.provider)) { route = observed; source = 'assistant/message.source' }
      }
    }
  }
  const provider = name(route.provider), model = name(route.model)
  const external = provider === 'pilot-cli' || provider.startsWith('harness-')
  const split = model.indexOf('::')
  return {
    external, provider, source,
    harness: provider === 'pilot-cli' ? (split < 0 ? model : model.slice(0, split)) : provider.replace(/^harness-/, ''),
    requestedModel: provider === 'pilot-cli' ? (split < 0 ? '' : model.slice(split + 2))
      : model === 'cli-default' ? '' : split < 0 ? model : model.slice(split + 2),
    // A host route or argv proves the request, not the vendor's internal model.
    actualModel: null,
  }
}

export interface SessionExecutionIdentity {
  provider: string
  requestedModel: string
  target: string
  stopReason: string
  mismatch: readonly string[]
  at: string
  accountId?: string
  accountLabel?: string
}

/** Completed one-shot children leave the live registry; retain names only for their pages. */
export class SessionIdentityStore {
  private rows: Record<string, SessionExecutionIdentity> = Object.create(null)
  constructor(private readonly file: string) {
    try {
      const stored = object(JSON.parse(readFileSync(file, 'utf8')))
      for (const [id, raw] of Object.entries(stored)) {
        const row = object(raw)
        if (name(row.provider) && name(row.target)) this.rows[id] = {
          provider: name(row.provider), requestedModel: name(row.requestedModel), target: name(row.target),
          stopReason: name(row.stopReason), at: name(row.at),
          mismatch: Array.isArray(row.mismatch) ? row.mismatch.filter((value): value is string => typeof value === 'string') : [],
          ...(name(row.accountId) ? {accountId:name(row.accountId),accountLabel:name(row.accountLabel)} : {}),
        }
      }
    } catch { /* no previous execution names */ }
  }
  get(id: string) { return this.rows[id] }
  set(id: string, row: SessionExecutionIdentity) {
    this.rows[id] = row
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify(this.rows), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
}
