/**
 * Races and failures around getting work to a guest: what is stored for a
 * guest survives a failed wake and a restart, a cancel never loses to a
 * slow wake, a sleep never swallows work, and what the guest must hold (its
 * key, its config) is pushed again whenever it may have lost it.
 */
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import type { InboundEvent, OutboundEvent, SecretsRequest } from "@invisible-dots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Scheduler, type Logger, type SchedulerOptions } from "../src/index.js";
import type { GuestApi, GuestEndpoint } from "../src/index.js";
import { FakeDriver, FakeGuest, FakeGuestError, ManualClock, waitFor, waitUntilSettledReady } from "../src/testing.js";

const yaml = (name: string, instructions = "keep watch") =>
  `name: ${name}\ninstructions: ${instructions}\nmodel:\n  provider: openrouter\n  id: test/model\ncomputer:\n  idle_timeout: 10m\n`;

const KEY = "sk-or-delivery-test-key-0123456789";

/** A gate a fake waits on until the test opens it. */
function gate(): { wait: Promise<void>; open(): void; reached: Promise<void>; arrive(): void } {
  let open!: () => void;
  let arrive!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  return { wait, open, reached, arrive };
}

const received = (guest: FakeGuest, type: InboundEvent["type"]) => guest.inbound.filter((e) => e.type === type);

describe.each(testAdapters())("delivery to guests (%s)", (kind) => {
  let t: TestDatabase;
  let db: Database;
  const open: Scheduler[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    await db.secrets.put("global", "openrouter_api_key", KEY);
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  afterAll(async () => {
    await t?.drop();
  });

  function make(driver: FakeDriver = new FakeDriver(), extra: Partial<SchedulerOptions> = {}) {
    const clock = new ManualClock();
    const scheduler = new Scheduler({
      db,
      driver,
      clock,
      dispatchIntervalMs: 60_000,
      idleCheckIntervalMs: 60_000,
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
      ...extra,
    });
    open.push(scheduler);
    drivers.set(scheduler, driver);
    return { scheduler, driver, clock };
  }

  const drivers = new Map<Scheduler, FakeDriver>();
  const driverOf = (s: Scheduler) => drivers.get(s)!;

  async function readyDot(s: Scheduler, name: string) {
    const dot = await s.createDot(yaml(name));
    await waitUntilSettledReady(s, driverOf(s), dot.id, name);
    return dot;
  }

  /** A guest that asks for an approval inside every task. */
  function asksForApproval(guest: FakeGuest): void {
    const original = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") {
        g.emit("task.started", { task_id: event.data.task_id });
        g.requestApproval(event.data.task_id);
      } else {
        return original(event, g);
      }
    };
  }

  it("an approval for a sleeping Dot whose wake fails is kept and reaches the guest at the next READY", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "approve-later");
    const guest = driver.guestOf(dot.id);
    asksForApproval(guest);
    const task = await scheduler.createTask(dot.id, { description: "needs a yes" });
    const approval = await waitFor(async () => (await scheduler.listApprovals("pending")).find((a) => a.task_id === task.id), "pending approval");
    await scheduler.lifecycle.stop(dot.id, "user");

    driver.failNext("start", new Error("QEMU exited (injected)"));
    await scheduler.resolveApproval(approval.id, "approve");
    await scheduler.settle();
    expect(received(guest, "approval.received")).toHaveLength(0);
    expect((await db.inbound.pending(dot.id)).map((r) => r.event.type)).toEqual(["approval.received"]);

    await scheduler.startComputer(dot.id);
    await waitFor(() => received(guest, "approval.received").length === 1, "approval delivered after the next READY");
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task completed");
    expect(await db.inbound.pending(dot.id)).toEqual([]);
  });

  it("a message stored before a restart is delivered by the next control plane", async () => {
    const driver = new FakeDriver();
    const first = make(driver).scheduler;
    const dot = await readyDot(first, "restart-chat");
    await first.lifecycle.stop(dot.id, "user");
    driver.failNext("start", new Error("QEMU exited (injected)"));
    const answer = await first.sendMessage(dot.id, "are you there?");
    expect(answer.delivery).toBe("queued");
    await first.close();
    open.splice(open.indexOf(first), 1);

    const { scheduler } = make(driver);
    await scheduler.start();
    await scheduler.startComputer(dot.id);
    const guest = driver.guestOf(dot.id);
    await waitFor(() => received(guest, "user.message").some((e) => e.id === answer.message_id), "message delivered");
    await waitFor(async () => (await scheduler.conversation(dot.id)).length === 2, "reply");
  });

  it("a task cancelled while its Dot wakes is never sent to the guest", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "cancel-early");
    await scheduler.lifecycle.stop(dot.id, "user");
    const guest = driver.guestOf(dot.id);
    guest.bootPolls = 40;
    const task = await scheduler.createTask(dot.id, { description: "never mind" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "RUNNING", "claimed");
    expect(scheduler.lifecycle.isReady(dot.id)).toBe(false);
    await scheduler.cancelTask(task.id);
    await waitFor(() => scheduler.lifecycle.isReady(dot.id), "woken anyway");
    await scheduler.settle();
    expect((await db.tasks.get(task.id))?.status).toBe("CANCELLED");
    expect(received(guest, "task.created")).toHaveLength(0);
    // Nothing to cancel on a guest that never heard of the task.
    expect(received(guest, "system.event")).toHaveLength(0);
  });

  it("a task cancelled after its send began is cancelled on the guest too", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "cancel-late");
    const guest = driver.guestOf(dot.id);
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") g.emit("task.started", { task_id: event.data.task_id });
    };
    const task = await scheduler.createTask(dot.id, { description: "long job" });
    await waitFor(() => received(guest, "task.created").length === 1, "delivered");
    await scheduler.cancelTask(task.id);
    await waitFor(() => received(guest, "system.event").length === 1, "cancel delivered");
    expect(received(guest, "system.event")[0]?.data).toMatchObject({ name: "task.cancelled", data: { task_id: task.id } });
  });

  it("an idle sleep never swallows a task that arrives while the agent prepares to sleep", async () => {
    const { scheduler, driver, clock } = make();
    const dot = await readyDot(scheduler, "light-sleeper");
    const guest = driver.guestOf(dot.id);
    const bootsAtReceipt: number[] = [];
    const complete = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") bootsAtReceipt.push(g.boots);
      return complete(event, g);
    };
    const sleeping = gate();
    const prepare = guest.prepareSleep.bind(guest);
    guest.prepareSleep = async () => {
      sleeping.arrive();
      await sleeping.wait;
      return prepare();
    };
    clock.advance(11 * 60_000);
    expect(await scheduler.idleCheck()).toEqual([dot.id]);
    await sleeping.reached;
    const task = await scheduler.createTask(dot.id, { description: "just in time" });
    await scheduler.dispatcher.dispatch();
    // Give a send that does not wait for the stop every chance to happen; a
    // correct one waits for the Dot's lock, so nothing arrives in this window.
    await waitFor(() => received(guest, "task.created").length > 0, "a send during prepare-sleep", 300).catch(() => undefined);
    expect(received(guest, "task.created")).toHaveLength(0);
    sleeping.open();
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task completed after the wake");
    // Received once, by the guest of the next boot: never by the one that was powering off.
    expect(bootsAtReceipt).toEqual([2]);
    expect((await db.computers.get(dot.id))?.state).toBe("RUNNING");
  });

  it("an idle sleep is called off when work was stored after the idle check", async () => {
    const { scheduler, driver, clock } = make();
    const dot = await readyDot(scheduler, "called-off");
    const guest = driver.guestOf(dot.id);
    // Work the idle check did not see: a message stored straight into the outbox.
    clock.advance(11 * 60_000);
    const message: InboundEvent<"user.message"> = { id: "msg_late", type: "user.message", ts: new Date().toISOString(), data: { text: "hi" } };
    await db.inbound.enqueue(dot.id, message);
    const stop = scheduler.lifecycle.stop(dot.id, "idle");
    await stop;
    expect((await db.computers.get(dot.id))?.state).toBe("RUNNING");
    expect(guest.calls).not.toContain("prepareSleep");
    expect(scheduler.lifecycle.isReady(dot.id)).toBe(true);
  });

  it("a stopped Dot with an unfinished task is woken for a new task", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "blocked");
    const guest = driver.guestOf(dot.id);
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") g.emit("task.started", { task_id: event.data.task_id });
    };
    const first = await scheduler.createTask(dot.id, { description: "unfinished" });
    await waitFor(() => received(guest, "task.created").length === 1, "first delivered");
    await scheduler.lifecycle.stop(dot.id, "user");
    await scheduler.createTask(dot.id, { description: "waits behind it" });
    await scheduler.pass();
    await waitFor(() => scheduler.lifecycle.isReady(dot.id), "woken for the new task");
    expect((await db.tasks.get(first.id))?.status).toBe("RUNNING");
  });

  it("a send that reached the guest but timed out is sent again, accepted once, and never fails the task", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "slow-ack");
    const guest = driver.guestOf(dot.id);
    const post = guest.postEvent.bind(guest);
    let timeouts = 3;
    guest.postEvent = async (event) => {
      await post(event);
      if (event.type === "task.created" && timeouts-- > 0) throw new FakeGuestError(0, "no answer within 30000 ms");
      return { accepted: true };
    };
    const task = await scheduler.createTask(dot.id, { description: "acknowledged late" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "completed");
    expect(received(guest, "task.created")).toHaveLength(1);
    expect((await db.tasks.runs(task.id)).map((r) => r.outcome)).toEqual(["completed"]);
  });

  it("a cancelled task leaves no pending approval, and a late request for it is never pending", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "expiring");
    const guest = driver.guestOf(dot.id);
    asksForApproval(guest);
    const task = await scheduler.createTask(dot.id, { description: "asks then gets cancelled" });
    const approval = await waitFor(async () => (await scheduler.listApprovals("pending")).find((a) => a.task_id === task.id), "pending");
    await scheduler.cancelTask(task.id);
    expect((await scheduler.listApprovals("pending")).map((a) => a.id)).not.toContain(approval.id);
    expect((await db.approvals.get(approval.id))?.status).toBe("expired");
    await expect(scheduler.resolveApproval(approval.id, "approve")).rejects.toMatchObject({ status: 409, code: "already_resolved" });

    const late = guest.requestApproval(task.id);
    await waitFor(async () => (await db.approvals.get(late)) !== null, "late request stored");
    expect((await db.approvals.get(late))?.status).toBe("expired");
  });

  it("an agent that restarts inside a running VM gets its key again", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "phoenix");
    const guest = driver.guestOf(dot.id);
    expect(guest.openrouterKey).toBe(KEY);
    guest.restartAgent();
    expect(guest.openrouterKey).toBeNull();
    await waitFor(() => guest.openrouterKey === KEY, "key pushed again after the restart");
    expect(guest.config?.name).toBe("phoenix");
  });

  it("a config changed while the Dot passes READY reaches the guest", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "late-config");
    const guest = driver.guestOf(dot.id);
    // The boot's agent.started is stored, and the push it starts in the
    // background has finished (it runs after the event's transaction, so the
    // cursor alone does not say so), so nothing but READY pushes from here on.
    await waitFor(async () => (await db.computers.get(dot.id))?.event_cursor === guest.outbox.at(-1)?.seq, "boot events stored");
    await scheduler.lifecycle.settle();
    const pushing = gate();
    const putConfig = guest.putConfig.bind(guest);
    let held = false;
    guest.putConfig = async (config) => {
      if (!held) {
        held = true;
        pushing.arrive();
        await pushing.wait;
      }
      return putConfig(config);
    };
    // A READY procedure on the running VM (as after a failed call or a control plane restart).
    scheduler.lifecycle.markSuspect(dot.id);
    const ready = scheduler.lifecycle.ensureReady(dot.id);
    await pushing.reached;
    const update = await scheduler.updateDot(dot.id, yaml("late-config", "a brand new instruction"));
    expect(update.config.instructions).toBe("a brand new instruction");
    pushing.open();
    await ready;
    expect(guest.config?.instructions).toBe("a brand new instruction");
  });

  it("a guest that echoes the key in a failed secret push never puts it in the log, the rows or the events", async () => {
    const lines: string[] = [];
    const record = (level: string) => (message: string, fields?: Record<string, unknown>) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    const logger: Logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
    const driver = new FakeDriver();
    driver.configureGuest = (g) => {
      g.pushSecrets = async (secrets: SecretsRequest) => {
        throw new FakeGuestError(502, `upstream said: bad request body {"openrouter_api_key":"${secrets.openrouter_api_key}"}`);
      };
    };
    const { scheduler } = make(driver, { logger });
    const dot = await scheduler.createDot(yaml("echoes"));
    await waitFor(async () => (await db.dots.get(dot.id))?.status === "ERROR", "ERROR");
    await scheduler.settle();
    const dotRow = await db.dots.get(dot.id);
    const computer = await db.computers.get(dot.id);
    const events = await db.events.list({ dotId: dot.id });
    expect(dotRow?.error).toMatch(/did not take the OpenRouter key and the MCP secrets \(status 502\)/);
    for (const text of [dotRow?.error ?? "", computer?.last_error ?? "", JSON.stringify(events), lines.join("\n")]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(KEY.slice(0, 12));
    }
  });

  it("a VM that dies is recorded as stopped, and a new task runs on a new port with a working event pump", async () => {
    /** Like the real guest client: an event stream bound to the port it was opened on, reconnecting forever. */
    class StalePortDriver extends FakeDriver {
      override guest(endpoint: GuestEndpoint, token: string): GuestApi {
        const inner = super.guest(endpoint, token);
        const vms = this.vms;
        return new Proxy(inner, {
          get: (target, property) => {
            if (property === "then") return undefined;
            if (property !== "events") {
              const value: unknown = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async function* (options: { after?: number; signal?: AbortSignal }): AsyncGenerator<OutboundEvent> {
              while (!options.signal?.aborted) {
                if (vms.get(endpoint.dotId)?.guestPort === endpoint.port) {
                  try {
                    yield* target.events(options);
                  } catch {
                    // reconnects, as GuestClient does on a reset
                  }
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            };
          },
        });
      }
    }
    const driver = new StalePortDriver();
    const { scheduler } = make(driver);
    const dot = await readyDot(scheduler, "lazarus");
    const before = (await db.computers.get(dot.id))?.guest_port;
    driver.crash(dot.id);
    const task = await scheduler.createTask(dot.id, { description: "after the crash" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task completed on the new boot");
    expect((await db.computers.get(dot.id))?.guest_port).not.toBe(before);
  });

  it("a VM that powers itself off with a task in progress is started again", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "self-stopper");
    const guest = driver.guestOf(dot.id);
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") g.emit("task.started", { task_id: event.data.task_id });
    };
    await scheduler.createTask(dot.id, { description: "keeps going" });
    await waitFor(() => received(guest, "task.created").length === 1, "delivered");
    const boots = guest.boots;
    driver.crash(dot.id);
    await waitFor(async () => (await db.events.list({ dotId: dot.id, types: ["computer.stopped"] })).some((e) => e.data.reason === "exited"), "stop recorded");
    await waitFor(() => guest.boots === boots + 1 && scheduler.lifecycle.isReady(dot.id), "started again");
  });
});
