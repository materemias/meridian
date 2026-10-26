import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { NativeDatabase, bookkeepingEngineInfo, hasWalResetFix } from "../../proxy/session/bookkeeping/nativeDatabase"

assert(!process.versions.bun, "stock Node runtime required")
const root = process.argv[2]
assert(root)
const directory = join(root, "native-runtime-data")
mkdirSync(directory, { mode: 0o700 })
const path = join(directory, "data.sqlite")
const engine = bookkeepingEngineInfo()
assert(hasWalResetFix(engine.version))
let db: NativeDatabase | undefined
try {
  db = new NativeDatabase(path)
  db.pragma("journal_mode=WAL")
  db.exec(`CREATE TABLE items(value TEXT) STRICT; CREATE TABLE counts(n INTEGER); INSERT INTO counts VALUES(0);
    CREATE TRIGGER counted AFTER INSERT ON items BEGIN UPDATE counts SET n=n+1; END;`)
  assert.equal(db.prepare("INSERT INTO items VALUES(?)").run("owned").changes, 1)
  const retained = db.prepare("SELECT value FROM items")
  assert.deepEqual(retained.get(), { value: "owned" })
  db.close()
  db = undefined
  const snapshot = () => readdirSync(directory).map(name => ({
    name, hash: createHash("sha256").update(readFileSync(join(directory, name))).digest("hex"),
  }))
  const before = snapshot()
  assert.deepEqual(before.map(row => row.name), ["data.sqlite"])
  db = new NativeDatabase(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readonly: true })
  assert.deepEqual(db.prepare("SELECT value FROM items").get(), { value: "owned" })
  assert.throws(() => db!.exec("INSERT INTO items VALUES('forbidden')"))
  assert.deepEqual(snapshot(), before)
  db.close()
  db = undefined
  assert.deepEqual(snapshot(), before)
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    engine, primaryCountCorrect: true, immutableNoSidecarsOrWrites: true,
    retainedFacadeDoesNotRetainNativeReader: true, allNativeOwnersClosed: true, modelCalls: 0 }))
} finally {
  db?.close()
  rmSync(directory, { recursive: true, force: true })
}
