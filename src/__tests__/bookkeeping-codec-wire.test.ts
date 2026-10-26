import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"
import { getStoredSessionGeneration, parseStoreDocument, serializeLegacyStore, STORE_META_KEY } from "../proxy/session/bookkeeping/legacyCodec"

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-codec-wire-"))
  setSessionStoreDir(directory)
})
afterEach(() => {
  setSessionStoreDir(null)
  rmSync(directory, { recursive: true, force: true })
})

it.each([1, 3])("matches the actual JSON writer for integer and escaped mapping keys, metadata v%s", async (version) => {
  const meta = version === 1 ? { version, slots: {} } : {
    version, slots: {}, priorityAssignments: {}, priorityAttempts: {}, priorityRollbackMappings: {},
  }
  const path = join(directory, "sessions.json")
  writeFileSync(path, JSON.stringify({ [STORE_META_KEY]: meta }), { mode: 0o600 })
  for (const key of ["named", "7", "0", "4294967294", "4294967295", "01", 'quoted"\\key']) {
    expect(await storeSharedSession(key, `owned-${key}`, 1, "lineage", ["owned-history"])).not.toBe(false)
  }
  // The oracle is the production JSON writer, not an object literal whose
  // integer-property enumeration would repeat the serializer's defect.
  const actualWriterBytes = readFileSync(path, "utf8")
  expect(actualWriterBytes.startsWith(`{${JSON.stringify(STORE_META_KEY)}:`)).toBe(true)
  const document = parseStoreDocument(actualWriterBytes)
  const serialized = serializeLegacyStore(document)
  expect(serialized).toBe(actualWriterBytes)
  expect(serialized.endsWith("\n")).toBe(false)
  const restored = parseStoreDocument(serialized)
  for (const [key, entry] of Object.entries(document.sessions)) {
    expect(JSON.stringify(restored.sessions[key])).toBe(JSON.stringify(entry))
    expect(getStoredSessionGeneration(restored.sessions[key]!, key)).toBe(getStoredSessionGeneration(entry, key))
  }
})
