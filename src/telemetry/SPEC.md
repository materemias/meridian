---
id: telemetry-ui
type: module-design
status: active
title: Telemetry and web UI
parent: architecture
references: [design-language]
---

## Responsibility

Record what Meridian did and show it to the operator:

- request metrics (bounded in-memory ring; optional SQLite history via libsql
  with `MERIDIAN_TELEMETRY_PERSIST=1`) and the diagnostic log ring buffer;
- the telemetry JSON API, `/metrics` (Prometheus view of retained records) and
  API-equivalent cost estimates (static Claude rates, generated OpenAI rates,
  user overrides);
- the server-rendered HTML pages (except `/plugins`, owned by `plugins`) — landing, `/telemetry`, `/profiles`,
  `/providers`, `/settings`, login callback, the terminal landing — and the
  shared site header (`profileBar.ts`), which is the single home of the color
  tokens;
- pure presentation shared with the desktop app (`providerView.ts`,
  `providerSetup.ts`);
- the shared `settingRow` presentation (`settingRow.ts`) every `/settings`
  row renders through: label and control on one line, description, status and
  env-override lines below. The override line credits an env var only when the
  resolver used it (`telemetryEnvSources` applies the resolver's own parse); a
  set but unusable variable is named as such.

## Boundary

- **Leaf module:** its only in-repo imports are `src/settings`, `src/env` and
  `src/configDir` (externally: Hono for the route sub-app in `routes.ts` that
  `server.ts` mounts, and libsql for persistence). Never imports `server.ts`, `session/`, adapters or provider backends; callers
  push data in and register its routes.
- Pages are self-contained template strings with **no UI build step**; every
  page follows [`design-language`](../../DESIGN.md) (tokens only, shared header,
  no page-level body background).
- Shared presentation used by `desktop-app` stays **pure** (no I/O, no Electron);
  neither UI executes a generated setup command.
- Cost figures are **estimates**, never an invoice or remaining-budget claim;
  unpriced models are excluded and labeled, never shown as zero.

## Decisions

- **`/` and `/profiles` update in place.** Their polls patch `#content` from
  the fresh markup (`domPatch.ts`) instead of replacing it: nodes are matched
  by `data-key`/`id` (cards by profile id) or by position among unkeyed
  siblings of one tag, and only changed attributes, text and added, moved or
  removed nodes are touched, so find-in-page, a selection, focus and scroll
  survive a refresh. A node marked `data-patch-own` (an open sign-in panel)
  keeps its script-owned children.
- **Card status is shared between both pages** (`profileCardStatus.ts`): the
  informational duplicate badge and the post-sign-in *updating* / *failed*
  line. The page remembers a sign-in it finished, so an answer requested
  before it cannot clear the updating state; `/profiles` polls every 1.5s
  while a card updates, drops an answer older than one already drawn, and
  exempts an updating card from the search (not from the provider chips). An
  updating card dims only its figures; its name row and active border never
  dim.

User-facing behavior is documented in `MONITORING.md`.

## Known limitations

- **History is volatile by default**; without persistence, metrics and logs
  vanish on restart, and a failed SQLite initialization silently falls back to
  memory (announced only at startup).
- **`/metrics` is not monotonic**: values come from up to 10,000 retained
  records and can fall as records age out, so `rate()`-style alerting is
  unreliable.
- **Cost totals can be incomplete** (unpriced models) and OpenAI Fast-mode
  requests are underestimated.
- **The persistence banner cannot be silenced by the `silent` config option**,
  because the stores are created at module load before config exists; only
  `MERIDIAN_QUIET=1` suppresses it.
