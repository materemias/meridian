import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { NativeDatabase, bookkeepingEngineInfo } from "../../proxy/session/bookkeeping/nativeDatabase"

const directory = process.argv[2]
if (!directory || !process.send) throw new Error("expected owned directory and IPC channel")
const db = new NativeDatabase(`${pathToFileURL(join(directory, "session-bookkeeping.sqlite")).href}?mode=ro`, {
  readonly: true,
})
db.exec("BEGIN")
db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()
db.exec("ROLLBACK")
if (db.inTransaction) throw new Error("idle reader retained a read transaction")
process.send({ ready: true, transaction: false, engine: bookkeepingEngineInfo() })
process.once("message", message => {
  if (message !== "close") throw new Error("unexpected idle reader command")
  db.close()
  process.disconnect?.()
})
process.once("disconnect", () => { db.close() })
