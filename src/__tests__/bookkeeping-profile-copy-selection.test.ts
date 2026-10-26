import { expect, it } from "bun:test"
import { selectProfileCopies } from "../proxy/session/bookkeeping/profileCopies"

const options = { profileIds: ["work", "personal", "default"], graceMs: 100,
  maxUnpinnedTranscripts: 2, isConversationActive: (id: string) => id === "active" }

it("groups configured prefixes, retains active/authoritative copies and preserves tie order", () => {
  const entry = (key: string, lastUsedAt: number) => ({ key, lastUsedAt, pinnedTranscripts: 1 })
  expect(selectProfileCopies([
    entry("work:ordinary", 1), entry("personal:ordinary", 950),
    entry("work:active", 1), entry("personal:active", 950),
    entry("work:protected", 1), entry("personal:protected", 950),
    entry("unknown:ordinary", 1), entry("default:ordinary", 1),
    entry("work:tie", 1), entry("personal:tie", 1),
  ], new Set(["work:protected"]), options, 1000)).toEqual(["work:ordinary", "personal:tie"])
})

it("charges both retained transcript slots and continues past an unaffordable victim", () => {
  const entry = (key: string, lastUsedAt: number, pinnedTranscripts: number) => ({ key, lastUsedAt, pinnedTranscripts })
  const entries = [entry("work:two", 1, 2), entry("personal:two", 950, 1),
    entry("work:one", 2, 1), entry("personal:one", 950, 1),
    entry("work:zero", 3, 0), entry("personal:zero", 950, 1)]
  expect(selectProfileCopies(entries, new Set(), options, 1000)).toEqual(["work:two", "work:zero"])
  expect(selectProfileCopies(entries, new Set(), { ...options, maxUnpinnedTranscripts: 1 }, 1000))
    .toEqual(["work:one", "work:zero"])
})
