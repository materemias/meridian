# OpenCode one-shot prompt acceptance harness

The two manual Node harnesses preserve the exact scripts used for PR #1428's actual title/summary baseline and candidate comparisons. They drive a pinned real OpenCode client through its setup-installed matching Meridian plugin, active server scrub, public SDK and native executable. They never read or modify private SDK transcripts. All subprocess and pipe witnesses join.

Run with Node22+ and pinned SDK0.2.141/native2.1.302 on macOS arm64, or native2.1.301/Node24.20.0 on Debian Linux arm64. Use OpenCode2.0.31 for the stable harness; the beta harness accepts only0.0.0-beta-18314/18866/19271. Set absolute paths in `E2E_MERIDIAN_ROOT` (reviewed built source or independently installed package), `E2E_HARNESS_ROOT` (this repository), `E2E_OPENCODE_BIN`, `E2E_NATIVE_BIN`, `E2E_PLUGIN_PATH` (scrub0.2.3), `E2E_SCRUB_VERSION=0.2.3`, `E2E_OPENCODE_VERSION`, and a new `E2E_EVIDENCE_DIR`.

Default mode uses an owned scripted upstream and spends no inference. For baseline instructions set `E2E_TITLE_MODE=baseline`; candidate uses `E2E_TITLE_MODE=candidate`. Keep `E2E_EXPECT=candidate`: the stable harness also checks the already-landed primary-agent switch behavior on both current baselines.

```sh
node scripts/e2e-opencode-one-shot-stable.mjs
node scripts/e2e-opencode-one-shot-beta.mjs
```

Actual mode adds `--live`, `E2E_ALLOW_LIVE_MODEL=1`, a private0600 access-only single-profile JSON array at `E2E_LIVE_PROFILE_FILE`, and `E2E_USAGE_GUARD_FILE`. Do not commit a grant. Admission uses the shared tested `scripts/lib/profileHistoryAdmission.mjs`: fresh official active-profile observation, paid ExtraUsage disabled, no credential refresh/write, and known included windows or explicitly bounded permission with current capacity labelled unknown. Maximum12 generations per one-shot case. Any provider refusal, unexpected model identity, overage or failed assertion stops dependent verification; no automatic rerun, account/model fallback or OAuth refresh occurs. Primary and one-shot requests here use exact Haiku5.5.

The stable case drives four primary turns plus the actual detached title hook. The beta case drives an initial primary turn and a fork to the client's real summary agent, observing both title and summary hooks. Native SDK initialization must retain the coding preset for primary requests; baseline one-shots append their instruction, while candidate one-shots replace it. Provider, native stream and public SDK message IDs/models must correlate. Captured response text comes only from these owned synthetic fixture prompts.

The beta harness starts a real server and waits for its own `/api/model` to expose the exact requested model before submitting the first CLI command. HTTP readiness precedes asynchronous catalog adoption in pinned clients. `E2E_CATALOG_DELAY_MS=1000` is a scripted-only schedule control that delays the initial genuine catalog response. The retained cold fixture fails before any SDK/model request; this warm readiness check passes the same delayed catalog. Actual verification leaves the delay unset. This does not claim a fix to client cold-start behavior.

The earlier personal-account quota-rejected #1428 run remains unqualified. A new controlled baseline/candidate comparison on a single healthy owned Team account establishes this account-agnostic adapter behavior; it does not claim the earlier account recovered. The complete original failures, causal catalog controls, exact task controllers and final metadata are escrowed in the PR's linked proof archive. This maintainer PR changes only manual harnesses and instructions, separate from the contributor's application code and Author credit.
