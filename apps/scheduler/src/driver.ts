/**
 * What the control plane needs from the VM layer. The real implementation
 * is an adapter over @invisible-dots/vm-manager (apps/api/src/vm-driver.ts);
 * tests use the in-process fakes of `./testing.js`.
 */
import type {
  AgentStateAnswer,
  BrowserIdentity,
  BrowserIdentityListAnswer,
  ComputerResources,
  CreateBrowserIdentityRequest,
  DotRuntimeConfig,
  FileListAnswer,
  HealthAnswer,
  InboundEvent,
  OutboundEvent,
  RefusedEvent,
  SecretsRequest,
  SystemAnswer,
  SkillListAnswer,
  ToolListAnswer,
  VmState,
} from "@invisible-dots/shared";

/**
 * The guest routes the control plane calls (sections 5.2 and 5.3). The
 * method names and shapes are those of vm-manager's GuestClient, which
 * satisfies this interface as it is. Failed calls throw an error carrying a
 * numeric `status` (0 when the guest could not be reached) and, when the
 * guest sent one, its `{ error }` code as `code`.
 */
export interface GuestApi {
  health(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HealthAnswer>;
  system(): Promise<SystemAnswer>;
  pushSecrets(secrets: SecretsRequest): Promise<void>;
  putConfig(config: DotRuntimeConfig): Promise<void>;
  postEvent(event: InboundEvent): Promise<unknown>;
  state(): Promise<AgentStateAnswer>;
  listBrowserIdentities(): Promise<BrowserIdentityListAnswer>;
  createBrowserIdentity(body: CreateBrowserIdentityRequest): Promise<BrowserIdentity>;
  getBrowserIdentity(id: string): Promise<BrowserIdentity>;
  deleteBrowserIdentity(id: string): Promise<void>;
  /** The JPEG of an open identity's window; 409 `not_open` when it is closed, 503 `busy` while a call holds it. */
  getBrowserIdentityFrame(id: string): Promise<Uint8Array>;
  /** End the identity's browser and keep its profile; closing a closed identity is not an error. */
  closeBrowserIdentity(id: string): Promise<void>;
  listTools(): Promise<ToolListAnswer>;
  listSkills(): Promise<SkillListAnswer>;
  prepareSleep(timeoutMs?: number): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  /** The bytes of a file; a file larger than `maxBytes` is refused with status 413 and code `FILE_TOO_LARGE`. */
  readFile(path: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  listFiles(path: string): Promise<FileListAnswer>;
  /**
   * The outbound event stream after `after`. It reconnects by itself on
   * network errors and ends only when `signal` aborts or it hits an error
   * that waiting cannot fix (a refused token). A message that is not an
   * event the host knows is not yielded: `onRefused` is awaited for it, in
   * order with the events, and the stream goes on past it.
   */
  events(options: { after?: number; signal?: AbortSignal; onRefused?: (info: RefusedEvent) => void | Promise<void> }): AsyncIterable<OutboundEvent>;
}

export interface ComputerSpecInput {
  dotId: string;
  /** The Dot token in clear; it goes into the seed (section 4.2). */
  token: string;
  /** The Dot's VM proxy in clear, absent for a direct exit; it goes into the seed with the token. */
  proxy?: string;
  resources: ComputerResources;
}

export interface CreatedComputer {
  /** The golden image the overlay is backed by; recorded, because it can never change for this disk. */
  goldenImage: string;
  runtimeImage: string;
}

export interface StartedComputer {
  /** The host port on 127.0.0.1 that QEMU forwards to the guest's port 1024 (section 3.5). */
  guestPort: number;
  /** The QEMU process. */
  pid: number;
  runtimeImage: string;
  /** The VM was already running; nothing was spawned and `guestPort` is the one it runs with. */
  alreadyRunning: boolean;
}

/** What the VM layer sees of one Dot's VM: its disk, its pid file and its QEMU process (section 3.4). */
export interface ComputerState {
  /** Whether the Dot's disk exists, that is whether the VM was ever created and not destroyed. */
  exists: boolean;
  /**
   * RUNNING while the Dot's QEMU process runs, STOPPED when it does not,
   * ERROR when a live pid cannot be proven to be that QEMU. Whether the guest
   * inside is up is guest health, which the READY procedure checks.
   */
  state: VmState;
  /** The pid of the live QEMU process, null when there is none. */
  pid: number | null;
  /**
   * The host port forwarded to the guest, from the pid file written when
   * QEMU was spawned, so it is right even when the database row is not;
   * null when not running.
   */
  guestPort: number | null;
  /** Why the state is ERROR, for logs and error messages. */
  detail: string | null;
}

/** Where a guest is reached: the forwarded port recorded in the `computers` row (section 5.1). */
export interface GuestEndpoint {
  dotId: string;
  port: number;
}

export interface WaitForHealthOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Timeout of each health request. */
  requestTimeoutMs: number;
}

export interface ComputerDriver {
  /** Overlay and seed (section 9.4 up to `write seed.iso`). Safe to retry. */
  create(spec: ComputerSpecInput): Promise<CreatedComputer>;
  /** Pick a guest port and spawn QEMU detached (sections 3.4 and 3.5). */
  start(spec: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer>;
  /**
   * Poll `GET /v1/health` until dot-agentd and the agent both report ok.
   * Fails at once on a refused token (status 401) and when the VM's QEMU
   * process exits, and after `timeoutMs` otherwise.
   */
  waitForHealth(endpoint: GuestEndpoint, token: string, options: WaitForHealthOptions): Promise<HealthAnswer>;
  /**
   * `POST /v1/system/poweroff` through the guest channel with the Dot's
   * token, then the QEMU process is killed after the grace period (section 9.5).
   */
  stop(dotId: string, token: string): Promise<{ forced: boolean }>;
  /**
   * A full stop and start, so the guest shuts down cleanly and new resources
   * and a new runtime ISO apply. The guest port changes.
   */
  reboot(spec: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer>;
  /** Stop the VM if it runs and remove its directory with the disk. */
  destroy(dotId: string): Promise<void>;
  /** From the pid file and the process, never from the database: this is what reconciliation compares against. */
  state(dotId: string): Promise<ComputerState>;
  guest(endpoint: GuestEndpoint, token: string): GuestApi;
  /** Release what this process holds. VMs keep running. */
  close(): Promise<void>;
}

/** The HTTP status a failed guest call carried, or 0 when the guest was not reached. */
export function guestErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : 0;
}

/** The `{ error }` code of a failed guest call, when there was one. */
export function guestErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && !/^E[A-Z]+$/.test(code) ? code : undefined;
}
