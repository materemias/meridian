import { afterEach, describe, expect, test } from "bun:test"
import { clearOAuthUsageForProfile, fetchOAuthUsage, peekOAuthUsage, redeemOAuthQuotaReset, resetOAuthUsageCache } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const input = { profile: "work", grantId: "grant_1", requestId: "Request-1" }
const org = "11111111-1111-4111-8111-111111111111"
const store: CredentialStore = {
  async read() { return { claudeAiOauth: { accessToken: "fake-selected-token", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000 } } },
  async write() { throw new Error("Unexpected credential write") },
}
const options = { store, profileId: "work", refreshImpl: async () => { throw new Error("Unexpected refresh") } }
afterEach(resetOAuthUsageCache)

describe("explicit OAuth quota redemption", () => {
  test("normalizes a confirmed reset outcome", async () => {
    const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
      Response.json(init?.method !== "POST" ? { organization: { uuid: org } } : {
        result: "reset", reason: null, resets_left: 0, cleared: ["five_hour"], weekly_resets_at: "2026-11-01T00:00:00Z",
      }),
    })
    expect(result).toEqual({ ok: true, outcome: { result: "reset", reason: null, resetsLeft: 0, cleared: ["five_hour"], weeklyResetsAt: Date.parse("2026-11-01T00:00:00Z"), cooldownUntil: null } })
  })

  test("missing token prevents all network calls", async () => {
    let calls = 0
    const result = await redeemOAuthQuotaReset(input, { ...options, store: { async read() { return null }, async write() { return false } }, fetchImpl: async () => { calls++; return Response.json({}) } })
    expect(result).toMatchObject({ ok: false, code: "no_token" })
    expect(calls).toBe(0)
  })

  test("failed or malformed identity prevents every POST", async () => {
    for (const identity of [() => new Response(null, { status: 401 }), () => new Response(null, { status: 429 }), () => Response.json({ organization: {} }), () => Response.json(null), () => { throw new Error("fake network failure") }]) {
      let calls = 0
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => {
        calls++
        expect(init?.method).not.toBe("POST")
        return identity()
      } })
      expect(result.ok).toBe(false)
      expect(calls).toBe(1)
    }
  })

  test("mutation errors never retry or expose upstream bodies", async () => {
    for (const [status, code, indeterminate] of [[401, "upstream_auth", false], [429, "rate_limited", false], [500, "reset_indeterminate", true]] as const) {
      let posts = 0
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ organization: { uuid: org } })
        posts++
        return new Response("private upstream body", { status })
      } })
      expect(posts).toBe(1)
      expect(result).toMatchObject({ ok: false, code, indeterminate })
      expect(JSON.stringify(result)).not.toContain("private upstream body")
    }
    let posts = 0
    const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ organization: { uuid: org } })
      posts++
      throw new DOMException("fake timeout", "TimeoutError")
    } })
    expect(posts).toBe(1)
    expect(result).toMatchObject({ ok: false, code: "reset_indeterminate", indeterminate: true })
  })

  test("unknown results and malformed outcome fields are not successful", async () => {
    for (const body of [{ result: "future" }, { result: "reset", resets_left: -1 }, { result: "reset", weekly_resets_at: "not-a-date" }, { result: "cooldown", cooldown_until: "not-a-date" }, { result: "reset", cleared: [42] }]) {
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => Response.json(init?.method === "POST" ? body : { organization: { uuid: org } }) })
      expect(result).toMatchObject({ ok: false, code: "invalid_response", indeterminate: true })
    }
  })

  test("semantic nonreset outcomes do not clear cached usage", async () => {
    await fetchOAuthUsage({ ...options, fetchImpl: async () => Response.json({ five_hour: { utilization: 100 } }) })
    const cached = peekOAuthUsage("work")
    for (const outcome of ["already_used", "not_limited", "cooldown", "ineligible", "unavailable"]) {
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => Response.json(init?.method === "POST" ? { result: outcome } : { organization: { uuid: org } }) })
      expect(result).toMatchObject({ ok: true, outcome: { result: outcome } })
      expect(peekOAuthUsage("work")).toBe(cached)
    }
    const cooldown = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
      Response.json(init?.method === "POST" ? { result: "cooldown", cooldown_until: "2026-11-01T00:00:00Z" } : { organization: { uuid: org } }),
    })
    expect(cooldown).toMatchObject({ ok: true, outcome: { result: "cooldown", cooldownUntil: Date.parse("2026-11-01T00:00:00Z") } })
    expect(peekOAuthUsage("work")).toBe(cached)
  })

  test("confirmed and uncertain mutations invalidate only the selected account, including unscoped default", async () => {
    for (const profileId of ["work", undefined]) {
      await fetchOAuthUsage({ ...options, profileId, fetchImpl: async () => Response.json({}) })
      if (profileId === undefined) await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json({}) })
      await fetchOAuthUsage({ ...options, profileId: "other", fetchImpl: async () => Response.json({}) })
      const other = peekOAuthUsage("other")
      await redeemOAuthQuotaReset({ ...input, profile: profileId ?? "default" }, { ...options, profileId, fetchImpl: async (_url, init) => Response.json(init?.method === "POST" ? { result: "reset" } : { organization: { uuid: org } }) })
      expect(peekOAuthUsage(profileId)).toBeUndefined()
      if (profileId === undefined) expect(peekOAuthUsage("default")).toBeUndefined()
      expect(peekOAuthUsage("other")).toBe(other)
      await fetchOAuthUsage({ ...options, profileId, fetchImpl: async () => Response.json({}) })
      if (profileId === undefined) await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json({}) })
      const uncertain = await redeemOAuthQuotaReset({ ...input, profile: profileId ?? "default" }, {
        ...options, profileId, fetchImpl: async (_url, init) => {
          if (init?.method === "POST") throw new Error("Synthetic connection loss")
          return Response.json({ organization: { uuid: org } })
        },
      })
      expect(uncertain).toMatchObject({ ok: false, code: "reset_indeterminate", indeterminate: true })
      expect(peekOAuthUsage(profileId)).toBeUndefined()
      if (profileId === undefined) expect(peekOAuthUsage("default")).toBeUndefined()
      expect(peekOAuthUsage("other")).toBe(other)
    }
  })

  test("a configured profile named default does not invalidate unscoped account usage", async () => {
    await fetchOAuthUsage({ ...options, profileId: undefined, fetchImpl: async () => Response.json({}) })
    await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json({}) })
    const unscoped = peekOAuthUsage()
    await redeemOAuthQuotaReset({ ...input, profile: "default" }, {
      ...options, profileId: "default", fetchImpl: async (_url, init) =>
        Response.json(init?.method === "POST" ? { result: "reset" } : { organization: { uuid: org } }),
    })
    expect(peekOAuthUsage("default")).toBeUndefined()
    expect(peekOAuthUsage()).toBe(unscoped)
  })

  test("a late pre-invalidation GET cannot repopulate cache or remove a newer in-flight read", async () => {
    const oldResponse = Promise.withResolvers<Response>()
    const newResponse = Promise.withResolvers<Response>()
    const oldStarted = Promise.withResolvers<void>()
    const newStarted = Promise.withResolvers<void>()
    const old = fetchOAuthUsage({ ...options, fetchImpl: async () => {
      oldStarted.resolve()
      return oldResponse.promise
    } })
    await oldStarted.promise
    clearOAuthUsageForProfile("work")
    let newCalls = 0
    const fetchImpl = async () => {
      newCalls++
      newStarted.resolve()
      return newResponse.promise
    }
    const fresh = fetchOAuthUsage({ ...options, fetchImpl })
    await newStarted.promise
    oldResponse.resolve(Response.json({ five_hour: { utilization: 100 } }))
    await old
    expect(peekOAuthUsage("work")).toBeUndefined()
    const shared = fetchOAuthUsage({ ...options, fetchImpl })
    expect(newCalls).toBe(1)
    newResponse.resolve(Response.json({ five_hour: { utilization: 0 } }))
    await Promise.all([fresh, shared])
    expect(peekOAuthUsage("work")?.windows[0]?.utilization).toBe(0)
  })
})
