# Building running-workout support — summary

How `create_run_workout` was built, in order. For the API encoding itself, see
`RUN-WORKOUT-HR-ANALYSIS.md` — this is the build history, not the reference.

## 1. Reverse-engineering
Captured real COROS API traffic (via the Chrome DevTools MCP against `t.coros.com`) to decode
run workout encoding: HR zones (%MaxHR, %HRR, %LTHR, direct bpm), targets (time in seconds,
distance in centimetres, open, training load, HR recovery), intensity modes (pace, power,
cadence), and repeat groups (a synthetic `isGroup:true` step plus children referencing it via
`groupId`). Written up in `RUN-WORKOUT-HR-ANALYSIS.md`.

## 2. Implementation (commit `ef9c34b`)
Run workout payload construction logic — `resolveRunSteps`, `buildRunStepPayload`,
`calculateRunWorkout`, `addRunWorkout` in `src/coros-api.ts` — and the `create_run_workout` MCP
tool in `src/index.ts`. Covered warmup/training/rest/cooldown steps with HR/pace/power/cadence
intensity modes and repeat groups.

## 3. Remaining target types (commit `fcfeab6`)
Added the two target types not covered in the first pass:
- `trainingLoad` (`targetType:6`) — step ends at a TL-point threshold.
- `hrRecovery` (`targetType:7`, rest steps only) — step ends when HR drops below a bpm
  threshold.

## 4. Test coverage (commit `a408791`)
An 8-case test suite for `resolveRunSteps`: warmup/training/cooldown encoding, repeat-group
`groupId` wiring, km→cm distance conversion, %LTHR encoding, and the trainingLoad/hrRecovery
targets (custom + default values).

## 5. Live integration + a strength-side fix (commit `5383f1d`)
On-demand live integration tests (`coros-api.integration.ts`) that round-trip a real run
workout (warmup + repeat×3 HR-zone distance intervals + cooldown) against the actual COROS
API. Also fixed `calculateWorkout` reading the wrong response keys for the **strength** path
(discovered while working on run — the `/calculate` response uses `plan*`-prefixed keys for
both sport types, but strength was reading the un-prefixed names).

## End state
`create_run_workout` is fully working: sport type 1, all four target types, three intensity
families (HR/pace/power/cadence), and repeat groups — backed by offline unit tests and
on-demand live integration tests (real API round trip).
