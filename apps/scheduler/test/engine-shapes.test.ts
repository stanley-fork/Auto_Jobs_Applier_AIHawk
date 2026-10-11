/**
 * The engine's answer to `GET /tools` and the data of every event it writes, against the host's description of them. The engine's own
 * test (`invisible_engine_dots/tests/dots/test_wire_shapes.py`) writes what it really answers, and one event of each
 * type and each set of keys its own writers produce, into `wire_shapes.json`; here that file is parsed with the
 * schemas of `packages/shared` and the host's fake guest is held to the same answers, so neither side can move a key,
 * or a rule of what the model is offered, without a suite failing. The host's schemas strip a key they do not know
 * and the host drops an event they refuse, so an event must come out of its parse exactly as it went in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_RUN_AT_MS,
  mcpServerStatusSchema,
  OUTBOUND_EVENT_TYPES,
  parseDotConfig,
  parseOutboundEvent,
  PERMISSIONS,
  skillSchema,
  toolInfoSchema,
  toRuntimeConfig,
  type DotRuntimeConfig,
} from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { FakeGuest, type FakeAutomation } from "../src/testing.js";

interface OfferingCase {
  permissions: Record<string, string>;
  offered: string[];
  tools: unknown[];
}

const shapes = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../invisible_engine_dots/tests/dots/wire_shapes.json", import.meta.url)), "utf8"),
) as {
  limits: { max_run_at_ms: number };
  outbound_events: { type: string; data: Record<string, unknown> }[];
  tool_offering: OfferingCase[];
  mcp: { tools: unknown[]; mcp_servers: unknown[] };
  skills: unknown[];
};

const baseConfig = toRuntimeConfig(parseDotConfig("name: shapes\nmodel:\n  provider: openrouter\n  id: test/model\n"));

function configFor(offering: OfferingCase): DotRuntimeConfig {
  return {
    ...baseConfig,
    permissions: offering.permissions as DotRuntimeConfig["permissions"],
  };
}

describe("what the engine answers, as the host describes it", () => {
  it("the last time the engine lets an automation run is the last time the host's schemas accept", () => {
    expect(shapes.limits.max_run_at_ms).toBe(MAX_RUN_AT_MS);
    const nextRun = (next_run_at_ms: number) => ({ seq: 1, id: "evt_x", type: "automation.next_run", ts: "2026-10-06T09:00:00.000Z", data: { next_run_at_ms } });
    expect(parseOutboundEvent(nextRun(MAX_RUN_AT_MS)).data).toEqual({ next_run_at_ms: MAX_RUN_AT_MS });
    expect(() => parseOutboundEvent(nextRun(MAX_RUN_AT_MS + 1))).toThrow();
    expect(new Date(MAX_RUN_AT_MS).toISOString()).toBe("9999-12-31T23:59:59.999Z");
  });

  it("every outbound event the engine writes comes out of the host's parse as it went in: none is refused and no key is stripped", () => {
    for (const [index, { type, data }] of shapes.outbound_events.entries()) {
      const event = { seq: index + 1, id: `evt_${index}`, type, ts: "2026-10-06T09:00:00.000Z", data };
      expect(parseOutboundEvent(event).data, JSON.stringify(event)).toEqual(data);
    }
    // One of every type the contract names, so a type the engine writes and the host does not know (or the reverse) is seen.
    expect([...new Set(shapes.outbound_events.map((event) => event.type))].sort()).toEqual([...OUTBOUND_EVENT_TYPES].sort());
  });

  it("a key the schema does not know is stripped by the parse, which the check above sees, and a key it needs and the engine lacks is refused", () => {
    const called = shapes.outbound_events.find((event) => event.type === "tool.called")!;
    const around = (event: { type: string; data: Record<string, unknown> }, data: Record<string, unknown>) => ({ seq: 1, id: "evt_x", type: event.type, ts: "2026-10-06T09:00:00.000Z", data });
    expect(parseOutboundEvent(around(called, { ...called.data, renamed_by_the_engine: true })).data).not.toEqual({ ...called.data, renamed_by_the_engine: true });
    const { tool: _tool, ...withoutTool } = called.data;
    expect(() => parseOutboundEvent(around(called, withoutTool))).toThrow();
  });

  it("the optional keys of the events are all written by the engine: a terminal, an interrupted call, a task's calls, an approval with and without a task, a reply to a message, the spend", () => {
    const keys = (type: string) => shapes.outbound_events.filter((event) => event.type === type).map((event) => Object.keys(event.data).sort().join());
    expect(keys("tool.called")).toEqual(expect.arrayContaining(["decision,duration_ms,ok,permission,target,tool,tty", "decision,duration_ms,interrupted,ok,permission,target,task_id,tool"]));
    expect(keys("approval.requested")).toEqual(expect.arrayContaining(["approval_id,arguments,permission,reason,task_id,tool", "approval_id,arguments,permission,reason,tool"]));
    expect(keys("message.assistant")).toEqual(["in_reply_to,spent_usd,text"]);
    expect(keys("task.progress")).toEqual(["spent_usd,task_id,text"]);
    expect(keys("task.failed")).toEqual(["error,spent_usd,task_id"]);
    expect(keys("task.completed")).toEqual(["spent_usd,summary,task_id"]);
  });

  it("the host's fake guest writes the automation events as the engine does", async () => {
    const written = shapes.outbound_events.filter((event) => event.type === "automation.next_run");
    expect(written.map((event) => event.data.next_run_at_ms)).toEqual([1_790_000_000_000, null]);
    const guest = new FakeGuest("token-for-shapes");
    guest.running = true;
    const row: FakeAutomation = {
      id: "job_every",
      name: "check the shop",
      enabled: true,
      schedule: { kind: "every", every_ms: 3_600_000 },
      message: "look at the orders",
      next_run_at_ms: 1_790_000_000_000,
      last_run_at_ms: null,
      last_status: null,
      last_error: null,
      delete_after_run: false,
      created_at_ms: 1_789_990_000_000,
    };
    guest.putAutomation(row);
    expect(guest.outbox.map((event) => ({ type: event.type, data: event.data }))).toEqual([written[0]]);
    guest.removeAutomation(row.id);
    expect(guest.outbox.map((event) => ({ type: event.type, data: event.data }))).toEqual(written);
  });

  it("every skill the engine shows parses with the skill schema, and a key it lacks or has extra is refused", () => {
    expect(shapes.skills.map((row) => (row as { name: string }).name)).toContain("invisible-playwright");
    for (const row of shapes.skills) expect(skillSchema.safeParse(row).error?.issues, JSON.stringify(row)).toBeUndefined();
    const first = shapes.skills[0] as Record<string, unknown>;
    const { content: _content, ...missing } = first;
    expect(skillSchema.safeParse(missing).success).toBe(false);
    expect(skillSchema.safeParse({ ...first, renamed_key: 1 }).success).toBe(false);
  });

  it("every tool row the engine shows parses with the tool schema, in the order of its table, under a permission the host knows", () => {
    for (const offering of shapes.tool_offering) {
      for (const row of offering.tools) expect(toolInfoSchema.safeParse(row).error?.issues, JSON.stringify(row)).toBeUndefined();
      const names = (offering.tools as { name: string }[]).map((row) => row.name);
      expect(names).toEqual((shapes.tool_offering[0]!.tools as { name: string }[]).map((row) => row.name));
      expect((offering.tools as { permission: string }[]).every((row) => PERMISSIONS.includes(row.permission as never))).toBe(true);
    }
  });

  it("what the engine says of the MCP servers a config declares parses with the host's schemas: their tools under `mcp.<server>`, their states", () => {
    expect(shapes.mcp.tools.length).toBeGreaterThan(0);
    for (const row of shapes.mcp.tools) expect(toolInfoSchema.safeParse(row).error?.issues, JSON.stringify(row)).toBeUndefined();
    expect(new Set((shapes.mcp.tools as { permission: string }[]).map((row) => row.permission))).toEqual(new Set(["mcp.tools"]));
    for (const status of shapes.mcp.mcp_servers) expect(mcpServerStatusSchema.safeParse(status).error?.issues, JSON.stringify(status)).toBeUndefined();
    expect((shapes.mcp.mcp_servers as { name: string; state: string }[]).map((status) => [status.name, status.state])).toEqual([["keyed", "failed"], ["tools", "connected"]]);
    expect(toolInfoSchema.safeParse({ ...(shapes.mcp.tools[0] as object), permission: "mcp.Not_A_Server" }).success).toBe(false);
  });

  it("the fake guest holds the engine's tools to the same permissions, and offers what the engine offers for the same config", async () => {
    const engineRows = new Map((shapes.tool_offering[0]!.tools as { name: string; permission: string }[]).map((row) => [row.name, row.permission]));
    for (const offering of shapes.tool_offering) {
      const guest = new FakeGuest("token-for-shapes");
      guest.running = true;
      guest.config = configFor(offering);
      const { tools } = await guest.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(engineRows.get(tool.name), `the engine has no tool ${tool.name}`).toBe(tool.permission);
        expect(tool.offered, `${tool.name} with ${JSON.stringify(offering.permissions)}`).toBe(offering.offered.includes(tool.name));
      }
    }
  });
});
