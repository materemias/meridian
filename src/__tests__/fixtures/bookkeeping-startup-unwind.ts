import { NativeDatabase as Database } from "../../proxy/session/bookkeeping/nativeDatabase"
import { initializeSessionBookkeeping } from "../../proxy/session/bookkeeping/connection"
import { acquireMaintenanceGuard } from "../../proxy/session/bookkeeping/guard"

const [mode, directory] = process.argv.slice(2)
if (!directory || !["prepare", "get", "identity", "close-failure"].includes(mode!)) {
  throw new Error("expected failure mode and an owned directory")
}
initializeSessionBookkeeping(directory).close()

const prepare = Database.prototype.prepare
let captured: Database | undefined
let closes = 0
let openError: unknown
let nativeUsable = false
let maintenanceAcquired = false
let maintenanceError: unknown
let reopened = false
let reopenError: unknown

Database.prototype.prepare = function (sql: string) {
  if (sql !== "SELECT migration_id,source_digests_json FROM schema_meta") return prepare.call(this, sql)
  captured = this
  if (mode === "prepare" || mode === "close-failure") throw new Error("owned provenance prepare fault")
  const statement = prepare.call(this, sql)
  statement.get = () => {
    if (mode === "get") throw new Error("owned provenance get fault")
    return { migration_id: "owned-wrong-identity", source_digests_json: "{}" }
  }
  return statement
}
try {
  initializeSessionBookkeeping(directory, {
    closeDatabase(db) {
      closes++
      if (mode === "close-failure") throw new Error("owned uncertain native close")
      db.close()
    },
  }).close()
} catch (error) {
  openError = error
} finally {
  Database.prototype.prepare = prepare
}

try {
  try {
    nativeUsable = Boolean(captured?.prepare("SELECT 1 AS n").get())
  } catch (error) {
    if (!(error instanceof Error)) throw error
    // A confirmed close must make the actual native handle unusable.
  }
  try {
    const exclusive = acquireMaintenanceGuard(directory)
    maintenanceAcquired = exclusive.mode === "exclusive"
    exclusive.close()
  } catch (error) {
    maintenanceError = error
  }
  try {
    initializeSessionBookkeeping(directory).close()
    reopened = true
  } catch (error) {
    reopenError = error
  }
} finally {
  // An uncertain-close case deliberately retains its ownership fence until
  // this original child exits. Close the captured native object for teardown.
  if (nativeUsable) captured?.close()
}

console.log(JSON.stringify({
  mode,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  openRejected: openError instanceof Error,
  openError: String(openError),
  closes,
  nativeUsable,
  maintenanceAcquired,
  maintenanceError: String(maintenanceError),
  reopened,
  reopenError: String(reopenError),
}))
