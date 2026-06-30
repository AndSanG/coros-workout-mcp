# Run workout with HR targets — reverse-engineered payload

Captured 2026-06-30 from `t.coros.com` (US region, host `teamapi.coros.com`) via the
Chrome DevTools MCP, by creating a default Run workout and saving it.

Endpoints are the **same** as strength: `POST /training/program/calculate` then
`POST /training/program/add`. Only the payload shape changes.

Raw bodies: `run-calculate-request.network-request`, `run-add-request.network-request`.

## Workout-level differences vs strength (sportType 4)

| Field | Strength | Run |
|---|---|---|
| `sportType` | `4` | `1` |
| `fastIntensityTypeName` | `"weight"` | `"custom"` |
| `referExercise` | `{intensityType:1,hrType:0,valueType:1}` | `{intensityType:0,hrType:0,valueType:0}` |
| `exercises[]` | strength moves (push-ups…) | run **steps** (warm up / training / rest / cool down) |

The rest of the workout wrapper (`access`, `pbVersion:2`, `subType:65535`, `sourceId`,
`poolLength`, etc.) is identical. `add` also carries an `exerciseBarChart[]` summary and
sets `distance`/`duration`/`sets`/`trainingLoad` from the `calculate` response.

## A run STEP with a heart-rate target

Example (Warm Up, 5 min, 91–95 % LTHR = 157–164 bpm):

```json
{
  "exerciseType": 1,
  "name": "T1120",
  "overview": "sid_run_warm_up_dist",
  "sportType": 1,
  "sets": 1,

  "targetType": 2,          // 2 = time (seconds); targetValue=300 → 5 min
  "targetValue": 300,

  "intensityType": 2,       // 2 = heart rate (strength: 1=weight, 0=none)
  "hrType": 3,              // HR target sub-mode (3 = % LTHR here)
  "isIntensityPercent": true,
  "intensityCustom": 2,
  "intensityValue": 157,        // lower bound, bpm
  "intensityValueExtend": 164,  // upper bound, bpm
  "intensityPercent": 91000,    // lower % LTHR × 1000  (91.000 %)
  "intensityPercentExtend": 95000, // upper % LTHR × 1000

  "restType": 3,
  "restValue": 0,
  "id": 1,                  // sequential 1-based
  "sortNo": 1,
  "originId": "425895398452936705",
  "createTimestamp": 1586584068,
  "equipment": [1],
  "part": [0]
}
```

### HR target encoding — the key finding
- `intensityType: 2` switches the step from "none/weight" to **heart rate**.
- `intensityValue` / `intensityValueExtend` = **absolute bpm** low/high.
- `intensityPercent` / `intensityPercentExtend` = **% ×1000** low/high.
- `isIntensityPercent` + `hrType` select WHICH heart-rate mode (see table below).

### HR intensity modes — all confirmed from UI requests

| Mode | intensityType | hrType | isIntensityPercent | intensityCustom | value fields |
|---|---|---|---|---|---|
| % Max Heart Rate | 2 | 1 | true | 2 | `intensityPercent`/`...Extend` = %×1000 (61000/70000); bpm in `intensityValue`/`...Extend` |
| % Heart Rate Reserve | 2 | 2 | **true** | 2 | `intensityPercent`/`...Extend` = %×1000 (71550/80140); bpm in `intensityValue`/`...Extend` |
| % Lactate Threshold HR | 2 | 3 | true | 2 | `intensityPercent`/`...Extend` = %×1000 (91000/95000); bpm in `intensityValue`/`...Extend` |
| Heart Rate (direct bpm) | 2 | 2 | **false** | 0 | `intensityValue`/`...Extend` = bpm (100/120); percent fields are non-integer decimals |

> Note: `hrType:2` is reused for both % HR Reserve and direct bpm. `isIntensityPercent` is the distinguishing flag.

### Non-HR intensity types (from source bundle `intensityTypeName` map)

| UI label | intensityType | notes |
|---|---|---|
| Pace | 3 | absolute pace; value unit TBD (likely sec/km) |
| % Threshold Pace | 3 | same intensityType, `isIntensityPercent:true` likely |
| % Effort Pace / Effort Pace | 8 | `adjustedPace` in source |
| Power | 6 | watts |
| Cadence | 7 | steps/min or rpm |
| Speed | 4 | km/h (source: `speed`) |

### Target types — all confirmed (UI requests + source bundle `targetTypeName` map)

| UI label | targetType | targetValue unit | notes |
|---|---|---|---|
| Time | 2 | seconds (300 = 5 min) | `targetDisplayUnit:0` |
| Distance | 5 | **centimetres** (100000 = 1 km) | `targetDisplayUnit:1` |
| Training Load | 6 | TL points (100 = 100 TL) | source: `"load"` |
| Open | 1 | 0 (no target) | source: `"manualEnd"` |
| HR Recovery | 7 | bpm threshold | source: `"heartRateRecovery"`; available on Rest step only |
| Reps (strength only) | 3 | reps | source: `"count"` |

### Repeat block — confirmed
A repeat is a synthetic group step with `isGroup: true` and **`sets` = repeat count**:
```json
{ "id": 2, "isGroup": true, "sets": 3, "exerciseType": 0, "intensityType": 0,
  "targetType": "", "restValue": 30, "sortNo": 2, "name": "" }
```
The repeated child steps carry `"groupId": 2` (= the group's `id`). The `add` response
expands them in `exerciseBarChart` (child steps appear N times).

### Step types (`exerciseType` + `name` code)
| exerciseType | role | code name | overview |
|---|---|---|---|
| 1 | Warm Up | T1120 | sid_run_warm_up_dist |
| 2 | Training (work) | T3001 | sid_run_training |
| 3 | Rest | T1122 | sid_run_cool_down_dist |
| 4 | Cool Down | T1123 | sid_run_cool_down_dist |

## Resolved — complete
- ✅ Distance target: `targetType:5`, value in **centimetres**.
- ✅ Direct bpm: `intensityType:2`, `hrType:2`, `isIntensityPercent:false`.
- ✅ Repeat count: `sets` on the synthetic `isGroup` step; children get `groupId`.
- ✅ % Max Heart Rate: `intensityType:2`, `hrType:1`, `isIntensityPercent:true`.
- ✅ % Heart Rate Reserve: `intensityType:2`, `hrType:2`, `isIntensityPercent:true`.
- ✅ Training Load: `targetType:6`, `targetValue` in TL points.
- ✅ Open: `targetType:1`, `targetValue:0`.
- ✅ HR Recovery (Rest): `targetType:7`.
- ✅ Pace: `intensityType:3` (source bundle `intensityTypeName`).
- ✅ Power: `intensityType:6` (source bundle).
- ✅ Cadence: `intensityType:7` (source bundle).
- ✅ Effort Pace / % Effort Pace: `intensityType:8` (`adjustedPace`, source bundle).

## Source references
- `intensityTypeName` map found in `main-iaFqXXuW.js`: `{0:"notSet",1:"weight",2:"heart",3:"pace",4:"speed",5:"swimmingStyle",6:"power",7:"cadence",8:"adjustedPace",9:"ftp",10:"gradeSystem",11:"rpe"}`
- `targetTypeName` map found in `main-iaFqXXuW.js`: `{0:"notSet",1:"manualEnd",2:"time",3:"count",4:"heart",5:"distance",6:"load",7:"heartRateRecovery",8:"cumulativeClimb",9:"routes"}`
- HR mode requests: reqid=299 (%MaxHR→hrType:1), reqid=318 (%HRR→hrType:2+isPercent:true), original captures (%LTHR→hrType:3, direct_bpm→hrType:2+isPercent:false)
- Target type requests: reqid=321 (Training Load→targetType:6), reqid=322 (Open→targetType:1)

Captures: `run-add-request.network-request` (time + %LTHR),
`run-add-dist-bpm.network-request` (distance + direct bpm + repeat×3).

## Delete endpoint (bonus capture)
`POST /training/program/delete` with body = JSON **array of program ids**:
```json
["478562032598303019"]
```
Response `{"result":"0000","message":"OK"}`. (The test workout was created then deleted.)
