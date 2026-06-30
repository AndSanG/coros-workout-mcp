# Research

Reverse-engineering artifacts for the undocumented COROS Training Hub API.
All captures were taken against the US region (`teamapi.coros.com`) in June 2026
using the Chrome DevTools MCP against `t.coros.com`.

---

## Files

### `RUN-WORKOUT-HR-ANALYSIS.md`
The main reference document. Contains the complete encoding tables for running workouts:
- Workout-level fields that differ from strength (`sportType:1`, `referExercise`, `fastIntensityTypeName`)
- Step types: exerciseType codes, internal code names (T1120/T3001/T1122/T1123), and `originId` values
- All HR intensity modes (`intensityType:2` + `hrType` + `isIntensityPercent`)
- All target types (`targetType` codes and their units)
- Non-HR intensity types from the minified source bundle (`intensityTypeName` map)
- Repeat group encoding (`isGroup:true` synthetic step + `groupId` on children)
- The delete endpoint

Start here when debugging API payloads or adding new features.

---

### `run-add-request.network-request`
Raw body of `POST /training/program/add` for a run workout with:
- **Time target** (5 min steps) and **% LTHR intensity** (91–95 % → 157–164 bpm)
- Structure: WarmUp → Group(×1)[Training + CoolDown] → Rest
- Captured when confirming `hrType:3` (% LTHR) encoding

### `run-add-dist-bpm.network-request`
Raw body of `POST /training/program/add` for a run workout with:
- **Distance target** (100 000 cm = 1 km) and **direct bpm** intensity (100–120 bpm)
- Structure: WarmUp → Group(×3)[Training + CoolDown] → Rest
- Also includes the `exerciseBarChart[]` array returned by the calculate step
- Captured when confirming `hrType:2 + isIntensityPercent:false` (direct bpm) and `targetType:5` (distance in cm)

### `run-calculate-request.network-request`
Raw body of `POST /training/program/calculate` for the same workout as `run-add-request`.
Shows the payload shape sent to `/calculate` (same structure as `/add` but without
`exerciseBarChart`, `distance`, `duration`, `sets`, `trainingLoad` applied).
The calculate response returns `planDuration`, `planSets`, `planTrainingLoad`, `planDistance`
(note the `plan*` prefix — different from the strength calculate response).

---

### `create-workout-request-all.txt`
A complete `curl` command (57 lines) for creating a **strength workout** via the EU region
(`teameuapi.coros.com`). Used as the original reference when building the strength
workout payload in `src/coros-api.ts`. Contains a multi-exercise payload with real
field values for `equipment`, `muscle`, `part`, `intensityType:1` (weight in grams), etc.

### `exercises-clean.json`
A cleaned snapshot of strength exercises fetched from the COROS API, used as input to
`extract-exercises.py` and as the initial seed for `data/exercises.json` (the bundled
exercise catalog shipped with the MCP server).

### `extract-exercises.py`
Python script that reads `exercises-clean.json` (or a raw API response) and outputs
cleaned JSON and CSV. Used once to bootstrap the exercise catalog. Not needed for
normal development — the `update_exercises` MCP tool replaces this workflow.

---

## Key findings summary

| Topic | Finding |
|---|---|
| Run sport type | `sportType: 1` |
| Endpoints | Same as strength: `/training/program/calculate` → `/training/program/add` |
| Step codes | WarmUp=T1120, Training=T3001, Rest=T1123, CoolDown=T1122 |
| Distance unit | Centimetres (`targetType:5`, e.g. 100 000 = 1 km) |
| HR intensity | `intensityType:2`; sub-mode via `hrType` + `isIntensityPercent` |
| % Max HR | `hrType:1`, `isIntensityPercent:true`, `intensityCustom:2` |
| % HRR | `hrType:2`, `isIntensityPercent:true`, `intensityCustom:2` |
| % LTHR | `hrType:3`, `isIntensityPercent:true`, `intensityCustom:2` |
| Direct bpm | `hrType:2`, `isIntensityPercent:false`, `intensityCustom:0` |
| Pace | `intensityType:3` |
| Power | `intensityType:6` |
| Cadence | `intensityType:7` |
| Repeat group | Synthetic step with `isGroup:true`, `sets:N`; children carry `groupId` |
| Delete | `POST /training/program/delete` with body `["<id>"]` |
