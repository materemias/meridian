/** Selection is pure; JSON and SQLite supply the same ordered metadata. */
export interface ProfileCopyPruneOptions {
  /** Configured non-default profile IDs; only their `${id}:` prefixes are recognized. */
  profileIds: Iterable<string>
  /** Copies used within this window are kept alongside the newest one. */
  graceMs: number
  /** Most transcripts the removed mappings may stop pinning in this call. */
  maxUnpinnedTranscripts: number
  /** A conversation with a request arrived or running keeps every copy. */
  isConversationActive: (conversationId: string) => boolean
}

export interface ProfileCopy {
  key: string
  lastUsedAt: number
  pinnedTranscripts: number
}

export function profileConversationId(key: string, profileIds: ReadonlySet<string>): string {
  const separator = key.indexOf(":")
  return separator > 0 && key.slice(0, separator) !== "default" && profileIds.has(key.slice(0, separator))
    ? key.slice(separator + 1) : key
}

export function selectProfileCopies(
  entries: readonly ProfileCopy[], protectedKeys: ReadonlySet<string>, options: ProfileCopyPruneOptions, now: number,
): string[] {
  const profiles = new Set(options.profileIds)
  const groups = new Map<string, ProfileCopy[]>()
  for (const entry of entries) {
    const conversation = profileConversationId(entry.key, profiles)
    const group = groups.get(conversation)
    if (group) group.push(entry)
    else groups.set(conversation, [entry])
  }
  const candidates: ProfileCopy[] = []
  for (const [conversation, group] of groups) {
    if (group.length < 2) continue
    const newest = group.reduce((best, entry) => entry.lastUsedAt > best.lastUsedAt ? entry : best)
    const superseded = group.filter(entry => entry !== newest && !protectedKeys.has(entry.key)
      && now - entry.lastUsedAt > options.graceMs)
    if (superseded.length && !options.isConversationActive(conversation)) candidates.push(...superseded)
  }
  candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  let remaining = options.maxUnpinnedTranscripts
  return candidates.filter(entry => {
    if (entry.pinnedTranscripts > remaining) return false
    remaining -= entry.pinnedTranscripts
    return true
  }).map(entry => entry.key)
}
