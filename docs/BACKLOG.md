# Backlog

Project status and pending tasks. Last updated: 2026-06-30.

## Bug fixes

### `calculateWorkout` read the wrong response keys (strength path) — ✅ FIXED
Found via a **live end-to-end test** (Chrome DevTools → captured a real browser token →
ran the full `list → create → verify → delete` round trip against `teamapi.coros.com`).
The strength `/calculate` response uses **`plan*`-prefixed keys** (`planDuration`, `planSets`,
`planTrainingLoad`) — same as the run path — but `calculateWorkout` was reading
`duration`/`totalSets`/`trainingLoad`, which don't exist. Result: `create_workout` reported
`Duration: ~NaN min | Sets: undefined | Training load: undefined` on every successful
strength workout (the workout itself saved fine — the server recomputes). Fixed in
`src/coros-api.ts`; added an offline regression test (`describe("calculateWorkout")`) that
stubs the `plan*` response shape.

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

### 1. Tool: `set_token` (HIGH PRIORITY — partially done)

**Problem:** `authenticate_coros` logs in via the API, which **invalidates the user's browser session**. The user must choose between using the web app OR the MCP.

**✅ Env-var half now implemented:** `getValidAuth()` now honors `COROS_TOKEN` + `COROS_USERID`
(+ `COROS_REGION`) as an explicit-token override — it builds `AuthData` directly, no login,
no file write, so the web session is never invalidated. (Previously the backlog claimed this
worked, but `getValidAuth` only supported `auth.json` + `COROS_EMAIL`/`COROS_PASSWORD`.)
**Still TODO:** the `set_token` *tool* itself (persists the token to `auth.json` so it
survives without keeping env vars around).

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

### 2. Tool: `delete_workout` — ✅ DONE

`POST /training/program/delete` with body `["<programId>"]`.

- `src/coros-api.ts` — added `deleteWorkout(auth, id)`.
- `src/index.ts` — registered the tool. Its **description explicitly states the action is
  destructive/irreversible and instructs the agent to confirm the workout (name + id) with
  the user and get approval before calling** — never speculatively.
- Depends on task 6 (the `id` shown by `list_workouts` is the argument).
- Tested: `deleteWorkout` has unit tests (fetch stubbed via `vi.stubGlobal`) asserting the
  body is `[id]` (array, not bare id) and that a non-`0000` API result throws.

---

### 3. Tests for run workout functions — ✅ DONE

Added a `describe("resolveRunSteps")` block to `src/__tests__/coros-api.test.ts` (8 cases):
warmup/training/cooldown encoding, repeat-group `groupId` references, km→cm distance
conversion, %LTHR percent encoding, plus the task-4 `trainingLoad` and `hrRecovery`
targets (custom + default values). Suite is now **35 tests**, all offline (no API calls).

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

### 6. Show `id` in `list_workouts` output — ✅ DONE

Added `id: string` to the inline response type and surfaced it in the formatted line as
`` `[id: <id>]` `` so users can pass it to `delete_workout`. The program-level `id` is a
string (confirmed in `research/create-workout-request-all.txt`: `"id":"0"`).

The formatting was extracted into an exported pure helper `formatWorkoutSummary(w)` in
`src/coros-api.ts` (index.ts can't be imported in a test — it starts the server on import).
Tested: id/name/duration shown, `estimatedTime`→`duration` fallback, overview on its own
line, and zero-defaults for missing counts.

---

### 7. Expiry-aware auth errors (MEDIUM PRIORITY)

`getValidAuth()` returns a stored/injected token **without checking validity** — an expired
token fails mid-call with a generic `COROS API error (...)`. Detect the auth-failure result
code from the API and return a clear, actionable message instead, e.g.
*"COROS token expired or invalid — re-run set_token / refresh COROS_TOKEN."*

**Where:** `apiPost`/`apiGet` in `src/coros-api.ts` already throw on `result !== "0000"`.
Identify the specific result/apiCode COROS returns for an invalid token (needs a capture —
let an expired/garbage token through and record the response), then special-case it.

---

### 8. Store token in OS keychain instead of plaintext `auth.json` (LOW PRIORITY)

`auth.json` is plaintext (mode 0600) at `~/.config/coros-workout-mcp/auth.json`. Independent
of how the token is acquired, moving it to the **macOS Keychain** (and equivalents) would
harden the credential at rest. This is a storage swap behind `storeAuth`/`loadAuth`, not an
auth-method change.

---

## Open questions (need investigation)

Unknowns surfaced during live testing / the auth discussion. Each needs a real capture or
experiment before a decision — do not assume.

### A. Token lifetime (TTL)
The browser/`accesstoken` worked in every live test but **was never observed expiring**. If
it is long-lived (days/weeks), manual `set_token` reuse is a non-issue; if hours, a
programmatic-harvest or self-renewing flow becomes worth building. **To answer:** record when
a captured token first starts returning auth errors.

### B. Does `/account/login` return a refresh token or expiry timestamp?
Only request headers were captured, never the full **login response body**. If COROS issues a
refresh token or an `expiresAt`, a silent-renew flow is possible (no re-copy, no password).
**To answer:** capture the full `POST /account/login` response and inspect `data`.

### C. Does logging out on the web revoke the token?
Web app + API share **one** session token (same value in the `accesstoken` header and the
`CPL-coros-token` cookie; an API login invalidates the web session). It is **untested**
whether explicitly logging out on the web revokes the shared token (likely) vs. just closing
the tab (likely harmless). **To answer:** capture a token, log out on web, retry an MCP call.

### D. Does the COROS phone app hold a separate, independent session?
Only the **web** session token was observed. If the mobile app maintains its own session
slot, it could be a browser-free token source that doesn't fight the web session. **Unknown —
do not claim it works** without testing. **To answer:** capture the app's `accesstoken` (proxy
the phone) and check whether using it disturbs the web session.

### E. Auth method trade-off (decision, pending A–D)
Two acquisition paths, mutually exclusive on their costs:
- **Browser-token reuse** (`set_token` / `COROS_TOKEN`): no password stored, web session
  preserved — but needs a logged-in browser to extract and the token expires.
- **Email/password login** (`authenticate_coros` / `COROS_EMAIL`+`COROS_PASSWORD`): fully
  automated and self-renewing — but stores the password and **invalidates the web session**.

There is **no browser-free *and* password-free path** in what's been observed: a token can
only originate from a login somewhere. Pick per A–D findings.

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
npm run build          # compile TypeScript → dist/
npm test               # vitest unit tests, offline (41 tests currently)
npm run test:integration   # on-demand LIVE round trip against the real COROS API
```

### Live integration tests (on demand)
14 live tests across two files (separate `vitest.integration.config.ts`, matches
`*.integration.ts`; excluded from `npm test`; skip cleanly when creds are absent):

- **`src/__tests__/coros-api.integration.ts`** (10) — calls the `coros-api` functions
  directly. Strength `list → create → verify → delete → gone`; run path (warmup + repeat×3
  HR-zone distance intervals + cooldown — the fragile encoding); and `update_exercises`
  (live catalog API + i18n CDN + in-memory rebuild, read-only — does NOT write
  `data/exercises.json`). Each create asserts the `plan*` metrics are real (non-NaN).
- **`src/__tests__/mcp-stdio.integration.ts`** (4) — TRUE end-to-end: spawns the compiled
  server (`dist/src/index.js`) and drives it over the real STDIO/JSON-RPC transport like a
  client would, so it covers `src/index.ts` tool registrations + transport + live API.
  Lists tools, checks auth, then `create_workout → list_workouts → delete_workout`.
  **Requires `npm run build` first** (spawns the compiled server).

Auth is injected via `COROS_TOKEN`/`COROS_USERID` (getValidAuth's explicit-token path) —
no `auth.json` touched, no login, web session stays valid. To run:
```bash
COROS_TOKEN=<accesstoken> COROS_USERID=<userId> COROS_REGION=us npm run test:integration
```
Get the token from DevTools → Network → any `teamapi.coros.com` request → `accesstoken`
header (does not invalidate the web session). Creates a clearly-labeled throwaway workout
and deletes it, with an `afterAll` safety-net cleanup.

### Auth for manual testing
The user's account is US region (`teamapi.coros.com`). To test without invalidating the browser session: extract the `accesstoken` header and `userId` from any `teamapi.coros.com` request in DevTools, then use the `set_token` tool (task 1) or pass them as env vars `COROS_TOKEN` + `COROS_USERID` + `COROS_REGION=us`.
