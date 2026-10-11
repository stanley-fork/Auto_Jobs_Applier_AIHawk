/**
 * In-process stand-ins for the VM layer and the guest agent, used by the
 * scheduler and API tests. FakeGuest follows the guest protocol of
 * architecture section 5: health that comes up after a boot, a key held in
 * memory only (lost on every reboot and every agent restart), `agent.started`
 * at every start of the agent, inbound events accepted once per id, an
 * outbox with monotonically increasing `seq` replayed after a cursor, and
 * browser identities under the same rules as the real agent's, and a small
 * file system (`putFile`) served through the files routes with the real
 * daemon's errors, the automations its engine runs (`putAutomation`) and a small tool table.
 */
import { crc32, deflateSync } from "node:zlib";
import {
  checkIdentityRequest,
  IDENTITY_ERROR_STATUS,
  FILE_TOO_LARGE,
  mcpPermission,
  mcpServerNames,
  GUEST_PATHS,
  IdentityRequestError,
  newId,
  newIdentityId,
  pollGuestHealth,
  type AgentState,
  type AgentStateAnswer,
  type BrowserIdentity,
  type BrowserIdentityListAnswer,
  type CreateBrowserIdentityRequest,
  type DotRuntimeConfig,
  type FileEntry,
  type FileListAnswer,
  type GuestChecks,
  type HealthAnswer,
  type IdentityErrorCode,
  type InboundEvent,
  type OutboundEvent,
  type OutboundEventDataMap,
  type OutboundEventType,
  type PermissionName,
  type RefusedEvent,
  type SecretsRequest,
  type SystemAnswer,
  type ToolInfo,
  type Skill,
  type SkillListAnswer,
  type ToolListAnswer,
  type VmState,
} from "@invisible-dots/shared";
import type {
  ComputerDriver,
  ComputerSpecInput,
  ComputerState,
  CreatedComputer,
  GuestApi,
  GuestEndpoint,
  StartedComputer,
  WaitForHealthOptions,
} from "./driver.js";

/** The fake desktop's size: a picture a browser draws with real proportions, so a page that shows it is laid out as it will be. */
const FAKE_DESKTOP = { width: 1280, height: 800 } as const;

/**
 * A job of the fake's engine, with the fields of nanobot's CronJob that decide when it runs and that a test reads back.
 * The host never lists the jobs (they are the Dot's, made and changed through its cron tool); it hears only when the
 * earliest is next due (`automation.next_run`).
 */
export interface FakeAutomation {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: "at" | "every" | "cron"; at_ms?: number; every_ms?: number; expr?: string; tz?: string };
  message: string;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_status: "ok" | "error" | "skipped" | null;
  last_error: string | null;
  delete_after_run: boolean;
  created_at_ms: number;
}

let desktop: Uint8Array | undefined;

/** A real PNG of the fake desktop, one flat colour, made once. */
function desktopPng(): Uint8Array {
  if (desktop) return desktop;
  const { width, height } = FAKE_DESKTOP;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([24, 32, 48], y * stride + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 2; // RGB
  desktop = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  return desktop;
}

/** The error shape of vm-manager's GuestRequestError: a status (0 = unreachable) and the guest's code. */
/** The most browser identities the engine keeps (`DEFAULT_MAX_IDENTITIES` in nanobot/dots/main.py). */
export const FAKE_MAX_IDENTITIES = 20;

export class FakeGuestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FakeGuestError";
  }
}

export type InboundHandler = (event: InboundEvent, guest: FakeGuest) => void | Promise<void>;

/**
 * The default agent: a task runs at once and completes; a message gets an
 * answer; an approval resumes and completes the task it belongs to.
 */
export const completeEverything: InboundHandler = (event, guest) => {
  switch (event.type) {
    case "task.created":
      guest.emit("agent.state", { state: "THINKING" });
      guest.emit("task.started", { task_id: event.data.task_id });
      guest.emit("task.completed", { task_id: event.data.task_id, summary: `done: ${event.data.description}` });
      guest.emit("agent.state", { state: "IDLE" });
      break;
    case "user.message":
      guest.emit("message.assistant", { text: `echo: ${event.data.text}`, in_reply_to: event.id });
      break;
    case "approval.received": {
      const pending = guest.pendingApproval;
      guest.pendingApproval = null;
      guest.emit("agent.state", { state: "EXECUTING" });
      if (pending?.task_id) {
        guest.emit("task.completed", { task_id: pending.task_id, summary: `approval ${event.data.decision}d` });
      }
      guest.emit("agent.state", { state: "IDLE" });
      break;
    }
    default:
      break;
  }
};

export class FakeGuest implements GuestApi {
  /** Whether the VM is powered on; every call fails as unreachable when it is not. */
  running = false;
  /** Health polls answered with agent "starting" after each boot before it reports "ok". */
  bootPolls = 1;
  #pollsSinceBoot = 0;
  #bootedAt = 0;
  agentState: AgentState = "IDLE";
  openrouterKey: string | null = null;
  /** The MCP servers' secrets the host pushed last, by server and name. */
  mcpSecrets: SecretsRequest["mcp_secrets"] = {};
  config: DotRuntimeConfig | null = null;
  checks: GuestChecks = { filesystem_writable: true, network_reachable: true, browser_installed: true };
  readonly outbox: OutboundEvent[] = [];
  readonly inbound: InboundEvent[] = [];
  readonly identities = new Map<string, BrowserIdentity>();
  /** The files of the guest by absolute path; directories exist where a file is under them (and home always). */
  readonly files = new Map<string, { content: Uint8Array; mtime: Date }>();
  /** Symbolic links of the guest: the absolute path of the link to its target (an absolute path). */
  readonly links = new Map<string, string>();
  /** The automations of the Dot by id (its cron tool made them). */
  readonly automations = new Map<string, FakeAutomation>();
  /**
   * The tools the fake's engine has: the real table's shape, a few rows; `offered` follows the permissions of the
   * config, as the engine's `offered_tools` does.
   */
  readonly tools: Omit<ToolInfo, "offered">[] = [
    { name: "exec", permission: "computer.exec", description: "Run a shell command on the computer." },
    { name: "read_file", permission: "files.read", description: "Read a file." },
    { name: "write_file", permission: "files.write", description: "Write a file." },
    { name: "cron", permission: "automations", description: "Schedule reminders and recurring tasks." },
    { name: "browser_identity_list", permission: "browser.identity.list", description: "List the browser identities." },
    { name: "browser_identity_create", permission: "browser.identity.create", description: "Create a browser identity." },
  ];
  /**
   * The tools each declared MCP server serves, by server; a server of the config with none here serves none. A server
   * named in `mcpFailures` is failed with that error instead, as the engine reports a server it could not start.
   */
  readonly mcpTools = new Map<string, Omit<ToolInfo, "offered" | "permission">[]>();
  readonly mcpFailures = new Map<string, string>();
  /** The skills the fake's engine shows: one built-in by default, as the real one ships; a test adds the Dot's own. */
  skills: Skill[] = [
    {
      name: "invisible-playwright",
      description: "Use the Dot's browser for any task on a website.",
      source: "builtin",
      path: "/opt/invisible-dots/engine/skills/invisible-playwright/SKILL.md",
      content: "---\nname: invisible-playwright\ndescription: Use the Dot's browser for any task on a website.\n---\n\n# The browser\n",
    },
  ];
  readonly calls: string[] = [];
  pendingApproval: { approval_id: string; task_id?: string } | null = null;
  onInbound: InboundHandler = completeEverything;
  /** While set, a frame of an open identity answers 503 `busy`, as when a call of the Dot holds the browser. */
  identityBusy = false;
  /** While set, a frame of an open identity answers with this code and its status of the shared table, as when the engine's browser fails. */
  identityFault: IdentityErrorCode | null = null;
  /** When set, `postEvent` fails with it once. */
  failNextPost: Error | null = null;
  boots = 0;
  /** The guest's clock, in ms since the epoch: what its engine compares the jobs' times with at a boot. */
  now: () => number = () => Date.now();
  #seq = 0;
  /** Messages the guest sent that the host will refuse, each after the `seq` of the last event the guest had written when it was sent. */
  #refusals: { info: RefusedEvent; after: number }[] = [];
  #wakers = new Set<() => void>();
  #streams = new Set<AbortController>();

  constructor(readonly token: string) {}

  boot(): void {
    this.running = true;
    this.boots++;
    this.#pollsSinceBoot = 0;
    this.#bootedAt = Date.now();
    this.openrouterKey = null;
    this.mcpSecrets = {};
    this.agentState = "IDLE";
    this.emit("agent.started", {});
    this.#catchUp();
  }

  /**
   * What the engine does at a start (CronService.start): a job whose time came while the computer was off runs once,
   * late, and moves on (a recurring job counts its next run from now, a one-time one is over), then the engine reports
   * the earliest next run when it differs from what the host was last told.
   */
  #catchUp(): void {
    const now = this.now();
    for (const job of [...this.automations.values()]) {
      if (!job.enabled || job.next_run_at_ms === null || job.next_run_at_ms > now) continue;
      const ran = { ...job, last_run_at_ms: now, last_status: "ok" as const, last_error: null };
      if (job.schedule.kind === "at") {
        if (job.delete_after_run) this.automations.delete(job.id);
        else this.automations.set(job.id, { ...ran, enabled: false, next_run_at_ms: null });
      } else {
        const every = job.schedule.kind === "every" ? (job.schedule.every_ms ?? 60_000) : 24 * 3_600_000;
        this.automations.set(job.id, { ...ran, next_run_at_ms: now + every });
      }
    }
    this.#reportNextRun();
  }

  /**
   * The agent process restarts inside a running VM (systemd after a crash):
   * its key is gone, its event stream drops, and it announces its start.
   */
  restartAgent(): void {
    this.agentRestarts++;
    this.openrouterKey = null;
    this.mcpSecrets = {};
    this.disconnectStreams();
    this.emit("agent.started", {});
  }

  agentRestarts = 0;

  powerOff(): void {
    this.running = false;
    this.disconnectStreams();
  }

  /** End every open event stream, as a dropped connection would. */
  disconnectStreams(): void {
    for (const controller of this.#streams) controller.abort();
    this.#streams.clear();
    this.#wake();
  }

  #wake(): void {
    for (const w of [...this.#wakers]) w();
  }

  #openIdentities(): BrowserIdentity[] {
    return [...this.identities.values()].filter((identity) => identity.status === "open");
  }

  /** The Dot opens an identity's browser (the engine does it for a tool call; the host only observes it). */
  launchIdentity(id: string): void {
    const identity = this.identities.get(id);
    if (!identity) throw new Error(`no identity ${id}`);
    this.identities.set(id, { ...identity, status: "open", lastUsedAt: new Date().toISOString() });
    this.emit("browser.identity.launched", { identity_id: id, name: identity.name });
  }

  #reachable(what: string): void {
    this.calls.push(what);
    if (!this.running) {
      if (this.#rebootDelayMs !== null) {
        setTimeout(() => this.boot(), this.#rebootDelayMs);
        this.#rebootDelayMs = null;
      }
      throw new FakeGuestError(0, `${what}: connect ECONNREFUSED (the VM is off)`, "ECONNREFUSED");
    }
  }

  #rebootDelayMs: number | null = null;

  /**
   * Power off and come back `delayMs` after the first call that finds the
   * guest down. A real reboot is seconds of downtime that a poll always sees;
   * booting on a plain timer instead would let a slow test machine miss it.
   */
  reboot(delayMs: number): void {
    this.powerOff();
    this.#rebootDelayMs = delayMs;
  }

  /** Append an outbound event to the outbox, as the agent does before streaming it. */
  emit<T extends OutboundEventType>(type: T, data: OutboundEventDataMap[T]): OutboundEvent {
    if (type === "agent.state") this.agentState = (data as { state: AgentState }).state;
    if (type === "approval.requested") {
      const d = data as OutboundEventDataMap["approval.requested"];
      this.pendingApproval = { approval_id: d.approval_id, ...(d.task_id ? { task_id: d.task_id } : {}) };
      this.agentState = "WAITING_APPROVAL";
    }
    const event = { seq: ++this.#seq, id: newId("evt"), type, ts: new Date().toISOString(), data } as OutboundEvent;
    this.outbox.push(event);
    this.#wake();
    return event;
  }

  /**
   * The engine writes an event of this type that the host's schema does not take: it has a `seq` (the next one) and the
   * stream carries it, but the host refuses it. What follows is stored as usual.
   */
  writeUnreadable(type: string, problem: string): void {
    this.#refusals.push({ info: { seq: ++this.#seq, type, problem }, after: this.outbox.at(-1)?.seq ?? 0 });
    this.#wake();
  }

  /** The stream carries a message that is not JSON, so it has no `seq` and no type to name. */
  sendGarbage(problem: string): void {
    this.#refusals.push({ info: { seq: null, type: null, problem }, after: this.outbox.at(-1)?.seq ?? 0 });
    this.#wake();
  }

  /** Ask for an approval from inside a task, as the policy engine does on `ask`. */
  requestApproval(taskId: string | undefined, tool = "browser_identity_delete", permission: PermissionName = "browser.identity.delete"): string {
    const approvalId = newId("apr");
    this.emit("agent.state", { state: "WAITING_APPROVAL" });
    this.emit("approval.requested", {
      approval_id: approvalId,
      ...(taskId ? { task_id: taskId } : {}),
      tool,
      permission,
      arguments: { identity_id: "shop-abc123" },
      reason: "the tool needs approval",
    });
    return approvalId;
  }

  async health(): Promise<HealthAnswer> {
    this.#reachable("health");
    this.#pollsSinceBoot++;
    // A real guest has been up for several seconds by the time its agent answers.
    const uptime = 5 + Math.floor((Date.now() - this.#bootedAt) / 1000);
    if (this.#pollsSinceBoot <= this.bootPolls) {
      return { agentd: "ok", agent: { status: "down" }, uptime_s: uptime };
    }
    return {
      agentd: "ok",
      agent: {
        status: "ok",
        state: this.agentState,
        openrouter_configured: this.openrouterKey !== null,
        browser: { identities: this.identities.size, open: this.#openIdentities().length },
        checks: { ...this.checks },
      },
      uptime_s: uptime,
    };
  }

  async system(): Promise<SystemAnswer> {
    this.#reachable("system");
    return {
      hostname: "invisible-dot-fake",
      uptime_s: 5 + Math.floor((Date.now() - this.#bootedAt) / 1000),
      cpus: 2,
      mem_total_bytes: 4 * 1024 ** 3,
      mem_available_bytes: 3 * 1024 ** 3,
      disk_total_bytes: 40 * 1024 ** 3,
      disk_free_bytes: 35 * 1024 ** 3,
    };
  }

  async pushSecrets(secrets: SecretsRequest): Promise<void> {
    this.#reachable("pushSecrets");
    this.openrouterKey = secrets.openrouter_api_key;
    this.mcpSecrets = structuredClone(secrets.mcp_secrets);
  }


  /** While set, `putConfig` waits for it (a slow push), and the config is stored when it resolves. */
  configPushGate: Promise<void> | null = null;

  async putConfig(config: DotRuntimeConfig): Promise<void> {
    this.#reachable("putConfig");
    await this.configPushGate;
    this.config = config;
  }

  async postEvent(event: InboundEvent): Promise<{ accepted: true }> {
    this.#reachable(`postEvent:${event.type}`);
    if (this.failNextPost) {
      const error = this.failNextPost;
      this.failNextPost = null;
      throw error;
    }
    // Like the agent's inbox: an id it already accepted is accepted again and ignored.
    if (this.inbound.some((e) => e.id === event.id)) return { accepted: true };
    this.inbound.push(event);
    await this.onInbound(event, this);
    return { accepted: true };
  }

  async state(): Promise<AgentStateAnswer> {
    this.#reachable("state");
    return { state: this.agentState, current_task_id: null, pending_approval: null };
  }

  async listBrowserIdentities(): Promise<BrowserIdentityListAnswer> {
    this.#reachable("listBrowserIdentities");
    return { identities: [...this.identities.values()] };
  }

  async createBrowserIdentity(body: CreateBrowserIdentityRequest): Promise<BrowserIdentity> {
    this.#reachable("createBrowserIdentity");
    let checked: { name: string; proxy?: string };
    try {
      // The agent's own rules, with the engine's own limit (DEFAULT_MAX_IDENTITIES in nanobot/dots/main.py).
      checked = checkIdentityRequest(body, this.identities.size, FAKE_MAX_IDENTITIES);
    } catch (error) {
      if (error instanceof IdentityRequestError) throw new FakeGuestError(error.code === "limit" ? 409 : 400, error.message, error.code);
      throw error;
    }
    const id = newIdentityId(checked.name);
    const identity: BrowserIdentity = {
      id,
      name: checked.name,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      status: "available",
      profilePath: `/home/dot/browsers/${id}/profile`,
      hasProxy: checked.proxy !== undefined,
    };
    this.identities.set(id, identity);
    this.emit("browser.identity.created", { identity_id: id, name: checked.name });
    return identity;
  }

  async getBrowserIdentity(id: string): Promise<BrowserIdentity> {
    this.#reachable("getBrowserIdentity");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `identity ${id} not found`, "not_found");
    return identity;
  }

  async deleteBrowserIdentity(id: string): Promise<void> {
    this.#reachable("deleteBrowserIdentity");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `identity ${id} not found`, "not_found");
    this.identities.delete(id);
    this.emit("browser.identity.deleted", { identity_id: id, name: identity.name });
  }

  async getBrowserIdentityFrame(id: string): Promise<Uint8Array> {
    this.#reachable("getBrowserIdentityFrame");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `no browser identity "${id}"`, "not_found");
    if (identity.status !== "open") {
      throw new FakeGuestError(409, `identity ${id} is not open; call browser_identity_launch first`, "not_open");
    }
    if (this.identityBusy) {
      throw new FakeGuestError(IDENTITY_ERROR_STATUS.busy, `browser identity "${id}" is busy with a call; ask again in a moment`, "busy");
    }
    if (this.identityFault) {
      throw new FakeGuestError(IDENTITY_ERROR_STATUS[this.identityFault], `browser identity "${id}" failed: ${this.identityFault}`, this.identityFault);
    }
    // The JPEG markers of an empty image: enough for a content check.
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  }

  async closeBrowserIdentity(id: string): Promise<void> {
    this.#reachable("closeBrowserIdentity");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `no browser identity "${id}"`, "not_found");
    if (identity.status !== "open") return;
    this.identities.set(id, { ...identity, status: "available" });
    this.emit("browser.identity.closed", { identity_id: id, name: identity.name });
  }

  /** Give the Dot an automation (its cron tool made it). */
  putAutomation(automation: FakeAutomation): void {
    this.automations.set(automation.id, automation);
    this.#reportNextRun();
  }

  /** Take an automation away (its cron tool removed it). */
  removeAutomation(id: string): void {
    this.automations.delete(id);
    this.#reportNextRun();
  }

  /**
   * What the engine does after every change of its jobs: tell the host, with an `automation.next_run` event, when the
   * earliest enabled one is due (null when none is), once per change (also at a boot, when a run made
   * late moved it: a boot with nothing changed reports nothing, the engine has told the host what it has to).
   */
  #reportNextRun(): void {
    const due = [...this.automations.values()].flatMap((a) => (a.enabled && a.next_run_at_ms !== null ? [a.next_run_at_ms] : []));
    const next = due.length > 0 ? Math.min(...due) : null;
    if (next === this.#reportedNextRun) return;
    this.#reportedNextRun = next;
    this.emit("automation.next_run", { next_run_at_ms: next });
  }

  #reportedNextRun: number | null = null;

  async listTools(): Promise<ToolListAnswer> {
    this.#reachable("listTools");
    const permissions: Record<string, string | undefined> = this.config?.permissions ?? {};
    const offered = (tool: Omit<ToolInfo, "offered">): boolean =>
      this.config !== null && (permissions[tool.permission] === "allow" || permissions[tool.permission] === "ask");
    const servers = this.config ? mcpServerNames(this.config) : [];
    const connected = servers.filter((name) => !this.mcpFailures.has(name));
    const mcpTools = connected.flatMap((name) => (this.mcpTools.get(name) ?? []).map((tool) => ({ ...tool, permission: mcpPermission(name) })));
    return {
      tools: [...this.tools, ...mcpTools].map((tool) => ({ ...tool, offered: offered(tool) })),
      mcp_servers: servers.map((name) => {
        const error = this.mcpFailures.get(name);
        return error === undefined
          ? { name, state: "connected" as const, error: null, tools: this.mcpTools.get(name)?.length ?? 0 }
          : { name, state: "failed" as const, error, tools: 0 };
      }),
    };
  }

  async listSkills(): Promise<SkillListAnswer> {
    this.#reachable("listSkills");
    return { skills: [...this.skills] };
  }

  /** Put a file in the guest's file system (the Dot wrote it). */
  putFile(path: string, content: string | Uint8Array, mtime: Date = new Date()): void {
    this.files.set(path, { content: typeof content === "string" ? new TextEncoder().encode(content) : content, mtime });
  }

  /** A symbolic link at `path` leading to `target` (absolute). */
  link(path: string, target: string): void {
    this.links.set(path, target);
  }

  /**
   * What dot-agentd's TCP listener does with a path: follow the symbolic links, and refuse (403 `outside_home`) a
   * real location that is not under home. The host's file routes always reach the guest through that listener.
   */
  #realPath(path: string): string {
    let real = path;
    for (let hops = 0; ; hops++) {
      if (hops > 40) throw new FakeGuestError(500, `${path}: too many levels of symbolic links`, "io_error");
      const key = [...this.links.keys()].filter((link) => real === link || real.startsWith(`${link}/`)).sort((a, b) => b.length - a.length)[0];
      if (key === undefined) break;
      real = this.links.get(key)! + real.slice(key.length);
    }
    if (real !== GUEST_PATHS.home && !real.startsWith(`${GUEST_PATHS.home}/`)) {
      throw new FakeGuestError(403, `the path leads outside ${GUEST_PATHS.home}`, "outside_home");
    }
    return real;
  }

  #isDirectory(path: string): boolean {
    return path === GUEST_PATHS.home || [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
  }

  async readFile(asked: string, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
    this.#reachable("readFile");
    const path = this.#realPath(asked);
    if (this.#isDirectory(path)) throw new FakeGuestError(400, `${path} is a directory; use /v1/files/list`, "is_a_directory");
    const file = this.files.get(path);
    if (!file) throw new FakeGuestError(404, `open ${path}: no such file or directory`, "not_found");
    if (options.maxBytes !== undefined && file.content.length > options.maxBytes) {
      throw new FakeGuestError(413, `the answer is larger than ${options.maxBytes} bytes`, FILE_TOO_LARGE);
    }
    return file.content;
  }

  async listFiles(asked: string): Promise<FileListAnswer> {
    this.#reachable("listFiles");
    const path = this.#realPath(asked);
    if (this.files.has(path)) throw new FakeGuestError(400, `${path} is not a directory`, "not_a_directory");
    if (!this.#isDirectory(path)) throw new FakeGuestError(404, `stat ${path}: no such file or directory`, "not_found");
    const entries = new Map<string, FileEntry>();
    for (const [file, { content, mtime }] of this.files) {
      if (!file.startsWith(`${path}/`)) continue;
      const [name, ...rest] = file.slice(path.length + 1).split("/");
      const modified = mtime.toISOString();
      const known = entries.get(name!);
      if (rest.length > 0) entries.set(name!, { name: name!, type: "dir", size: 0, mtime: known && known.mtime > modified ? known.mtime : modified });
      else entries.set(name!, { name: name!, type: "file", size: content.length, mtime: modified });
    }
    return { entries: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
  }

  async prepareSleep(): Promise<void> {
    this.#reachable("prepareSleep");
  }

  async screenshot(): Promise<Uint8Array> {
    this.#reachable("screenshot");
    return desktopPng();
  }

  /** The outbox after `after`, then every new event, until aborted or disconnected. */
  async *events(options: { after?: number; signal?: AbortSignal; onRefused?: (info: RefusedEvent) => void | Promise<void> }): AsyncGenerator<OutboundEvent> {
    this.#reachable("events");
    const own = new AbortController();
    this.#streams.add(own);
    let after = options.after ?? 0;
    const handed = new Set<object>();
    try {
      for (;;) {
        if (options.signal?.aborted) return;
        if (own.signal.aborted) throw new FakeGuestError(0, "event stream disconnected");
        // A refused message is handed over when its turn comes (after the events written before it), as the real
        // stream does, and a reconnect resumes after its `seq`.
        const refusal = this.#refusals.find((r) => !handed.has(r) && !this.outbox.some((e) => e.seq > after && e.seq <= r.after));
        if (refusal) {
          handed.add(refusal);
          if (refusal.info.seq !== null && refusal.info.seq <= after) continue;
          await options.onRefused?.(refusal.info);
          if (refusal.info.seq !== null) after = refusal.info.seq;
          continue;
        }
        const next = this.outbox.find((e) => e.seq > after);
        if (next) {
          after = next.seq;
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            this.#wakers.delete(done);
            options.signal?.removeEventListener("abort", done);
            resolve();
          };
          this.#wakers.add(done);
          options.signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.#streams.delete(own);
    }
  }
}

interface FakeVm {
  state: VmState;
  guestPort: number | null;
  pid: number | null;
  token: string;
}

export type DriverOperation = "create" | "start" | "stop" | "reboot" | "destroy";

/** The first port FakeDriver hands out; far from anything a test binds, and never really bound. */
const FAKE_FIRST_PORT = 47_000;

/**
 * A ComputerDriver that keeps its "VMs" in memory and boots a FakeGuest in
 * each. Like QEMU with a fresh port forward, every start gets a new port,
 * and a guest is reached only through the port its VM runs with now.
 */
export class FakeDriver implements ComputerDriver {
  readonly vms = new Map<string, FakeVm>();
  readonly guests = new Map<string, FakeGuest>();
  readonly calls: string[] = [];
  readonly #failures = new Map<DriverOperation, { error: Error; times: number }>();
  #nextPort = FAKE_FIRST_PORT;
  #nextPid = 9_000;
  /** Applied to every new guest, e.g. to install a custom agent behaviour. */
  configureGuest: (guest: FakeGuest) => void = () => {};
  rebootDelayMs = 30;
  goldenImage = "images/golden-test.qcow2";
  runtimeImage = "images/runtime-test.iso";

  /** Make the next `times` calls of `operation` fail with `error`. */
  failNext(operation: DriverOperation, error: Error = new Error(`${operation} failed (injected)`), times = 1): void {
    this.#failures.set(operation, { error, times });
  }

  #enter(operation: DriverOperation, dotId: string): void {
    this.calls.push(`${operation}:${dotId}`);
    const failure = this.#failures.get(operation);
    if (failure) {
      if (--failure.times <= 0) this.#failures.delete(operation);
      throw failure.error;
    }
  }

  guestOf(dotId: string): FakeGuest {
    const guest = this.guests.get(dotId);
    if (!guest) throw new Error(`no fake guest for ${dotId}`);
    return guest;
  }

  /** Power a VM off behind the control plane's back, as a crash or a host reboot would. */
  crash(dotId: string): void {
    const vm = this.vms.get(dotId);
    if (vm) Object.assign(vm, { state: "STOPPED", guestPort: null, pid: null });
    this.guests.get(dotId)?.powerOff();
  }

  async create(spec: ComputerSpecInput): Promise<CreatedComputer> {
    this.#enter("create", spec.dotId);
    if (!this.vms.has(spec.dotId)) this.vms.set(spec.dotId, { state: "STOPPED", guestPort: null, pid: null, token: spec.token });
    if (!this.guests.has(spec.dotId)) {
      const guest = new FakeGuest(spec.token);
      this.configureGuest(guest);
      this.guests.set(spec.dotId, guest);
    }
    return { goldenImage: this.goldenImage, runtimeImage: this.runtimeImage };
  }

  async start(spec: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer> {
    this.#enter("start", spec.dotId);
    const vm = this.vms.get(spec.dotId);
    if (!vm) throw new Error(`the disk of ${spec.dotId} does not exist`);
    if (vm.state === "RUNNING" && vm.guestPort !== null && vm.pid !== null) {
      return { guestPort: vm.guestPort, pid: vm.pid, runtimeImage: this.runtimeImage, alreadyRunning: true };
    }
    Object.assign(vm, { state: "RUNNING", guestPort: this.#nextPort++, pid: this.#nextPid++ });
    this.guestOf(spec.dotId).boot();
    return { guestPort: vm.guestPort!, pid: vm.pid!, runtimeImage: this.runtimeImage, alreadyRunning: false };
  }

  async stop(dotId: string, token: string) {
    this.#enter("stop", dotId);
    // Like dot-agentd: the poweroff needs the Dot's token.
    if (this.vms.get(dotId) && token !== this.vms.get(dotId)!.token) throw new FakeGuestError(401, "unauthorized", "unauthorized");
    this.crash(dotId);
    return { forced: false };
  }

  /** Like the real one: the guest goes down, comes back a moment later, and the port changes. */
  async reboot(spec: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer> {
    this.#enter("reboot", spec.dotId);
    const vm = this.vms.get(spec.dotId);
    if (!vm) throw new Error(`the disk of ${spec.dotId} does not exist`);
    Object.assign(vm, { state: "RUNNING", guestPort: this.#nextPort++, pid: this.#nextPid++ });
    this.guestOf(spec.dotId).reboot(this.rebootDelayMs);
    return { guestPort: vm.guestPort!, pid: vm.pid!, runtimeImage: this.runtimeImage, alreadyRunning: false };
  }

  /** vm-manager's rule and loop (pollGuestHealth), with "QEMU exited" as the check, as VmManager has. */
  async waitForHealth(endpoint: GuestEndpoint, token: string, options: WaitForHealthOptions): Promise<HealthAnswer> {
    const source = { address: `fake:${endpoint.port}`, health: (o: { timeoutMs?: number }) => this.guest(endpoint, token).health(o) };
    return pollGuestHealth(source, {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      check: () => {
        if (this.vms.get(endpoint.dotId)?.state !== "RUNNING") throw new Error(`QEMU of ${endpoint.dotId} is not running any more`);
      },
    });
  }

  async destroy(dotId: string) {
    this.#enter("destroy", dotId);
    this.guests.get(dotId)?.powerOff();
    this.vms.delete(dotId);
    this.guests.delete(dotId);
  }

  async state(dotId: string): Promise<ComputerState> {
    const vm = this.vms.get(dotId);
    if (!vm) return { exists: false, state: "STOPPED", pid: null, guestPort: null, detail: null };
    return { exists: true, state: vm.state, pid: vm.pid, guestPort: vm.guestPort, detail: vm.state === "RUNNING" ? "running" : null };
  }

  guest(endpoint: GuestEndpoint, token: string): GuestApi {
    const vm = this.vms.get(endpoint.dotId);
    const guest = this.guests.get(endpoint.dotId);
    const refuse = (status: number, message: string, code?: string) =>
      new Proxy({} as GuestApi, {
        // Not a thenable: `await` on the client must not call "then" and hang.
        get: (_target, property) =>
          property === "then"
            ? undefined
            : async () => {
                throw new FakeGuestError(status, message, code);
              },
      });
    // A port the VM no longer runs with reaches nothing, like a stale forward after a restart.
    if (!vm || !guest || vm.guestPort !== endpoint.port) {
      return refuse(0, `connect ECONNREFUSED 127.0.0.1:${endpoint.port}`, "ECONNREFUSED");
    }
    // Every call is refused, like dot-agentd answering 401 to a wrong token.
    if (token !== guest.token) return refuse(401, "unauthorized", "unauthorized");
    return guest;
  }

  async close() {}
}

/** Poll until `predicate` holds; fails with `what` after `timeoutMs`. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  what: string,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Wait until the Dot is READY and doing nothing: no lifecycle operation
 * under its lock, every event its fake guest emitted so far stored by the
 * pump, and what READY and those events started in the background done too
 * (the flush of its outbox, the push an agent.started asks for). A test that
 * starts earlier races that work: an idle check skips a Dot whose outbox is
 * being flushed, and a guest event stored later counts as activity, which is
 * right in a server and a coin toss in a test.
 */
export async function waitUntilSettledReady(
  scheduler: {
    db: { dots: { get(id: string): Promise<{ status: string } | null> }; computers: { get(id: string): Promise<{ event_cursor: number } | null> } };
    lifecycle: { isBusy(id: string): boolean };
    settle(): Promise<void>;
  },
  driver: FakeDriver,
  dotId: string,
  what: string,
): Promise<void> {
  // A Dot's creation is dozens of queries: against a Postgres across WSL on a loaded host that has taken over 5 s.
  await waitFor(async () => (await scheduler.db.dots.get(dotId))?.status === "READY" && !scheduler.lifecycle.isBusy(dotId), `${what} READY`, 15_000);
  const lastSeq = driver.guestOf(dotId).outbox.at(-1)?.seq ?? 0;
  await waitFor(async () => ((await scheduler.db.computers.get(dotId))?.event_cursor ?? 0) >= lastSeq, `${what}'s guest events stored`, 15_000);
  await scheduler.settle();
}

/** A clock tests move by hand. */
export class ManualClock {
  #now: number;
  constructor(start: Date = new Date()) {
    this.#now = start.getTime();
  }
  now(): Date {
    return new Date(this.#now);
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}
