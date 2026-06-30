import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildExercisePayload,
  buildWorkoutPayload,
  resolveExercises,
  resolveRunSteps,
  calculateWorkout,
  deleteWorkout,
  formatWorkoutSummary,
} from "../coros-api.js";
import { findByName } from "../exercise-catalog.js";
import type { AuthData } from "../types.js";

describe("coros-api payload construction", () => {
  describe("buildExercisePayload", () => {
    it("builds payload from Push-ups catalog entry with defaults", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1);

      expect(payload.nameText).toBe("Push-ups");
      expect(payload.name).toBe("T1004");
      expect(payload.originId).toBe(pushups.id);
      expect(payload.sortNo).toBe(1);
      expect(payload.id).toBe(1);
      expect(payload.sportType).toBe(4);
      expect(payload.targetType).toBe(3); // reps
      expect(payload.targetValue).toBe(15); // default reps
      expect(payload.sets).toBe(4); // default sets from catalog
      expect(payload.restValue).toBe(30); // default rest
      expect(payload.intensityType).toBe(1);
      expect(payload.intensityValue).toBe(0);
      expect(payload.isGroup).toBe(false);
      expect(payload.groupId).toBe("");
      expect(payload.intensityDisplayUnit).toBe("6");
    });

    it("applies reps override", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1, { reps: 20 });

      expect(payload.targetType).toBe(3);
      expect(payload.targetValue).toBe(20);
    });

    it("applies sets override", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1, { sets: 5 });

      expect(payload.sets).toBe(5);
    });

    it("applies weight override in grams", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1, {
        weightGrams: 10000,
      });

      expect(payload.intensityType).toBe(1);
      expect(payload.intensityValue).toBe(10000);
    });

    it("applies weight override in kg (converts to grams)", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1, { weightKg: 20 });

      expect(payload.intensityType).toBe(1);
      expect(payload.intensityValue).toBe(20000);
    });

    it("applies rest override", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1, { restSeconds: 60 });

      expect(payload.restType).toBe(1);
      expect(payload.restValue).toBe(60);
    });

    it("applies duration override (changes targetType to 2)", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1, { duration: 45 });

      expect(payload.targetType).toBe(2);
      expect(payload.targetValue).toBe(45);
    });

    it("includes media URLs from catalog", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1);

      expect(payload.thumbnailUrl).toBeTruthy();
      expect(payload.videoInfos.length).toBeGreaterThan(0);
      expect(payload.coverUrlArrStr).toBeTruthy();
    });

    it("includes text fields", () => {
      const pushups = findByName("Push-ups")!;
      const payload = buildExercisePayload(pushups, 1);

      expect(payload.muscleText).toBe("Chest");
      expect(payload.partText).toContain("Chest");
      expect(payload.equipmentText).toBe("Bodyweight");
    });
  });

  describe("buildWorkoutPayload", () => {
    it("builds a workout with correct defaults", () => {
      const pushups = findByName("Push-ups")!;
      const exercise = buildExercisePayload(pushups, 1);

      const workout = buildWorkoutPayload(
        "Test Workout",
        "A test",
        [exercise]
      );

      expect(workout.name).toBe("Test Workout");
      expect(workout.overview).toBe("A test");
      expect(workout.sportType).toBe(4);
      expect(workout.exercises).toHaveLength(1);
      expect(workout.pbVersion).toBe(2);
      expect(workout.access).toBe(1);
      expect(workout.id).toBe("0");
      expect(workout.duration).toBe(0);
      expect(workout.totalSets).toBe(0);
    });
  });

  describe("resolveExercises", () => {
    it("resolves exercise names to payloads", () => {
      const payloads = resolveExercises([
        { name: "Push-ups", sets: 3, reps: 15 },
        { name: "Squats", sets: 3, reps: 10 },
      ]);

      expect(payloads).toHaveLength(2);
      expect(payloads[0].nameText).toBe("Push-ups");
      expect(payloads[0].sortNo).toBe(1);
      expect(payloads[0].sets).toBe(3);
      expect(payloads[0].targetValue).toBe(15);

      expect(payloads[1].nameText).toBe("Squats");
      expect(payloads[1].sortNo).toBe(2);
      expect(payloads[1].sets).toBe(3);
      expect(payloads[1].targetValue).toBe(10);
    });

    it("throws for unknown exercise name", () => {
      expect(() =>
        resolveExercises([{ name: "Nonexistent Exercise" }])
      ).toThrow('Exercise not found in catalog: "Nonexistent Exercise"');
    });
  });
});

describe("resolveRunSteps", () => {
  it("builds a simple warmup + training + cooldown", () => {
    const steps = resolveRunSteps([
      { type: "warmup", targetType: "open" },
      {
        type: "training",
        targetType: "time",
        durationSeconds: 300,
        intensityMode: "heart_rate",
        bpmLow: 140,
        bpmHigh: 160,
      },
      { type: "cooldown", targetType: "open" },
    ]);

    expect(steps).toHaveLength(3);
    expect(steps[0].exerciseType).toBe(1); // warmup = T1120
    expect(steps[0].targetType).toBe(1); // open
    expect(steps[1].targetType).toBe(2); // time
    expect(steps[1].targetValue).toBe(300);
    expect(steps[1].intensityType).toBe(2);
    expect(steps[1].hrType).toBe(2);
    expect(steps[1].isIntensityPercent).toBe(false);
    expect(steps[1].intensityValue).toBe(140);
    expect(steps[1].intensityValueExtend).toBe(160);
    expect(steps[2].exerciseType).toBe(3); // cooldown = T1122
  });

  it("builds a repeat group with correct groupId references", () => {
    const steps = resolveRunSteps([
      { type: "warmup", targetType: "open" },
      {
        repeat: 3,
        restSeconds: 60,
        steps: [
          { type: "training", targetType: "distance", distanceKm: 1 },
          { type: "rest", targetType: "time", durationSeconds: 90 },
        ],
      },
      { type: "cooldown", targetType: "open" },
    ]);

    // warmup + group + training + rest + cooldown = 5
    expect(steps).toHaveLength(5);
    expect(steps[1].isGroup).toBe(true);
    expect(steps[1].sets).toBe(3);
    expect(steps[1].restValue).toBe(60);
    expect(steps[2].groupId).toBe("2"); // group's id, as a string
    expect(steps[3].groupId).toBe("2");
    expect(steps[4].groupId).toBe(""); // cooldown is outside the group
  });

  it("converts distance km to cm", () => {
    const steps = resolveRunSteps([
      { type: "training", targetType: "distance", distanceKm: 1.5 },
    ]);
    expect(steps[0].targetType).toBe(5);
    expect(steps[0].targetValue).toBe(150000); // 1.5 km = 150 000 cm
    expect(steps[0].targetDisplayUnit).toBe(1);
  });

  it("encodes %LTHR correctly", () => {
    const steps = resolveRunSteps([
      {
        type: "training",
        targetType: "time",
        durationSeconds: 300,
        intensityMode: "percent_lthr",
        percentLow: 91,
        percentHigh: 95,
        bpmLow: 157,
        bpmHigh: 164,
      },
    ]);
    expect(steps[0].hrType).toBe(3);
    expect(steps[0].isIntensityPercent).toBe(true);
    expect(steps[0].intensityPercent).toBe(91000);
    expect(steps[0].intensityPercentExtend).toBe(95000);
    expect(steps[0].intensityCustom).toBe(2);
  });

  it("encodes a trainingLoad target", () => {
    const steps = resolveRunSteps([
      { type: "training", targetType: "trainingLoad", trainingLoadPoints: 120 },
    ]);
    expect(steps[0].targetType).toBe(6);
    expect(steps[0].targetValue).toBe(120);
  });

  it("defaults trainingLoad to 100 points when omitted", () => {
    const steps = resolveRunSteps([
      { type: "training", targetType: "trainingLoad" },
    ]);
    expect(steps[0].targetValue).toBe(100);
  });

  it("encodes an hrRecovery target on a rest step", () => {
    const steps = resolveRunSteps([
      { type: "rest", targetType: "hrRecovery", hrRecoveryBpm: 110 },
    ]);
    expect(steps[0].exerciseType).toBe(4); // rest = T1123
    expect(steps[0].targetType).toBe(7);
    expect(steps[0].targetValue).toBe(110);
  });

  it("defaults hrRecovery to 120 bpm when omitted", () => {
    const steps = resolveRunSteps([
      { type: "rest", targetType: "hrRecovery" },
    ]);
    expect(steps[0].targetValue).toBe(120);
  });
});

describe("calculateWorkout", () => {
  const auth: AuthData = {
    accessToken: "tok",
    userId: "user1",
    region: "us",
    timestamp: 0,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the plan* response keys (the live /calculate shape) to the result", async () => {
    // Live API returns planDuration/planSets/planTrainingLoad, NOT
    // duration/totalSets/trainingLoad. Reading the wrong keys yields NaN/undefined
    // in the create_workout output — guard against that regression here.
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        result: "0000",
        data: { planDuration: 504, planSets: 6, planTrainingLoad: 42 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ex = resolveExercises([{ name: "Push-ups", sets: 3, reps: 12 }]);
    const calc = await calculateWorkout(auth, "T", "", ex);

    expect(calc.duration).toBe(504);
    expect(calc.totalSets).toBe(6);
    expect(calc.trainingLoad).toBe(42);
    expect(Number.isNaN(Math.round(calc.duration / 60))).toBe(false);
  });
});

describe("deleteWorkout", () => {
  const auth: AuthData = {
    accessToken: "tok",
    userId: "user1",
    region: "us",
    timestamp: 0,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the id wrapped in a single-element array to /program/delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ result: "0000", message: "OK" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await deleteWorkout(auth, "12345");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://teamapi.coros.com/training/program/delete");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual(["12345"]); // array, not bare id
  });

  it("throws when the API returns a non-0000 result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ result: "1001", message: "Not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteWorkout(auth, "bad-id")).rejects.toThrow("Not found");
  });
});

describe("formatWorkoutSummary", () => {
  it("includes the id, name, and rounded duration", () => {
    const line = formatWorkoutSummary({
      id: "426109589008859136",
      name: "Push Day",
      estimatedTime: 2700, // 45 min
      totalSets: 18,
      exerciseNum: 6,
    });
    expect(line).toContain("**Push Day**");
    expect(line).toContain("[id: 426109589008859136]");
    expect(line).toContain("45 min");
    expect(line).toContain("18 sets");
    expect(line).toContain("6 exercises");
  });

  it("falls back to duration when estimatedTime is absent, and overview onto a new line", () => {
    const line = formatWorkoutSummary({
      id: "7",
      name: "Easy Run",
      duration: 1800, // 30 min
      overview: "Zone 2 base",
    });
    expect(line).toContain("[id: 7]");
    expect(line).toContain("30 min");
    expect(line).toContain("\n  Zone 2 base");
  });

  it("shows zeroes when set/exercise counts are missing", () => {
    const line = formatWorkoutSummary({ id: "1", name: "Empty" });
    expect(line).toContain("0 min");
    expect(line).toContain("0 sets");
    expect(line).toContain("0 exercises");
  });
});
