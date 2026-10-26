---
id: profiles-routing
type: module-design
status: active
title: Profiles, auth and account routing
parent: architecture
---

## Responsibility

Own the operator's **Claude accounts** and decide which one serves a request:

- profiles — resolve, list, add, rename, switch, browser/pasted-code OAuth
  login, token refresh/health, plan and usage facts, and the cross-process
  profile config store (`profile*.ts`, `auth*.ts`, `tokenHealth.ts`,
  `tokenRefresh.ts`, `oauth*.ts`,
  `planAllowance.ts`, `credentialsMode.ts`);
- routing modes (`routing.ts`): `active` (default), `sticky` (rendezvous
  hashing), `priority` (fail-over pool) and `active+priority`, plus
  follow-another-instance mode (`followActive.ts`);
- per-profile rate-limit and exhaustion tracking (`rateLimitStore.ts`,
  `limitDetection.ts`) and human-turn attestation verification for priority
  failback (`priorityAttestation.ts`).

## Boundary

- Does not import `server.ts`, `session/` or adapters. The core supplies the
  session/assignment key and performs dispatch and failover. One deliberate
  exception to the downward flow: `profileCli.ts` (the `meridian profile` CLI)
  calls `chatgpt/seatCli`, because one CLI covers Claude profiles and ChatGPT
  seats.
- Rate-limit facts are **keyed per profile**, and `profileId` is a required
  argument, so no call site can read one account's window for another. A
  profile switch clears nothing; `/auth/refresh` clears only its own profile.
- The `x-meridian-profile` pin always wins over any routing mode.
- Claude profiles never hold ChatGPT credentials (those live in
  [`chatgpt-backend`](chatgpt/SPEC.md)); routing never crosses providers.

User-facing behavior: `docs/profiles.md`. Throttling and `[1m]` bench scope:
[`architecture`](../../ARCHITECTURE.md) → *Throttling Contract*.

## Decisions

- **Automatic account switching is opt-in.** Several users explicitly do not
  want it, so the default stays `active`. `MERIDIAN_ROUTING` /
  `MERIDIAN_PROFILE_ORDER` fall back to settings; unknown ids are logged and
  unlisted profiles go last — a typo must never change routing.
- **Priority keeps cache affinity.** An existing session stays on a healthy
  account (prompt cache is per account); each profile is tried at most once per
  request; an exhausted pool surfaces the last-tried account's error; only new
  conversations drain back to a recovered preferred account
  (`priorityFailback: next-user-turn` additionally allows an attested human turn
  to fail back).
- **`active+priority`** puts the manually active profile first and the priority
  order behind it, and the active profile **outranks** an existing session
  assignment: here the head moves only because a human or supervisor moved it,
  and moving running conversations is what they moved it for. Affinity still
  applies below the active profile, so an outage costs one cold cache rather
  than one per turn.
- **Keyless affinity.** The priority assignment key is the root session id, else
  `fp:<fingerprint>`, else none. It is only an *account* key, never a session
  key, so a collision merely shares an account. Subagents use their root
  session and stay on the parent's account. Assignments are an LRU (cap 5000);
  keyed routes are additionally durable in SQLite bookkeeping.
- **Keyless forks share the parent's account on purpose.** This deliberately
  diverges from the session-resume guard, which forces keyless `fork-` /
  `subagent-` requests to replay fresh: a *session* collision would
  cross-contaminate history, while an *assignment* collision only pins two
  conversations to one account and keeps its prompt cache warm. Do not "fix"
  the two into consistency.
- **Cooldowns are layered:** Anthropic's named reset first, then the profile's
  own observed window (5-hour or 7-day, capped per window), then a 10-minute
  default. An OAuth-usage refinement may only *extend* a cooldown, runs only at
  full utilization, is not awaited, and is skipped for non-`claude-max` and
  billing refusals.
- **Sticky routing is stateless** (rendezvous hashing): stickiness survives
  restarts without a persisted map, and adding a profile moves only the
  sessions that hash to it.

## Known limitations

- Exhaustion and cooldown state is in memory; a restart forgets it.
- **No failover after content streams.** A rate limit arriving after the first
  real SSE frame is relayed to the client instead of failing over —
  deliberately, so a stream the client is consuming is never yanked.
- A followed instance behind `MERIDIAN_API_KEY` always fails the follow poll
  (no credentials are sent) and the follower falls back to its local profile.
- Clients with no session identity bench `[1m]` profile-wide on a rate limit,
  because there is nothing narrower to scope it to.
