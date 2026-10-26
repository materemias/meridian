import { bookkeepingBunPreloadArgs } from "./fixtures/bookkeeping-support"
import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

// Each child owns its environment, real listener/native database and original
// request finalizer. Only SDK/auth/executable boundaries are synthetic.
for (const mode of ["sqlite-slow", "json-slow", "embedded-slow", "embedded-idle", "sqlite-normal", "sqlite-chatgpt-slow"]) {
  it(`joins original request cleanup before releasing backend ownership: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-proxy-close-")))
    try {
      const child = spawnSync(process.execPath, [...bookkeepingBunPreloadArgs(), resolve("src/__tests__/fixtures/bookkeeping-proxy-close.mjs"),
        resolve("."), root, mode], {
        env: { BOOKKEEPING_TEST_SQLITE_LIBRARY: process.env.BOOKKEEPING_TEST_SQLITE_LIBRARY, PATH: process.env.PATH, HOME: root, USERPROFILE: root,
          SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          TMPDIR: root, TMP: root, TEMP: root },
        encoding: "utf8", timeout: process.platform === "win32" ? 65_000 : 15_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stdout + child.stderr).toBe(0)
      const line = child.stdout.split("\n").find(value => value.startsWith("SHUTDOWN_REPORT "))
      expect(line, child.stderr).toBeDefined()
      const report = JSON.parse(line!.slice("SHUTDOWN_REPORT ".length))
      writeBenchArtifact(`proxy-close-${mode}.json`, report)
      expect(report.identicalPromise).toBe(true)
      expect(report.listenerClosed).toBe(true)
      expect(report.counters).toMatchObject({ sdkQueries: report.idle ? 0 : 1, realCredentialReads: 0, spawnedSdkChildren: 0,
        outboundFetchRefusals: 0 })
      if (report.withChatGpt) {
        expect(report.beforeReleaseChatGptLeaseAvailable).toBe(false)
        expect(report.afterCloseChatGptLeaseAvailable).toBe(true)
      }
      if (report.delayed) {
        expect(report.outcomeBeforeRelease).toBe(report.embedded ? "pending" : "rejected")
        if (!report.embedded) expect(report.closeError).toContain("did not join")
        if (report.sql) {
          expect(report.beforeRelease.guardReleased).toBe(false)
          expect(report.beforeRelease.sqliteBackendInstalled).toBe(true)
          expect(report.beforeRelease.runtimeIdentityRetained).toBe(true)
        }
      } else {
        expect(report.outcome).toBe("fulfilled")
        if (!report.embedded) expect(report.counters.gcRuns).toBeGreaterThanOrEqual(1)
      }
      if (report.embedded) {
        // Joining an embedder's work must not start fresh transcript deletions.
        if (report.idle) expect(report.counters.gcRuns).toBe(0)
        expect(report.outcome).toBe("fulfilled")
        expect(report.afterBackend.connection.refs).toBe(1)
        expect(report.afterBackend.guardReleased).toBe(false)
      }
      // Observed BEFORE child exit: process termination cannot hide a leak.
      expect(report.afterOuterOwner.guardReleased).toBe(true)
      expect(report.afterOuterOwner.sqliteBackendInstalled).toBe(false)
      expect(report.afterOuterOwner.runtimeIdentityRetained).toBe(false)
      if (!report.idle) expect(report.events.some((event: { name: string }) => event.name === "actualSqlTranscriptLeaseReleased")).toBe(true)
    } finally {
      // spawnSync joins the original actor and both pipes before disposal.
      rmSync(root, { recursive: true, force: true })
    }
  }, process.platform === "win32" ? 70_000 : 20_000)
}
