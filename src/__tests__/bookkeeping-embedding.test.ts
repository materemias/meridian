import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { initializeProxyBookkeeping } from "../proxy/server"
import { retainProxyBookkeeping, admitSessionStoreWrite } from "../proxy/session/bookkeeping/runtime"
import { connectionFor } from "../proxy/session/bookkeeping/connection"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { acquireMaintenanceGuard } from "../proxy/session/bookkeeping/guard"
import { activeStoreBackend } from "../proxy/session/bookkeeping/storeBackend"
import { lifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import { setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"

let directory: string, saved: string | undefined
let fixture: string
const owners: Array<{ close(): void | Promise<void> }> = []
beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "embedding-close-fixture-")))
  symlinkSync(resolve("node_modules"), join(fixture, "node_modules"), "junction")
  const built = spawnSync(process.execPath, ["build", resolve("src/__tests__/fixtures/bookkeeping-embedding-close.ts"),
    "--target=node", "--external", "libsql", `--outfile=${join(fixture, "close.mjs")}`], { encoding: "utf8", timeout: 30_000 })
  expect(built.status, built.stdout + built.stderr).toBe(0)
})
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }) })
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-embedding-")))
  saved = process.env.MERIDIAN_BOOKKEEPING
  process.env.MERIDIAN_BOOKKEEPING = "sqlite"
  setSessionStoreDir(directory)
})
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).reverse().map(async owner => owner.close()))
  expect(activeStoreBackend()).toBeUndefined()
  setSessionStoreDir(null)
  if (saved === undefined) delete process.env.MERIDIAN_BOOKKEEPING
  else process.env.MERIDIAN_BOOKKEEPING = saved
  rmSync(directory, { recursive: true, force: true })
})
async function open() {
  const handle = await initializeProxyBookkeeping()
  if (!handle) throw new Error("explicit SQL fixture must have an owner")
  owners.push(handle)
  return handle
}
function exclusiveAvailable(): boolean {
  const guard = acquireMaintenanceGuard(directory)
  guard.close()
  return true
}
function blockAdmission() {
  const gate = Promise.withResolvers<void>()
  const blocker = lifecycleLockQueue.run(connectionFor(directory).path, undefined, () => gate.promise)
  const admitted = admitSessionStoreWrite(() => storeSharedSession("owned-admission", "owned-sdk"))
  return { gate, blocker, admitted }
}

it("exports an opaque owner with one idempotent async close and no SQL capabilities", async () => {
  const handle = await open()
  expect(Object.keys(handle)).toEqual(["close"])
  const closing = handle.close()
  expect(closing).toBeInstanceOf(Promise)
  expect(handle.close()).toBe(closing)
  await closing
  expect(activeStoreBackend()).toBeUndefined()
  expect(exclusiveAvailable()).toBe(true)
})

it("joins admitted durable work before a successful final-owner close releases maintenance", async () => {
  const handle = await open()
  const { gate, blocker, admitted } = blockAdmission()
  try {
    const closing = handle.close()
    let settled = false
    void Promise.resolve(closing).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(connectionFor(directory).refs).toBe(1)
    expect(() => exclusiveAvailable()).toThrow("guard is held")
    gate.resolve()
    await blocker
    expect(await admitted).not.toBe(false)
    await closing
    expect(activeStoreBackend()).toBeUndefined()
    expect(exclusiveAvailable()).toBe(true)
  } finally {
    gate.resolve()
    await Promise.allSettled([blocker, admitted])
  }
})

it("releases a nonfinal owner while another owner continues its own admission", async () => {
  const handle = await open()
  const retained = retainProxyBookkeeping()
  if (!retained) throw new Error("second SQL owner missing")
  owners.push(retained)
  const { gate, blocker, admitted } = blockAdmission()
  try {
    await handle.close()
    expect(connectionFor(directory).refs).toBe(1)
    expect(activeStoreBackend()).toBeDefined()
    gate.resolve()
    await blocker
    expect(await admitted).not.toBe(false)
    retained.close()
    expect(activeStoreBackend()).toBeUndefined()
  } finally {
    gate.resolve()
    await Promise.allSettled([blocker, admitted])
  }
})

it("a private native reader does not let the final runtime owner abandon queued store work", async () => {
  const handle = await open()
  const reader = initializeSessionBookkeeping(directory)
  owners.push(reader)
  const { gate, blocker, admitted } = blockAdmission()
  try {
    const closing = handle.close()
    let settled = false
    void Promise.resolve(closing).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(activeStoreBackend()).toBeDefined()
    gate.resolve()
    await blocker
    expect(await admitted).not.toBe(false)
    await closing
    expect(activeStoreBackend()).toBeUndefined()
    expect(reader.reader.get("SELECT claude_session_id FROM mappings WHERE key='owned-admission'")?.claude_session_id)
      .toBe("owned-sdk")
    expect(() => exclusiveAvailable()).toThrow("guard is held")
    reader.close()
    expect(exclusiveAvailable()).toBe(true)
  } finally {
    gate.resolve()
    await Promise.allSettled([blocker, admitted])
  }
})

it("reports a bounded unjoined close while retaining ownership until the original work joins", async () => {
  const handle = await open()
  const { gate, blocker, admitted } = blockAdmission()
  try {
    const closing = handle.close()
    expect(closing).toBeInstanceOf(Promise)
    await expect(Promise.resolve(closing)).rejects.toThrow("close did not join")
    expect(handle.close()).toBe(closing)
    expect(connectionFor(directory).refs).toBe(1)
    expect(() => exclusiveAvailable()).toThrow("guard is held")
    gate.resolve()
    await blocker
    await admitted
    const deadline = Date.now() + 1000
    while (activeStoreBackend() && Date.now() < deadline) await Bun.sleep(5)
    expect(activeStoreBackend()).toBeUndefined()
    expect(exclusiveAvailable()).toBe(true)
  } finally {
    gate.resolve()
    await Promise.allSettled([blocker, admitted])
  }
}, 5000)

it("retains undefined initialization for the default JSON backend", async () => {
  process.env.MERIDIAN_BOOKKEEPING = "json"
  expect(await initializeProxyBookkeeping()).toBeUndefined()
})

it("keeps a failed native close and maintenance guard in its original Node actor", () => {
  const faultDirectory = join(directory, "uncertain-close")
  mkdirSync(faultDirectory, { mode: 0o700 })
  const child = spawnSync("node", [join(fixture, "close.mjs"), faultDirectory], {
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, encoding: "utf8", timeout: 15_000,
  })
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status, child.stderr).toBe(0)
  const report = JSON.parse(child.stdout)
  expect(report).toMatchObject({ closeRejected: true, samePromise: true, nativeUsable: true,
    maintenanceAcquired: false, reopened: false })
  // This is an exit witness for that original child and its pipes, not a later PID lookup.
  const guard = acquireMaintenanceGuard(faultDirectory)
  guard.close()
  console.info(JSON.stringify({ ...report, originalActorAndPipesJoined: true,
    maintenanceAvailableOnlyAfterOriginalExit: true }))
})
