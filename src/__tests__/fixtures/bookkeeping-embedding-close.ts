import assert from "node:assert/strict"
import { initializeSessionBookkeeping } from "../../proxy/session/bookkeeping/database"
import { initializeProxyBookkeeping } from "../../proxy/session/bookkeeping/embedding"
import { acquireMaintenanceGuard } from "../../proxy/session/bookkeeping/guard"
import { setSessionStoreDir } from "../../proxy/sessionStore"
import type { NativeDatabase as Database } from "../../proxy/session/bookkeeping/nativeDatabase"

assert(!process.versions.bun, "native Node actor required")
const directory = process.argv[2]
assert(directory)
process.env.MERIDIAN_BOOKKEEPING = "sqlite"
setSessionStoreDir(directory)
let native: Database | undefined
const reader = initializeSessionBookkeeping(directory, { closeDatabase(db) {
  native = db
  throw new Error("owned uncertain native close")
} })
const owner = await initializeProxyBookkeeping()
assert(owner)
reader.close()
const closing = owner.close()
assert.equal(owner.close(), closing)
let failure: unknown
try { await closing } catch (error) { failure = error }
assert(failure instanceof Error)
assert.match(failure.message, /native close failed/)
assert.equal(owner.close(), closing)
let maintenance = false, reopened = false
try { const guard = acquireMaintenanceGuard(directory); maintenance = true; guard.close() }
catch (error) { assert(error instanceof Error) }
try { initializeSessionBookkeeping(directory).close(); reopened = true }
catch (error) { assert(error instanceof Error) }
assert(!maintenance && !reopened)
assert(native)
const nativeUsable = Boolean(native.prepare("SELECT 1 AS n").get())
assert(nativeUsable)
native.close()
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  closeRejected: true, samePromise: true, nativeUsable, maintenanceAcquired: maintenance,
  reopened, scope: "original actor retains uncertain ownership until process exit" }))
