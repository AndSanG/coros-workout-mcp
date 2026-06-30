import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type {
  AuthData,
  CatalogExercise,
  ExerciseOverrides,
  ExercisePayload,
  RawExercise,
  Region,
  RunGroupInput,
  RunStepInput,
  WorkoutPayload,
} from "./types.js";
import {
  REGION_URLS,
  MuscleCode,
  PartCode,
  EquipmentCode,
} from "./types.js";
import { findByName } from "./exercise-catalog.js";

const CONFIG_DIR = resolve(homedir(), ".config", "coros-workout-mcp");
const AUTH_FILE = resolve(CONFIG_DIR, "auth.json");
const DEFAULT_SOURCE_URL =
  "https://d31oxp44ddzkyk.cloudfront.net/source/source_default/0/2fbd46e17bc54bc5873415c9fa767bdc.jpg";

// --- Auth ---

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

export function storeAuth(auth: AuthData): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
}

export function loadAuth(): AuthData | null {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function login(
  email: string,
  password: string,
  region: Region = "eu"
): Promise<AuthData> {
  const apiUrl = REGION_URLS[region];
  const res = await fetch(`${apiUrl}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: email,
      accountType: 2,
      pwd: md5(password),
    }),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS login failed: ${data.message || data.result}`);
  }

  const auth: AuthData = {
    accessToken: data.data.accessToken,
    userId: data.data.userId,
    region,
    timestamp: Date.now(),
  };
  storeAuth(auth);
  return auth;
}

/** Get valid auth from a direct token, the stored file, or an email/password login. */
export async function getValidAuth(): Promise<AuthData | null> {
  const region = (process.env.COROS_REGION as Region) || "eu";

  // 1. Explicit token override (e.g. extracted from the browser). Does not touch
  //    the stored file and does not log in, so it never invalidates the web session.
  const token = process.env.COROS_TOKEN;
  const userId = process.env.COROS_USERID;
  if (token && userId) {
    return { accessToken: token, userId, region, timestamp: Date.now() };
  }

  // 2. Stored auth file.
  const stored = loadAuth();
  if (stored) return stored;

  // 3. Email/password login (WARNING: invalidates any active web session).
  const email = process.env.COROS_EMAIL;
  const password = process.env.COROS_PASSWORD;
  if (email && password) {
    return login(email, password, region);
  }

  return null;
}

// --- API helpers ---

function apiHeaders(auth: AuthData): Record<string, string> {
  return {
    "Content-Type": "application/json",
    accesstoken: auth.accessToken,
    yfheader: JSON.stringify({ userId: auth.userId }),
  };
}

async function apiPost(auth: AuthData, path: string, body: unknown): Promise<unknown> {
  const apiUrl = REGION_URLS[auth.region];
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: apiHeaders(auth),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

async function apiGet(
  auth: AuthData,
  path: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const apiUrl = REGION_URLS[auth.region];
  const url = new URL(`${apiUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: apiHeaders(auth),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

/** Fetch the full exercise catalog from COROS API */
export async function queryExerciseCatalog(
  auth: AuthData,
  sportType: number = 4
): Promise<RawExercise[]> {
  const result = (await apiGet(auth, "/training/exercise/query", {
    userId: auth.userId,
    sportType,
  })) as { data: RawExercise[] };
  return result.data;
}

/** Fetch i18n strings from the COROS static CDN (no auth needed) */
export async function fetchI18nStrings(): Promise<Record<string, string>> {
  const url = "https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch i18n strings: ${res.status} ${res.statusText}`);
  }
  let text = await res.text();
  // Strip "window.en_US=" prefix and trailing semicolon
  text = text.replace(/^window\.en_US\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(text);
}

/**
 * Transform raw exercises + i18n map into CatalogExercise[].
 * Name resolution order: i18n[codeName] → existingCatalog[codeName].name → codeName
 * The i18n file only covers ~100 of ~383 exercises, so the existing catalog
 * provides names for exercises that predate the i18n system.
 */
export function buildCatalogFromRaw(
  rawExercises: RawExercise[],
  i18n: Record<string, string>,
  existingCatalog: CatalogExercise[] = []
): { catalog: CatalogExercise[]; i18nMisses: string[] } {
  const i18nMisses: string[] = [];
  const catalog: CatalogExercise[] = [];

  // Build lookup from existing catalog by codeName for fallback
  const existingByCode = new Map<string, CatalogExercise>();
  for (const e of existingCatalog) {
    existingByCode.set(e.codeName, e);
  }

  for (const r of rawExercises) {
    // Resolve human-readable name:
    // 1. i18n (code name key, e.g. "T1300" → "Weighted Jump Squats")
    // 2. Existing catalog entry (for older exercises without i18n)
    // 3. Fall back to raw code name
    let humanName = i18n[r.name];
    if (!humanName) {
      const existing = existingByCode.get(r.name);
      if (existing) {
        humanName = existing.name;
      } else {
        humanName = r.name;
        i18nMisses.push(r.name);
      }
    }

    // Resolve description from i18n
    const desc = i18n[r.name + "_desc"] || "";

    // Build text fields from numeric codes
    const muscle = r.muscle || [];
    const muscleRelevance = r.muscleRelevance || [];
    const part = r.part || [];
    const equipment = r.equipment || [];
    const primaryMuscle = muscle[0];
    const secondaryMuscles = muscleRelevance.filter((m) => m !== primaryMuscle);
    const muscleText = primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || String(primaryMuscle)
      : "";
    const secondaryMuscleText = secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || String(m))
      .join(",");
    const partText = part
      .map((p) => (PartCode as Record<number, string>)[p] || String(p))
      .join(",");
    const equipmentText = equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || String(e))
      .join(",");

    catalog.push({
      id: r.id,
      name: humanName.trim(),
      codeName: r.name,
      overview: r.overview,
      animationId: r.animationId,
      muscle,
      muscleRelevance,
      part,
      equipment,
      exerciseType: r.exerciseType,
      targetType: r.targetType,
      targetValue: r.targetValue,
      intensityType: r.intensityType,
      intensityValue: r.intensityValue,
      restType: r.restType,
      restValue: r.restValue,
      sets: r.sets,
      sortNo: r.sortNo,
      sportType: r.sportType,
      status: r.status,
      createTimestamp: r.createTimestamp,
      thumbnailUrl: r.thumbnailUrl || "",
      sourceUrl: r.sourceUrl,
      videoUrl: r.videoUrl,
      coverUrlArrStr: r.coverUrlArrStr,
      videoUrlArrStr: r.videoUrlArrStr,
      videoInfos: r.videoInfos,
      muscleText,
      secondaryMuscleText,
      partText,
      equipmentText,
      desc,
    });
  }

  // Sort alphabetically by name
  catalog.sort((a, b) => a.name.localeCompare(b.name));

  return { catalog, i18nMisses };
}

// --- Payload construction ---

export function buildExercisePayload(
  exercise: CatalogExercise,
  sortNo: number,
  overrides: Partial<ExerciseOverrides> = {}
): ExercisePayload {
  const sets = overrides.sets ?? exercise.sets;
  let targetType = exercise.targetType;
  let targetValue = exercise.targetValue;
  if (overrides.reps !== undefined) {
    targetType = 3;
    targetValue = overrides.reps;
  } else if (overrides.duration !== undefined) {
    targetType = 2;
    targetValue = overrides.duration;
  }

  const restValue = overrides.restSeconds ?? exercise.restValue;

  let intensityType = exercise.intensityType;
  let intensityValue = exercise.intensityValue;
  if (overrides.weightGrams !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightGrams;
  } else if (overrides.weightKg !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightKg * 1000;
  }

  // Build text fields from codes
  const primaryMuscle = exercise.muscle[0];
  const secondaryMuscles = (exercise.muscleRelevance || []).filter(
    (m) => m !== primaryMuscle
  );
  const muscleText =
    exercise.muscleText ||
    (primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || ""
      : "");
  const secondaryMuscleText =
    exercise.secondaryMuscleText ||
    secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || "")
      .filter(Boolean)
      .join(",");
  const partText =
    exercise.partText ||
    exercise.part
      .map((p) => (PartCode as Record<number, string>)[p] || "")
      .filter(Boolean)
      .join(",");
  const equipmentText =
    exercise.equipmentText ||
    exercise.equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || "")
      .filter(Boolean)
      .join(",");

  return {
    access: 0,
    animationId: exercise.animationId ?? 0,
    coverUrlArrStr: exercise.coverUrlArrStr,
    createTimestamp: exercise.createTimestamp,
    defaultOrder: 0,
    equipment: exercise.equipment,
    exerciseType: exercise.exerciseType,
    id: sortNo, // sequential 1-based index used in API
    intensityCustom: 0,
    intensityType,
    intensityValue,
    isDefaultAdd: 0,
    isGroup: false,
    isIntensityPercent: false,
    muscle: exercise.muscle,
    muscleRelevance: exercise.muscleRelevance || [],
    name: exercise.codeName,
    overview: exercise.overview,
    part: exercise.part,
    restType: 1,
    restValue,
    sets,
    sortNo,
    sourceUrl: exercise.sourceUrl,
    sportType: 4,
    status: 1,
    targetType,
    targetValue,
    thumbnailUrl: exercise.thumbnailUrl,
    userId: 0,
    videoInfos: exercise.videoInfos,
    videoUrl: exercise.videoUrl,
    videoUrlArrStr: exercise.videoUrlArrStr,
    nameText: exercise.name,
    desc: exercise.desc,
    descText: exercise.desc,
    partText,
    muscleText,
    secondaryMuscleText,
    equipmentText,
    groupId: "",
    originId: exercise.id,
    targetDisplayUnit: 0,
    hrType: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityDisplayUnit: "6",
  };
}

export function buildWorkoutPayload(
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): WorkoutPayload {
  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    duration: 0,
    essence: 0,
    estimatedType: 0,
    estimatedValue: 0,
    exerciseNum: 0,
    exercises: exercisePayloads,
    headPic: "",
    id: "0",
    idInPlan: "0",
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    planIdIndex: 0,
    poolLength: 2500,
    profile: "",
    referExercise: { intensityType: 1, hrType: 0, valueType: 1 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    sportType: 4,
    star: 0,
    subType: 65535,
    targetType: 0,
    targetValue: 0,
    thirdPartyId: 0,
    totalSets: 0,
    trainingLoad: 0,
    type: 0,
    unit: 0,
    userId: "0",
    version: 0,
    videoCoverUrl: "",
    videoUrl: "",
    fastIntensityTypeName: "weight",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: "425868133463670784",
  };
}

/** Resolve exercise overrides to catalog entries and build payloads */
export function resolveExercises(
  exercises: ExerciseOverrides[]
): ExercisePayload[] {
  return exercises.map((override, index) => {
    const catalog = findByName(override.name);
    if (!catalog) {
      throw new Error(`Exercise not found in catalog: "${override.name}"`);
    }
    return buildExercisePayload(catalog, index + 1, override);
  });
}

// --- Workout API ---

export interface CalculateResult {
  duration: number;
  totalSets: number;
  trainingLoad: number;
}

export async function calculateWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): Promise<CalculateResult> {
  const payload = buildWorkoutPayload(name, overview, exercisePayloads);
  // The /calculate response uses plan*-prefixed keys (planDuration, planSets,
  // planTrainingLoad) for both strength and run — confirmed against the live API.
  const result = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: { planDuration: number; planSets: number; planTrainingLoad: number };
  };
  return {
    duration: result.data.planDuration,
    totalSets: result.data.planSets,
    trainingLoad: result.data.planTrainingLoad,
  };
}

export async function addWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[],
  calculated: CalculateResult
): Promise<unknown> {
  const payload = buildWorkoutPayload(name, overview, exercisePayloads);
  // Apply calculated values
  payload.duration = calculated.duration;
  payload.totalSets = calculated.totalSets;
  payload.distance = "0"; // String in add (number in calculate)
  payload.sets = calculated.totalSets;
  payload.pitch = 0;
  return apiPost(auth, "/training/program/add", payload);
}

// --- Run workout payload construction ---

const RUN_STEP_META = {
  warmup:   { exerciseType: 1, defaultOrder: 1, name: "T1120", overview: "sid_run_warm_up_dist",  originId: "425895398452936705", createTimestamp: 1586584068, isDefaultAdd: 0 },
  training: { exerciseType: 2, defaultOrder: 2, name: "T3001", overview: "sid_run_training",       originId: "426109589008859136", createTimestamp: 1587381919, isDefaultAdd: 1 },
  rest:     { exerciseType: 4, defaultOrder: 3, name: "T1123", overview: "sid_run_cool_down_dist", originId: "425895398452936705", createTimestamp: 1586584214, isDefaultAdd: 0 },
  cooldown: { exerciseType: 3, defaultOrder: 3, name: "T1122", overview: "sid_run_cool_down_dist", originId: "425895456971866112", createTimestamp: 1586584214, isDefaultAdd: 0 },
} as const;

const RUN_SOURCE_URL =
  "https://d31oxp44ddzkyk.cloudfront.net/source/source_default/0/5a9db1c3363348298351aaabfd70d0f5.jpg";
const RUN_SOURCE_ID = "425868113867882496";

function buildRunStepPayload(
  step: RunStepInput,
  id: number,
  groupId: number | ""
): ExercisePayload {
  const meta = RUN_STEP_META[step.type];

  // Target
  let targetType: number | string = 2;
  let targetValue = 300;
  let targetDisplayUnit = 0;
  if (step.targetType === "distance") {
    targetType = 5;
    targetValue = Math.round((step.distanceKm ?? 1) * 100000); // km → cm
    targetDisplayUnit = 1;
  } else if (step.targetType === "open") {
    targetType = 1;
    targetValue = 0;
  } else if (step.targetType === "trainingLoad") {
    targetType = 6;
    targetValue = step.trainingLoadPoints ?? 100;
    targetDisplayUnit = 0;
  } else if (step.targetType === "hrRecovery") {
    targetType = 7;
    targetValue = step.hrRecoveryBpm ?? 120;
    targetDisplayUnit = 0;
  } else {
    targetType = 2;
    targetValue = step.durationSeconds ?? 300;
  }

  // Intensity
  let intensityType = 0;
  let hrType = 0;
  let isIntensityPercent = false;
  let intensityCustom = 0;
  let intensityValue = 0;
  let intensityValueExtend = 0;
  let intensityPercent = 0;
  let intensityPercentExtend = 0;

  const mode = step.intensityMode ?? "none";
  if (mode === "heart_rate") {
    intensityType = 2; hrType = 2; isIntensityPercent = false; intensityCustom = 0;
    intensityValue = step.bpmLow ?? 0;
    intensityValueExtend = step.bpmHigh ?? 0;
  } else if (mode === "percent_max_hr") {
    intensityType = 2; hrType = 1; isIntensityPercent = true; intensityCustom = 2;
    intensityValue = step.bpmLow ?? 0;
    intensityValueExtend = step.bpmHigh ?? 0;
    intensityPercent = Math.round((step.percentLow ?? 0) * 1000);
    intensityPercentExtend = Math.round((step.percentHigh ?? 0) * 1000);
  } else if (mode === "percent_hrr") {
    intensityType = 2; hrType = 2; isIntensityPercent = true; intensityCustom = 2;
    intensityValue = step.bpmLow ?? 0;
    intensityValueExtend = step.bpmHigh ?? 0;
    intensityPercent = Math.round((step.percentLow ?? 0) * 1000);
    intensityPercentExtend = Math.round((step.percentHigh ?? 0) * 1000);
  } else if (mode === "percent_lthr") {
    intensityType = 2; hrType = 3; isIntensityPercent = true; intensityCustom = 2;
    intensityValue = step.bpmLow ?? 0;
    intensityValueExtend = step.bpmHigh ?? 0;
    intensityPercent = Math.round((step.percentLow ?? 0) * 1000);
    intensityPercentExtend = Math.round((step.percentHigh ?? 0) * 1000);
  } else if (mode === "pace") {
    intensityType = 3;
    intensityValue = step.intensityLow ?? 0;
    intensityValueExtend = step.intensityHigh ?? 0;
  } else if (mode === "power") {
    intensityType = 6;
    intensityValue = step.intensityLow ?? 0;
    intensityValueExtend = step.intensityHigh ?? 0;
  } else if (mode === "cadence") {
    intensityType = 7;
    intensityValue = step.intensityLow ?? 0;
    intensityValueExtend = step.intensityHigh ?? 0;
  }

  return {
    access: 0,
    animationId: 0,
    coverUrlArrStr: "",
    createTimestamp: meta.createTimestamp,
    defaultOrder: meta.defaultOrder,
    equipment: [1],
    exerciseType: meta.exerciseType,
    id,
    intensityCustom,
    intensityType,
    intensityValue,
    isDefaultAdd: meta.isDefaultAdd,
    isGroup: false,
    isIntensityPercent,
    muscle: [],
    muscleRelevance: [],
    name: meta.name,
    overview: meta.overview,
    part: [0],
    restType: 3,
    restValue: step.restSeconds ?? 0,
    sets: 1,
    sortNo: id,
    sourceUrl: "",
    sportType: 1,
    status: 0,
    targetType,
    targetValue,
    thumbnailUrl: "",
    userId: 0,
    videoInfos: [],
    videoUrl: "",
    videoUrlArrStr: "",
    nameText: "",
    desc: "",
    descText: "",
    partText: "",
    muscleText: "",
    secondaryMuscleText: "",
    equipmentText: "",
    groupId: groupId === "" ? "" : String(groupId),
    originId: meta.originId,
    targetDisplayUnit,
    hrType,
    intensityValueExtend,
    intensityMultiplier: 0,
    intensityPercent,
    intensityPercentExtend,
    intensityDisplayUnit: "0",
  };
}

function buildGroupStep(id: number, sets: number, restSeconds: number): ExercisePayload {
  return {
    access: 0,
    animationId: 0,
    coverUrlArrStr: "",
    createTimestamp: 0,
    defaultOrder: 0,
    equipment: [],
    exerciseType: 0,
    id,
    intensityCustom: 0,
    intensityType: 0,
    intensityValue: 0,
    isDefaultAdd: 0,
    isGroup: true,
    isIntensityPercent: false,
    muscle: [],
    muscleRelevance: [],
    name: "",
    overview: "",
    part: [],
    restType: 0,
    restValue: restSeconds,
    sets,
    sortNo: id,
    sourceUrl: "",
    sportType: 0,
    status: 0,
    targetType: "",
    targetValue: 0,
    thumbnailUrl: "",
    userId: 0,
    videoInfos: [],
    videoUrl: "",
    videoUrlArrStr: "",
    nameText: "",
    desc: "",
    descText: "",
    partText: "",
    muscleText: "",
    secondaryMuscleText: "",
    equipmentText: "",
    groupId: "",
    originId: "",
    targetDisplayUnit: 0,
    hrType: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityDisplayUnit: "0",
  };
}

export function resolveRunSteps(
  items: Array<RunStepInput | RunGroupInput>
): ExercisePayload[] {
  const payloads: ExercisePayload[] = [];
  let nextId = 1;

  for (const item of items) {
    if ("repeat" in item) {
      const groupId = nextId;
      payloads.push(buildGroupStep(groupId, item.repeat, item.restSeconds ?? 30));
      nextId++;
      for (const child of item.steps) {
        payloads.push(buildRunStepPayload(child, nextId, groupId));
        nextId++;
      }
    } else {
      payloads.push(buildRunStepPayload(item, nextId, ""));
      nextId++;
    }
  }

  return payloads;
}

export function buildRunWorkoutPayload(
  name: string,
  overview: string,
  steps: ExercisePayload[]
): WorkoutPayload {
  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    duration: 0,
    essence: 0,
    estimatedType: 0,
    estimatedValue: 0,
    exerciseNum: 0,
    exercises: steps,
    headPic: "",
    id: "0",
    idInPlan: "0",
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    planIdIndex: 0,
    poolLength: 2500,
    profile: "",
    referExercise: { intensityType: 0, hrType: 0, valueType: 0 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: RUN_SOURCE_URL,
    sportType: 1,
    star: 0,
    subType: 65535,
    targetType: 0,
    targetValue: 0,
    thirdPartyId: 0,
    totalSets: 0,
    trainingLoad: 0,
    type: 0,
    unit: 0,
    userId: "0",
    version: 0,
    videoCoverUrl: "",
    videoUrl: "",
    fastIntensityTypeName: "custom",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: RUN_SOURCE_ID,
  };
}

export interface RunCalculateResult {
  duration: number;
  totalSets: number;
  trainingLoad: number;
  distance: string;
  exerciseBarChart: unknown[];
}

export async function calculateRunWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  steps: ExercisePayload[]
): Promise<RunCalculateResult> {
  const payload = buildRunWorkoutPayload(name, overview, steps);
  const result = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: {
      planDuration: number;
      planSets: number;
      planTrainingLoad: number;
      planDistance: string;
      exerciseBarChart: unknown[];
    };
  };
  return {
    duration: result.data.planDuration,
    totalSets: result.data.planSets,
    trainingLoad: result.data.planTrainingLoad,
    distance: result.data.planDistance ?? "0",
    exerciseBarChart: result.data.exerciseBarChart ?? [],
  };
}

export async function addRunWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  steps: ExercisePayload[],
  calculated: RunCalculateResult
): Promise<unknown> {
  const payload = buildRunWorkoutPayload(name, overview, steps);
  payload.duration = calculated.duration;
  payload.totalSets = calculated.totalSets;
  payload.trainingLoad = calculated.trainingLoad;
  payload.distance = calculated.distance;
  payload.sets = calculated.totalSets;
  payload.pitch = 0;
  payload.exerciseBarChart = calculated.exerciseBarChart;
  return apiPost(auth, "/training/program/add", payload);
}

export interface QueryOptions {
  name?: string;
  sportType?: number;
  startNo?: number;
  limitSize?: number;
}

export async function queryWorkouts(
  auth: AuthData,
  options: QueryOptions = {}
): Promise<unknown> {
  const body = {
    name: options.name || "",
    supportRestExercise: 1,
    startNo: options.startNo ?? 0,
    limitSize: options.limitSize ?? 10,
    sportType: options.sportType ?? 0,
  };
  return apiPost(auth, "/training/program/query", body);
}

export async function deleteWorkout(auth: AuthData, id: string): Promise<void> {
  // Endpoint expects an array of program ids, even for a single delete.
  await apiPost(auth, "/training/program/delete", [id]);
}

export interface WorkoutSummary {
  id: string;
  name: string;
  overview?: string;
  duration?: number;
  estimatedTime?: number;
  totalSets?: number;
  exerciseNum?: number;
}

/** Format a single workout for the `list_workouts` tool output. */
export function formatWorkoutSummary(w: WorkoutSummary): string {
  const durationMin = Math.round((w.estimatedTime || w.duration || 0) / 60);
  return `- **${w.name}** \`[id: ${w.id}]\` (${durationMin} min, ${w.totalSets || 0} sets, ${w.exerciseNum || 0} exercises)${w.overview ? `\n  ${w.overview}` : ""}`;
}
