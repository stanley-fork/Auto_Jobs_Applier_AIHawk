/**
 * What the host sends the engine: the events (`POST /events`) and the Dot's config (`PUT /config`), pinned in a file
 * the engine checks. They are not written by hand here: a real scheduler runs a Dot against the fake guest, and what
 * its own writers send is what the guest received. The engine is Python and parses them with its own parsers
 * (`invisible_engine_dots/tests/dots/test_host_wire_shapes.py`), so neither side can move a key, or a rule of what is
 * accepted, without a suite failing. The other direction, what the engine writes, is `engine-shapes.test.ts`.
 *
 * A key renamed or added here fails this test until the file is written again
 * (`UPDATE_HOST_WIRE_SHAPES=1 npx vitest run apps/scheduler/test/host-shapes.test.ts`), and then fails the engine's
 * test until its parser says the same.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@invisible-dots/database/testing";
import { INBOUND_EVENT_TYPES } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scheduler } from "../src/index.js";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "../src/testing.js";

const FIXTURE = fileURLToPath(new URL("../../../invisible_engine_dots/tests/dots/host_wire_shapes.json", import.meta.url));

const MINIMAL = "name: shapes-min\nmodel:\n  provider: openrouter\n  id: test/model\n";
const FULL = `name: shapes-full
instructions: Answer in one line.
model:
  provider: openrouter
  id: test/model
models:
  summary: test/small
computer:
  cpu: 4
  memory: 6G
  disk: 30G
  idle_timeout: 5m
permissions:
  computer.exec: deny
  files.write: ask
  mcp.time: allow
mcp_servers:
  time:
    command: uvx
    args: [mcp-server-time, --local-timezone, Europe/Rome]
    env:
      LOG_LEVEL: warning
    secrets: [TIME_TOKEN]
  search:
    url: https://search.example/mcp
    headers:
      X-Client: dots
    secrets: [Authorization]
    timeout_s: 30
limits:
  max_steps_per_task: 30
  max_cost_per_task_usd: 2.5
`;

describe("what the host sends the engine", () => {
  let t: TestDatabase;
  let scheduler: Scheduler;
  let written: Awaited<ReturnType<typeof shapes>>;
  const driver = new FakeDriver();

  beforeAll(async () => {
    t = await createTestDatabase("pglite");
    await t.db.secrets.put("global", "openrouter_api_key", "sk-or-test");
    scheduler = new Scheduler({
      db: t.db,
      driver,
      clock: new ManualClock(),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
    });
    written = await shapes();
  });

  afterAll(async () => {
    await scheduler?.close();
    await t?.drop();
  });

  async function readyDot(yaml: string, name: string) {
    const dot = await scheduler.createDot(yaml);
    await waitUntilSettledReady(scheduler, driver, dot.id, name);
    return dot;
  }

  async function shapes() {
    const configs = [];
    for (const [name, yaml] of [["shapes-min", MINIMAL], ["shapes-full", FULL]] as const) {
      const dot = await readyDot(yaml, name);
      configs.push({ name, config: structuredClone(driver.guestOf(dot.id).config) });
    }
    // The secrets of the full config's servers, set as the person sets them: the push carries them with the key.
    const full = await scheduler.requireDot("shapes-full");
    await scheduler.setMcpSecret(full.id, "time", "TIME_TOKEN", "tt-1");
    await scheduler.setMcpSecret(full.id, "search", "Authorization", "Bearer sk-search-1");
    const fullGuest = driver.guestOf(full.id);
    const secrets_requests = [{ openrouter_api_key: fullGuest.openrouterKey, mcp_secrets: structuredClone(fullGuest.mcpSecrets) }];

    const dot = await readyDot("name: shapes-talk\nmodel:\n  provider: openrouter\n  id: test/model\n", "shapes-talk");
    const guest = driver.guestOf(dot.id);
    // A quiet guest: it takes a task up and says nothing else, so nothing but what the host sends is in `inbound`.
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") g.emit("task.started", { task_id: event.data.task_id });
    };
    await scheduler.sendMessage(dot.id, "what is the cheapest fare to Lisbon?");
    const task = await scheduler.createTask(dot.id, { description: "compare the fares", priority: 5 });
    await waitFor(async () => (await scheduler.getTask(task.id)).status === "RUNNING", "the task running");
    const plain = await scheduler.createTask(dot.id, { description: "a task with the default priority" });
    await scheduler.cancelTask(task.id);
    await waitFor(() => guest.inbound.some((event) => event.type === "system.event"), "the cancel reaching the guest");
    const approved = guest.requestApproval(undefined);
    const rejected = guest.requestApproval(undefined);
    await waitFor(async () => (await scheduler.listApprovals("pending")).filter((a) => a.dot_id === dot.id).length === 2, "two pending approvals");
    await scheduler.resolveApproval(approved, "approve", { note: "go on" });
    await scheduler.resolveApproval(rejected, "reject");
    await waitFor(() => guest.inbound.filter((event) => event.type === "approval.received").length === 2, "both answers reaching the guest");
    expect(plain.priority).toBe(0);

    // The id and the time of an event are the host's own and vary: the engine's parser takes any, and the file is about
    // the data. The ids of tasks and approvals, drawn at random, are named in the order they appear.
    const named = new Map([[task.id, "task-1"], [plain.id, "task-2"], [approved, "approval-1"], [rejected, "approval-2"]]);
    const inbound_events = (JSON.parse(
      [...named].reduce((text, [id, name]) => text.replaceAll(id, name), JSON.stringify(guest.inbound.map((event) => ({ type: event.type, data: event.data })))),
    ) as { type: string; data: Record<string, unknown> }[]);
    return { runtime_configs: configs, secrets_requests, inbound_events };
  }

  it("writes what the host's own writers sent, as the file the engine's parsers check", async () => {
    const text = `${JSON.stringify(written, null, 2)}\n`;
    if (process.env.UPDATE_HOST_WIRE_SHAPES === "1") writeFileSync(FIXTURE, text);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(text));
  });

  it("holds one event of each type the host sends, the optional note of an answer with and without it, and a config with every section set", async () => {
    expect([...new Set(written.inbound_events.map((event) => event.type))].sort()).toEqual([...INBOUND_EVENT_TYPES].sort());
    const answers = written.inbound_events.filter((event) => event.type === "approval.received").map((event) => Object.keys(event.data).sort().join());
    expect(answers).toEqual(["approval_id,decision,note", "approval_id,decision"]);
    const priorities = written.inbound_events.filter((event) => event.type === "task.created").map((event) => event.data.priority);
    expect(priorities).toEqual([5, 0]);
    const [minimal, full] = written.runtime_configs.map((entry) => entry.config as Record<string, unknown>);
    expect(Object.keys(full!).sort()).toEqual(["instructions", "limits", "mcp_servers", "model", "models", "name", "permissions"]);
    expect(Object.keys(full!.mcp_servers as object).sort()).toEqual(["search", "time"]);
    expect(written.secrets_requests[0]!.mcp_secrets).toEqual({ time: { TIME_TOKEN: "tt-1" }, search: { Authorization: "Bearer sk-search-1" } });
    expect(Object.keys(minimal!)).not.toContain("instructions");
    expect(minimal).not.toHaveProperty("computer");
  });
});
