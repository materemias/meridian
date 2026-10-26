---
id: session
type: module-design
status: active
title: Sessions, lineage and bookkeeping
parent: architecture
depends-on: [telemetry-ui]
---

## Responsibility

Map each client conversation to a Claude SDK session and decide, per request,
whether the incoming history can **resume**, **fork** or must **replay**:

- lineage verification (continuation / compaction / undo / diverged) over
  structured v2 hashes;
- the in-memory session and fingerprint LRUs and the durable shared store that
  lets another proxy process resume the same conversation;
- turn serialization (in-process and cross-process), transcript publication
  leases and transcript garbage collection;
- the optional SQLite bookkeeping backend (`bookkeeping/`) and its offline
  `meridian-bookkeeping` maintenance CLI.

Code: `src/proxy/session/`, plus `sessionStore.ts`, `sessionLifecycle.ts` and
`executionHistory.ts` beside it.

## Boundary

- `lineage.ts` is **pure**: hashing and comparison only — no I/O, caches or
  server/cache imports; testable without mocks.
- `cache.ts` **owns all mutable session state**; no other module creates
  session LRUs.
- Never imports `server.ts`, adapters or provider backends. It may use the
  leaf `messages.ts`, `utils/lruMap.ts` and telemetry diagnostics.
- Lineage proof is the **original client history**; plugin-modified execution
  history may change what the SDK runs but never proves a resume.
- When it cannot prove the SDK session contains a section of client history,
  it starts fresh and replays — it never silently skips history.
- The Antigravity backend never uses this module; the ChatGPT backend reuses
  only its durability primitives (`durableFileSystem`, `processIncarnation`,
  `recoveryClaim`).
- JSON bookkeeping is the default; `MERIDIAN_BOOKKEEPING=sqlite` is explicit and
  a SQLite directory never falls back to JSON.

Detailed contracts live in [`architecture`](../../../ARCHITECTURE.md): *Session
Management*, *Lineage Verification*, *SQLite bookkeeping boundary*, *Transcript
publication lifetime*, *Session store write cost*, *Lineage hash encoding* and
*Appended content and transient hooks*.

## Known limitations

- **Container host identity.** Inside containers the derived `hostId` changes on
  restart, and containers built from one image share a baked `machine-id`, so
  stale or foreign store locks can wedge requests. Workaround:
  `MERIDIAN_HOST_ID` (see `docs/configuration.md` → *Known limitations*).
- **Boot identity is required.** Without a host boot identity Meridian refuses
  to start (escape hatch `MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY=1` still cannot
  serve).
- **Mixed proxy versions replay.** v1 lineage digests cannot prove a v2 prefix,
  so alternating old and new proxies repeats a full-history replay until every
  participating proxy is upgraded.
- **Editing a primary agent's instructions without switching agents** stays
  subject to the native resume limitation (the SDK restores its original system
  prompt).
- **A conversation returning to a pruned profile copy replays** instead of
  resuming (only with `MERIDIAN_SESSION_PROFILE_COPY_PRUNE=1`).
- **Windows writer-lease recovery** for a crashed proxy waits for a host reboot,
  because an executor's death does not prove its descendants gone.
