import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

/**
 * TRUE end-to-end test of the MCP server over its real STDIO transport.
 *
 * Unlike coros-api.integration.ts (which calls the coros-api functions directly), this
 * spawns the compiled server (`dist/src/index.js`) as a child process and drives it via
 * JSON-RPC exactly as a real MCP client (Claude) would. It therefore exercises the tool
 * registrations and arg parsing in src/index.ts, the STDIO transport, AND the live API.
 *
 * Auth is injected into the child via COROS_TOKEN/COROS_USERID env vars (getValidAuth's
 * explicit-token path) — no auth.json is touched, no login happens, the web session stays
 * valid. Build first (`npm run build`), then run on demand:
 *   COROS_TOKEN=<accesstoken> COROS_USERID=<userId> COROS_REGION=us npm run test:integration
 *
 * Skips cleanly when credentials are absent. Creates a clearly-labeled throwaway workout
 * and deletes it, with an afterAll safety net.
 */

const token = process.env.COROS_TOKEN;
const userId = process.env.COROS_USERID;
const region = process.env.COROS_REGION ?? "us";
const hasCreds = Boolean(token && userId);

const SERVER_ENTRY = resolve(__dirname, "..", "..", "dist", "src", "index.js");
const TEST_NAME = `MCP STDIO E2E — delete me ${Date.now()}`;

/** Flatten an MCP tool result's content array to a single string. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

describe.skipIf(!hasCreds)("MCP server over STDIO (live, end-to-end)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let createdId: string | undefined;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [SERVER_ENTRY],
      env: {
        ...process.env,
        COROS_TOKEN: token!,
        COROS_USERID: userId!,
        COROS_REGION: region,
      },
    });
    client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    // Safety net: remove the test workout if a step failed before the delete.
    if (createdId && client) {
      try {
        await client.callTool({ name: "delete_workout", arguments: { id: createdId } });
      } catch {
        /* already gone */
      }
    }
    await client?.close();
  });

  it("registers the expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "authenticate_coros",
      "check_coros_auth",
      "search_exercises",
      "create_workout",
      "create_run_workout",
      "update_exercises",
      "list_workouts",
      "delete_workout",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("reports authenticated via the injected browser token", async () => {
    const res = await client.callTool({ name: "check_coros_auth", arguments: {} });
    const text = textOf(res);
    expect(text).toContain("Authenticated");
    expect(text).toContain(userId!);
  });

  it("create_workout returns real metrics (no NaN/undefined) through the tool layer", async () => {
    const res = await client.callTool({
      name: "create_workout",
      arguments: {
        name: TEST_NAME,
        overview: "stdio e2e",
        exercises: [
          { name: "Push-ups", sets: 3, reps: 12 },
          { name: "Squats", sets: 3, reps: 15 },
        ],
      },
    });
    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("created successfully");
    // Regression guard for the plan*-key bug, now verified end-to-end through the tool output.
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  it("list_workouts surfaces the new workout with its id, which delete_workout removes", async () => {
    // Find the created workout's id from the formatted list output.
    const listRes = await client.callTool({
      name: "list_workouts",
      arguments: { sportType: 4, limit: 30 },
    });
    const listText = textOf(listRes);
    const escaped = TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\*\\*${escaped}\\*\\*\\s*\`\\[id: (\\d+)\\]\``).exec(listText);
    expect(match, `created workout not found in list output:\n${listText}`).not.toBeNull();
    createdId = match![1];

    // Delete it through the tool.
    const delRes = await client.callTool({
      name: "delete_workout",
      arguments: { id: createdId },
    });
    expect(delRes.isError).toBeFalsy();
    expect(textOf(delRes)).toContain("Deleted");

    // Verify it is gone.
    const afterRes = await client.callTool({
      name: "list_workouts",
      arguments: { sportType: 4, limit: 30 },
    });
    expect(textOf(afterRes)).not.toContain(TEST_NAME);
    createdId = undefined; // cleaned up
  });
});
