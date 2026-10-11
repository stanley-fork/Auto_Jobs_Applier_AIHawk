import type { AddressInfo } from "node:net";
import { ChannelHub } from "@invisible-dots/channels";
import { FakeChannelType } from "@invisible-dots/channels/testing";
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { Scheduler } from "@invisible-dots/scheduler";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { ApiError, InvisibleDotsClient } from "@invisible-dots/sdk";
import { MAX_EVENT_PAGE, OPENROUTER_KEY_RULE, type DoctorCheck, type StoredEvent } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_VERSION, buildServer, type FastifyInstance } from "../src/index.js";
import { hostFacts } from "./host-facts.js";

const TOKEN = "test-token-0123456789abcdef";

/** What the host report answers on this fake host: one row that is not ok, with the command that fixes it. */
const REPORT: DoctorCheck[] = [
  { id: "node", label: "Node", status: "ok", detail: "24.19.0" },
  { id: "qemu", label: "QEMU", status: "missing", detail: "qemu-system-x86_64 not found", fix: "invisible-dots setup" },
];

const yaml = (name: string, idle = "15m") =>
  `name: ${name}\nmodel:\n  provider: openrouter\n  id: test/model\ncomputer:\n  idle_timeout: ${idle}\n`;

describe.each(testAdapters())("control-plane API (%s)", (kind) => {
  let t: TestDatabase;
  let db: Database;
  let app: FastifyInstance;
  let scheduler: Scheduler;
  let channels: ChannelHub;
  let driver: FakeDriver;
  let clock: ManualClock;
  let base: string;
  let api: InvisibleDotsClient;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    // A Dot reaches READY only with a key to push (lifecycle #push): every test that readies one needs it, so it is
    // stored here and not by whichever test happened to run first.
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
    driver = new FakeDriver();
    clock = new ManualClock();
    scheduler = new Scheduler({
      db,
      driver,
      clock,
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10 },
      dispatcher: { retryDelayMs: 0 },
    });
    channels = new ChannelHub({ db, host: scheduler, types: [new FakeChannelType()] });
    app = buildServer({ scheduler, channels, doctor: async () => REPORT, host: hostFacts(kind), token: TOKEN, heartbeatMs: 50 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    api = new InvisibleDotsClient({ baseUrl: base, token: TOKEN });
  });

  afterAll(async () => {
    await app?.close();
    await channels?.close();
    await scheduler?.close();
    await t?.drop();
  });

  async function readyDot(name: string, idle?: string) {
    const dot = await api.createDot(yaml(name, idle));
    await waitUntilSettledReady(scheduler, driver, dot.id, name);
    return dot;
  }

  it("refuses requests without the right bearer token with 401 JSON", async () => {
    const none = await fetch(`${base}/api/dots`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthorized" });
    const wrong = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    const stream = await fetch(`${base}/api/stream`, { headers: { authorization: "Basic abc" } });
    expect(stream.status).toBe(401);
    await expect(new InvisibleDotsClient({ baseUrl: base, token: "wrong-token-xxxxxxxx" }).health()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("doctor: the host report with its verdict, only with the token", async () => {
    expect((await fetch(`${base}/api/doctor`)).status).toBe(401);
    expect(await api.doctor()).toEqual({ ok: false, checks: REPORT });
  });

  it("health, unknown routes and malformed bodies answer {error, message}", async () => {
    expect(await api.health()).toEqual({ status: "ok", database: "ok", version: API_VERSION, openrouter_configured: true, ...hostFacts(kind) });
    const missing = await fetch(`${base}/api/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    const broken = await fetch(`${base}/api/dots`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: "invalid_request" });
  });

  it("usage: the spend the guest reported, since a moment, from the event log", async () => {
    const dot = await readyDot("usage-one");
    const other = await readyDot("usage-two");
    expect(await api.usage(dot.id)).toEqual({ dot_id: dot.id, since: null, spent_usd: 0 });
    const guest = driver.guestOf(dot.id);
    guest.onInbound = () => {};
    const task = await api.createTask(dot.id, { description: "costly" });
    await waitFor(async () => (await db.tasks.runs(task.id))[0]?.delivered_at, "delivered");
    guest.emit("task.progress", { task_id: task.id, text: "step", spent_usd: 0.25 });
    guest.emit("task.completed", { task_id: task.id, summary: "done", spent_usd: 0.5 });
    guest.emit("message.assistant", { text: "hello", spent_usd: 0.125 });
    driver.guestOf(other.id).emit("message.assistant", { text: "not mine", spent_usd: 9 });
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "completed");
    await waitFor(async () => (await api.usage(dot.id)).spent_usd === 0.625, "chat answer stored");
    expect(await api.usage(dot.name)).toEqual({ dot_id: dot.id, since: null, spent_usd: 0.625 });
    expect((await api.getTask(task.id)).spent_usd).toBe(0.5);
    expect((await api.listTasks(dot.id))[0]?.spent_usd).toBe(0.5);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await api.usage(dot.id, { since: future })).toEqual({ dot_id: dot.id, since: future, spent_usd: 0 });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect((await api.usage(dot.id, { since: past })).spent_usd).toBe(0.625);
  });

  it("usage: a bad since is 400, an unknown Dot 404, and a deleted Dot's history stays readable by id", async () => {
    const dot = await readyDot("usage-three");
    await expect(api.usage(dot.id, { since: "yesterday" })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(api.usage(dot.id, { since: "2026-13-45T00:00:00Z" })).rejects.toMatchObject({ status: 400 });
    await expect(api.usage("no-such-dot")).rejects.toMatchObject({ status: 404 });
    driver.guestOf(dot.id).emit("message.assistant", { text: "paid", spent_usd: 0.5 });
    await waitFor(async () => (await api.usage(dot.id)).spent_usd === 0.5, "spend stored");
    await api.deleteDot(dot.id);
    await waitFor(async () => (await db.dots.get(dot.id)) === null, "deleted");
    expect(await api.usage(dot.id)).toEqual({ dot_id: dot.id, since: null, spent_usd: 0.5 });
  });

  it("create validates the config: 400 with the issues, 409 for a taken name", async () => {
    const invalid = await api.createDot({ name: "Bad Name", model: { provider: "openrouter", id: "m" } }).catch((e) => e);
    expect(invalid).toBeInstanceOf(ApiError);
    expect(invalid).toMatchObject({ status: 400, code: "invalid_config" });
    expect((invalid as ApiError).details).toEqual([expect.objectContaining({ path: "name" })]);
    await readyDot("taken-name");
    await expect(api.createDot(yaml("taken-name"))).rejects.toMatchObject({ status: 409, code: "name_taken" });
  });

  it("create -> READY -> task -> guest events -> COMPLETED, visible in tasks, events and the stream", async () => {
    const controller = new AbortController();
    const seen: StoredEvent[] = [];
    const streaming = (async () => {
      for await (const event of api.stream({ signal: controller.signal })) {
        seen.push(event);
        if (event.type === "task.completed") break;
      }
    })();

    const dot = await readyDot("flow-dot");
    expect((await api.listDots()).map((d) => d.name)).toContain("flow-dot");
    expect(await api.getDot("flow-dot")).toMatchObject({ id: dot.id, computer_state: "RUNNING" });
    const computer = await api.computer(dot.id);
    expect(computer).toMatchObject({ state: "RUNNING", ready: true });

    const task = await api.createTask("flow-dot", { description: "find the cheapest day", priority: 1 });
    expect(task.status).toBe("PENDING");
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "task COMPLETED");
    expect((await api.listTasks(dot.id)).map((x) => x.id)).toContain(task.id);
    await streaming;
    controller.abort();
    expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(["dot.created", "computer.started", "task.created", "task.completed"]));

    const events = await api.events(dot.id);
    expect(events.find((e) => e.type === "task.completed")?.data).toMatchObject({ task_id: task.id });
    const after = events[1]!.id;
    expect((await api.events(dot.id, { after, limit: 2 })).map((e) => e.id)).toEqual(events.slice(2, 4).map((e) => e.id));
    await expect(api.events(dot.id, { limit: MAX_EVENT_PAGE + 1 })).rejects.toMatchObject({ status: 400 });
    await expect(api.cancelTask(task.id)).rejects.toMatchObject({ status: 409, code: "task_finished" });
  });

  it("events: filtered by type names and by task, together and with after and limit", async () => {
    const dot = await readyDot("event-filters");
    const guest = driver.guestOf(dot.id);
    const one = await api.createTask(dot.id, { description: "one" });
    const two = await api.createTask(dot.id, { description: "two" });
    // Two whole tasks, one after the other: 0.6 s on PGlite, 2.2 s on a PostgreSQL reached across WSL, past the
    // default 5 s when that machine is loaded. The wait bounds liveness only.
    await waitFor(async () => (await api.getTask(two.id)).status === "COMPLETED", "second task done", 15_000);
    const call = { tool: "exec", permission: "exec.run", decision: "allow", ok: true, duration_ms: 5 } as const;
    guest.emit("tool.called", { task_id: one.id, ...call, target: "ls" });
    guest.emit("tool.called", { ...call, target: "date" });
    guest.emit("browser.identity.created", { identity_id: "bi_shop", name: "shop" });
    await waitFor(async () => (await api.events(dot.id, { types: ["browser.identity.created"] })).length === 1, "events stored");

    const types = (events: StoredEvent[]) => events.map((e) => e.type);
    expect(types(await api.events(dot.id, { types: ["tool.called"] }))).toEqual(["tool.called", "tool.called"]);
    expect(types(await api.events(dot.id, { types: ["tool.called", "browser.identity.created"] }))).toEqual(["tool.called", "tool.called", "browser.identity.created"]);
    // A task's events: the host's own and the guest's, in id order; the chat's tool call belongs to no task.
    const ofOne = await api.events(dot.id, { taskId: one.id });
    expect(types(ofOne)).toEqual(expect.arrayContaining(["task.created", "task.started", "task.completed", "tool.called"]));
    expect(ofOne.every((e) => e.data.task_id === one.id)).toBe(true);
    expect(ofOne.map((e) => e.id)).toEqual([...ofOne.map((e) => e.id)].sort((a, b) => a - b));
    expect(ofOne.filter((e) => e.type === "tool.called").map((e) => e.data.target)).toEqual(["ls"]);
    expect((await api.events(dot.id, { taskId: two.id, types: ["tool.called"] })).length).toBe(0);
    expect(types(await api.events(dot.id, { taskId: one.id, types: ["tool.called"] }))).toEqual(["tool.called"]);
    expect((await api.events(dot.id, { taskId: one.id, limit: 1 })).length).toBe(1);
    expect((await api.events(dot.id, { taskId: one.id, after: ofOne.at(-1)!.id })).length).toBe(0);
    expect(await api.events(dot.id, { taskId: "task_nobody" })).toEqual([]);

    // The raw query: an empty types is no filter, a type nobody emits is refused, so is a repeated or empty parameter.
    const get = async (query: string) => {
      const response = await fetch(`${base}/api/dots/${dot.id}/events?${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return { status: response.status, body: (await response.json()) as { events?: StoredEvent[]; error?: string; message?: string } };
    };
    expect((await get("types=")).body.events!.length).toBeGreaterThan(5);
    expect(await get("types=tool.called,tool.calls")).toMatchObject({ status: 400, body: { error: "invalid_request", message: "unknown event type: tool.calls" } });
    expect((await get("types=tool.called&types=browser.identity.created")).status).toBe(400);
    // The Dot keeps its notes itself: a note written is no event, and asking for one is asking for a type nobody emits.
    expect(await get("types=memory.written")).toMatchObject({ status: 400, body: { message: "unknown event type: memory.written" } });
    expect((await get("task_id=a&task_id=b")).status).toBe(400);
    expect((await get("task_id=")).status).toBe(400);

    // Newest first, and a tool filter that narrows tool.called only: the newest browser call is found past the calls of other tools.
    const browser = { ...call, tool: "browser_navigate", target: "x-1: https://example.com/" };
    guest.emit("tool.called", browser);
    guest.emit("tool.called", { ...call, target: "pwd" });
    guest.emit("tool.called", { ...call, target: "whoami" });
    await waitFor(async () => (await api.events(dot.id, { types: ["tool.called"] })).length === 5, "more events stored");
    const newest = await api.events(dot.id, { types: ["tool.called"], order: "desc", limit: 2 });
    expect(newest.map((e) => e.data.target)).toEqual(["whoami", "pwd"]);
    const browserCalls = await api.events(dot.id, { types: ["tool.called"], tools: ["browser_navigate", "browser_click"], order: "desc", limit: 1 });
    expect(browserCalls.map((e) => e.data.target)).toEqual(["x-1: https://example.com/"]);
    expect((await api.events(dot.id, { types: ["tool.called", "browser.identity.created"], tools: ["browser_click"] })).map((e) => e.type)).toEqual(["browser.identity.created"]);
    // `before` goes on, older, from the oldest event of a newest-first page, and only there.
    const calls = await api.events(dot.id, { types: ["tool.called"], order: "desc", limit: 2 });
    expect((await api.events(dot.id, { types: ["tool.called"], order: "desc", limit: 2, before: calls.at(-1)!.id })).map((e) => e.data.target)).toEqual(["x-1: https://example.com/", "date"]);
    expect(await get(`before=${calls.at(-1)!.id}`)).toMatchObject({ status: 400, body: { message: "before pages a list in order=desc" } });
    expect((await get("order=desc&before=-1")).status).toBe(400);
    expect((await get("order=sideways")).status).toBe(400);
    expect((await get("order=desc&order=asc")).status).toBe(400);
    expect((await get("tools=a&tools=b")).status).toBe(400);
    await expect(api.events("no-such-dot", { types: ["tool.called"] })).rejects.toMatchObject({ status: 404 });
  });

  it("files: list and read what is under /home/dot, as the guest answers, and nothing else", async () => {
    const dot = await readyDot("file-reader");
    const guest = driver.guestOf(dot.id);
    const note = "# Fares\n\nCheapest day is Tuesday.\n";
    guest.putFile("/home/dot/memory/fares.md", note, new Date("2026-10-01T10:00:00Z"));
    guest.putFile("/home/dot/memory/trips/rome.md", "Rome", new Date("2026-10-02T10:00:00Z"));
    guest.putFile("/home/dot/workspace/shot.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    guest.putFile("/home/dot/notes.txt", "hi");
    guest.putFile("/etc/passwd", "root:x:0:0");

    expect(await api.listFiles(dot.id, "/home/dot/memory")).toEqual({
      path: "/home/dot/memory",
      entries: [
        { name: "fares.md", type: "file", size: note.length, mtime: "2026-10-01T10:00:00.000Z" },
        { name: "trips", type: "dir", size: 0, mtime: "2026-10-02T10:00:00.000Z" },
      ],
    });
    // Home by default, and relative or ~ paths mean the same as the absolute one.
    const home = await api.listFiles(dot.id);
    expect(home.path).toBe("/home/dot");
    expect(home.entries.map((e) => e.name)).toEqual(["memory", "notes.txt", "workspace"]);
    expect(await api.listFiles(dot.id, "~/memory")).toEqual(await api.listFiles(dot.id, "memory/"));

    expect(new TextDecoder().decode(await api.readFile(dot.id, "/home/dot/memory/fares.md"))).toBe(note);
    expect(new TextDecoder().decode(await api.readFile(dot.id, "memory/trips/rome.md"))).toBe("Rome");
    expect([...(await api.readFile(dot.id, "workspace/shot.png"))]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Outside home, or with a .. segment: 400 before the guest is asked, whatever the guest holds.
    const callsBefore = guest.calls.length;
    for (const path of ["/etc/passwd", "/home", "/home/dotter/x", "../../etc/passwd", "memory/../../../etc/passwd", "/home/dot/memory/.."]) {
      await expect(api.readFile(dot.id, path), path).rejects.toMatchObject({ status: 400, code: "invalid_path" });
      await expect(api.listFiles(dot.id, path), path).rejects.toMatchObject({ status: 400, code: "invalid_path" });
    }
    expect(guest.calls.length).toBe(callsBefore);
    const raw = (route: string, query: string) => fetch(`${base}/api/dots/${dot.id}/${route}${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await raw("files", "")).status).toBe(400);
    expect((await raw("files", "?path=")).status).toBe(400);
    expect((await raw("files", "?path=a&path=b")).status).toBe(400);
    expect((await raw("files/list", "?path=")).status).toBe(400);
    expect((await fetch(`${base}/api/dots/${dot.id}/files?path=notes.txt`)).status).toBe(401);

    // The guest's own refusals pass through with their code.
    await expect(api.readFile(dot.id, "memory/missing.md")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.listFiles(dot.id, "memory/missing")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.readFile(dot.id, "memory")).rejects.toMatchObject({ status: 400, code: "is_a_directory" });
    await expect(api.listFiles(dot.id, "notes.txt")).rejects.toMatchObject({ status: 400, code: "not_a_directory" });

    // A link under home that leads out of it passes the path rule and is the guest's 403, with nothing of the target in the answer.
    guest.putFile("/proc/4242/environ", "PROXY_PASSWORD=hunter2");
    guest.link("/home/dot/environ", "/proc/4242/environ");
    const leak = await raw("files", `?path=${encodeURIComponent("environ")}`);
    expect(leak.status).toBe(403);
    expect(await leak.json()).toMatchObject({ error: "outside_home" });
    await expect(api.readFile(dot.id, "environ")).rejects.toMatchObject({ status: 403, code: "outside_home" });
  });

  it("files: a read says what it is, so the page never runs a Dot's file; a large one is refused", async () => {
    const dot = await readyDot("file-types");
    const guest = driver.guestOf(dot.id);
    guest.putFile("/home/dot/page.html", "<script>alert(1)</script>");
    guest.putFile("/home/dot/pic.png", Uint8Array.from([1, 2, 3]));
    guest.putFile("/home/dot/data.bin", Uint8Array.from([4, 5]));
    guest.putFile("/home/dot/é \"q\".txt", "x");
    guest.putFile("/home/dot/big.bin", new Uint8Array(16 * 1024 * 1024 + 1));
    guest.putFile("/home/dot/limit.bin", new Uint8Array(16 * 1024 * 1024));
    const read = (path: string) => fetch(`${base}/api/dots/${dot.id}/files?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${TOKEN}` } });

    const html = await read("page.html");
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(html.headers.get("content-disposition")).toMatch(/^inline; filename="page\.html"/);
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    expect((await read("pic.png")).headers.get("content-type")).toBe("image/png");
    const bin = await read("data.bin");
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-disposition")).toMatch(/^attachment; filename="data\.bin"/);
    expect((await read("é \"q\".txt")).headers.get("content-disposition")).toBe(
      "inline; filename=\"_ _q_.txt\"; filename*=UTF-8''%C3%A9%20%22q%22.txt",
    );

    expect((await read("limit.bin")).status).toBe(200);
    const big = await read("big.bin");
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "file_too_large" });
    await expect(api.readFile(dot.id, "big.bin")).rejects.toMatchObject({ status: 413, code: "file_too_large" });
  });

  it("files need a running computer (409 computer_stopped) and a Dot that exists", async () => {
    const dot = await readyDot("file-sleeper");
    await api.stopComputer(dot.id);
    await scheduler.settle();
    await expect(api.listFiles(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.readFile(dot.id, "notes.txt")).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await api.startComputer(dot.id);
    await waitFor(async () => (await api.computer(dot.id)).ready, "started again");
    await expect(api.listFiles("no-such-dot")).rejects.toMatchObject({ status: 404 });
    await expect(api.readFile("no-such-dot", "a")).rejects.toMatchObject({ status: 404 });
  });

  it("a tool table that follows the permissions, and no automations route: the jobs are the Dot's own", async () => {
    const dot = await readyDot("automations");
    expect((await fetch(`${base}/api/dots/${dot.id}/automations`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${base}/api/dots/${dot.id}/tools`)).status).toBe(401);

    // Tools: the table, and what the model is offered follows the permissions the config pushed.
    const { tools: none, mcp_servers } = await api.listTools(dot.id);
    expect(mcp_servers).toEqual([]);
    expect(none.map((t) => t.name)).toEqual([
      "exec",
      "read_file",
      "write_file",
      "cron",
      "browser_identity_list",
      "browser_identity_create",
    ]);
    // The pushed config has the defaults filled in, none of them deny: every tool is offered.
    expect(none.every((t) => t.offered)).toBe(true);
    await api.updateDot(dot.id, `${yaml("automations")}permissions:
  computer.exec: allow
  files.read: ask
  files.write: deny
  automations: deny
`);
    await waitFor(async () => (await api.listTools(dot.id)).tools.some((t) => !t.offered), "permissions pushed");
    expect(Object.fromEntries((await api.listTools(dot.id)).tools.map((t) => [t.name, t.offered]))).toEqual({
      exec: true,
      read_file: true,
      write_file: false,
      cron: false,
      browser_identity_list: true,
      browser_identity_create: true,
    });
  });

  it("the tools need a running computer (409 computer_stopped) and a Dot that exists", async () => {
    const dot = await readyDot("automation-sleeper");
    await api.stopComputer(dot.id);
    await scheduler.settle();
    await expect(api.listTools(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.listSkills(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await api.startComputer(dot.id);
    await waitFor(async () => (await api.computer(dot.id)).ready, "started again");
    await expect(api.listTools("no-such-dot")).rejects.toMatchObject({ status: 404 });
    await expect(api.listSkills("no-such-dot")).rejects.toMatchObject({ status: 404 });
  });

  it("the skills are the engine's, the built-in ones and the Dot's own, each with its whole file", async () => {
    const dot = await readyDot("skilled");
    const guest = driver.guestOf(dot.id);
    const own = { name: "shop-login", description: "Log in to the shop.", source: "dot" as const, path: "/home/dot/skills/shop-login/SKILL.md", content: "---\nname: shop-login\n---\n" };
    guest.skills = [...guest.skills, own];
    const skills = await api.listSkills(dot.id);
    expect(skills.map((s) => [s.name, s.source])).toEqual([["invisible-playwright", "builtin"], ["shop-login", "dot"]]);
    expect(skills[1]).toEqual(own);
    expect((await fetch(`${base}/api/dots/${dot.id}/skills`)).status).toBe(401);
  });

  it("the stream filters by Dot and replays after an id without duplicates", async () => {
    const a = await readyDot("stream-a");
    const b = await readyDot("stream-b");
    const history = await api.events(a.id);
    const controller = new AbortController();
    const got: StoredEvent[] = [];
    const reading = (async () => {
      for await (const event of api.stream({ dotId: "stream-a", after: history[0]!.id, signal: controller.signal })) {
        got.push(event);
        if (event.type === "browser.identity.created") break;
      }
    })();
    driver.guestOf(b.id).emit("browser.identity.created", { identity_id: "bi_b", name: "b-only" });
    driver.guestOf(a.id).emit("browser.identity.created", { identity_id: "bi_a", name: "a-only" });
    await reading;
    controller.abort();
    expect(got.every((e) => e.dot_id === a.id)).toBe(true);
    expect(got.map((e) => e.id)).toEqual([...new Set(got.map((e) => e.id))]);
    expect(got[0]?.id).toBe(history[1]?.id);
    expect(got.at(-1)?.data).toMatchObject({ name: "a-only" });
  });

  it("approval flow over HTTP", async () => {
    const dot = await readyDot("asks-first");
    const guest = driver.guestOf(dot.id);
    const original = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") g.requestApproval(event.data.task_id);
      else return original(event, g);
    };
    const task = await api.createTask(dot.id, { description: "delete an identity" });
    const pending = await waitFor(
      async () => (await api.listApprovals("pending")).find((a) => a.dot_id === dot.id),
      "approval pending",
    );
    expect(pending.task_id).toBe(task.id);
    await waitFor(async () => (await api.getTask(task.id)).status === "WAITING_APPROVAL", "task waiting");
    const rejected = await api.reject(pending.id, { note: "keep it" });
    expect(rejected).toMatchObject({ status: "rejected", note: "keep it" });
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "task resumed and completed");
    await expect(api.approve(pending.id)).rejects.toMatchObject({ status: 409, code: "already_resolved" });
    await expect(api.approve("apr_missing")).rejects.toMatchObject({ status: 404 });
    const raw = await fetch(`${base}/api/approvals?status=maybe`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(raw.status).toBe(400);
  });

  it("approvals: several statuses at once, newest answer first, a limit that keeps the newest and a cursor", async () => {
    const dot = await readyDot("asks-often");
    const guest = driver.guestOf(dot.id);
    const ids = [guest.requestApproval(undefined), guest.requestApproval(undefined), guest.requestApproval(undefined)];
    await waitFor(async () => (await api.listApprovals("pending")).filter((a) => a.dot_id === dot.id).length === 3, "three pending");
    await api.reject(ids[1]!, {});
    await api.approve(ids[0]!, {});
    const mine = async (...args: Parameters<typeof api.listApprovals>) => (await api.listApprovals(...args)).filter((a) => a.dot_id === dot.id).map((a) => a.id);
    // Answered, the last answered first (ids[0] after ids[1]); the one still pending is not among them.
    expect(await mine(["approved", "rejected", "expired"], { order: "desc" })).toEqual([ids[0], ids[1]]);
    expect(await mine(["pending", "rejected"])).toEqual([ids[1], ids[2]]);
    const newestOne = await api.listApprovals(["approved", "rejected", "expired"], { order: "desc", limit: 1 });
    expect(newestOne.map((a) => a.id)).toEqual([ids[0]]);
    expect((await api.listApprovals(["approved", "rejected", "expired"], { order: "desc", limit: 1, before: ids[0]! })).map((a) => a.id)).toEqual([ids[1]]);

    // Of one Dot, chosen in the database: by id or by name, and a Dot that does not exist has none.
    const other = await readyDot("asks-rarely");
    const otherAsk = driver.guestOf(other.id).requestApproval(undefined);
    await waitFor(async () => (await api.listApprovals("pending", { dot: other.id })).length === 1, "the other Dot's approval");
    expect((await api.listApprovals("pending", { dot: other.id })).map((a) => a.id)).toEqual([otherAsk]);
    expect((await api.listApprovals("pending", { dot: "asks-rarely" })).map((a) => a.id)).toEqual([otherAsk]);
    expect((await api.listApprovals(["approved", "rejected"], { dot: dot.id, order: "desc" })).map((a) => a.id)).toEqual([ids[0], ids[1]]);
    expect(await api.listApprovals("pending", { dot: "dot_nobody" })).toEqual([]);

    const get = async (query: string) => (await fetch(`${base}/api/approvals?${query}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status;
    expect(await get("dot_id=")).toBe(400);
    expect(await get(`dot_id=${dot.id}&dot_id=${other.id}`)).toBe(400);
    expect(await get("status=approved,maybe")).toBe(400);
    expect(await get("status=")).toBe(400);
    expect(await get("status=approved&status=rejected")).toBe(400);
    expect(await get("order=newest")).toBe(400);
    expect(await get("limit=0")).toBe(400);
    expect(await get("limit=501")).toBe(400);
    expect(await get(`order=desc&before=${ids[0]}&limit=1`)).toBe(200);
    expect(await get(`before=${ids[0]}`)).toBe(400);
    expect(await get("order=desc&before=")).toBe(400);
  });

  it("approve with always over HTTP sets the permission in the Dot's config and pushes it", async () => {
    const dot = await readyDot("always-http");
    const guest = driver.guestOf(dot.id);
    const approvalId = guest.requestApproval(undefined);
    await waitFor(async () => (await api.listApprovals("pending")).some((a) => a.id === approvalId), "approval pending");
    const post = (id: string, decision: string, body: unknown) =>
      fetch(`${base}/api/approvals/${id}/${decision}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(approvalId, "approve", { always: "yes" })).status).toBe(400);
    expect((await post(approvalId, "approve", { always: false })).status).toBe(400);
    expect((await post(approvalId, "reject", { always: true })).status).toBe(400);
    expect((await api.listApprovals("pending")).some((a) => a.id === approvalId)).toBe(true);
    expect((await api.getDot(dot.id)).config.permissions).toEqual({});

    expect(await api.approve(approvalId, { note: "yes", always: true })).toMatchObject({ status: "approved", note: "yes" });
    expect((await api.getDot(dot.id)).config.permissions["browser.identity.delete"]).toBe("allow");
    expect(guest.config?.permissions["browser.identity.delete"]).toBe("allow");
    const resolved = (await api.events(dot.id, { types: ["approval.resolved"] })).at(-1);
    expect(resolved?.data).toEqual({ approval_id: approvalId, decision: "approve", note: "yes", always: true });
    await expect(api.approve(approvalId, { always: true })).rejects.toMatchObject({ status: 409, code: "already_resolved" });
  });

  it("messages: delivered to a READY Dot and readable as a conversation", async () => {
    const dot = await readyDot("talker");
    const sent = await api.sendMessage("talker", "what did you find?");
    expect(sent.delivery).toBe("delivered");
    await waitFor(async () => (await api.messages(dot.id)).length === 2, "reply");
    expect((await api.messages(dot.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
    await expect(api.sendMessage(dot.id, "  ")).rejects.toMatchObject({ status: 400 });
  });

  it("tasks: the newest first, a page at a time, and a cursor that goes on through the rest", async () => {
    const dot = await readyDot("many-tasks");
    const other = await readyDot("other-tasks");
    const made: string[] = [];
    for (const description of ["one", "two", "three", "four", "five"]) {
      made.push((await api.createTask(dot.id, { description })).id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const foreign = (await api.createTask(other.id, { description: "not mine" })).id;
    const newestFirst = [...made].reverse();
    expect((await api.listTasks(dot.id)).map((t) => t.id)).toEqual(newestFirst);
    const first = await api.listTasks(dot.id, { limit: 2 });
    expect(first.map((t) => t.id)).toEqual(newestFirst.slice(0, 2));
    const second = await api.listTasks(dot.id, { limit: 2, before: first.at(-1)!.id });
    expect(second.map((t) => t.id)).toEqual(newestFirst.slice(2, 4));
    expect((await api.listTasks(dot.id, { limit: 2, before: second.at(-1)!.id })).map((t) => t.id)).toEqual(newestFirst.slice(4));
    expect(await api.listTasks(dot.id, { before: made[0]! })).toEqual([]);
    // Another Dot's task is no cursor here, and nothing of it is listed.
    expect(await api.listTasks(dot.id, { before: foreign })).toEqual([]);

    const get = async (query: string) => (await fetch(`${base}/api/dots/${dot.id}/tasks?${query}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status;
    expect(await get("limit=0")).toBe(400);
    expect(await get("limit=201")).toBe(400);
    expect(await get("limit=x")).toBe(400);
    expect(await get("before=")).toBe(400);
    expect(await get("limit=200&before=nobody")).toBe(200);
  });

  it("messages: the newest page of a long conversation, and a cursor that goes back through the rest", async () => {
    const dot = await readyDot("chatty");
    for (const [index, word] of ["one", "two", "three"].entries()) {
      await api.sendMessage(dot.id, word);
      await waitFor(async () => (await api.messages(dot.id)).length === 2 * (index + 1), `reply to ${word}`);
    }
    const all = await api.messages(dot.id);
    expect(all.length).toBe(6);
    // The default is the oldest first, so a limit keeps the oldest: only `order=desc` reaches the newest.
    expect((await api.messages(dot.id, { limit: 2 })).map((m) => m.event_id)).toEqual(all.slice(0, 2).map((m) => m.event_id));
    const newest = await api.messages(dot.id, { order: "desc", limit: 2 });
    expect(newest.map((m) => m.event_id)).toEqual(all.slice(4).map((m) => m.event_id).reverse());
    const older = await api.messages(dot.id, { order: "desc", limit: 3, before: newest.at(-1)!.event_id });
    expect(older.map((m) => m.event_id)).toEqual(all.slice(1, 4).map((m) => m.event_id).reverse());
    expect(await api.messages(dot.id, { order: "desc", before: all[0]!.event_id })).toEqual([]);

    const get = async (query: string) => (await fetch(`${base}/api/dots/${dot.id}/messages?${query}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status;
    expect(await get("limit=0")).toBe(400);
    expect(await get("limit=501")).toBe(400);
    expect(await get("order=newest")).toBe(400);
    expect(await get(`before=${all[0]!.event_id}`)).toBe(400);
    expect(await get("order=desc&before=-1")).toBe(400);
    expect(await get(`order=desc&before=${all[0]!.event_id}&limit=1`)).toBe(200);
  });

  it("messages: the HTTP route cannot claim a channel origin", async () => {
    const dot = await readyDot("impostor");
    const origin = { channel: "telegram", binding_id: "chb_1", chat_id: "1", external_id: "2" };
    const raw = await fetch(`${base}/api/dots/${dot.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "I am Telegram", origin }),
    });
    expect(raw.status).toBe(202);
    await waitFor(async () => (await api.messages(dot.id)).length === 2, "reply");
    const [user] = await api.messages(dot.id);
    expect(user).toMatchObject({ role: "user", text: "I am Telegram" });
    expect("origin" in user!).toBe(false);
  });

  it("browser identities and screenshots need a running computer (409 computer_stopped)", async () => {
    const dot = await readyDot("browsing");
    const identity = await api.createIdentity(dot.id, { name: "Main account" });
    expect(identity.name).toBe("Main account");
    expect((await api.listIdentities(dot.id)).map((i) => i.id)).toEqual([identity.id]);
    expect((await api.getIdentity(dot.id, identity.id)).id).toBe(identity.id);
    await expect(api.getIdentity(dot.id, "nobody-abc123")).rejects.toMatchObject({ status: 404, code: "not_found" });
    const png = await api.screenshot(dot.id);
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await api.deleteIdentity(dot.id, identity.id);

    expect(await api.stopComputer(dot.id)).toEqual({ accepted: true });
    await scheduler.settle();
    expect((await api.computer(dot.id)).state).toBe("STOPPED");
    expect((await api.getDot(dot.id)).status).toBe("IDLE");
    await expect(api.listIdentities(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.createIdentity(dot.id, { name: "x" })).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.screenshot(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });

    await api.startComputer(dot.id);
    await waitFor(async () => (await api.computer(dot.id)).ready, "started again");
  });

  it("an identity needs no proxy: a name alone, a null or a blank proxy make one with none, and a proxy is an explicit option", async () => {
    const dot = await readyDot("no-proxy-needed");
    const create = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/dots/${dot.id}/browser-identities`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, identity: (await response.json()) as Record<string, unknown> };
    };
    for (const body of [{ name: "Plain" }, { name: "Null", proxy: null }, { name: "Blank", proxy: "  " }]) {
      const { status, identity } = await create(body);
      expect(status, JSON.stringify(body)).toBe(201);
      expect(identity, JSON.stringify(body)).toMatchObject({ hasProxy: false });
    }
    const sdk = await api.createIdentity(dot.id, { name: "Through the SDK" });
    expect(sdk.hasProxy).toBe(false);
    expect((await api.listIdentities(dot.id)).some((i) => i.hasProxy || "proxy" in i)).toBe(false);

    // The proxy is a secret: it is passed on as written, and the identity says only that it has one.
    const own = await api.createIdentity(dot.id, { name: "Own exit", proxy: "socks5://user:hunter2@proxy.test:1080" });
    expect(own.hasProxy).toBe(true);
    expect(own).not.toHaveProperty("proxy");
    const listed = JSON.stringify(await api.listIdentities(dot.id));
    expect(listed).not.toContain("hunter2");
    expect(listed).not.toContain("proxy.test");
    expect((await create({ name: "Number", proxy: 8080 })).status).toBe(400);
  });

  it("an MCP server's secrets are set and cleared through the API and the SDK, and no answer carries a value", async () => {
    const dot = await api.createDot(`${yaml("mcp-api")}mcp_servers:\n  web:\n    url: https://web.example/mcp\n    secrets: [Authorization]\n`);
    await waitUntilSettledReady(scheduler, driver, dot.id, "mcp-api");
    const route = `${base}/api/dots/${dot.id}/mcp-secrets/web/Authorization`;
    expect((await fetch(route, { method: "PUT", body: JSON.stringify({ value: "x" }), headers: { "content-type": "application/json" } })).status).toBe(401);
    expect((await fetch(`${base}/api/dots/${dot.id}/mcp-secrets`)).status).toBe(401);

    const set = await api.setMcpSecret(dot.id, "web", "Authorization", "Bearer api-1");
    expect(set).toEqual({ dot_id: dot.id, secrets: [{ server: "web", name: "Authorization", set: true }] });
    expect(driver.guestOf(dot.id).mcpSecrets).toEqual({ web: { Authorization: "Bearer api-1" } });
    expect(JSON.stringify(await api.mcpSecrets(dot.id))).not.toContain("api-1");

    // A PUT with no value is refused, not taken as a clear; the DELETE clears.
    const empty = await fetch(route, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ value: null }) });
    expect(empty.status).toBe(400);
    expect((await api.setMcpSecret(dot.id, "web", "Authorization", null)).secrets[0]!.set).toBe(false);
    await expect(api.setMcpSecret(dot.id, "nope", "Authorization", "x")).rejects.toMatchObject({ status: 404 });
  });

  it("an identity's frame is a JPEG of an open one, and close ends it, through the API and the SDK", async () => {
    const dot = await readyDot("viewing");
    const identity = await api.createIdentity(dot.id, { name: "Main account" });
    await expect(api.getIdentityFrame(dot.id, identity.id)).rejects.toMatchObject({ status: 409, code: "not_open" });
    await expect(api.getIdentityFrame(dot.id, "nobody-abc123")).rejects.toMatchObject({ status: 404, code: "not_found" });

    driver.guestOf(dot.id).launchIdentity(identity.id);
    const jpeg = await api.getIdentityFrame(dot.id, identity.id);
    expect([...jpeg]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const raw = await fetch(`${base}/api/dots/${dot.id}/browser-identities/${identity.id}/frame`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(raw.headers.get("content-type")).toBe("image/jpeg");
    expect(raw.headers.get("cache-control")).toBe("no-store");
    driver.guestOf(dot.id).identityBusy = true;
    await expect(api.getIdentityFrame(dot.id, identity.id)).rejects.toMatchObject({ status: 503, code: "busy" });
    driver.guestOf(dot.id).identityBusy = false;

    await api.closeIdentity(dot.id, identity.id);
    expect((await api.getIdentity(dot.id, identity.id)).status).toBe("available");
    await expect(api.getIdentityFrame(dot.id, identity.id)).rejects.toMatchObject({ status: 409, code: "not_open" });
    await expect(api.closeIdentity(dot.id, "nobody-abc123")).rejects.toMatchObject({ status: 404, code: "not_found" });

    await api.stopComputer(dot.id);
    await scheduler.settle();
    await expect(api.getIdentityFrame(dot.id, identity.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.closeIdentity(dot.id, identity.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
  });

  it("sleeps after idle_timeout (fake clock) and a new task wakes it", async () => {
    const dot = await readyDot("napper", "5m");
    clock.advance(6 * 60_000);
    expect(await scheduler.idleCheck()).toContain(dot.id);
    await scheduler.settle();
    expect((await api.computer(dot.id)).state).toBe("STOPPED");
    const task = await api.createTask(dot.id, { description: "wake up" });
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "task after wake");
    expect((await api.computer(dot.id)).state).toBe("RUNNING");
  });

  it("the secret route refuses a key that cannot travel in a header with 400, naming the rule and never the key", async () => {
    const dot = await readyDot("key-check");
    expect(await api.setOpenRouterKey("sk-or-good", dot.id)).toEqual({ pushed: 1 });

    for (const bad of ["sk-or-v1-SECRETHEAD\nSECRETTAIL", "sk-or-v1-SECRET HEAD", "sk-or-v1-SECRETüHEAD", "SECRET\u0000HEAD"]) {
      const refused = await api.setOpenRouterKey(bad, dot.id).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ApiError);
      expect(refused).toMatchObject({ status: 400, code: "invalid_request" });
      expect((refused as ApiError).message).toContain(OPENROUTER_KEY_RULE);
      expect((refused as ApiError).message).not.toContain("SECRET");
    }
    // Nothing was stored or pushed by the refusals.
    expect(await db.secrets.get(dot.id, "openrouter_api_key")).toBe("sk-or-good");
    expect(driver.guestOf(dot.id).openrouterKey).toBe("sk-or-good");

    // A pasted key with its ends trimmed is the key.
    await api.setOpenRouterKey("  sk-or-padded\n", dot.id);
    expect(driver.guestOf(dot.id).openrouterKey).toBe("sk-or-padded");
  });

  it("PATCH updates the config; DELETE removes the Dot; the secret route stores the key", async () => {
    const dot = await readyDot("to-patch");
    const updated = await api.updateDot(dot.id, `${yaml("to-patch")}instructions: short answers\n`);
    expect(updated.config.instructions).toBe("short answers");
    expect(driver.guestOf(dot.id).config?.instructions).toBe("short answers");
    // A save from an old read is a 409 over the wire, and a malformed read is a 400.
    const body = `${yaml("to-patch")}instructions: from a stale form\n`;
    await expect(api.updateDot(dot.id, body, dot.config_version)).rejects.toMatchObject({ status: 409, code: "dot_changed" });
    expect((await api.updateDot(dot.id, body, updated.config_version)).config.instructions).toBe("from a stale form");
    await expect(api.updateDot(dot.id, body, 1.5)).rejects.toMatchObject({ status: 400, code: "invalid_request" });

    expect(await api.setOpenRouterKey("sk-or-rotated", "to-patch")).toEqual({ pushed: 1 });
    expect(driver.guestOf(dot.id).openrouterKey).toBe("sk-or-rotated");
    await expect(api.setOpenRouterKey("")).rejects.toMatchObject({ status: 400 });

    expect(await api.deleteDot("to-patch")).toEqual({ accepted: true });
    await scheduler.settle();
    await expect(api.getDot("to-patch")).rejects.toMatchObject({ status: 404 });
    expect((await api.events(dot.id)).at(-1)?.type).toBe("dot.deleted");
  });
});
