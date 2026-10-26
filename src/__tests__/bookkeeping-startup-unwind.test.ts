import { unexpectedNodeSqliteStderr } from "./fixtures/bookkeeping-support"
import { afterAll, beforeAll, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

let root: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-startup-unwind-")))
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction")
  // Build outside bun:test's module registry, using the real Node entrypoint.
  const built = spawnSync(process.execPath, ["build", resolve("src/__tests__/fixtures/bookkeeping-startup-unwind.ts"),
    "--target=node", "--external", "libsql", `--outfile=${join(root, "probe.mjs")}`], {
    encoding: "utf8", timeout: 15_000,
  })
  expect(built.error).toBeUndefined()
  expect(built.status).toBe(0)
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function probe(mode: string) {
  const directory = join(root, mode)
  mkdirSync(directory, { mode: 0o700 })
  const result = spawnSync("node", [join(root, "probe.mjs"), mode, directory], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  expect(unexpectedNodeSqliteStderr(result.stderr)).toBe("")
  const report = JSON.parse(result.stdout)
  console.info(JSON.stringify(report))
  return report
}

it.each(["prepare", "get", "identity"])("closes native SQLite before releasing ownership after a provenance %s failure", (mode) => {
  const result = probe(mode)
  expect(result.openRejected).toBe(true)
  expect(result.closes).toBe(1)
  expect(result.nativeUsable).toBe(false)
  expect(result.maintenanceAcquired).toBe(true)
  expect(result.reopened).toBe(true)
})

it("retains the ownership fence and refuses reopen after an uncertain startup close", () => {
  const result = probe("close-failure")
  expect(result.openRejected).toBe(true)
  expect(result.openError).toContain("cleanup failed")
  expect(result.closes).toBe(1)
  expect(result.nativeUsable).toBe(true)
  expect(result.maintenanceAcquired).toBe(false)
  expect(result.reopened).toBe(false)
  expect(result.reopenError).toContain("native close failed")
})
