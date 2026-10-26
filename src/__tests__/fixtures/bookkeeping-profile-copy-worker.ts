import { once } from "node:events"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { initializeSessionBookkeeping } from "../../proxy/session/bookkeeping/database"
import { sqliteSessionStoreBackend } from "../../proxy/session/bookkeeping/sqliteStoreBackend"
import { sqliteLifecycleBackend } from "../../proxy/session/bookkeeping/lifecycleSql"
import { setSessionStoreBackendForTest, setSessionStoreDir } from "../../proxy/sessionStore"
import { releaseSupersededProfileCopies, setSessionLifecycleBackendForTest } from "../../proxy/sessionLifecycle"

if (process.versions.bun) throw new Error("native Node actor required")
const [directory, partition] = process.argv.slice(2)
if (!directory || !["0", "1"].includes(partition!)) throw new Error("owned directory and partition required")
setSessionStoreDir(directory)
let admitted = false, committed = false, fenced = 0
const handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
  db.exec(sql)
  if (sql === "COMMIT" && admitted && !committed) {
    committed = true
    writeFileSync(join(directory, `prune-committed-${partition}`), "done")
  }
} })
setSessionStoreBackendForTest(sqliteSessionStoreBackend)
setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
const ready = once(process, "message")
process.send!({ type: "ready", pid: process.pid, node: process.version })
try {
  await ready
  const { CrossProcessTurnCoordinator } = await import("../../proxy/session/crossProcessTurnCoordinator")
  const coordinator = new CrossProcessTurnCoordinator(join(directory, "turn-locks"))
  const acquire = coordinator.tryAcquireIdle.bind(coordinator)
  coordinator.tryAcquireIdle = async key => {
    const lease = await acquire(key)
    if (lease) fenced++
    return lease
  }
  const waitFor = (prefix: string) => {
    const other = join(directory, `${prefix}-${partition === "0" ? "1" : "0"}`)
    const deadline = Date.now() + 5000
    while (!existsSync(other)) {
      if (Date.now() >= deadline) throw new Error(`other original actor did not reach ${prefix}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  const removed = await releaseSupersededProfileCopies({ profileIds: ["work", "personal"],
    graceMs: 24 * 60 * 60_000,
    isConversationActive: id => Number(id.split("-").at(-1)) % 2 !== Number(partition),
  }, { storeDir: directory, maxPending: 8, pinProvider: () => {
    // Both initial reconciliations and disjoint turn fences precede either prune.
    // Both native prune commits precede either post-prune reconciliation.
    if (fenced === 4 && !admitted) {
      admitted = true
      writeFileSync(join(directory, `prune-ready-${partition}`), "ready")
      waitFor("prune-ready")
    }
    if (committed) waitFor("prune-committed")
    return []
  }, lockWaitMs: 5000 }, coordinator)
  setSessionLifecycleBackendForTest(null)
  setSessionStoreBackendForTest(null)
  handle.close()
  process.send!({ type: "done", removed, node: process.version, platform: process.platform,
    arch: process.arch, pid: process.pid }, () => { process.disconnect() })
} catch (error) {
  setSessionLifecycleBackendForTest(null)
  setSessionStoreBackendForTest(null)
  handle.close()
  throw error
}
