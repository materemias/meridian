import { expect, it } from "bun:test"
import { assertAdmissionHeartbeat, type AdmissionHeartbeat } from "./fixtures/bookkeeping-heartbeat"

const responsive: AdmissionHeartbeat = {
  budgetMs: 80,
  elapsedMs: 82,
  ticks: [8, 16, 24, 32, 40, 48, 56, 64, 72, 80],
  maxGapMs: 8,
}

it("accepts a responsive timer whose cadence differs from its requested interval", () => {
  expect(() => assertAdmissionHeartbeat(responsive)).not.toThrow()
})

it("accepts the recorded eleven-tick schedule with an eleven-millisecond maximum gap", () => {
  expect(() => assertAdmissionHeartbeat({ ...responsive,
    ticks: [11, 19, 27, 35, 41, 47, 53, 61, 65, 72, 78], maxGapMs: 11 })).not.toThrow()
})

it("retains the existing 25 ms gap boundary", () => {
  expect(() => assertAdmissionHeartbeat({ ...responsive,
    ticks: [25, 50, 75], maxGapMs: 25 })).not.toThrow()
  expect(() => assertAdmissionHeartbeat({ ...responsive,
    ticks: [25.01, 50.01, 75.01], maxGapMs: 25.01 })).toThrow("timer gap")
})

it("rejects a silent timer even when a short observation fits the gap boundary", () => {
  expect(() => assertAdmissionHeartbeat({ budgetMs: 20, elapsedMs: 20, ticks: [], maxGapMs: 20 }))
    .toThrow("timer starved")
})

it("rejects a fully blocked observation", () => {
  expect(() => assertAdmissionHeartbeat({ ...responsive, ticks: [], maxGapMs: 82 }))
    .toThrow("timer starved")
})

it("rejects a long pause even when its total callback count is high", () => {
  const ticks = [...Array.from({ length: 20 }, (_, index) => index + 1),
    ...Array.from({ length: 20 }, (_, index) => index + 60)]
  expect(() => assertAdmissionHeartbeat({ ...responsive, ticks, maxGapMs: 40 })).toThrow("timer gap")
})

it("retains the early-expiry rejection", () => {
  expect(() => assertAdmissionHeartbeat({ ...responsive, elapsedMs: 79.999,
    ticks: [8, 16, 24, 32, 40, 48, 56, 64, 72] })).toThrow("early expiry")
})

it("retains the strict 50 ms expiry allowance", () => {
  const ticks = Array.from({ length: 16 }, (_, index) => (index + 1) * 8)
  expect(() => assertAdmissionHeartbeat({ ...responsive, ticks, elapsedMs: 129.999 })).not.toThrow()
  expect(() => assertAdmissionHeartbeat({ ...responsive, ticks, elapsedMs: 130 })).toThrow("late expiry")
})
