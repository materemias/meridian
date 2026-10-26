import { Database } from "bun:sqlite"
import { isAbsolute } from "node:path"

// Explicit selection for an owned test process only. Product code never
// overrides a host application's global Bun SQLite library.
const library = process.env.BOOKKEEPING_TEST_SQLITE_LIBRARY
  || process.env.MERIDIAN_TEST_SQLITE_LIBRARY
if (library) {
  if (!isAbsolute(library)) throw new Error("test SQLite library must be an absolute path")
  Database.setCustomSQLite(library)
  process.env.BOOKKEEPING_TEST_SQLITE_LIBRARY = library
}
