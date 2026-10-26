import { expect, test } from "bun:test"
import { createBuildObserver, observeInWorker, type BuildObservation } from "../proxy/buildObserver"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

test("cached requests stay responsive and share one pending observation", async () => {
  let calls = 0
  let finish: (value: BuildObservation) => void = () => { throw new Error("scan not started") }
  const observer = createBuildObserver(() => {
    calls++
    return new Promise(resolve => { finish = resolve })
  })
  try {
    expect(calls).toBe(0)
    const start = performance.now()
    for (let i = 0; i < 10000; i++) expect(observer.read().state).toBe("unknown")
    expect(performance.now() - start).toBeLessThan(200)
    await Promise.resolve()
    expect(calls).toBe(1)
    finish({ state: "missing" })
    await Promise.resolve()
    expect(observer.read().state).toBe("missing")
  } finally { observer.close() }
})

test("demand refresh respects minimum start cadence without idle scans", async () => {
  let now = 0
  let calls = 0
  const observer = createBuildObserver(async () => {
    calls++
    return { state: "missing" }
  }, 10_000, () => now)
  try {
    expect(calls).toBe(0)
    expect(observer.read().state).toBe("unknown")
    await Promise.resolve()
    now = 9999
    for (let i = 0; i < 100; i++) expect(observer.read().state).toBe("missing")
    expect(calls).toBe(1)
    now = 10000
    await Promise.resolve()
    expect(calls).toBe(1)
    observer.read()
    expect(calls).toBe(2)
  } finally { observer.close() }
})

test("Bun source worker reports failure without blocking timers", async () => {
  let timerRan = false
  const timer = setTimeout(() => { timerRan = true }, 0)
  const result = await observeInWorker("/nonexistent-meridian-build-observer", "artifact")
  clearTimeout(timer)
  expect(timerRan).toBe(true)
  expect(result.state).toBe("invalid")
})

test("Node bundled worker resolves alongside the bundled observer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meridian-worker-bundle-"))
  try {
    // Match the production build's clean CLI process. In-process Bun.build
    // shares bun:test's resolver state with unrelated imported test modules.
    const bundled = spawnSync(process.execPath, ["build", resolve(import.meta.dir, "../proxy/buildObserver.ts"),
      resolve(import.meta.dir, "../proxy/buildObservationWorker.ts"), `--outdir=${directory}`, "--target=node"], {
      encoding: "utf8", timeout: 30000,
    })
    expect(bundled.error).toBeUndefined()
    expect(bundled.status, bundled.stderr).toBe(0)
    writeFileSync(join(directory, "package.json"), '{"type":"module"}')
    writeFileSync(join(directory, "driver.mjs"), 'import {observeInWorker} from "./buildObserver.js"; const keepAlive=setInterval(()=>{},1000); try { const result=await observeInWorker("/missing-provenance-test","artifact"); if(result.state!=="invalid") process.exitCode=1; } finally { clearInterval(keepAlive) }')
    const result = spawnSync("node", [join(directory, "driver.mjs")], { encoding: "utf8", timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    // A missing worker must fail this check, rather than looking like the
    // expected invalid-artifact response from the actual running worker.
    rmSync(join(directory, "buildObservationWorker.js"))
    const missingWorker = spawnSync("node", [join(directory, "driver.mjs")], { encoding: "utf8", timeout: 10000 })
    expect(missingWorker.error).toBeUndefined()
    expect(missingWorker.status).not.toBe(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
