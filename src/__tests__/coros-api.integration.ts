import { describe, it, expect, afterAll } from "vitest";
import {
  resolveExercises,
  calculateWorkout,
  addWorkout,
  resolveRunSteps,
  calculateRunWorkout,
  addRunWorkout,
  resolveBikeSteps,
  calculateBikeWorkout,
  addBikeWorkout,
  queryWorkouts,
  deleteWorkout,
  formatWorkoutSummary,
  queryExerciseCatalog,
  fetchI18nStrings,
  buildCatalogFromRaw,
} from "../coros-api.js";
import type { WorkoutSummary } from "../coros-api.js";
import type { AuthData, RunStepInput, RunGroupInput, BikeStepInput, BikeGroupInput } from "../types.js";

/**
 * LIVE integration test — hits the real COROS Training Hub API.
 *
 * Excluded from `npm test` (default run only matches *.test.ts). Run on demand:
 *   COROS_TOKEN=<accesstoken> COROS_USERID=<userId> COROS_REGION=us \
 *     npm run test:integration
 *
 * Get the token from browser DevTools → Network → any request to teamapi.coros.com →
 * `accesstoken` request header (and `userId` from the response). Using the browser token
 * does NOT invalidate the web session (unlike authenticate_coros, which logs in afresh).
 *
 * The whole suite SKIPS (does not fail) when credentials are absent. It creates a
 * clearly-labeled throwaway workout and deletes it, with an afterAll safety-net cleanup.
 */

const token = process.env.COROS_TOKEN;
const userId = process.env.COROS_USERID;
const region = (process.env.COROS_REGION ?? "us") as "us" | "eu";
const hasCreds = Boolean(token && userId);

if (!hasCreds) {
  console.warn(
    "\n[integration] SKIPPED — set COROS_TOKEN + COROS_USERID (+ COROS_REGION) to run live tests.\n"
  );
}

const auth: AuthData = {
  accessToken: token ?? "",
  userId: userId ?? "",
  region,
  timestamp: Date.now(),
};

const TEST_NAME = `MCP INTEGRATION TEST — delete me ${Date.now()}`;

type Workout = WorkoutSummary;
const list = async (sportType: number, limit = 20): Promise<Workout[]> => {
  const res = (await queryWorkouts(auth, { sportType, limitSize: limit })) as {
    data?: Workout[];
  };
  return res.data ?? [];
};
const listStrength = (limit = 20) => list(4, limit);
const listRun = (limit = 20) => list(1, limit);
const listBike = (limit = 20) => list(2, limit);

describe.skipIf(!hasCreds)("coros-api integration (live API)", () => {
  // Shared across the ordered steps below; vitest runs tests in a file sequentially.
  let createdId: string | undefined;

  afterAll(async () => {
    // Safety net: if an assertion failed mid-flow, remove the leftover test workout.
    if (createdId) {
      try {
        await deleteWorkout(auth, createdId);
      } catch {
        /* already gone */
      }
    }
  });

  it("lists strength workouts and formats each with its id", async () => {
    const workouts = await listStrength(5);
    for (const w of workouts) {
      expect(formatWorkoutSummary(w)).toContain(`[id: ${w.id}]`);
    }
  });

  it("creates a workout and returns real (non-NaN) calculated metrics", async () => {
    const exercises = resolveExercises([
      { name: "Push-ups", sets: 3, reps: 12 },
      { name: "Squats", sets: 3, reps: 15 },
    ]);

    const calc = await calculateWorkout(auth, TEST_NAME, "integration", exercises);
    // Regression guard for the plan*-key bug: these must be real numbers, not NaN/undefined.
    expect(Number.isNaN(calc.duration)).toBe(false);
    expect(calc.duration).toBeGreaterThan(0);
    expect(calc.totalSets).toBeGreaterThan(0);

    const addResp = (await addWorkout(
      auth,
      TEST_NAME,
      "integration",
      exercises,
      calc
    )) as { result: string; data: string };
    expect(addResp.result).toBe("0000");
    createdId = addResp.data; // new program id
    expect(createdId).toBeTruthy();
  });

  it("finds the created workout in the list by id", async () => {
    expect(createdId).toBeTruthy();
    const found = (await listStrength()).find((w) => w.id === createdId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(TEST_NAME);
  });

  it("deletes the workout and it disappears from the list", async () => {
    expect(createdId).toBeTruthy();
    await deleteWorkout(auth, createdId!);
    const stillThere = (await listStrength()).find((w) => w.id === createdId);
    expect(stillThere).toBeUndefined();
    createdId = undefined; // cleaned up — don't double-delete in afterAll
  });
});

describe.skipIf(!hasCreds)("coros-api integration — run path (live API)", () => {
  const RUN_NAME = `MCP INTEGRATION RUN — delete me ${Date.now()}`;
  let createdId: string | undefined;

  // A deliberately non-trivial encoding: warmup + a repeat×3 group of
  // [1 km @ heart-rate zone, 60 s rest] + cooldown. Exercises distance (km→cm),
  // HR-zone intensity, and repeat-group groupId wiring — the fragile run surface.
  const steps: Array<RunStepInput | RunGroupInput> = [
    { type: "warmup", targetType: "open" },
    {
      repeat: 3,
      restSeconds: 60,
      steps: [
        {
          type: "training",
          targetType: "distance",
          distanceKm: 1,
          intensityMode: "heart_rate",
          bpmLow: 150,
          bpmHigh: 165,
        },
        { type: "rest", targetType: "time", durationSeconds: 60 },
      ],
    },
    { type: "cooldown", targetType: "open" },
  ];

  afterAll(async () => {
    if (createdId) {
      try {
        await deleteWorkout(auth, createdId);
      } catch {
        /* already gone */
      }
    }
  });

  it("calculates a run workout with real (non-NaN) plan* metrics and distance", async () => {
    const runSteps = resolveRunSteps(steps);
    const calc = await calculateRunWorkout(auth, RUN_NAME, "integration", runSteps);
    // plan*-key regression guard for the run path.
    expect(Number.isNaN(calc.duration)).toBe(false);
    expect(calc.totalSets).toBeGreaterThan(0);
    // 3 × 1 km of distance targets → the server should report > 0 planDistance.
    expect(parseFloat(calc.distance)).toBeGreaterThan(0);
  });

  it("creates the run workout and finds it in the list by id", async () => {
    const runSteps = resolveRunSteps(steps);
    const calc = await calculateRunWorkout(auth, RUN_NAME, "integration", runSteps);
    const addResp = (await addRunWorkout(
      auth,
      RUN_NAME,
      "integration",
      runSteps,
      calc
    )) as { result: string; data: string };
    expect(addResp.result).toBe("0000");
    createdId = addResp.data;
    expect(createdId).toBeTruthy();

    const found = (await listRun()).find((w) => w.id === createdId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(RUN_NAME);
  });

  it("deletes the run workout and it disappears from the list", async () => {
    expect(createdId).toBeTruthy();
    await deleteWorkout(auth, createdId!);
    const stillThere = (await listRun()).find((w) => w.id === createdId);
    expect(stillThere).toBeUndefined();
    createdId = undefined;
  });
});

describe.skipIf(!hasCreds)("coros-api integration — bike path (live API)", () => {
  const BIKE_NAME = `MCP INTEGRATION BIKE — delete me ${Date.now()}`;
  let createdId: string | undefined;

  // Exercises the fragile bike-only surface: warmup + a repeat×3 group of
  // [2 km @ %FTP (dual percent+watts encoding), 60 s rest @ cadence] + cooldown.
  const steps: Array<BikeStepInput | BikeGroupInput> = [
    { type: "warmup", targetType: "open" },
    {
      repeat: 3,
      restSeconds: 60,
      steps: [
        {
          type: "training",
          targetType: "distance",
          distanceKm: 2,
          intensityMode: "percent_ftp",
          percentLow: 76,
          percentHigh: 90,
          intensityLow: 179,
          intensityHigh: 212,
        },
        {
          type: "rest",
          targetType: "time",
          durationSeconds: 60,
          intensityMode: "cadence",
          intensityLow: 60,
          intensityHigh: 70,
        },
      ],
    },
    { type: "cooldown", targetType: "open" },
  ];

  afterAll(async () => {
    if (createdId) {
      try {
        await deleteWorkout(auth, createdId);
      } catch {
        /* already gone */
      }
    }
  });

  it("calculates a bike workout with real (non-NaN) plan* metrics and distance", async () => {
    const bikeSteps = resolveBikeSteps(steps);
    const calc = await calculateBikeWorkout(auth, BIKE_NAME, "integration", bikeSteps);
    // plan*-key regression guard for the bike path.
    expect(Number.isNaN(calc.duration)).toBe(false);
    expect(calc.totalSets).toBeGreaterThan(0);
    // 3 × 2 km of distance targets → the server should report > 0 planDistance.
    expect(parseFloat(calc.distance)).toBeGreaterThan(0);
  });

  it("creates the bike workout and finds it in the list by id", async () => {
    const bikeSteps = resolveBikeSteps(steps);
    const calc = await calculateBikeWorkout(auth, BIKE_NAME, "integration", bikeSteps);
    const addResp = (await addBikeWorkout(
      auth,
      BIKE_NAME,
      "integration",
      bikeSteps,
      calc
    )) as { result: string; data: string };
    expect(addResp.result).toBe("0000");
    createdId = addResp.data;
    expect(createdId).toBeTruthy();

    const found = (await listBike()).find((w) => w.id === createdId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(BIKE_NAME);
  });

  it("deletes the bike workout and it disappears from the list", async () => {
    expect(createdId).toBeTruthy();
    await deleteWorkout(auth, createdId!);
    const stillThere = (await listBike()).find((w) => w.id === createdId);
    expect(stillThere).toBeUndefined();
    createdId = undefined;
  });
});

describe.skipIf(!hasCreds)("coros-api integration — update_exercises (live API + CDN)", () => {
  // Read-only: hits the catalog API and the i18n CDN and rebuilds the catalog in memory.
  // Does NOT write data/exercises.json (the update_exercises tool does; we skip that to
  // avoid mutating the repo). This is purely drift detection for the catalog endpoint and
  // the CDN string bundle.
  it("fetches the raw exercise catalog from the API", async () => {
    const raw = await queryExerciseCatalog(auth, 4);
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeGreaterThan(100); // ~383 bundled; live should be in the same ballpark
    // Shape guard: each raw exercise carries the fields buildCatalogFromRaw relies on.
    expect(typeof raw[0].name).toBe("string");
    expect(typeof raw[0].id).not.toBe("undefined");
  });

  it("fetches i18n strings from the CDN", async () => {
    const i18n = await fetchI18nStrings();
    expect(i18n && typeof i18n).toBe("object");
    expect(Object.keys(i18n).length).toBeGreaterThan(0);
  });

  it("rebuilds a catalog from live data with resolved names and i18n coverage", async () => {
    const [raw, i18n] = await Promise.all([
      queryExerciseCatalog(auth, 4),
      fetchI18nStrings(),
    ]);
    const { catalog, i18nMisses } = buildCatalogFromRaw(raw, i18n, []);
    expect(catalog.length).toBe(raw.length);
    // At least some exercises resolve to a human-readable i18n name (not a raw code like "T1004").
    const resolved = catalog.filter((e) => e.name !== e.codeName);
    expect(resolved.length).toBeGreaterThan(0);
    // i18nMisses is the diagnostic list of code names without a string; sanity-bounded.
    expect(i18nMisses.length).toBeLessThanOrEqual(raw.length);
  });
});
