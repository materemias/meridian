/**
 * Tests for extra-usage-required fallback.
 *
 * Verifies that when a "extra usage required for 1M context" error occurs:
 * 1. Models with [1m] context fall back to the base model (immediate retry, no backoff)
 * 2. The fallback only triggers when the model has extended context
 * 3. The error propagates normally when the model is already base
 */

import { installModelsMock } from "./modelsMock"
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getSessionStoreDir, readSessionStoreSnapshot } from "../proxy/sessionStore"
import { reconcile, type TranscriptLocator } from "../proxy/sessionLifecycle"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
  resolveMockSdkSessionId,
} from "./helpers"

// Track query calls to verify retry behavior
interface LifecycleResourceSnapshot {
  locator: TranscriptLocator
  generation: string
  state: string
  activeLeases?: Record<string, { purpose?: "publication"; owner: { pid: number } }>
}

let queryCalls: Array<{ model: string; callIndex: number; resume?: string; sessionId?: string }> = []
let queryCallCount = 0
/** Benches recorded when a [1m] model is stripped after a rate limit (#862),
 *  with the session scope they were recorded against (#901). */
let rateLimitBenches: Array<{ profileId: string | undefined; until: number; sessionKey?: string }> = []
let lifecycleAtQuery: Array<LifecycleResourceSnapshot | undefined> = []
let lifecycleBeforeSdkEvents: Array<LifecycleResourceSnapshot | undefined> = []
let reconcileBeforeSdkEvents = false
let resumeFallbackRefusal: "extra_usage" | "rate_limit" | undefined

function readLifecycleResource(sessionId: string): LifecycleResourceSnapshot | undefined {
  const sidecar = JSON.parse(readFileSync(join(getSessionStoreDir(), "session-gc.json"), "utf8")) as {
    resources: Record<string, LifecycleResourceSnapshot>
  }
  return Object.values(sidecar.resources).find((resource) => resource.locator.sessionId === sessionId)
}

/** Check ownership and publication, not a transient GC state label (#917/#933). */
function expectSafeFallbackTargets(reconciled: boolean) {
  expect(queryCalls.map((call) => call.model)).toEqual(["sonnet[1m]", "sonnet"])
  expect(lifecycleAtQuery).toHaveLength(2)
  expect(lifecycleBeforeSdkEvents).toHaveLength(2)
  const expectedIds = queryCalls.map((call) => call.sessionId)
  expect(expectedIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
  expect(new Set(expectedIds).size).toBe(2)
  for (const snapshots of [lifecycleAtQuery, lifecycleBeforeSdkEvents]) {
    expect(snapshots.map((resource) => resource?.locator.sessionId)).toEqual(expectedIds)
    for (const resource of snapshots) {
      expect(resource).toBeDefined()
      // The same proxy's sweep rescues pinned prepared targets to live before
      // SDK startup. Both states are safe only with their ownership still intact.
      expect(["prepared", "live"]).toContain(resource?.state ?? "missing")
      expect(resource?.generation).toMatch(/^r:[0-9a-f]{64}:[1-9][0-9]*$/)
      const leases = Object.values(resource?.activeLeases ?? {})
      expect(leases.some((lease) => lease.purpose === "publication" && lease.owner.pid === process.pid)).toBe(true)
      expect(leases.some((lease) => lease.purpose === undefined && lease.owner.pid === process.pid)).toBe(true)
    }
  }
  expect(lifecycleBeforeSdkEvents.map((resource) => resource?.generation))
    .toEqual(lifecycleAtQuery.map((resource) => resource?.generation))
  if (reconciled) {
    expect(lifecycleBeforeSdkEvents.map((resource) => resource?.state)).toEqual(["live", "live"])
  }
  const publishedIds = Object.values(readSessionStoreSnapshot()).map((entry) => entry.claudeSessionId)
  expect(publishedIds).toContain(expectedIds[1] ?? "missing")
  expect(publishedIds).not.toContain(expectedIds[0] ?? "missing")
}

// Control what the mock does
let unrelatedSdkDelayMs = 0
let mockBehavior: "extra_usage_then_succeed" | "always_extra_usage" | "out_of_extra_usage_then_succeed" | "resume_extra_usage_then_succeed" | "succeed" | "error_assistant_then_ratelimit" | "rate_limit_twice_then_succeed" = "succeed"

const EXTRA_USAGE_ERROR = "Claude Code returned an error result: API Error: Extra usage is required for 1M context · enable extra usage at claude.ai/settings/usage, or use --model to switch"
const OUT_OF_EXTRA_USAGE_ERROR = "Claude Code returned an error result: API Error: 400 You're out of extra usage."

// Unspecified model exports retain their real implementation.

// Force sonnet[1m] regardless of auth status so tests are self-contained.
installModelsMock(() => ({
  mapModelToClaudeModel: () => "sonnet[1m]",
  resolveClaudeExecutableAsync: async () => "claude",
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  hasExtendedContext: (model: string) => model.endsWith("[1m]"),
  stripExtendedContext: (model: string) => model.replace("[1m]", ""),
  isClosedControllerError: () => false,
  recordExtendedContextUnavailable: () => {},
  recordExtendedContextRateLimited: (profileId: string | undefined, until: number, sessionKey?: string) => {
    rateLimitBenches.push({ profileId, until, sessionKey })
  },
  isExtendedContextKnownUnavailable: () => false,
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
}))

installSdkMock(() => ({
  query: (opts: any) => {
    queryCallCount++
      const callIndex = queryCallCount
      const model = opts.options?.model || "sonnet"
      const sessionId = opts.options?.sessionId
      queryCalls.push({ model, callIndex, resume: opts.options?.resume, sessionId })
      const returnedSessionId = resolveMockSdkSessionId(opts.options, `sdk-session-${callIndex}`)
      if (sessionId) lifecycleAtQuery.push(readLifecycleResource(sessionId))
      const isStreaming = opts.options?.includePartialMessages === true

    return (async function* () {
      // SDK latency is unrelated to Meridian's rate-limit retry timer.
      if (unrelatedSdkDelayMs && callIndex === 1) {
        await new Promise(resolve => setTimeout(resolve, unrelatedSdkDelayMs))
      }
      if (mockBehavior === "rate_limit_twice_then_succeed" && callIndex <= 2) {
        // Stripping [1m] is free; the second refusal must back off on base.
        throw new Error("429 rate limit exceeded")
      }
      if (sessionId) {
        if (reconcileBeforeSdkEvents) {
          const resource = readLifecycleResource(sessionId)
          if (!resource) throw new Error(`SDK target ${sessionId} was not journaled`)
          // Force the same legal transition as the background sweep between
          // target preparation and the first SDK event, without relying on timing.
          await reconcile([{ ...resource.locator, lifecycleGeneration: resource.generation }], {
            maxPending: 1_000_000,
          })
        }
        const resource = readLifecycleResource(sessionId)
        lifecycleBeforeSdkEvents.push(resource)
      }
      if (mockBehavior === "always_extra_usage") {
        throw new Error(EXTRA_USAGE_ERROR)
      }

      // Model a resumed transcript that fits the extended window but not the
      // base window. Its history belongs to the SDK, not the submitted delta.
      if (resumeFallbackRefusal && opts.options?.resume) {
        if (model.endsWith("[1m]")) {
          throw new Error(resumeFallbackRefusal === "extra_usage"
            ? EXTRA_USAGE_ERROR
            : "429 rate limit exceeded for 1m context")
        }
        throw new Error('API Error: 400 {"type":"invalid_request_error","message":"prompt is too long: 435234 tokens > 200000 maximum"}')
      }

      if (mockBehavior === "extra_usage_then_succeed" && callIndex === 1) {
        throw new Error(EXTRA_USAGE_ERROR)
      }

      if (mockBehavior === "out_of_extra_usage_then_succeed" && callIndex === 1) {
        throw new Error(OUT_OF_EXTRA_USAGE_ERROR)
      }

      if (
        mockBehavior === "resume_extra_usage_then_succeed" &&
        opts.options?.resume === queryCalls[0]?.sessionId &&
        (model === "sonnet[1m]" || model === "sonnet")
      ) {
        throw new Error(OUT_OF_EXTRA_USAGE_ERROR)
      }

      // Simulates real SDK behaviour: emits an error assistant event first,
      // then throws a rate_limit error (which is what the SDK does when the
      // rate_limit_event with status:"rejected" is received).
      // The didYieldContent guard must NOT fire for error assistant events.
      if (mockBehavior === "error_assistant_then_ratelimit" && callIndex === 1) {
        yield {
          type: "assistant",
          error: "rate_limit",
          uuid: `uuid-${callIndex}-err`,
          message: {
            id: `msg-${callIndex}-err`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "API Error: Extra usage is required for 1M context" }],
            model: "<synthetic>",
            stop_reason: "stop_sequence",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          session_id: returnedSessionId,
        }
        throw new Error("429 rate limit exceeded for 1m context")
      }

      // Success path
      if (isStreaming) {
        yield { ...messageStart(`msg-${callIndex}`), session_id: returnedSessionId }
        yield { ...textBlockStart(0), session_id: returnedSessionId }
        yield { ...textDelta(0, `response-${callIndex}`), session_id: returnedSessionId }
        yield { ...blockStop(0), session_id: returnedSessionId }
        yield { ...messageDelta("end_turn"), session_id: returnedSessionId }
        yield { ...messageStop(), session_id: returnedSessionId }
      }
      yield {
        type: "assistant",
        uuid: `uuid-${callIndex}`,
        message: {
          id: `msg-${callIndex}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${callIndex}` }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: returnedSessionId,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-extra-usage-fallback.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { lookupSharedSession } = await import("../proxy/sessionStore")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

describe("Extra usage required fallback", () => {
  beforeEach(async () => {
    await clearSessionCache()
    queryCalls = []
    rateLimitBenches = []
    lifecycleAtQuery = []
    lifecycleBeforeSdkEvents = []
    reconcileBeforeSdkEvents = false
    resumeFallbackRefusal = undefined
    unrelatedSdkDelayMs = 0
    queryCallCount = 0
    mockBehavior = "succeed"
  })

  describe("Non-streaming", () => {
    it.each([false, true])("falls back from [1m] to base model on extra usage error (reconcile=%s)", async (reconcileFirst) => {
      reconcileBeforeSdkEvents = reconcileFirst
      mockBehavior = "extra_usage_then_succeed"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      // Should succeed after fallback (no backoff delay)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.content).toEqual([{ type: "text", text: "response-2" }])
      expectSafeFallbackTargets(reconcileFirst)
    })

    it("propagates error when model is already base (no [1m] to strip)", async () => {
      mockBehavior = "always_extra_usage"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      // After stripping [1m] (if applicable) and retrying, the error
      // should eventually propagate since the base model also fails
      expect(response.status).toBe(500)
    })

    it("falls back on the short 'out of extra usage' error", async () => {
      mockBehavior = "out_of_extra_usage_then_succeed"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      expect(queryCalls.length).toBe(2)
      expect(queryCalls[0]!.model).toBe("sonnet[1m]")
      expect(queryCalls[1]!.model).toBe("sonnet")
    })
  })

  describe("Streaming", () => {
    it.each([false, true])("falls back from [1m] to base model on extra usage error (reconcile=%s)", async (reconcileFirst) => {
      reconcileBeforeSdkEvents = reconcileFirst
      mockBehavior = "extra_usage_then_succeed"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      // Should contain successful stream content after fallback
      expect(text).toContain("event: message_start")
      expect(text).toContain("response-2")
      expect(text).toContain("event: message_stop")
      expect(parseSSE(text).some((event) => event.event === "error")).toBe(false)
      expectSafeFallbackTargets(reconcileFirst)
    })

    it("returns error event when model is already base", async () => {
      mockBehavior = "always_extra_usage"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200) // SSE always returns 200
      const text = await response.text()
      const events = parseSSE(text)
      const errorEvent = events.find((e) => e.event === "error")
      expect(errorEvent).toBeDefined()
    })

    it("retries resumed base model as a fresh session after extra usage", async () => {
      mockBehavior = "resume_extra_usage_then_succeed"
      const app = createTestApp()

      await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }, { "x-opencode-session": "sess-1" })

      const response = await post(app, {
        model: "sonnet",
        stream: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [
            { type: "text", text: "Running task." },
            { type: "tool_use", id: "toolu_1", name: "write", input: { path: "a.txt" } },
          ] },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
          ] },
        ],
      }, { "x-opencode-session": "sess-1" })

      expect(response.status).toBe(200)
      expect(response.headers.get("x-claude-session-id")).toBeNull()
      const text = await response.text()
      expect(text).toContain("event: message_start")
      const initialSessionId = queryCalls[0]?.sessionId
      const extendedForkSessionId = queryCalls[1]?.sessionId
      const baseForkSessionId = queryCalls[2]?.sessionId
      const freshFallbackSessionId = queryCalls[3]?.sessionId
      for (const sessionId of [initialSessionId, extendedForkSessionId, baseForkSessionId, freshFallbackSessionId]) {
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
      }
      expect(new Set([initialSessionId, extendedForkSessionId, baseForkSessionId, freshFallbackSessionId]).size).toBe(4)
      expect(lookupSharedSession("sess-1")?.claudeSessionId).toBe(freshFallbackSessionId)
      expect(queryCalls.slice(-3)).toEqual([
        { model: "sonnet[1m]", callIndex: 2, resume: initialSessionId, sessionId: extendedForkSessionId },
        { model: "sonnet", callIndex: 3, resume: initialSessionId, sessionId: baseForkSessionId },
        { model: "sonnet", callIndex: 4, resume: undefined, sessionId: freshFallbackSessionId },
      ])
    })
  })

  describe("Resumed context exceeds the fallback window", () => {
    for (const refusal of ["extra_usage", "rate_limit"] as const) {
      it.each([false, true])(`preserves the client compaction signal after ${refusal} (stream=%s)`, async (stream) => {
        const app = createTestApp()
        const headers = { "x-opencode-session": `overflow-${refusal}-${stream}` }
        // Large client history is accepted on the initial extended request;
        // the next request resumes that SDK transcript with a short delta.
        const history = { role: "user", content: "history ".repeat(110_000) }
        const initial = await post(app, {
          model: "sonnet", stream: false, messages: [history],
        }, headers)
        expect(initial.status).toBe(200)
        const initialBody = await initial.json()
        const sourceSessionId = queryCalls[0]!.sessionId
        resumeFallbackRefusal = refusal

        const response = await post(app, {
          model: "sonnet", stream,
          messages: [history, { role: "assistant", content: initialBody.content }, { role: "user", content: "continue" }],
        }, headers)
        const error = stream
          ? parseSSE(await response.text()).find((event) => event.event === "error")?.data.error
          : (await response.json()).error

        expect(response.status).toBe(stream ? 200 : 400)
        expect(queryCalls.map((call) => call.model)).toEqual(["sonnet[1m]", "sonnet[1m]", "sonnet"])
        expect(queryCalls.slice(1).every((call) => call.resume === sourceSessionId)).toBe(true)
        expect(error?.type).toBe("invalid_request_error")
        expect(error?.message).toMatch(/prompt is too long/i)
        // Failed forks must not replace the last successful source transcript.
        expect(lookupSharedSession(headers["x-opencode-session"])?.claudeSessionId).toBe(sourceSessionId)
      })
    }
  })

  describe("backoff timers, independent of request duration", () => {
    for (const stream of [false, true]) {
      for (const scenario of ["extra-usage", "unrelated-delay", "rate-limit-control"] as const) {
        it(`${scenario}: observes the actual backoff timer (stream=${stream})`, async () => {
          const baseDelayMs = 317
          const previousDelay = process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS
          process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS = String(baseDelayMs)
          mockBehavior = scenario === "rate-limit-control" ? "rate_limit_twice_then_succeed" : "extra_usage_then_succeed"
          unrelatedSdkDelayMs = scenario === "unrelated-delay" ? 701 : 0
          // Let real timers run. The positive control proves this observer sees
          // the configured backoff; the SDK-latency fixture has a different delay.
          const timerObserver = spyOn(globalThis, "setTimeout")
          try {
            const app = createTestApp()
            const started = Date.now()
            const response = await post(app, {
              model: "sonnet",
              stream,
              messages: [{ role: "user", content: "hello" }],
            })
            expect(response.status).toBe(200)
            if (stream) {
              const events = parseSSE(await response.text())
              expect(events.some(event => event.event === "error")).toBe(false)
              expect(events.filter(event => event.event === "message_stop")).toHaveLength(1)
            } else {
              expect((await response.json()).stop_reason).toBe("end_turn")
            }
            const elapsed = Date.now() - started
            const backoffTimers = timerObserver.mock.calls.filter(([, delay]) => delay === baseDelayMs)
            expect(backoffTimers).toHaveLength(scenario === "rate-limit-control" ? 1 : 0)
            expect(queryCalls.map(call => call.model)).toEqual(scenario === "rate-limit-control"
              ? ["sonnet[1m]", "sonnet", "sonnet"] : ["sonnet[1m]", "sonnet"])
            console.log(JSON.stringify({ scenario, stream, elapsedMs: elapsed,
              backoffTimers: backoffTimers.length, models: queryCalls.map(call => call.model) }))
          } finally {
            timerObserver.mockRestore()
            if (previousDelay === undefined) delete process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS
            else process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS = previousDelay
          }
        })
      }
    }
  })

  describe("Real SDK behaviour: error assistant emitted before throw", () => {
    it("retries after error assistant event + rate limit throw (non-streaming)", async () => {
      // Simulates the real SDK sequence when extra usage is disabled:
      // 1. SDK yields type:"assistant" with error:"rate_limit" field
      // 2. SDK throws a rate limit error
      // Previously, step 1 set didYieldContent=true which blocked the retry.
      mockBehavior = "error_assistant_then_ratelimit"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      // Should succeed after stripping [1m] and retrying with sonnet
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.content).toBeDefined()
      // Two query calls: first (sonnet[1m]) failed, second (sonnet) succeeded
      expect(queryCalls.length).toBe(2)
      expect(queryCalls[0]!.model).toBe("sonnet[1m]")
      expect(queryCalls[1]!.model).toBe("sonnet")
    })

    it("benches [1m] after a rate-limit strip so the next request does not flap back (#862)", async () => {
      // Stripping [1m] without recording anything means the NEXT request maps
      // straight back to [1m] — two model switches, and a cold prompt cache in
      // both directions, for one rate-limit event.
      mockBehavior = "error_assistant_then_ratelimit"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(response.status).toBe(200)

      expect(rateLimitBenches.length).toBe(1)
      expect(rateLimitBenches[0]!.until).toBeGreaterThan(Date.now())
    })

    it("scopes the rate-limit bench to the requesting session (#901)", async () => {
      // A profile-wide bench downgrades every concurrent sibling of an RLM
      // harness the instant one child is limited, and the model switch cold-
      // caches all of them. The bench has to name the session that earned it.
      mockBehavior = "error_assistant_then_ratelimit"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }, { "x-opencode-session": "rlm-child-7" })
      expect(response.status).toBe(200)

      expect(rateLimitBenches.length).toBe(1)
      expect(rateLimitBenches[0]!.sessionKey).toBe("rlm-child-7")
    })

    it("falls back to a profile-wide bench when the client has no session id (#901)", async () => {
      mockBehavior = "error_assistant_then_ratelimit"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(response.status).toBe(200)

      expect(rateLimitBenches.length).toBe(1)
      expect(rateLimitBenches[0]!.sessionKey).toBeUndefined()
    })
  })
})
