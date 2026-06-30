# Backlog

Project status and pending tasks. Last updated: 2026-06-30.

## Current state — what is implemented

### Available MCP tools
| Tool | Description | Status |
|---|---|---|
| `authenticate_coros` | Login via API (stores token in auth.json) | ✅ |
| `check_coros_auth` | Check whether a session is active | ✅ |
| `search_exercises` | Search the local strength exercise catalog (~383 exercises) | ✅ |
| `create_workout` | Create a **strength** workout (sportType:4) | ✅ |
| `create_run_workout` | Create a **running** workout (sportType:1) with HR zones, distance targets, repeat groups | ✅ |
| `update_exercises` | Refresh the exercise catalog from the COROS API | ✅ |
| `list_workouts` | List the user's workouts | ✅ |

### Reverse-engineered run workout encoding
Fully documented in `research/RUN-WORKOUT-HR-ANALYSIS.md`. Confirmed working:
- HR zones: %MaxHR, %HRR, %LTHR, direct bpm
- Targets: time (seconds), distance (centimetres), open, training load
- Intensity: pace, power, cadence
- Repeat groups: synthetic `isGroup:true` step + children with `groupId`
- Warmup / Training / Rest / Cooldown with correct exerciseType codes and originIds

---

## Pending tasks

### 1. Tool: `set_token` (HIGH PRIORITY)

**Problem:** `authenticate_coros` logs in via the API, which **invalidates the user's browser session**. The user must choose between using the web app OR the MCP.

**Solution:** Add a tool that accepts a token extracted directly from browser request headers, without doing a login call.

**Implementation:**
1. In `src/index.ts`, register the new tool:
   ```typescript
   server.tool("set_token",
     "Store a COROS session token obtained from the browser (avoids invalidating the web session).",
     {
       accessToken: z.string().describe("accesstoken header value from browser DevTools"),
       userId: z.string().describe("userId from yfheader in browser DevTools"),
       region: z.enum(["us", "eu"]).default("us"),
     },
     async ({ accessToken, userId, region }) => {
       storeAuth({ accessToken, userId, region, timestamp: Date.now() });
       return { content: [{ type: "text", text: `Token stored. userId: ${userId}, region: ${region}` }] };
     }
   )
   ```
2. `storeAuth` is already exported from `coros-api.ts` ✅ — no changes needed there.
3. Nothing else to change — `getValidAuth()` already reads the stored auth.json.

**How the user gets the token:** DevTools → Network → any request to `teamapi.coros.com` → `accesstoken` request header.

---

### 2. Tool: `delete_workout` (MEDIUM PRIORITY)

**Captured endpoint:** `POST /training/program/delete` with body `["<programId>"]`. Response: `{"result":"0000","message":"OK"}`.

**Implementation:**
1. In `src/coros-api.ts`, add:
   ```typescript
   export async function deleteWorkout(auth: AuthData, id: string): Promise<void> {
     await apiPost(auth, "/training/program/delete", [id]);
   }
   ```
2. In `src/index.ts`, register:
   ```typescript
   server.tool("delete_workout",
     "Delete a workout from COROS Training Hub by ID.",
     { id: z.string().describe("Workout ID (from list_workouts)") },
     async ({ id }) => { /* auth check + deleteWorkout(auth, id) */ }
   )
   ```
3. Update `list_workouts` to include the `id` field in its output (currently not shown — see task 6).

---

### 3. Tests for run workout functions (MEDIUM PRIORITY)

`src/__tests__/coros-api.test.ts` covers the strength path but **none of the run code has tests**.

**Add to `src/__tests__/coros-api.test.ts`:**

```typescript
describe("resolveRunSteps", () => {
  it("builds a simple warmup + training + cooldown", () => {
    const steps = resolveRunSteps([
      { type: "warmup", targetType: "open" },
      { type: "training", targetType: "time", durationSeconds: 300, intensityMode: "heart_rate", bpmLow: 140, bpmHigh: 160 },
      { type: "cooldown", targetType: "open" },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0].exerciseType).toBe(1); // warmup = T1120
    expect(steps[1].intensityValue).toBe(140);
    expect(steps[1].intensityValueExtend).toBe(160);
    expect(steps[1].hrType).toBe(2);
    expect(steps[1].isIntensityPercent).toBe(false);
    expect(steps[2].exerciseType).toBe(3); // cooldown = T1122
  });

  it("builds a repeat group with correct groupId references", () => {
    const steps = resolveRunSteps([
      { type: "warmup", targetType: "open" },
      { repeat: 3, restSeconds: 60, steps: [
        { type: "training", targetType: "distance", distanceKm: 1 },
        { type: "rest", targetType: "time", durationSeconds: 90 },
      ]},
      { type: "cooldown", targetType: "open" },
    ]);
    // warmup + group + training + rest + cooldown = 5
    expect(steps).toHaveLength(5);
    expect(steps[1].isGroup).toBe(true);
    expect(steps[1].sets).toBe(3);
    expect(steps[2].groupId).toBe("2"); // groupId = group's id
    expect(steps[3].groupId).toBe("2");
    expect(steps[4].groupId).toBe("");  // cooldown is outside the group
  });

  it("converts distance km to cm", () => {
    const steps = resolveRunSteps([
      { type: "training", targetType: "distance", distanceKm: 1.5 },
    ]);
    expect(steps[0].targetType).toBe(5);
    expect(steps[0].targetValue).toBe(150000); // 1.5 km = 150 000 cm
  });

  it("encodes %LTHR correctly", () => {
    const steps = resolveRunSteps([
      { type: "training", targetType: "time", durationSeconds: 300,
        intensityMode: "percent_lthr", percentLow: 91, percentHigh: 95, bpmLow: 157, bpmHigh: 164 },
    ]);
    expect(steps[0].hrType).toBe(3);
    expect(steps[0].isIntensityPercent).toBe(true);
    expect(steps[0].intensityPercent).toBe(91000);
    expect(steps[0].intensityPercentExtend).toBe(95000);
    expect(steps[0].intensityCustom).toBe(2);
  });
});
```

---

### 4. `hrRecovery` + `trainingLoad` target types — ✅ DONE

**`hrRecovery`** (`targetType:7`) — the watch waits until HR drops below a bpm threshold before advancing. Only meaningful on `rest` steps. Field: `hrRecoveryBpm` (60–200, default 120).

**`trainingLoad`** (`targetType:6`) — step ends when accumulated training load reaches a TL-point target. Field: `trainingLoadPoints` (default 100).

Both codes confirmed in `research/RUN-WORKOUT-HR-ANALYSIS.md` (`targetTypeName` map: `6:"load"`, `7:"heartRateRecovery"`).

**Changes made:**
- `src/types.ts` — extended `RunStepInput.targetType` union, added `trainingLoadPoints?` + `hrRecoveryBpm?`.
- `src/coros-api.ts` — added `trainingLoad`/`hrRecovery` branches in `buildRunStepPayload()`.
- `src/index.ts` — extended the Zod enum and added both fields with descriptions.

---

### 5. Update CLAUDE.md (LOW PRIORITY)

Add a section for `create_run_workout` with the full schema and an example call, so any Claude agent knows how to build run workouts without reading the source.

**Content to add under the "Architecture" section:**

```markdown
- `create_run_workout` — Sport type 1. Steps: warmup/training/rest/cooldown.
  Targets: time (seconds), distance (km → cm internally), open.
  Intensity: heart_rate (bpmLow/bpmHigh), percent_max_hr/percent_hrr/percent_lthr
  (percentLow/percentHigh + bpmLow/bpmHigh required), pace (sec/km), power (watts), cadence (spm).
  Repeat groups: `{ repeat: N, steps: [...], restSeconds: 30 }`.
  Calls /calculate then /add, same as strength. Calculate response uses plan* prefix
  (planDuration, planSets, planTrainingLoad, planDistance) — different from strength.
```

---

### 6. Show `id` in `list_workouts` output (LOW PRIORITY)

`list_workouts` currently does not include the workout `id` in its output. This is needed to pass to `delete_workout`.

**Change in `src/index.ts`** — update the workout formatting map:
```typescript
.map((w) => {
  const durationMin = Math.round((w.estimatedTime || w.duration || 0) / 60);
  return `- **${w.name}** [id: ${w.id}] (${durationMin} min, ${w.totalSets || 0} sets)`;
})
```

---

## Quick reference

### Key files
- `src/index.ts` — MCP tool registration
- `src/coros-api.ts` — API clients and payload builders
- `src/types.ts` — TypeScript interfaces
- `research/RUN-WORKOUT-HR-ANALYSIS.md` — complete run API encoding reference
- `research/run-add-request.network-request` — real captured payload (time + %LTHR)
- `research/run-add-dist-bpm.network-request` — real captured payload (distance + bpm + repeat×3)

### Commands
```bash
npm run build   # compile TypeScript → dist/
npm test        # vitest (27 tests currently)
```

### Auth for manual testing
The user's account is US region (`teamapi.coros.com`). To test without invalidating the browser session: extract the `accesstoken` header and `userId` from any `teamapi.coros.com` request in DevTools, then use the `set_token` tool (task 1) or pass them as env vars `COROS_TOKEN` + `COROS_USERID` + `COROS_REGION=us`.
