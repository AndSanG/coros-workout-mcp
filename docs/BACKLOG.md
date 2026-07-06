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

### 1. Tool: `set_token` — ✅ DONE

**Problem it solves:** `authenticate_coros` logs in via the API, which **invalidates the user's
browser session** (confirmed live — it evicts the shared `"web"` slot; see Open Questions C).
`set_token` lets a token be persisted to `auth.json` without ever calling `/account/login`, so
the browser session is never touched.

Registered in `src/index.ts`, right after `check_coros_auth`. Takes `accessToken`, `userId`,
`region` and calls the already-exported `storeAuth()` from `coros-api.ts` — no changes needed
there, and `getValidAuth()` already reads the stored file. The env-var half
(`COROS_TOKEN`/`COROS_USERID`, no file write at all) was already implemented before this.

**Two ways to get the token to feed it:**

1. **Manual (no agent browser access):** DevTools → Network → any `teamapi.coros.com` request
   → copy the `accesstoken` header and the `userId` from the `yfheader` request header → call
   `set_token` with those values.
2. **Agent-driven, no credentials typed anywhere (preferred when available):** if the assistant
   has browser automation tools (e.g. the Chrome DevTools MCP) and the user already has an
   active, logged-in COROS web session, the assistant can read the token directly off any
   in-flight request — `list_network_requests` / `get_network_request` on any
   `teamapi.coros.com` call shows the `accesstoken` header and `yfheader` (which contains
   `userId`) — and call `set_token` with them. No login form, no credentials ever handled by
   the assistant, no risk to the web session (this is exactly `getValidAuth`'s "acquire, don't
   mint" path — see the auth-alternatives write-up under Open Questions). This is the same
   technique used throughout the auth investigation earlier (`account/query` responses were
   read this way to get the current token during the C/B captures).

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

### 7. Expiry-aware auth errors — ✅ DONE

The result code was identified during the question-C live capture (see Open Questions below):
COROS returns `result: "1019"`, message `"Access token is invalid"` for a revoked/invalid
accesstoken. `apiPost`/`apiGet` in `src/coros-api.ts` now special-case it via a shared
`assertApiSuccess()` helper, throwing *"COROS token expired or invalid — re-run set_token /
refresh COROS_TOKEN."* instead of the generic `COROS API error (...)` message. `login()`'s own
result check is untouched — that's a bad-credentials failure, not a stale-token one. Every
other API call goes through `apiPost`/`apiGet` so picks this up automatically (e.g.
`deleteWorkout`). Tested: added a case to the `describe("deleteWorkout")` block asserting the
1019 response throws the clear message, not the raw one. Suite is now **42 tests**.

---

### 8. Store token in OS keychain instead of plaintext `auth.json` — DECLINED (2026-07-06)

`auth.json` is plaintext (mode 0600) at `~/.config/coros-workout-mcp/auth.json`. Independent
of how the token is acquired, moving it to the **macOS Keychain** (and equivalents) would
harden the credential at rest. This is a storage swap behind `storeAuth`/`loadAuth`, not an
auth-method change.

**Decision: not doing this.** Explicitly declined after the auth investigation confirmed the
risk this would mitigate is small: the token is bounded and revocable (question C — a logout
kills it instantly, `result: "1019"`), likely expires on its own too (question A, unmeasured
but presumably bounded), and file permissions already restrict it to the local user account.
Don't resurface this unless something changes the risk model (e.g. the token turns out to be
very long-lived, or `auth.json` needs to hold something more sensitive than it does today).

---

## Open questions (need investigation)

Unknowns surfaced during live testing / the auth discussion. Each needs a real capture or
experiment before a decision — do not assume.

### A. Token lifetime (TTL)
The browser/`accesstoken` worked in every live test but **was never observed expiring**. If
it is long-lived (days/weeks), manual `set_token` reuse is a non-issue; if hours, a
programmatic-harvest or self-renewing flow becomes worth building. **To answer:** record when
a captured token first starts returning auth errors.

### B. Does `/account/login` return a refresh token or expiry timestamp? — ✅ ANSWERED (2026-07-06)
**No.** Captured the full response body with a standalone Puppeteer script (launched an
isolated Chrome profile — see below — to sidestep the hard-redirect problem that defeated two
earlier attempts via the Chrome DevTools MCP). Full shape:

```json
{
  "apiCode": "...", "result": "0000", "message": "OK",
  "data": {
    "accessToken": "...", "userId": "...", "email": "...",
    "birthday": 19900408, "nickname": "...", "headPic": "...",
    "maxHr": 196, "rhr": 50, "zoneData": {...}, "userProfile": {...},
    "runScoreList": [...], "climbConfig": [...]
    /* ...rest is user profile data, same shape as /account/query */
  },
  "extend": { "grayHeaders": {} }
}
```

No `refreshToken`, no `expiresAt`/`ttl`/expiry field anywhere. `login()` in `src/coros-api.ts`
was already only reading `accessToken`/`userId` — confirmed there was nothing else worth
capturing. **Conclusion for question E (auth method trade-off):** a self-renewing,
password-free flow is not possible — COROS's login response gives no way to refresh a token
without re-submitting credentials. The two acquisition paths remain genuinely exclusive on
their costs; there's no middle ground to discover here.

**How it was captured (for future reference):** the Chrome DevTools MCP tools couldn't do this
reliably — COROS's web app does a **hard page redirect** to the dashboard immediately after
login (confirmed: the dashboard load shows up as a fresh top-level `GET`, not a client-side
route change), which wipes the DevTools network log before the response can be read. Both a
retroactive `includePreservedRequests` read and a `window.fetch`/`XMLHttpRequest` interceptor
injected via `initScript` (writing to `localStorage` to survive the navigation) failed —
confirmed with a control test that `includePreservedRequests` doesn't survive *any* explicit
navigation in this tool, not just the login redirect. What worked: a standalone Node script
(`puppeteer-core`, real CDP `page.on("response")` events, immune to the navigation-log-clearing
issue) launching a **separate, isolated Chrome profile** — so no interaction with the real
browser session or credentials was needed from the assistant. Script + output were kept in a
scratch directory outside the repo, not committed.

### C. Does logging out on the web revoke the token? — ✅ ANSWERED (2026-07-06)
**Yes, immediately and server-side.** Live-tested: captured the active `accesstoken` from a
logged-in browser session, called `GET /account/logout` directly (found via the bundled JS —
`teamapi.coros.com/account/logout`, no body), then immediately retried the *same* token against
`GET /account/query`. Result: `{"result":"1019","message":"Access token is invalid"}`. The
browser's own session died at the same moment (confirmed — reload showed the login page).
This is a genuine server-side revocation, not just a client-side cookie clear.

**Bonus:** this identifies the exact result code for task 7 (expiry-aware auth errors) —
`result: "1019"` / message `"Access token is invalid"` is COROS's auth-failure signature.
`apiPost`/`apiGet` in `src/coros-api.ts` can special-case this now without further guessing.

### D. Does the COROS phone app hold a separate, independent session? — ✅ ANSWERED behaviorally (2026-07-06)
**Yes — confirmed independent.** Two complementary findings:

1. **Web is unified across browsers, not per-browser.** Logging in on Chrome then Safari (same
   account): only the most recent survives. So "the web session" isn't tied to a specific
   browser/cookie jar — it's one server-side slot keyed by something like `(userId, platform)`,
   and any web login (any browser, or our own `authenticate_coros`) evicts whatever was
   previously in that slot.
2. **Mobile does not share that slot.** Triggered a real login via `login()` (the same call
   `authenticate_coros` makes) while the phone app was logged in and active. Result: the web
   browser was evicted (expected), but **the phone app kept working, untouched.** If mobile used
   the same slot as web, this login would have evicted it too — it didn't, so mobile is tracked
   as a genuinely separate session, most likely a different platform/client-type key server-side.

**Practical implication for question E:** the documented downside of `authenticate_coros`
("invalidates the web session") is real but **narrower than previously assumed** — it costs you
the browser tab, not your phone app. For anyone who mainly uses the phone day to day, automated
email/password login is much less disruptive than the original write-up implied.

**Still unresolved (lower priority now):** we still can't *extract* the phone's own token
programmatically — the Charles Proxy attempt hit certificate pinning (undecryptable
`coros.com` traffic even with the root cert fully trusted on-device; getting past that needs
jailbreak/root + Frida/objection, deliberately not pursued, out of scope). That would have been
a nice bonus (a password-free, non-disruptive token source) but is no longer the blocking
question it was — we now know *behaviorally* that mobile is safe to leave alone regardless.

### E. Auth method trade-off (decision, pending only A now)
Two acquisition paths, mutually exclusive on their costs:
- **Browser-token reuse** (`set_token` / `COROS_TOKEN`): no password stored, web session
  preserved — but needs a logged-in browser to extract and the token expires.
- **Email/password login** (`authenticate_coros` / `COROS_EMAIL`+`COROS_PASSWORD`): fully
  automated and self-renewing — invalidates the web session, but (per D) **not the phone app**.
  Only the password itself is ever handled in-memory; only the resulting token is written to
  `auth.json` (mode 0600) — same storage risk as the token-reuse path, not an additional one.

B is resolved (no refresh token exists, so there's no hybrid option), C confirms browser-token
reuse is fragile against any explicit logout anywhere on the shared web slot, and D confirms
mobile is untouched by an API login. **Net effect: `authenticate_coros` is more attractive than
originally written up**, especially for anyone who mainly interacts with COROS via the phone —
its real cost is just the browser tab, not full account access. Still open: A (how long does an
un-revoked token actually last?) — the last variable that could still shift this.

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
