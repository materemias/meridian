import { afterEach, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  NativeDatabase, bookkeepingEngineInfo, hasWalResetFix,
} from "../proxy/session/bookkeeping/nativeDatabase"
import { errorCode } from "../proxy/session/bookkeeping/storagePaths"
import { buildNodeFixture, unexpectedNodeSqliteStderr, writeBenchArtifact } from "./fixtures/bookkeeping-support"

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it("requires the upstream WAL-reset fix rather than accepting a major/minor approximation", () => {
  for (const version of ["3.44.6", "3.44.7", "3.50.7", "3.51.3", "3.53.4"]) {
    expect(hasWalResetFix(version)).toBe(true)
  }
  for (const version of ["3.44.5", "3.45.1", "3.50.6", "3.51.2", "3.51.3-unknown", "4.0.0", "unknown"]) {
    expect(hasWalResetFix(version)).toBe(false)
  }
  const info = bookkeepingEngineInfo()
  expect(hasWalResetFix(info.version)).toBe(true)
  expect(info.sourceId.length).toBeGreaterThan(64)
})

it("returns primary mutation counts for CAS despite triggers and reuses statement facades safely", () => {
  const db = new NativeDatabase(":memory:")
  try {
    db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, value INTEGER);
      CREATE TABLE counts(n INTEGER); INSERT INTO counts VALUES(0);
      CREATE TRIGGER inserted AFTER INSERT ON items BEGIN UPDATE counts SET n=n+1; END;`)
    const insert = db.prepare("INSERT INTO items VALUES(?,?)")
    expect(insert.run(1, 10).changes).toBe(1)
    expect(insert.run(2, 20).changes).toBe(1)
    expect(db.prepare("SELECT n FROM counts").get()).toEqual({ n: 2 })
    expect(db.prepare("UPDATE items SET value=30 WHERE id=?").run(9).changes).toBe(0)
    expect(db.prepare("DELETE FROM items WHERE id=?").run(1).changes).toBe(1)
    expect(db.prepare("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: 2 }])
  } finally { db.close() }
  db.close()
})

it("keeps immutable inspection read-only without creating WAL/SHM or waiting for statement GC", () => {
  const dir = mkdtempSync(join(tmpdir(), "bookkeeping-native-engine-"))
  directories.push(dir)
  const path = join(dir, "snapshot.sqlite")
  const writer = new NativeDatabase(path)
  writer.pragma("journal_mode=WAL")
  writer.exec("CREATE TABLE items(value TEXT) STRICT")
  writer.prepare("INSERT INTO items VALUES(?)").run("owned")
  // Retaining this facade must not retain a native prepared handle or reader.
  const retained = writer.prepare("SELECT value FROM items")
  expect(retained.get()).toEqual({ value: "owned" })
  writer.close()
  const snapshot = () => readdirSync(dir).map(name => ({
    name, hash: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex"),
  }))
  const before = snapshot()
  expect(before.map(row => row.name)).toEqual(["snapshot.sqlite"])
  const reader = new NativeDatabase(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readonly: true })
  try {
    expect(reader.prepare("SELECT value FROM items").get()).toEqual({ value: "owned" })
    expect(() => reader.exec("INSERT INTO items VALUES('forbidden')")).toThrow()
    expect(snapshot()).toEqual(before)
  } finally { reader.close() }
  expect(snapshot()).toEqual(before)
})

it("recognizes Node numeric busy/locked results without treating unrelated SQLite errors as contention", () => {
  const failure = (errcode: number) => Object.assign(new Error("native refusal"), {
    code: "ERR_SQLITE_ERROR", errcode,
  })
  expect(errorCode(failure(5))).toBe("SQLITE_BUSY")
  expect(errorCode(failure(517))).toBe("SQLITE_BUSY")
  expect(errorCode(failure(262))).toBe("SQLITE_LOCKED")
  expect(errorCode(failure(11))).toBe("ERR_SQLITE_ERROR")
  expect(errorCode(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("EACCES")
})

it("qualifies the stock Node engine and immutable/close behavior in an independent real process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bookkeeping-node-engine-"))
  directories.push(directory)
  const build = await buildNodeFixture("bookkeeping-native-runtime.ts", "native-runtime.mjs", directory)
  expect(build.success, String(build.logs)).toBe(true)
  const actor = spawnSync("node", [join(directory, "native-runtime.mjs"), directory], {
    encoding: "utf8", timeout: 10000,
  })
  expect(actor.error).toBeUndefined()
  expect(actor.signal).toBeNull()
  expect(actor.status, actor.stdout + actor.stderr).toBe(0)
  expect(unexpectedNodeSqliteStderr(actor.stderr)).toBe("")
  const report = JSON.parse(actor.stdout)
  expect(hasWalResetFix(report.engine.version)).toBe(true)
  expect(report.primaryCountCorrect).toBe(true)
  expect(report.immutableNoSidecarsOrWrites).toBe(true)
  expect(report.retainedFacadeDoesNotRetainNativeReader).toBe(true)
  expect(report.allNativeOwnersClosed).toBe(true)
  expect(report.modelCalls).toBe(0)
  writeBenchArtifact("native-runtime.json", report)
})

it("allows only the exact Node SQLite notice in otherwise-empty native stderr", () => {
  const notice = "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n"
    + "(Use `node --trace-warnings ...` to show where the warning was created)\n"
  expect(unexpectedNodeSqliteStderr(notice)).toBe("")
  expect(unexpectedNodeSqliteStderr(notice + "unexpected failure\n")).toBe("unexpected failure\n")
  expect(unexpectedNodeSqliteStderr(notice.replace("SQLite", "another API"))).toContain("ExperimentalWarning")
})
