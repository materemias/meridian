import assert from "node:assert/strict"

/** Real-client extension for an E41 host. `history` uses the supported SDK
 * getSessionMessages API. The host owns authentication, request limits and
 * process custody; this gate never reads SDK transcript files. */
export async function verifySessionCacheClear({ clearSessionCache, storedSession,
  snapshot, history, createFreshTurn }) {
  const before = storedSession()
  assert(before?.claudeSessionId, "A real published session is required before clearing")
  const originalHistory = await history(before)
  assert(originalHistory.length > 0, "Missing supported SDK source history")
  const completion = clearSessionCache()
  assert(completion instanceof Promise, "Public cleanup must return its completion promise")
  await completion
  assert.equal(Object.keys(snapshot()).length, 0, "Awaited cleanup left durable session mappings")
  await createFreshTurn()
  const after = storedSession()
  assert(after?.claudeSessionId, "Fresh client turn did not publish a mapping")
  assert.notEqual(after.claudeSessionId, before.claudeSessionId, "Client resumed the cleared mapping")
  const freshHistory = await history(after)
  assert(freshHistory.length > 0, "Fresh session lacks supported SDK history")
  assert.deepEqual(await history(before), originalHistory, "Clearing changed the original SDK history")
  return { completionPromise: true, durableMappingsCleared: true, freshSession: true,
    originalHistoryUnchanged: true, originalSessionId: before.claudeSessionId,
    freshSessionId: after.claudeSessionId }
}
