/**
 * The life of a Dot's computer on the host: create (section 9.4), the READY
 * procedure (9.3), sleep and wake (9.5), reboot, delete, the guest event
 * pump, and reconciliation with the running QEMU processes (found through
 * their pid files) after a control plane restart.
 *
 * Every operation that changes a computer's state runs under a per-Dot lock,
 * so a wake and an idle sleep of the same Dot can never interleave. A Dot is
 * in `#ready` only between a completed READY procedure and the moment an
 * operation under that lock takes it out again, so anything that skips the
 * lock because the Dot is READY (a delivery, a push) can only meet a stop
 * that has not started yet: every stop takes the Dot out of `#ready` first.
 */
import { VM_PROXY_NAME, type Database, type Repositories } from "@invisible-dots/database";
import type { EventLog } from "@invisible-dots/events";
import {
  COMPUTER_STOPPED,
  computerIsUp,
  computerResources,
  PREPARE_SLEEP_TIMEOUT_MS,
  toRuntimeConfig,
  type DotState,
  type HealthAnswer,
  type HostEventDataMap,
  type HostEventType,
  type OutboundEvent,
  type RefusedEvent,
  type StopReason,
  type StoredEvent,
  type VmState,
} from "@invisible-dots/shared";
import { guestErrorCode, guestErrorStatus, type ComputerDriver, type ComputerSpecInput, type ComputerState, type GuestApi } from "./driver.js";
import { applyGuestEvent, dotStatusForAgent } from "./guest-events.js";
import { ControlPlaneError, errorMessage, KeyedMutex, sleep, type Clock, type Logger } from "./support.js";

export interface LifecycleOptions {
  /** How long a started VM may take to pass the READY procedure. Default 10 minutes (a first boot runs cloud-init). */
  readyTimeoutMs: number;
  /** Interval between health polls while waiting for READY. Default 2 s. */
  healthPollMs: number;
  /** Per-request timeout of a health poll. Default 5 s. */
  healthRequestTimeoutMs: number;
  /** First retry delay of the event pump after a failure; doubles up to `pumpMaxRetryMs`. */
  pumpRetryMs: number;
  pumpMaxRetryMs: number;
  /** Time the agent gets to flush its state before a shutdown (section 9.5). Default PREPARE_SLEEP_TIMEOUT_MS of packages/shared, which the engine's own steps fit inside. */
  prepareSleepTimeoutMs: number;
  /**
   * How long before an automation is due a stopped computer is started, and how close to one a running computer is
   * kept awake (section 9.5). It is the time a start takes to reach READY with some to spare; the passes that look
   * for the Dots to start run every few seconds, so the computer is up between this long and a pass before the run.
   * Default 90 s.
   */
  automationWakeLeadMs: number;
}

export const DEFAULT_LIFECYCLE_OPTIONS: LifecycleOptions = {
  readyTimeoutMs: 10 * 60_000,
  healthPollMs: 2_000,
  healthRequestTimeoutMs: 5_000,
  pumpRetryMs: 1_000,
  pumpMaxRetryMs: 30_000,
  prepareSleepTimeoutMs: PREPARE_SLEEP_TIMEOUT_MS,
  automationWakeLeadMs: 90_000,
};

export interface LifecycleDeps {
  db: Database;
  events: EventLog;
  driver: ComputerDriver;
  clock: Clock;
  logger: Logger;
  options?: Partial<LifecycleOptions>;
  /** Called when a task reached a terminal state or a Dot became READY: the dispatcher may have work to hand out. */
  onWorkPossible?: () => void;
  /** Called every time a Dot becomes READY: what waits in its inbound outbox can go now. */
  onReady?: (dotId: string) => void;
}

/** Why a stop is asked for: the idle sleep, or the person (`exited` is only ever recorded, never asked for). */
export type StopRequest = Exclude<StopReason, "exited">;

/** Part of the error a Dot gets when READY failed only for want of a key; setting a key retries those Dots. */
export const MISSING_KEY_MESSAGE = "no OpenRouter API key is configured";

/** The READY procedure failed; the message says which step and why. */
export class NotReadyError extends ControlPlaneError {
  constructor(dotId: string, message: string) {
    super(503, "computer_not_ready", `Dot ${dotId}: ${message}`);
    this.name = "NotReadyError";
  }
}

/**
 * A failed guest call described by its status and code only. Used where the
 * request carried a secret: the error text of a guest or a proxy may echo
 * the body, and this message goes into logs, `dots.error` and the event log.
 */
function describeWithoutBody(error: unknown): string {
  const status = guestErrorStatus(error);
  const code = guestErrorCode(error) ?? (error as { code?: unknown })?.code;
  return status === 0 ? `the guest was not reached${typeof code === "string" ? ` (${code})` : ""}` : `status ${status}${typeof code === "string" ? `, ${code}` : ""}`;
}

/** Store a host event through the transaction a change is made in (`Lifecycle.#commit`). */
type HostLog = <K extends HostEventType>(dotId: string, type: K, data: HostEventDataMap[K]) => Promise<void>;

export class Lifecycle {
  readonly #db: Database;
  readonly #events: EventLog;
  readonly #driver: ComputerDriver;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #opts: LifecycleOptions;
  readonly #onWorkPossible: () => void;
  readonly #onReady: (dotId: string) => void;
  readonly #mutex = new KeyedMutex();
  /** Pushes of the key and the config to a READY guest, one at a time per Dot, so the last one sent is the newest. */
  readonly #pushes = new KeyedMutex();
  /** Bumped by every change of what a guest must hold; READY completes only on an unchanged generation. */
  readonly #generation = new Map<string, number>();
  /** Dots whose READY procedure completed since their computer last started. */
  readonly #ready = new Set<string>();
  readonly #pumps = new Map<string, AbortController>();
  readonly #pumpDone = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
  #closed = false;

  constructor(deps: LifecycleDeps) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#driver = deps.driver;
    this.#clock = deps.clock;
    this.#log = deps.logger;
    this.#opts = { ...DEFAULT_LIFECYCLE_OPTIONS, ...deps.options };
    this.#onWorkPossible = deps.onWorkPossible ?? (() => {});
    this.#onReady = deps.onReady ?? (() => {});
  }

  isReady(dotId: string): boolean {
    return this.#ready.has(dotId);
  }

  /** Whether a lifecycle operation is queued or running for the Dot. */
  isBusy(dotId: string): boolean {
    return this.#mutex.isBusy(dotId);
  }

  /**
   * The guest of a running computer, reached through the port recorded at its
   * start. The port is read for every call: it changes with every start.
   */
  async guest(dotId: string): Promise<GuestApi> {
    const computer = await this.#db.computers.get(dotId);
    if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
    if (computer.guest_port === null) {
      throw new ControlPlaneError(409, COMPUTER_STOPPED, `the computer of Dot ${dotId} is ${computer.state}, it has no guest port`);
    }
    return this.#driver.guest({ dotId, port: computer.guest_port }, await this.#db.computers.token(dotId));
  }

  /**
   * Run `write` in one transaction, and publish what it logged after COMMIT, in order. A change of state and the host
   * events that tell it commit together or not at all: a control plane killed between two writes leaves the state it
   * was in before the change (which recovery knows how to finish), never a state nobody was told of. `log` stores a host
   * event through the transaction. Like every transaction that inserts events and changes other rows, `write` logs first
   * and writes its rows after (the event insert takes the event-order lock, database events.ts).
   */
  async #commit<T>(write: (tx: Repositories, log: HostLog) => Promise<T>): Promise<T> {
    const { value, logged } = await this.#db.transaction(async (tx) => {
      const logged: StoredEvent[] = [];
      const log: HostLog = async (dotId, type, data) => {
        logged.push(await this.#events.appendHostIn(tx, dotId, type, data));
      };
      return { value: await write(tx, log), logged };
    });
    for (const event of logged) this.#events.publish(event);
    return value;
  }

  /** Log `computer.state` when the computer's row holds another state now; the caller writes the row after its events. */
  async #logState(tx: Repositories, log: HostLog, dotId: string, state: VmState): Promise<void> {
    if ((await tx.computers.get(dotId))?.state !== state) await log(dotId, "computer.state", { state });
  }

  /** Log `dot.updated` for the status ERROR (the other statuses are told by the events of what caused them); the caller writes the row after its events. */
  async #logDotStatus(tx: Repositories, log: HostLog, dotId: string, status: DotState, error: string | null): Promise<void> {
    const dot = status === "ERROR" ? await tx.dots.get(dotId) : null;
    if (dot) await log(dotId, "dot.updated", { name: dot.name, status, error });
  }

  async #setVmState(dotId: string, state: VmState, lastError?: string | null, stopReason?: StopReason): Promise<void> {
    await this.#commit(async (tx, log) => {
      await this.#logState(tx, log, dotId, state);
      await tx.computers.setState(dotId, state, lastError, stopReason);
    });
  }

  async #setDotStatus(dotId: string, status: DotState, error: string | null = null): Promise<void> {
    await this.#commit(async (tx, log) => {
      await this.#logDotStatus(tx, log, dotId, status, error);
      await tx.dots.setStatus(dotId, status, error);
    });
  }

  /**
   * The computer is up: its process, its images and its state RUNNING, with `computer.state` and `computer.started`,
   * in one write. From here on the guest is reached through this port.
   */
  async #recordStarted(
    dotId: string,
    started: { guestPort: number; pid: number; runtimeImage: string },
    goldenImage: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.#commit(async (tx, log) => {
      await this.#logState(tx, log, dotId, "RUNNING");
      await log(dotId, "computer.started", { guest_port: started.guestPort, runtime_image: started.runtimeImage, ...extra });
      await tx.computers.setProcess(dotId, { guestPort: started.guestPort, pid: started.pid });
      await tx.computers.setImages(dotId, goldenImage, started.runtimeImage);
      await tx.computers.setState(dotId, "RUNNING", null);
    });
  }

  /** The computer and the Dot are in ERROR for `message`, with `computer.state` and `dot.updated`, in one write. */
  async #recordError(dotId: string, message: string): Promise<void> {
    await this.#commit(async (tx, log) => {
      await this.#logState(tx, log, dotId, "ERROR");
      await this.#logDotStatus(tx, log, dotId, "ERROR", message);
      await tx.computers.setState(dotId, "ERROR", message);
      await tx.dots.setStatus(dotId, "ERROR", message);
    });
  }

  /**
   * The computer is off: no process, the state STOPPED with the reason, `computer.state` and `computer.stopped`, and
   * the Dot idle, in one write. Recovery, which finds a computer off that was not recorded as such, leaves a Dot that
   * is disabled or in ERROR as it is (`keepFailedDot`).
   */
  async #recordStopped(dotId: string, reason: StopReason, forced: boolean, keepFailedDot = false): Promise<void> {
    await this.#commit(async (tx, log) => {
      await this.#logState(tx, log, dotId, "STOPPED");
      await log(dotId, "computer.stopped", { reason, forced });
      const dot = await tx.dots.get(dotId);
      await tx.computers.setProcess(dotId, null);
      await tx.computers.setState(dotId, "STOPPED", null, reason);
      if (dot && !(keepFailedDot && (dot.status === "DISABLED" || dot.status === "ERROR"))) await tx.dots.setStatus(dotId, "IDLE", null);
    });
  }

  /** Record a lifecycle failure on both rows, log it, and rethrow it. */
  async #fail(dotId: string, step: string, error: unknown): Promise<never> {
    const message = `${step} failed: ${errorMessage(error)}`;
    this.#log.error(message, { dotId });
    await this.#recordError(dotId, message).catch(() => {});
    throw error instanceof ControlPlaneError ? error : new ControlPlaneError(502, "computer_error", `Dot ${dotId}: ${message}`);
  }

  async #spec(dotId: string): Promise<ComputerSpecInput & { goldenImage: string | null; state: VmState }> {
    const [dot, computer] = await Promise.all([this.#db.dots.get(dotId), this.#db.computers.get(dotId)]);
    if (!dot || !computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
    const proxy = await this.#db.secrets.get(dotId, VM_PROXY_NAME);
    return {
      dotId,
      token: await this.#db.computers.token(dotId),
      ...(proxy ? { proxy } : {}),
      resources: computerResources(dot.config),
      goldenImage: computer.golden_image,
      state: computer.state,
    };
  }

  /** Section 9.4: provision the computer of a Dot inserted as CREATING, start it and bring it to READY. */
  provision(dotId: string): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const spec = await this.#spec(dotId);
      this.#log.info("provisioning computer", { dotId });
      let created;
      try {
        created = await this.#driver.create(spec);
      } catch (error) {
        return this.#fail(dotId, "create", error);
      }
      await this.#db.computers.setImages(dotId, created.goldenImage, created.runtimeImage);
      await this.#startLocked(dotId);
    });
  }

  /**
   * Make sure the Dot can take work: start a stopped computer, finish the
   * READY procedure of a running one that is not READY yet. Resolves once
   * READY; throws (and leaves the Dot in ERROR) when that fails.
   */
  async ensureReady(dotId: string): Promise<void> {
    if (this.#ready.has(dotId)) return;
    await this.#mutex.run(dotId, () => this.#ensureReadyLocked(dotId));
  }

  async #ensureReadyLocked(dotId: string): Promise<void> {
    if (this.#ready.has(dotId)) return;
    const computer = await this.#db.computers.get(dotId);
    if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
    if (computer.state === "DELETING") throw new ControlPlaneError(409, "dot_deleting", `Dot ${dotId} is being deleted`);
    if (computer.state === "PROVISIONING") {
      throw new ControlPlaneError(409, "dot_provisioning", `Dot ${dotId} is still being provisioned`);
    }
    const vm = await this.#driver.state(dotId);
    if (vm.state === "RUNNING" && vm.guestPort !== null) {
      await this.#adoptRunning(dotId, { ...vm, guestPort: vm.guestPort });
    } else {
      await this.#startLocked(dotId);
    }
  }

  /**
   * Start a stopped computer for an automation that is due, if it still is one: the pass that chose it read the
   * database before this turn of the per-Dot lock came, and the person may have stopped the computer since (a stop
   * that is not started for its automations), or the guest reported another time. The rule is read again, under the
   * lock, from the same place the pass read it (`stoppedDotsWithAutomationDue`); true when the computer was started.
   */
  async wakeForAutomation(dotId: string): Promise<boolean> {
    if (this.#ready.has(dotId)) return false;
    return this.#mutex.run(dotId, async () => {
      if (!(await this.stoppedDotsWithAutomationDue()).includes(dotId)) return false;
      await this.#ensureReadyLocked(dotId);
      return true;
    });
  }

  async #startLocked(dotId: string): Promise<void> {
    const spec = await this.#spec(dotId);
    if (!spec.goldenImage) {
      return this.#fail(dotId, "start", new Error("the computer has no golden image recorded; it was never created"));
    }
    await this.#setVmState(dotId, "STARTING");
    let started;
    try {
      started = await this.#driver.start({ ...spec, goldenImage: spec.goldenImage });
    } catch (error) {
      await this.#db.computers.setProcess(dotId, null).catch(() => {});
      return this.#fail(dotId, "start", error);
    }
    await this.#recordStarted(dotId, started, spec.goldenImage, started.alreadyRunning ? { already_running: true } : {});
    await this.#readyProcedure(dotId);
  }

  /**
   * A running VM this process did not start (after a control plane restart,
   * or after a failed READY). Its port and pid are what QEMU and its pid
   * file say now; the row is brought in line with them when it differs.
   */
  async #adoptRunning(dotId: string, vm: ComputerState & { guestPort: number }): Promise<void> {
    const computer = await this.#db.computers.get(dotId);
    const pid = vm.pid ?? computer?.pid ?? null;
    if (pid === null) {
      return this.#fail(dotId, "attach to the running computer", new Error("QEMU runs but neither its pid file nor the database names its pid"));
    }
    if (computer?.guest_port !== vm.guestPort || computer?.pid !== pid) {
      this.#log.info("recording the running VM's process", { dotId, guestPort: vm.guestPort, pid });
      await this.#db.computers.setProcess(dotId, { guestPort: vm.guestPort, pid });
    }
    await this.#setVmState(dotId, "RUNNING", null);
    await this.#readyProcedure(dotId);
  }

  #generationOf(dotId: string): number {
    return this.#generation.get(dotId) ?? 0;
  }

  /**
   * Push what the guest must hold: the OpenRouter key and the secrets the
   * config's MCP servers name (memory only in the guest, so lost with every
   * agent restart), then the runtime config, all read from the database now.
   * The one place that does this, for READY, for a changed key, secret or
   * config, and after an agent restart.
   */
  async #push(dotId: string, guest: GuestApi): Promise<void> {
    const key = await this.#db.secrets.openRouterKey(dotId);
    if (!key) throw new NotReadyError(dotId, `${MISSING_KEY_MESSAGE}; set one with PUT /api/secrets/openrouter`);
    const dot = await this.#db.dots.get(dotId);
    if (!dot) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} not found`);
    const mcpSecrets = await this.#db.secrets.mcpSecrets(dotId, dot.config.mcp_servers);
    try {
      await guest.pushSecrets({ openrouter_api_key: key, mcp_secrets: mcpSecrets });
    } catch (error) {
      // Never the guest's own words here: whatever answered may have echoed a secret.
      throw new Error(`the guest did not take the OpenRouter key and the MCP secrets (${describeWithoutBody(error)})`);
    }
    await guest.putConfig(toRuntimeConfig(dot.config));
  }

  /**
   * Section 9.3: wait for dot-agentd and the agent, push the OpenRouter key,
   * push the runtime config, then require the agent to report the key and
   * every self-check. Only then is the Dot READY and its events pumped.
   */
  async #readyProcedure(dotId: string): Promise<void> {
    const computer = await this.#db.computers.get(dotId);
    if (computer?.guest_port == null) {
      return this.#fail(dotId, "READY", new Error("the computer has no guest port recorded"));
    }
    // A pump of an earlier start reads a port that is gone and never comes back on its own.
    await this.#stopPump(dotId);
    const endpoint = { dotId, port: computer.guest_port };
    const token = await this.#db.computers.token(dotId);
    const guest = this.#driver.guest(endpoint, token);
    let health: HealthAnswer;
    try {
      health = await this.#driver.waitForHealth(endpoint, token, {
        timeoutMs: this.#opts.readyTimeoutMs,
        intervalMs: this.#opts.healthPollMs,
        requestTimeoutMs: this.#opts.healthRequestTimeoutMs,
      });
    } catch (error) {
      if ((error as { status?: unknown }).status === 401) {
        return this.#fail(dotId, "READY", new Error("the guest refused the Dot token (401)"));
      }
      return this.#fail(dotId, "READY (waiting for the guest)", error);
    }

    let agentState;
    for (;;) {
      const generation = this.#generationOf(dotId);
      try {
        await this.#push(dotId, guest);
        health = await guest.health({ timeoutMs: this.#opts.healthRequestTimeoutMs });
      } catch (error) {
        return this.#fail(dotId, error instanceof NotReadyError ? "READY" : "READY (secret and config push)", error);
      }
      const problems: string[] = [];
      if (health.agent.status !== "ok") problems.push(`agent status ${health.agent.status}`);
      else {
        if (!health.agent.openrouter_configured) problems.push("the agent does not report the OpenRouter key as configured");
        const checks = health.agent.checks;
        if (!checks) problems.push("the agent reports no self-checks");
        else {
          if (!checks.filesystem_writable) problems.push("filesystem not writable");
          if (!checks.network_reachable) problems.push("network not reachable");
          if (!checks.browser_installed) problems.push("browser layer not installed");
        }
      }
      if (problems.length > 0) {
        return this.#fail(dotId, "READY", new NotReadyError(dotId, problems.join("; ")));
      }
      try {
        agentState = await guest.state();
      } catch (error) {
        return this.#fail(dotId, "READY (agent state)", error);
      }
      // A key or a config stored while this procedure pushed was refused by
      // syncGuest (the Dot was not READY yet): push again, then decide.
      // The comparison and the add below run without an await between them.
      if (this.#generationOf(dotId) === generation) break;
      this.#log.info("key or config changed during READY, pushing again", { dotId });
    }
    this.#ready.add(dotId);
    await this.#db.computers.touch(dotId, this.#clock.now());
    // The status comes from the state snapshot before the pump starts, so a
    // pumped agent.state, which is newer than the snapshot, always wins.
    await this.#setDotStatus(dotId, dotStatusForAgent(agentState.state));
    this.#startPump(dotId);
    this.#log.info("dot ready", { dotId, agent: agentState.state });
    this.#onReady(dotId);
    this.#onWorkPossible();
  }

  /**
   * Take the Dot out of READY before anything that ends its computer's run:
   * from here on every delivery and every push goes through the per-Dot
   * lock, which the caller holds. A push already on its way is waited for.
   * Returns whether the Dot was READY.
   */
  async #leaveReady(dotId: string): Promise<boolean> {
    const wasReady = this.#ready.delete(dotId);
    await this.#pushes.run(dotId, async () => {});
    return wasReady;
  }

  /**
   * Whether an idle sleep may still go ahead, read again under the per-Dot
   * lock: the Dot is READY with an IDLE agent and has no work. Work that
   * arrived after the idle check (a claimed task, a message, an approval)
   * is pending in the database by now, also when its send is in flight.
   */
  async #stillIdle(dotId: string): Promise<boolean> {
    const [dot, computer] = await Promise.all([this.#db.dots.get(dotId), this.#db.computers.get(dotId)]);
    if (dot?.status !== "READY" || computer?.state !== "RUNNING") return false;
    return !(await this.keepsAwake(dotId));
  }

  /**
   * Whether the Dot has something that makes an idle sleep pointless (section 9.5): work (`tasks.hasWork`), or an
   * automation due within the wake lead time, past ones included (the guest makes a missed run when it starts, and a
   * computer put to sleep now would be started again at once).
   */
  async keepsAwake(dotId: string): Promise<boolean> {
    const now = this.#clock.now();
    if (await this.#db.tasks.hasWork(dotId, now)) return true;
    const dueAt = (await this.#db.computers.get(dotId))?.next_automation_at;
    return dueAt != null && Date.parse(dueAt) <= now.getTime() + this.#opts.automationWakeLeadMs;
  }

  /**
   * The Dots whose computer is stopped and has an automation due within the wake lead time: the ones to start so
   * their guest is ready when the run is due (or, for a run already missed, makes it as it starts).
   */
  stoppedDotsWithAutomationDue(): Promise<string[]> {
    return this.#db.computers.stoppedWithAutomationBy(new Date(this.#clock.now().getTime() + this.#opts.automationWakeLeadMs));
  }

  /**
   * Put the Dot to sleep, or stop it on the user's request (section 9.5). The reason is recorded with the computer: a
   * computer the person stopped is not started for its automations until the person starts it again, also when it was
   * already asleep.
   */
  stop(dotId: string, reason: StopRequest): Promise<void> {
    return this.#mutex.run(dotId, () => this.#stopLocked(dotId, reason, true));
  }

  /**
   * The stop, with the per-Dot lock held. An idle stop that is asked for now checks again that the Dot is idle
   * (`recheckIdle`); one that recovery finds half done does not: the shutdown began before the control plane went
   * down, the guest may already have taken prepare-sleep, and calling it off would leave a computer that runs without
   * being READY. It is finished, and the pass wakes the computer if the work that came meanwhile needs it.
   */
  async #stopLocked(dotId: string, reason: StopRequest, recheckIdle: boolean): Promise<void> {
    const computer = await this.#db.computers.get(dotId);
    if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
    if (computer.state === "STOPPED") {
      // The person's stop of a computer that is asleep: it is not started for its automations from now on, which every
      // view of the computer (its automations note) learns from the event, as it learns of any other stop.
      if (reason === "user" && computer.stop_reason !== "user") {
        await this.#commit(async (tx, log) => {
          await log(dotId, "computer.stopped", { reason, forced: false });
          await tx.computers.setState(dotId, "STOPPED", undefined, "user");
        });
      }
      return;
    }
    if (computer.state === "DELETING" || computer.state === "PROVISIONING") {
      throw new ControlPlaneError(409, "invalid_state", `Dot ${dotId} cannot be stopped while ${computer.state}`);
    }
    const wasReady = await this.#leaveReady(dotId);
    if (reason === "idle" && recheckIdle && !(await this.#stillIdle(dotId))) {
      if (wasReady) this.#ready.add(dotId);
      this.#log.info("idle sleep called off: work arrived meanwhile", { dotId });
      return;
    }
    this.#log.info("stopping computer", { dotId, reason });
    await this.#setVmState(dotId, "STOPPING", undefined, reason);
    if (wasReady) {
      try {
        const guest = await this.guest(dotId);
        await guest.prepareSleep(this.#opts.prepareSleepTimeoutMs);
      } catch (error) {
        // The shutdown still happens: the guest flushes its own state on SIGTERM too.
        this.#log.warn("prepare-sleep failed, shutting down anyway", { dotId, error: errorMessage(error) });
      }
    }
    await this.#stopPump(dotId);
    let result;
    try {
      result = await this.#driver.stop(dotId, await this.#db.computers.token(dotId));
    } catch (error) {
      return this.#fail(dotId, "stop", error);
    }
    await this.#recordStopped(dotId, reason, result.forced);
  }

  /**
   * A reboot is a clean stop and a start of the same VM (the agent flushes
   * its state first, as before a sleep), so a new runtime ISO and new
   * resources apply. The port changes; the READY procedure runs against the
   * new one.
   */
  reboot(dotId: string): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const computer = await this.#db.computers.get(dotId);
      if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
      if (!computerIsUp(computer.state)) {
        throw new ControlPlaneError(409, COMPUTER_STOPPED, `Dot ${dotId} cannot be rebooted while ${computer.state}`);
      }
      const spec = await this.#spec(dotId);
      if (!spec.goldenImage) {
        return this.#fail(dotId, "reboot", new Error("the computer has no golden image recorded; it was never created"));
      }
      if (await this.#leaveReady(dotId)) {
        try {
          await (await this.guest(dotId)).prepareSleep(this.#opts.prepareSleepTimeoutMs);
        } catch (error) {
          this.#log.warn("prepare-sleep before reboot failed, rebooting anyway", { dotId, error: errorMessage(error) });
        }
      }
      await this.#stopPump(dotId);
      await this.#setVmState(dotId, "STARTING");
      let started;
      try {
        started = await this.#driver.reboot({ ...spec, goldenImage: spec.goldenImage });
      } catch (error) {
        await this.#db.computers.setProcess(dotId, null).catch(() => {});
        return this.#fail(dotId, "reboot", error);
      }
      await this.#recordStarted(dotId, started, spec.goldenImage, { reboot: true });
      await this.#readyProcedure(dotId);
    });
  }

  /** Destroy the VM and its disk, then remove the Dot's rows (the event log keeps its history). */
  remove(dotId: string): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const dot = await this.#db.dots.get(dotId);
      if (!dot) return;
      await this.#setVmState(dotId, "DELETING");
      await this.#leaveReady(dotId);
      await this.#stopPump(dotId);
      try {
        await this.#driver.destroy(dotId);
      } catch (error) {
        return this.#fail(dotId, "delete", error);
      }
      await this.#commit(async (tx, log) => {
        await log(dotId, "dot.deleted", { name: dot.name });
        await tx.dots.delete(dotId);
      });
      this.#log.info("dot deleted", { dotId, name: dot.name });
    });
  }

  /**
   * The key or the config the guest must hold changed (a PATCH, a new key,
   * an agent that restarted and lost its key): push both to a READY guest
   * now. A Dot that is not READY gets them from its READY procedure, which
   * sees the change through the generation and pushes again if it was
   * already past its own push. True when this call pushed.
   */
  async syncGuest(dotId: string): Promise<boolean> {
    this.#generation.set(dotId, this.#generationOf(dotId) + 1);
    if (!this.#ready.has(dotId)) return false;
    return this.#pushes.run(dotId, async () => {
      if (!this.#ready.has(dotId)) return false;
      await this.#push(dotId, await this.guest(dotId));
      return true;
    });
  }

  readyDots(): string[] {
    return [...this.#ready];
  }

  /** A failed call means the guest may be gone: the next delivery re-checks READY instead of trusting it. */
  markSuspect(dotId: string): void {
    this.#ready.delete(dotId);
  }

  #runInBackground(what: string, dotId: string, work: () => Promise<unknown>): void {
    if (this.#closed) return;
    const tracked: Promise<unknown> = work()
      .catch((error) => this.#log.error(`${what} failed`, { dotId, error: errorMessage(error) }))
      .finally(() => this.#background.delete(tracked));
    this.#background.add(tracked);
  }

  /** Whether work this class started in the background is still running. */
  get busy(): boolean {
    return this.#background.size > 0;
  }

  /** Wait for the work this class started in the background (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  #startPump(dotId: string): void {
    if (this.#pumps.has(dotId) || this.#closed) return;
    const controller = new AbortController();
    this.#pumps.set(dotId, controller);
    const done = this.#pump(dotId, controller.signal).finally(() => {
      if (this.#pumps.get(dotId) === controller) this.#pumps.delete(dotId);
      if (this.#pumpDone.get(dotId) === done) this.#pumpDone.delete(dotId);
    });
    this.#pumpDone.set(dotId, done);
  }

  async #stopPump(dotId: string): Promise<void> {
    this.#pumps.get(dotId)?.abort();
    await this.#pumpDone.get(dotId);
  }

  /**
   * Consume the guest's outbound stream from the stored cursor. Every event
   * is stored, applied and the cursor advanced in ONE transaction, so a crash
   * between two events loses nothing and applies nothing twice. On a failure
   * the loop starts over from the cursor in the database, unless the VM's
   * QEMU is gone: then the pump ends and the computer is recorded as stopped.
   */
  async #pump(dotId: string, signal: AbortSignal): Promise<void> {
    let delay = this.#opts.pumpRetryMs;
    while (!signal.aborted) {
      try {
        const computer = await this.#db.computers.get(dotId);
        if (!computer) return;
        const guest = await this.guest(dotId);
        this.#log.debug("event pump connecting", { dotId, after: computer.event_cursor });
        for await (const event of guest.events({ after: computer.event_cursor, signal, onRefused: (info) => this.#refused(dotId, info) })) {
          if (signal.aborted) return;
          await this.handleGuestEvent(dotId, event);
          delay = this.#opts.pumpRetryMs;
        }
        if (signal.aborted) return;
        this.#log.warn("guest event stream ended", { dotId });
      } catch (error) {
        if (signal.aborted) return;
        this.#log.warn("event pump failed, retrying", { dotId, error: errorMessage(error), retryMs: delay });
      }
      if (await this.#qemuGone(dotId)) {
        this.#runInBackground("recording a VM that stopped by itself", dotId, () => this.#exited(dotId));
        return;
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, this.#opts.pumpMaxRetryMs);
    }
  }

  async #qemuGone(dotId: string): Promise<boolean> {
    try {
      return (await this.#driver.state(dotId)).state === "STOPPED";
    } catch {
      return false;
    }
  }

  /**
   * The QEMU of a READY Dot exited without a stop from the control plane: the
   * guest powered itself off, or QEMU crashed or was killed. The computer is
   * recorded as stopped; when the Dot still has work (`keepsAwake`: a task, or
   * an automation due within the wake lead time), it is started again so its
   * guest picks that work up (section 9.5).
   */
  async #exited(dotId: string): Promise<void> {
    const recorded = await this.#mutex.run(dotId, async () => {
      const computer = await this.#db.computers.get(dotId);
      // A stop, reboot or start under the lock already dealt with it.
      if (computer?.state !== "RUNNING" || !(await this.#qemuGone(dotId))) return false;
      this.#ready.delete(dotId);
      await this.#stopPump(dotId);
      this.#log.warn("the VM stopped without being asked to", { dotId });
      await this.#recordStopped(dotId, "exited", false);
      return true;
    });
    if (recorded && (await this.keepsAwake(dotId))) {
      this.#log.info("the Dot still has work, starting its computer again", { dotId });
      this.#runInBackground("restart after an unexpected stop", dotId, () => this.ensureReady(dotId));
    }
  }

  /**
   * The guest sent a message the host's schema refused. It is not stored as the guest's event (it is not one), but it is
   * not lost with a log line either: a `guest.event.refused` host event says that it happened and what was wrong, and
   * the cursor moves past it in the same transaction, so a reconnect does not read it again. An engine and a host that
   * disagree on an event would otherwise leave the Dot with a state nobody can see (an approval that is never shown).
   */
  async #refused(dotId: string, info: RefusedEvent): Promise<void> {
    const now = this.#clock.now();
    const stored = await this.#db.transaction(async (tx) => {
      const logged = await this.#events.appendHostIn(tx, dotId, "guest.event.refused", info);
      if (info.seq !== null) await tx.computers.advanceCursor(dotId, info.seq, now);
      return logged;
    });
    this.#events.publish(stored);
  }

  /** Store and apply one guest event; exported for recovery tools and tests. */
  async handleGuestEvent(dotId: string, event: OutboundEvent): Promise<StoredEvent | null> {
    const now = this.#clock.now();
    const { stored, applied } = await this.#db.transaction(async (tx) => {
      // The event first: its insert takes the event-order lock (events.ts).
      const stored = await this.#events.appendGuest(tx, dotId, event);
      await tx.computers.advanceCursor(dotId, event.seq, now);
      const applied = stored ? await applyGuestEvent(tx, dotId, event) : { taskSettled: false };
      return { stored, applied };
    });
    if (stored) this.#events.publish(stored);
    if (applied.taskSettled) this.#onWorkPossible();
    if (stored && event.type === "agent.started") {
      // The agent process restarted inside a running VM: it lost the key it keeps in memory.
      this.#runInBackground("pushing the key again after an agent restart", dotId, async () => {
        try {
          await this.syncGuest(dotId);
        } catch (error) {
          this.markSuspect(dotId);
          throw error;
        }
      });
    }
    return stored;
  }

  /**
   * After a control plane restart: bring the database in line with the QEMU
   * processes that are actually running (pid files and process liveness,
   * never the rows),
   * finish interrupted operations, and run the READY procedure for every
   * computer that is still running. Returns once each Dot's recovery has
   * started; the slow parts continue in the background.
   */
  async recover(): Promise<Promise<void>[]> {
    const background: Promise<void>[] = [];
    const track = (dotId: string, what: string, work: Promise<void>) =>
      background.push(work.catch((error) => this.#log.error(`recovery: ${what} failed`, { dotId, error: errorMessage(error) })));

    for (const computer of await this.#db.computers.list()) {
      const dotId = computer.dot_id;
      if (computer.state === "PROVISIONING") {
        this.#log.info("recovery: resuming provisioning", { dotId });
        track(dotId, "provisioning", this.provision(dotId));
        continue;
      }
      if (computer.state === "DELETING") {
        this.#log.info("recovery: resuming deletion", { dotId });
        track(dotId, "deletion", this.remove(dotId));
        continue;
      }
      let vm;
      try {
        vm = await this.#driver.state(dotId);
      } catch (error) {
        this.#log.error("recovery: cannot read the VM state", { dotId, error: errorMessage(error) });
        continue;
      }
      if (!vm.exists) {
        await this.#db.computers.setProcess(dotId, null);
        await this.#recordError(dotId, "the VM disk is missing");
        continue;
      }
      if (vm.state === "RUNNING") {
        if (computer.state === "STOPPING") {
          this.#log.info("recovery: finishing an interrupted stop", { dotId });
          // The reason the stop was asked for was recorded with STOPPING; setting RUNNING clears it.
          await this.#db.computers.setState(dotId, "RUNNING");
          const reason = computer.stop_reason === "idle" ? "idle" : "user";
          track(dotId, "stop", this.#mutex.run(dotId, () => this.#stopLocked(dotId, reason, false)));
        } else if (vm.guestPort === null) {
          await this.#recordError(dotId, "QEMU runs but has no forward to the guest port, so the guest cannot be reached");
        } else {
          // The port comes from the pid file, so a row that missed it (the
          // control plane stopped between the spawn and the update) is
          // corrected here; the READY procedure then checks the guest.
          const running = { ...vm, guestPort: vm.guestPort };
          this.#log.info("recovery: reattaching to a running computer", { dotId, was: computer.state, pid: vm.pid });
          track(dotId, "reattach", this.#mutex.run(dotId, () => this.#adoptRunning(dotId, running)));
        }
      } else if (vm.state === "STOPPED") {
        if (computer.state !== "STOPPED") {
          this.#log.info("recovery: computer is off", { dotId, was: computer.state });
          // A stop that was under way keeps its reason; a VM that went off with the control plane down exited by itself.
          // Either way the stop is told now: the control plane went down before it could.
          await this.#recordStopped(dotId, computer.stop_reason ?? "exited", false, true);
        } else if (computer.guest_port !== null || computer.pid !== null) {
          await this.#db.computers.setProcess(dotId, null);
        }
      } else {
        await this.#recordError(dotId, `the VM is ${vm.state}${vm.detail ? `: ${vm.detail}` : ""}`);
      }
    }
    return background;
  }

  /** Stop every pump and release the driver's host resources. VMs keep running. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#pumps.values()) controller.abort();
    await Promise.all(this.#pumpDone.values());
    await this.settle();
    await this.#driver.close();
  }
}
