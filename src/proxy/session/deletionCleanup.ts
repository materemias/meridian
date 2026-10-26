import { AsyncLocalStorage } from "node:async_hooks"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

const owners = new AsyncLocalStorage<SessionDeletionCleanupOwner>()
const pendingByDirectory = new Map<string, Set<Promise<void>>>()

function directoryKey(directory: string): string {
  try { return realpathSync.native(resolve(directory)) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolve(directory)
    throw error
  }
}

/** Private per-proxy custody; closing a sibling does not join this owner's work. */
export class SessionDeletionCleanupOwner {
  private readonly pending = new Set<Promise<void>>()

  run<T>(operation: () => Promise<T>): Promise<T> {
    return owners.run(this, operation)
  }

  retain(joined: Promise<void>): void {
    this.pending.add(joined)
    // Rejection cannot establish cleanup. Keep uncertain ownership until restart.
    void joined.then(() => this.pending.delete(joined), () => undefined)
  }

  async join(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }
}

/** Retain the directory's final SQL owner as well as this proxy's own cleanup. */
export function trackSessionDeletionCleanup(directory: string, joined: Promise<void>): void {
  const key = directoryKey(directory)
  const pending = pendingByDirectory.get(key) ?? new Set<Promise<void>>()
  pendingByDirectory.set(key, pending)
  pending.add(joined)
  owners.getStore()?.retain(joined)
  void joined.then(() => {
    pending.delete(joined)
    if (pending.size === 0) pendingByDirectory.delete(key)
  }, () => undefined) // Unknown cleanup keeps both ownership records.
}

export function hasPendingSessionDeletionCleanup(directory: string): boolean {
  return (pendingByDirectory.get(directoryKey(directory))?.size ?? 0) > 0
}

/** Admission covers the gaps between durable transactions and child creation. */
export async function ownSessionDeletionWork<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  trackSessionDeletionCleanup(directory, settled)
  try { return await operation() }
  finally { release() }
}
