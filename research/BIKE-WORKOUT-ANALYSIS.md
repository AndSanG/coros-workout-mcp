# Bike workout — reverse-engineered payload

Captured 2026-09-09/10 from `t.coros.com` (US region, host `teamapi.coros.com`) via the
Chrome DevTools MCP, by creating default and edited Bike workouts in the "Create Workouts"
dialog and reading the `/training/program/estimate` (live preview), `/training/program/calculate`,
and `/training/schedule/update` request bodies. Endpoints are the same as run/strength:
`POST /training/program/calculate` then `POST /training/program/add` (the schedule-attached
save path uses `/training/schedule/update` instead of `/add`, wrapping the same `program` object).

## Workout-level differences vs run (sportType 1) / strength (sportType 4)

| Field | Strength | Run | Bike |
|---|---|---|---|
| `sportType` | `4` | `1` | `2` |
| `fastIntensityTypeName` | `"weight"` | `"custom"` | `"custom"` |
| `referExercise` | `{intensityType:1,hrType:0,valueType:1}` | `{intensityType:0,hrType:0,valueType:0}` | `{intensityType:0,hrType:0,valueType:0}` |
| `exercises[].sportType` | `4` | `1` | `2` |

`sourceUrl`/`sourceId` (cosmetic cover photo) varied between captures of the *same* workout
(e.g. `425868133463670784`/`...785` and others) and the API accepted all of them — these fields
appear to be decorative only, not validated server-side. `pbVersion` likewise varied between `2`
and `6` across captures with no effect on success; the bike implementation uses `2` for
consistency with the existing run/strength code.

## Step types (`exerciseType` + `name` code) — same numbering as run

| exerciseType | role | code name | overview (bike) | originId |
|---|---|---|---|---|
| 1 | Warm Up | T1120 | sid_bike_warm_up_dist | 425895398452936705 |
| 2 | Training (work) | **T4000** (not T3001 — bike-specific) | sid_bike_dist_speed | 426109589008859136 |
| 4 | Rest (inside a repeat group) | T1123 | sid_bike_cool_down_dist | 425895398452936705 |
| 3 | Cool Down (standalone) | T1122 | sid_bike_cool_down_dist | 425895456971866112 |

The `originId` values are identical to run's — they reference sport-agnostic template ids.
Only `name` (code), `overview` (i18n key), and `sportType` differ per sport.

## Intensity modes — all confirmed from UI requests

| Mode | intensityType | hrType | isIntensityPercent | intensityCustom | value fields |
|---|---|---|---|---|---|
| Heart Rate (direct bpm) | 2 | 2 | false | 0 | `intensityValue`/`...Extend` = bpm |
| % Max Heart Rate | 2 | 1 | true | 2 | `intensityPercent`/`...Extend` = %×1000; bpm in `intensityValue`/`...Extend` |
| % Heart Rate Reserve | 2 | 2 | true | 2 | same as above |
| % Lactate Threshold HR | 2 | 3 | true | 2 | same as above |
| **%FTP** (bike-only) | **9** | 0 | true | 2 | `intensityPercent`/`...Extend` = %×1000; **watts** in `intensityValue`/`...Extend` |
| Power (absolute watts) | 6 | 0 | false | 0 | `intensityValue`/`...Extend` = watts, no scaling |
| **Speed** (bike-only) | **4** | 0 | false | 0 | `intensityValue`/`...Extend` = km/h × **100** (15 km/h → 1500); `intensityDisplayUnit:"4"` (string, unlike the `"0"` used elsewhere) |
| Cadence | 7 | 0 | false | 0 | `intensityValue`/`...Extend` = rpm, no scaling |

Confirmed live via the UI's %FTP field: COROS computes the watt bounds shown in the UI from
the account's FTP setting (`account/query` → `zoneData.ftp`), but the `/estimate` and
`/calculate` payloads still carry **both** the percent and the absolute watts explicitly —
exactly like run's HR percent modes always carry both percent and bpm. The bike tool therefore
requires the caller to supply `intensityLow`/`intensityHigh` (watts) alongside
`percentLow`/`percentHigh` for `percent_ftp`, matching the existing run convention rather than
computing watts from the account's FTP.

## Target types — identical encoding to run

| UI label | targetType | targetValue unit |
|---|---|---|
| Time | 2 | seconds |
| Distance | 5 | centimetres (100000 = 1 km) |
| Training Load | 6 | TL points |
| Open | 1 | 0 |
| HR Recovery (Rest step only) | 7 | bpm threshold |

Confirmed available on both the Training step (Time/Distance/Training Load/Open) and the Rest
step (adds HR Recovery) — same set as run.

## Repeat block — identical to run

Synthetic `isGroup:true` step with `sets:N` (repeat count) and `restValue` (rest between reps);
child steps carry `groupId` = the group's `id`. Confirmed the live `/calculate` response expands
`exerciseBarChart` with the repeated children N times (verified against a live 3× repeat).

## Live validation

Called `calculateBikeWorkout` (no save) against the real API with a warmup (%FTP) → 3×[training
(distance + power) + rest (cadence)] → cooldown (speed) workout. Got a real non-NaN
`planDuration`/`planSets`/`planTrainingLoad`/`planDistance`, and `exerciseBarChart` correctly
showed the training/rest pair repeated 3 times — confirms the payload shape, the repeat-group
encoding, and all four bike-specific intensity modes (%FTP, power, speed, cadence) end to end.
No workout was saved (`/add` was not called).
