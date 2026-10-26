import { profileConversationId, selectProfileCopies, type ProfileCopyPruneOptions } from "./profileCopies"
import { MAPPING_OBJECT_ORDER } from "./mappingMetadata"
import { advanceStoreSlot } from "./storeMutationSupport"
import { withStoreRead, withStoreWrite } from "./storeScope"
import type { BookkeepingReader, BookkeepingTransaction } from "./types"

function snapshot(reader: BookkeepingReader) {
  // Selection never hydrates histories or canonicalizes paths under a native transaction.
  const entries = reader.all(`SELECT key,last_used_at,generation_token,
    (CASE WHEN json_extract(current_locator_json,'$.sessionId')=claude_session_id THEN 1 ELSE 0 END
    + CASE WHEN json_extract(previous_locator_json,'$.sessionId')=previous_claude_session_id THEN 1 ELSE 0 END) AS pin_count
    FROM mappings ORDER BY ${MAPPING_OBJECT_ORDER}`).map(row => ({
    key: String(row.key), lastUsedAt: Number(row.last_used_at) || 0,
    generation: String(row.generation_token), pinnedTranscripts: Number(row.pin_count),
  }))
  const protectedKeys = new Set(reader.all(`SELECT mapping_key FROM priority_assignments
    UNION SELECT mapping_key FROM priority_rollbacks`).map(row => String(row.mapping_key)))
  return { entries, protectedKeys }
}

/** The application callback runs only after its native read scope has closed. */
export function prepareProfileCopyPrune(directory: string, options: ProfileCopyPruneOptions) {
  const observed = withStoreRead(directory, snapshot)
  const profileIds = new Set(options.profileIds)
  const selected = new Set(selectProfileCopies(observed.entries, observed.protectedKeys,
    { ...options, profileIds }, Date.now()))
  const generations = new Map(observed.entries.filter(row => selected.has(row.key))
    .map(row => [row.key, row.generation]))
  return { profileIds, graceMs: options.graceMs, generations,
    conversations: new Set([...selected].map(key => profileConversationId(key, profileIds))) }
}
export type PreparedProfileCopyPrune = ReturnType<typeof prepareProfileCopyPrune>

/** Revalidate metadata, protected routes and exact generations at the deletion linearization point. */
export function prunePreparedProfileCopies(
  tx: BookkeepingTransaction, prepared: PreparedProfileCopyPrune, budget: number,
) {
  const current = snapshot(tx)
  for (const row of current.entries) {
    if (prepared.generations.get(row.key) !== row.generation) current.protectedKeys.add(row.key)
  }
  const victims = selectProfileCopies(current.entries, current.protectedKeys, {
    profileIds: prepared.profileIds, graceMs: prepared.graceMs, maxUnpinnedTranscripts: budget,
    isConversationActive: id => !prepared.conversations.has(id),
  }, Date.now())
  const resources = new Map<string, Set<string | null>>()
  for (const key of victims) {
    for (const pin of tx.all("SELECT resource_key,generation FROM mapping_pins WHERE mapping_key=?", key)) {
      const resource = String(pin.resource_key)
      let generations = resources.get(resource)
      if (!generations) resources.set(resource, generations = new Set())
      generations.add(pin.generation === null ? null : String(pin.generation))
    }
    tx.run("DELETE FROM mappings WHERE key=?", key)
    advanceStoreSlot(tx, key)
  }
  return { removed: victims.length, resources }
}

export function listSupersededProfileConversations(directory: string, options: ProfileCopyPruneOptions): string[] {
  return [...prepareProfileCopyPrune(directory, options).conversations]
}

export function pruneSupersededProfileCopies(directory: string, options: ProfileCopyPruneOptions): number {
  const prepared = prepareProfileCopyPrune(directory, options)
  if (!prepared.generations.size) return 0
  return withStoreWrite(directory, tx => prunePreparedProfileCopies(tx, prepared, options.maxUnpinnedTranscripts).removed)
}
