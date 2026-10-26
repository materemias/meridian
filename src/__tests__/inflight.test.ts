/**
 * GET /inflight: observed client HTTP requests, answered only to loopback peers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setSessionStoreDir } from "../proxy/sessionStore"
import { InflightRegistry, isLoopbackPeer, onResponseDone } from "../proxy/inflight"
import {
  assistantMessage,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
  resolveMockSdkSessionId,
  textBlockStart,
  textDelta,
} from "./helpers"

interface AttemptControl {
  release: () => void
  started: Promise<void>
}

let controls: AttemptControl[] = []
let queryCalls = 0

installSdkMock(() => ({
  query: (params: any) => {
    queryCalls++
    let release = () => {}
    let markStarted = () => {}
    const wait = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    controls.push({ release, started })
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-inflight-${queryCalls}`)
    const generator = (async function* () {
      markStarted()
      yield { ...messageStart(), session_id: sessionId }
      await wait
      yield { ...textBlockStart(0), session_id: sessionId }
      yield { ...textDelta(0, "ok"), session_id: sessionId }
      yield { ...blockStop(0), session_id: sessionId }
      yield { ...messageDelta("end_turn"), session_id: sessionId }
      yield { ...messageStop(), session_id: sessionId }
      yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
    })()
    return Object.assign(generator, { close: () => {} })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "inflight.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, startProxyServer, clearSessionCache } = await import("../proxy/server")

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } }

function messages(sessionId: string, stream: boolean): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages: [{ role: "user", content: "hi" }] }),
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(2)
  }
}

describe("InflightRegistry", () => {
  it("counts every entry exactly once: queued while waiting, else by stream", () => {
    const registry = new InflightRegistry()
    const stream = registry.begin("claude", 1_000)
    stream.setStream(true)
    registry.begin("claude", 2_000)
    const waiting = registry.begin("claude", 3_000)
    waiting.setStream(true)
    const leave = waiting.enterQueue()
    registry.begin("antigravity", 500).setStream(true)

    expect(registry.snapshot(["claude"], 10_000)).toEqual({
      scope: "client-http",
      at: new Date(10_000).toISOString(),
      total: 4,
      oldestStartedAt: new Date(500).toISOString(),
      upstreams: {
        claude: { streams: 1, requests: 1, queued: 1 },
        antigravity: { streams: 1, requests: 0, queued: 0 },
      },
    })

    leave()
    leave()
    expect(registry.snapshot(["claude"]).upstreams.claude).toEqual({ streams: 2, requests: 1, queued: 0 })
  })

  it("is empty, with every reported upstream at zero, once everything ends", () => {
    const registry = new InflightRegistry()
    const entry = registry.begin("claude")
    entry.end()
    entry.end()
    expect(registry.snapshot(["claude", "antigravity"], 0)).toEqual({
      scope: "client-http",
      at: new Date(0).toISOString(),
      total: 0,
      oldestStartedAt: null,
      upstreams: { claude: { streams: 0, requests: 0, queued: 0 }, antigravity: { streams: 0, requests: 0, queued: 0 } },
    })
  })
})

describe("isLoopbackPeer", () => {
  const none = new Headers()
  it("accepts IPv4 and IPv6 loopback, mapped or not", () => {
    for (const address of ["127.0.0.1", "127.12.0.9", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackPeer(address, none)).toBe(true)
  })
  it("refuses everything else, and anything that came through a proxy", () => {
    for (const address of [undefined, "", "10.0.0.1", "::ffff:192.168.1.2", "100.105.229.19", "fe80::1", "127.0.0.1.evil"]) {
      expect(isLoopbackPeer(address, none)).toBe(false)
    }
    for (const header of ["forwarded", "x-forwarded-for", "x-real-ip"]) {
      expect(isLoopbackPeer("127.0.0.1", new Headers({ [header]: "203.0.113.9" }))).toBe(false)
    }
  })
})

describe("onResponseDone", () => {
  it("fires once the body is read to the end, not before", async () => {
    let done = 0
    const response = onResponseDone(new Response("abc", { status: 201, headers: { "x-a": "1" } }), () => { done++ })
    expect(done).toBe(0)
    expect([response.status, response.headers.get("x-a")]).toEqual([201, "1"])
    expect(await response.text()).toBe("abc")
    expect(done).toBe(1)
  })
  it("fires when the client abandons the body, and at once when there is none", async () => {
    let cancelled = 0
    const response = onResponseDone(new Response(new ReadableStream({ pull() {} })), () => { cancelled++ })
    await response.body!.cancel()
    expect(cancelled).toBe(1)
    let empty = 0
    onResponseDone(new Response(null, { status: 204 }), () => { empty++ })
    expect(empty).toBe(1)
  })
})

describe("GET /inflight", () => {
  let sessionDir = ""

  beforeEach(async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-inflight-test-"))
    setSessionStoreDir(sessionDir)
    queryCalls = 0
    controls = []
    await clearSessionCache()
  })

  afterEach(async () => {
    for (const control of controls) control.release()
    await Bun.sleep(25)
    rmSync(sessionDir, { recursive: true, force: true })
  })

  it("answers only loopback peers, with no API key needed", async () => {
    process.env.MERIDIAN_API_KEY = "inflight-test-key"
    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
      const allowed = await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get("cache-control")).toBe("no-store")
      expect(await allowed.json()).toMatchObject({ scope: "client-http", total: 0, oldestStartedAt: null, upstreams: { claude: { streams: 0, requests: 0, queued: 0 } } })

      expect((await app.fetch(new Request("http://localhost/inflight"))).status).toBe(403)
      expect((await app.fetch(new Request("http://localhost/inflight"), { incoming: { socket: { remoteAddress: "192.168.1.20" } } })).status).toBe(403)
      const proxied = new Request("http://localhost/inflight", { headers: { "x-forwarded-for": "203.0.113.9" } })
      expect((await app.fetch(proxied, LOOPBACK)).status).toBe(403)
    } finally {
      delete process.env.MERIDIAN_API_KEY
    }
  })

  it("counts a live stream, a request waiting for its session's turn and one waiting for an SDK slot, then drains to zero", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, maxConcurrent: 1 })
    const snapshot = async () => (await (await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()) as {
      total: number
      oldestStartedAt: string | null
      upstreams: Record<string, { streams: number; requests: number; queued: number }>
    }

    const streamed = await app.fetch(messages("inflight-a", true))
    await waitFor(() => controls.length === 1, "the stream to reach the SDK")
    await controls[0]!.started
    // A queued duplicate of the initial user turn is stale once that turn
    // publishes. Declare the concurrent fork flow this queue-observation test
    // needs, rather than racing the intentional session-conflict refusal.
    const sameSessionRequest = messages("inflight-a", false)
    sameSessionRequest.headers.set("x-meridian-source", "fork-inflight-test")
    const sameSession = app.fetch(sameSessionRequest)
    const otherSession = app.fetch(messages("inflight-b", false))
    let seen = await snapshot()
    // Both are counted from arrival (as requests) and move to queued once waiting.
    for (let tries = 0; seen.upstreams.claude!.queued < 2 && tries < 1000; tries++) {
      await Bun.sleep(2)
      seen = await snapshot()
    }
    expect(seen.total).toBe(3)
    expect(seen.upstreams.claude).toEqual({ streams: 1, requests: 0, queued: 2 })
    expect(seen.oldestStartedAt).not.toBeNull()
    expect(JSON.stringify(seen)).not.toContain("inflight-a")

    controls[0]!.release()
    await streamed.text()
    await waitFor(() => controls.length === 2, "the next request to reach the SDK")
    await controls[1]!.started
    // Another request can briefly leave its turn queue before entering the SDK
    // queue. Reaching the SDK in one request does not synchronize that transition.
    await waitFor(async () => (await snapshot()).upstreams.claude!.queued === 1, "the remaining SDK waiter")
    seen = await snapshot()
    expect(seen.total).toBe(2)
    expect(seen.upstreams.claude).toEqual({ streams: 0, requests: 1, queued: 1 })

    let settled = false
    const both = Promise.all([sameSession, otherSession]).finally(() => { settled = true })
    while (!settled) {
      for (const control of controls) control.release()
      await Bun.sleep(5)
    }
    const buffered = await both
    expect(buffered.map(response => response.status)).toEqual([200, 200])
    expect((await snapshot()).total).toBe(2)
    await Promise.all(buffered.map(response => response.text()))
    seen = await snapshot()
    expect(seen.total).toBe(0)
    expect(seen.upstreams.claude).toEqual({ streams: 0, requests: 0, queued: 0 })
  }, 20_000)

  for (const stream of [false, true]) {
    it(`retains a ${stream ? "streamed" : "buffered"} HTTP response after SDK work settles until its body is consumed`, async () => {
      const backend = createProxyServer({ silent: true })
      const pending = backend.app.fetch(messages("retained-body", stream))
      await waitFor(() => controls.length === 1, "the SDK request")
      controls[0]!.release()
      const response = await pending
      await waitFor(() => backend.getInFlightCount?.() === 0, "SDK work settlement")
      const snapshot = async () => (await (await backend.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()) as { total: number }
      expect((await snapshot()).total).toBe(1)
      await response.text()
      expect((await snapshot()).total).toBe(0)
    })
  }

  it.skipIf(process.platform === "win32")("reports HTTP idle while an explicitly out-of-scope background response still runs", async () => {
    const backend = createProxyServer({ backend: "combined", silent: true,
      antigravity: { executable: fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url)), allowToolBridge: true } })
    const post = await backend.app.fetch(new Request("http://localhost/antigravity/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "fixture-model", input: "HANG", background: true }),
    }))
    try {
      expect(post.status).toBe(200)
      const job = await post.json() as { id: string; status: string }
      const work = await (await backend.app.fetch(new Request(`http://localhost/antigravity/v1/responses/${job.id}`))).json() as { status: string }
      expect(["queued", "in_progress"]).toContain(work.status)
      const observed = await (await backend.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()
      expect(observed).toMatchObject({ scope: "client-http", total: 0 })
      expect(JSON.stringify(observed)).not.toContain(job.id)
      const cancel = await backend.app.fetch(new Request(`http://localhost/antigravity/v1/responses/${job.id}/cancel`, { method: "POST" }))
      expect((await cancel.json() as {status:string}).status).toBe("cancelled")
    } finally { await backend.closeBackend?.() }
  }, 20_000)

  it("reads the real socket peer when served over HTTP", async () => {
    const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    try {
      const { port } = proxy.server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}/inflight`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as { total: number }).total).toBe(0)
      const proxied = await fetch(`http://127.0.0.1:${port}/inflight`, { headers: { "x-forwarded-for": "203.0.113.9" } })
      expect(proxied.status).toBe(403)
    } finally {
      await proxy.close()
    }
  }, 20_000)
})
