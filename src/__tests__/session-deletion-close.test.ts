import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

for (const mode of ["normal", "close", "stdout", "stderr"]) {
  it(`joins the original deletion child and both captured pipes: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-deletion-close-")))
    try {
      const child = spawnSync(process.execPath, [resolve("src/__tests__/fixtures/session-deletion-close.mjs"), resolve("."), root, mode], {
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root,
          SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        encoding: "utf8", timeout: process.platform === "win32" ? 65000 : 15000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stdout + child.stderr).toBe(0)
      const line = child.stdout.split("\n").find(line => line.startsWith("DELETION_CLOSE_REPORT "))
      expect(line).toBeDefined()
      const report = JSON.parse(line!.slice("DELETION_CLOSE_REPORT ".length))
      writeBenchArtifact(`deletion-close-${mode}.json`, report)
      expect(report.premature).toBe(false)
      expect(report.outcome).toBe("fulfilled")
      expect(report.modelCalls).toBe(0)
      expect(Object.values(report.witness).every(Boolean)).toBe(true)
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  }, process.platform === "win32" ? 70000 : 20000)
}
