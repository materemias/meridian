import { createRequire } from "node:module"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import type { Database as BunDatabase, Statement as BunStatement } from "bun:sqlite"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import type { SqlValue } from "./types"

const nativeRequire = createRequire(import.meta.url)
type EngineInfo = Readonly<{ version: string; sourceId: string }>
type Statement = StatementSync | BunStatement
type OpenOptions = { readonly?: boolean }
let qualifiedEngine: EngineInfo | undefined

/** Versions containing the upstream WAL-reset fix, including its two backports. */
export function hasWalResetFix(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3])
  return major === 3 && (minor > 51 || (minor === 51 && patch >= 3)
    || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6))
}

function openDriver(filename: string, options?: OpenOptions): DatabaseSync | BunDatabase {
  if (process.versions.bun) {
    const { Database, constants } = nativeRequire("bun:sqlite") as typeof import("bun:sqlite")
    const access = options?.readonly ? constants.SQLITE_OPEN_READONLY
      : constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE
    return new Database(filename, access | constants.SQLITE_OPEN_URI)
  }
  const { DatabaseSync } = nativeRequire("node:sqlite") as typeof import("node:sqlite")
  return new DatabaseSync(filename, { readOnly: options?.readonly })
}

function closeDriver(driver: DatabaseSync | BunDatabase): void {
  if ("isTransaction" in driver) driver.close()
  else driver.close(true)
}

/** Never open a persistent main/guard inode with an unqualified runtime engine. */
export function bookkeepingEngineInfo(): EngineInfo {
  if (qualifiedEngine) return qualifiedEngine
  let probe: DatabaseSync | BunDatabase
  try {
    probe = openDriver(":memory:")
  } catch (cause) {
    throw new BookkeepingMaintenanceRequiredError(
      "SQLite bookkeeping requires a runtime with builtin SQLite; use Node 22.22.3 or a qualified newer runtime",
      { cause },
    )
  }
  let qualified: EngineInfo
  try {
    const statement = probe.prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId")
    let row: unknown
    try { row = statement.get() } finally { if ("finalize" in statement) statement.finalize() }
    if (!row || typeof row !== "object" || !("version" in row) || typeof row.version !== "string"
      || !("sourceId" in row) || typeof row.sourceId !== "string") {
      throw new BookkeepingMaintenanceRequiredError("native SQLite provenance is unavailable")
    }
    if (!hasWalResetFix(row.version)) {
      throw new BookkeepingMaintenanceRequiredError(
        `SQLite ${row.version} lacks the qualified WAL-reset fix; use Node 22.22.3+ or configure a patched Bun SQLite library before initialization`,
      )
    }
    qualified = Object.freeze({ version: row.version, sourceId: row.sourceId })
  } finally {
    // This probe owns only memory. Cache qualification only after its original
    // handle closes, before any persistent database or guard can be opened.
    closeDriver(probe)
  }
  qualifiedEngine = qualified
  return qualified
}

function copyRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid native SQLite row")
  return { ...row }
}

class NativeStatement {
  constructor(private readonly driver: DatabaseSync | BunDatabase, private readonly sql: string) {}

  private use<T>(operation: (statement: Statement) => T): T {
    const statement = this.driver.prepare(this.sql)
    try { return operation(statement) } finally {
      // Bun's close(true) can only establish closure once every original
      // statement is finalized. Retaining prepared handles until GC would also
      // make a long-running proxy accumulate an unbounded statement registry.
      if ("finalize" in statement) statement.finalize()
    }
  }

  get(...parameters: SqlValue[]): Record<string, unknown> | undefined {
    const row = this.use(statement => statement.get(...parameters))
    return row === null || row === undefined ? undefined : copyRow(row)
  }

  all(...parameters: SqlValue[]): Array<Record<string, unknown>> {
    return this.use(statement => statement.all(...parameters)).map(copyRow)
  }

  run(...parameters: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.use(statement => statement.run(...parameters))
    // Runtime wrappers differ on whether `changes` includes trigger writes.
    // CAS requires SQLite's primary-statement count on this same connection.
    const row = new NativeStatement(this.driver, "SELECT changes() AS changes").get()
    if (!row || typeof row.changes !== "number" || !Number.isSafeInteger(row.changes)) {
      throw new Error("invalid native SQLite mutation count")
    }
    return { changes: row.changes, lastInsertRowid: result.lastInsertRowid }
  }
}

/** The existing private synchronous bookkeeping surface over the runtime's SQLite. */
export class NativeDatabase {
  private readonly driver: DatabaseSync | BunDatabase
  private closed = false

  constructor(filename: string, options?: OpenOptions) {
    bookkeepingEngineInfo()
    this.driver = openDriver(filename, options)
  }

  get inTransaction(): boolean {
    if (this.closed) return false
    return "isTransaction" in this.driver ? this.driver.isTransaction : this.driver.inTransaction
  }

  prepare(sql: string): NativeStatement {
    return new NativeStatement(this.driver, sql)
  }

  exec(sql: string): void {
    this.driver.exec(sql)
  }

  pragma(setting: string): Array<Record<string, unknown>> {
    return this.prepare(`PRAGMA ${setting}`).all()
  }

  close(): void {
    if (this.closed) return
    closeDriver(this.driver)
    this.closed = true
  }
}
