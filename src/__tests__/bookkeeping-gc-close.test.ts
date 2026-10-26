import { bookkeepingBunPreloadArgs } from "./fixtures/bookkeeping-support"
import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

for (const mode of ["custom", "native", "admission"]) {
  it(`retains the final SQLite owner until original timed-out GC cleanup joins: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-gc-close-")))
    try {
      const child = spawnSync(process.execPath, [...bookkeepingBunPreloadArgs(), resolve("src/__tests__/fixtures/bookkeeping-gc-close.mjs"), resolve("."), root, mode], {
        env: { BOOKKEEPING_TEST_SQLITE_LIBRARY: process.env.BOOKKEEPING_TEST_SQLITE_LIBRARY, PATH: process.env.PATH, HOME: root, USERPROFILE: root,
          SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        encoding: "utf8", timeout: process.platform === "win32" ? 65000 : 20000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stdout + child.stderr).toBe(0)
      const line = child.stdout.split("\n").find(line => line.startsWith("GC_CLOSE_REPORT "))
      expect(line).toBeDefined()
      const report = JSON.parse(line!.slice("GC_CLOSE_REPORT ".length))
      writeBenchArtifact(`gc-close-${mode}.json`, report)
      expect(report.closeOutcome).toBe("rejected")
      expect(report.closeError).toContain("did not join")
      expect(report.joinOutcome).toBe("fulfilled")
      expect(report.before.guardAvailable).toBe(false)
      expect(report.after.guardAvailable).toBe(true)
      expect(report.modelCalls).toBe(0)
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  }, process.platform === "win32" ? 70000 : 25000)
}
