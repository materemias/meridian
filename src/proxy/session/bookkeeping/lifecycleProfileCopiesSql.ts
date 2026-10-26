import { join } from "node:path"
import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { CrossProcessTurnCoordinator, type CrossProcessTurnLease } from "../crossProcessTurnCoordinator"
import { SessionLifecycleBacklogError, SessionLifecycleCorruptError, SessionLifecycleError } from "../lifecycleErrors"
import { PIN_LOOKUP_SQL } from "./mappings"
import type { ProfileCopyPruneOptions } from "./profileCopies"
import { directoryFor, normalizeInput, nowMs, pendingCount, positiveOption } from "./lifecycleRowsSql"
import { reconcile } from "./lifecycleReconcileSql"
import { readResource } from "./resources"
import { prepareProfileCopyPrune, prunePreparedProfileCopies } from "./storeProfileCopiesSql"
import { withBookkeepingWriteAsync } from "./transaction"

/** Mapping deletion and the retirement it admits share one native commit. All application
 * callbacks, filesystem observations, turn admission and waits remain outside that commit. */
export async function releaseSupersededProfileCopies(
  copies: Omit<ProfileCopyPruneOptions, "maxUnpinnedTranscripts">,
  options: SessionLifecycleOptions = {},
  coordinator = new CrossProcessTurnCoordinator(join(directoryFor(options), "turn-locks")),
): Promise<number> {
  const maximum = positiveOption(options.maxPending, 256, "maxPending")
  const half = Math.floor(maximum / 2)
  const pinProvider = options.pinProvider
  if (!pinProvider) throw new SessionLifecycleError("profile-copy pruning requires an authoritative pin provider")
  const observePins = () => {
    for (const pin of pinProvider()) normalizeInput(pin, options)
  }
  observePins()
  // Recover old unrecorded retirements before granting additional capacity.
  await reconcile([], options)
  if (half === 0) return 0
  const directory = directoryFor(options)
  const prepared = prepareProfileCopyPrune(directory, { ...copies, maxUnpinnedTranscripts: half })
  const leases: CrossProcessTurnLease[] = []
  const fenced = new Set<string>()
  try {
    for (const conversation of [...prepared.conversations].slice(0, 64)) {
      const lease = await coordinator.tryAcquireIdle(`session:${conversation}`)
      if (!lease) continue
      leases.push(lease)
      if (!copies.isConversationActive(conversation)) fenced.add(conversation)
    }
    prepared.conversations = fenced
    if (!fenced.size) return 0
    observePins()
    let now = nowMs(options)
    const grace = options.retiredGraceMs ?? 11 * 60_000
    if (!Number.isSafeInteger(grace) || grace < 0) throw new TypeError("retiredGraceMs must be a non-negative integer")
    const removed = await withBookkeepingWriteAsync(directory, options, tx => {
      const budget = half - pendingCount(tx)
      if (budget <= 0) return 0
      const result = prunePreparedProfileCopies(tx, prepared, budget)
      for (const [key, generations] of result.resources) {
        const resource = readResource(tx, key)
        if (!resource) throw new SessionLifecycleCorruptError("profile copy pins a missing transcript")
        if (!generations.has(null) && !generations.has(resource.generation)) continue
        if (resource.state === "deleted" || resource.state === "deleting")
          throw new SessionLifecycleError("profile copy pins a deleting or deleted transcript")
        if (resource.state !== "live" || tx.get(PIN_LOOKUP_SQL, key, resource.generation)
          || tx.get("SELECT token FROM resource_leases WHERE resource_key=? LIMIT 1", key)) continue
        // Reserve conservatively even if an additional application pin may rescue this row.
        // Reconciliation below refreshes those pins outside SQL and promotes it before release.
        // A deletion claim independently refreshes pins and cannot use this reservation as proof.
        tx.run(`UPDATE resources SET state='retired',updated_at=?,next_attempt_at=?,row_version=row_version+1
          WHERE key=? AND generation=? AND row_version=? AND state='live'`,
          now, now + grace, key, resource.generation, resource.rowVersion)
      }
      if (pendingCount(tx) > half) throw new SessionLifecycleBacklogError("profile-copy retirement reservation exceeds budget")
      return result.removed
    }, () => {
      // A local turn may register while this sweep waits for FIFO/native admission.
      // Foreign turns remain fenced by the real maintenance leases throughout.
      prepared.conversations = new Set([...fenced].filter(id => !copies.isConversationActive(id)))
      observePins()
      now = nowMs(options)
    })
    if (removed) await reconcile([], options)
    return removed
  } finally {
    const releases = await Promise.allSettled(leases.map(lease => lease.release()))
    const failure = releases.find(result => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }
}
