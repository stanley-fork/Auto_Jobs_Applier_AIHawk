/**
 * The host to guest protocol of architecture section 5: dot-agentd routes
 * (5.2), invisible-dots-agent routes (5.3), the guest filesystem (4.2) and
 * the environment variables every component reads. The host filesystem (3.2)
 * is in paths.ts, which needs node:path and so stays out of the web client.
 */
import { z } from "zod";
import type { DotRuntimeConfig } from "./config.js";
import type { AgentState } from "./states.js";
import { isPermissionName } from "./tools.js";

/**
 * POSIX join without node:path, so the web client can import this module.
 * Inputs are absolute directories and plain names, never ".." segments.
 */
function join(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""))).join("/");
}

/**
 * dot-agentd listens on this TCP port inside the guest; QEMU forwards a free
 * port on the host's 127.0.0.1 to it (sections 3.5 and 5.1).
 */
export const GUEST_PORT = 1024;

/** stdout and stderr of `POST /v1/exec` are each capped at this many bytes. */
export const EXEC_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Tool results longer than this are cut with a marker before they reach the model (section 8.5). */
export const TOOL_RESULT_MAX_CHARS = 12_000;

/**
 * The one truncation function: cut a text to at most `max` characters, the
 * marker included, saying how much the reader does not see. `head` keeps the
 * beginning; `head-tail` keeps about 70% from the beginning and 30% from the
 * end, for text whose last lines matter as much as its first.
 */
export function truncateText(text: string, max: number = TOOL_RESULT_MAX_CHARS, mode: "head" | "head-tail" = "head"): string {
  if (text.length <= max) return text;
  const marker = (omitted: number) =>
    mode === "head" ? `\n[... truncated: ${omitted} more characters not shown]` : `\n[... truncated: ${omitted} characters not shown ...]\n`;
  // The marker's length depends on the count it states, so size it for the worst case.
  const keep = max - marker(text.length).length;
  if (keep <= 0) return text.slice(0, max);
  if (mode === "head") return text.slice(0, keep) + marker(text.length - keep);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return text.slice(0, head) + marker(text.length - keep) + (tail > 0 ? text.slice(text.length - tail) : "");
}

export const DEFAULT_LISTEN = "127.0.0.1:8787";
/** Where `invisible-dots server` serves the web client (section 9.7). */
/**
 * 127.0.0.2, not 127.0.0.1: a Dot's VM reaches the host's 127.0.0.1 as 10.0.2.2 (QEMU's user network), and the web
 * client has no login, so it listens on a loopback address no VM reaches (architecture section 9.7).
 */
export const DEFAULT_WEB_LISTEN = "127.0.0.2:3000";

/** Environment variable names. */
export const ENV = {
  /** The one host data directory (section 3.2); default `~/.invisible-dots`. */
  HOME: "INVISIBLE_DOTS_HOME",
  /** The one directory QEMU is looked for in, when set (section 3.1). */
  QEMU_DIR: "INVISIBLE_DOTS_QEMU_DIR",
  LISTEN: "INVISIBLE_DOTS_LISTEN",
  /** Where the web client listens when `invisible-dots server` starts it, as host:port. */
  WEB_LISTEN: "INVISIBLE_DOTS_WEB_LISTEN",
  /** Extra host names (comma separated) the web server may be reached by, besides loopback. */
  WEB_ALLOWED_HOSTS: "INVISIBLE_DOTS_WEB_ALLOWED_HOSTS",
  /** The pid of the `invisible-dots server` that started the web server, which exits once that process is gone. */
  WEB_PARENT_PID: "INVISIBLE_DOTS_WEB_PARENT_PID",
  /** The API token itself, instead of the api.token file: the server's token, or the one a client sends. */
  TOKEN: "INVISIBLE_DOTS_TOKEN",
  /** Where clients (CLI, web server) reach the API. Default http://127.0.0.1:8787. */
  URL: "INVISIBLE_DOTS_URL",
  /** `1` turns on the opt-in WhatsApp adapter (Baileys, an unofficial client with a risk of account bans; architecture 9.8). */
  WHATSAPP: "INVISIBLE_DOTS_WHATSAPP",
  DATABASE_URL: "DATABASE_URL",
  /** Read by invisible-playwright-mcp, one value per browser identity (section 6). */
  MCP_HOME: "INVISIBLE_MCP_HOME",
  MCP_SESSION_ID: "INVISIBLE_MCP_SESSION_ID",
  PROFILE_DIR: "STEALTHFOX_PROFILE_DIR",
  HEADLESS: "STEALTHFOX_HEADLESS",
  /** Set only for an identity that was given a proxy of its own; otherwise the browser inherits the egress of the VM (section 6). */
  PROXY: "STEALTHFOX_PROXY",
  DISPLAY: "DISPLAY",
  /** `off` stops invisible_core from reinstalling itself from the package index at a launch when its version drifts. */
  CORE_AUTOFIX: "INVISIBLE_CORE_AUTOFIX",
  /** `1` tells invisible-playwright-mcp that the engine opens and closes its browser and offers the model the page tools
   * only: it serves `main` alone, no tool takes `browser`, and its instructions are the page rules. */
  HOST_MANAGED: "INVISIBLE_MCP_HOST_MANAGED",
} as const;

/** The X display the guest desktop runs on. */
export const GUEST_DISPLAY = ":0";

/** Guest paths (section 4.2). The guest is always Linux, so these are POSIX paths. */
export const GUEST_PATHS = {
  config: "/etc/invisible-dots/config.json",
  runtime: "/opt/invisible-dots",
  home: "/home/dot",
  workspace: "/home/dot/workspace",
  downloads: "/home/dot/downloads",
  documents: "/home/dot/documents",
  memory: "/home/dot/memory",
  browsers: "/home/dot/browsers",
  /**
   * The home of each browser identity's MCP server (`<mcpHomes>/<identity_id>`). Outside `/home/dot` on purpose: the
   * server saves the proxy of the browser it opened, password included, in a session file under its home, and the
   * file routes of the host read `/home/dot` and nothing else (architecture sections 4.2 and 6).
   */
  mcpHomes: "/var/lib/invisible-dots/mcp",
  runDir: "/run/invisible-dots",
  agentdSocket: "/run/invisible-dots/agentd.sock",
  /** The engine's API, in a directory of the engine's user dot cannot write (architecture 4.2). */
  agentSocket: "/run/invisible-dots-agent/agent.sock",
} as const;

/** The most a read of one guest file through the host API returns (`GET /api/dots/:id/files`): 16 MiB. */
export const MAX_HOST_FILE_BYTES = 16 * 1024 * 1024;

/** The `error` code of a read refused for its size: by the host client when the file passes the limit it was given. */
export const FILE_TOO_LARGE = "file_too_large";

/** The longest path the host API takes for a guest file; Linux's own PATH_MAX. */
const MAX_HOST_PATH_LENGTH = 4096;

export type HomePathCheck = { ok: true; path: string } | { ok: false; problem: string };

/**
 * The one rule for which guest paths the host API reads (`/api/dots/:id/files` and `/files/list`): those under
 * `/home/dot`. `raw` is an absolute path, a path relative to `/home/dot`, or `~` / `~/...` (which dot-agentd also
 * resolves against home); the answer is the normalized absolute path that goes to dot-agentd, `.` and empty
 * segments dropped. A `..` segment is refused rather than resolved, so a path never means more than it says.
 * The check is lexical and only the early answer: the rule is dot-agentd's, which follows symbolic links and
 * refuses (403 `outside_home`) a path whose real location is not under home.
 */
export function checkHomePath(raw: unknown): HomePathCheck {
  if (typeof raw !== "string" || raw === "") return { ok: false, problem: "path must be a non-empty string" };
  if (raw.length > MAX_HOST_PATH_LENGTH) return { ok: false, problem: `path is longer than ${MAX_HOST_PATH_LENGTH} characters` };
  if (raw.includes("\0")) return { ok: false, problem: "path contains a NUL byte" };
  const home = GUEST_PATHS.home.split("/").filter(Boolean);
  let segments: string[];
  if (raw === "~" || raw.startsWith("~/")) segments = [...home, ...raw.slice(1).split("/")];
  else if (raw.startsWith("/")) segments = raw.split("/");
  else segments = [...home, ...raw.split("/")];
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "..") return { ok: false, problem: 'path must not contain ".." segments' };
    if (segment !== "" && segment !== ".") kept.push(segment);
  }
  if (!home.every((segment, i) => kept[i] === segment)) {
    return { ok: false, problem: `path must be inside ${GUEST_PATHS.home}` };
  }
  return { ok: true, path: `/${kept.join("/")}` };
}

/**
 * Paths of one browser identity: its directory and profile under a browsers root (default `/home/dot/browsers`), and
 * the home of its MCP server under an MCP homes root (default `/var/lib/invisible-dots/mcp`, outside the home).
 */
export function identityPaths(
  identityId: string,
  browsersDir: string = GUEST_PATHS.browsers,
  mcpHomesDir: string = GUEST_PATHS.mcpHomes,
) {
  const root = join(browsersDir, identityId);
  return {
    root,
    profile: join(root, "profile"),
    mcp: join(mcpHomesDir, identityId),
  };
}

/** `/etc/invisible-dots/config.json` in the guest, written by cloud-init (root-only: dot never reads it). */
export interface GuestBootConfig {
  dotId: string;
  token: string;
  /**
   * The Dot's VM proxy, `socks5://[user:password@]host:port`, absent for a Dot that goes out directly. The guest's
   * runtime routes the whole VM through it at boot (guest/image-builder/runtime/install.sh); a new value is used from
   * the next start, because the seed is written at every start.
   */
  proxy?: string;
}

/** The QEMU `-name` of a Dot's VM, also stored as `computers.vm_name` (sections 3.4 and 9.1). */
export function vmName(dotId: string): string {
  return `invisible-dot-${dotId}`;
}

export const AGENTD_ROUTES = {
  health: "/v1/health",
  system: "/v1/system",
  exec: "/v1/exec",
  files: "/v1/files",
  filesList: "/v1/files/list",
  screenshot: "/v1/screenshot",
  /**
   * The one route without the token (section 5.1): `?nonce=<hex>` answers
   * `{ proof }`, the HMAC-SHA256 of GUEST_PROOF_CONTEXT plus the nonce under
   * the Dot token. The host asks it before it sends the token anywhere, so a
   * process that took over a stale guest port never sees the token.
   */
  proof: "/v1/proof",
  /**
   * How the control plane stops a VM (section 3.4): the guest powers itself
   * off and QEMU exits with it. Served on the TCP port only, never on the
   * agent's socket: powering off is the control plane's decision.
   */
  poweroff: "/v1/system/poweroff",
  /** Prefix of the reverse proxy to the agent socket. */
  agent: "/v1/agent",
} as const;

/** What `GET /v1/proof` signs before the nonce; dot-agentd's Go code holds the same bytes. */
export const GUEST_PROOF_CONTEXT = "invisible-dots guest proof v1\n";

/** `GET /v1/proof` answer: lowercase hex. */
export interface ProofAnswer {
  proof: string;
}

export const AGENT_ROUTES = {
  health: "/health",
  secrets: "/secrets",
  config: "/config",
  events: "/events",
  eventsStream: "/events/stream",
  state: "/state",
  browserIdentities: "/browser-identities",
  browserIdentity: (id: string) => `/browser-identities/${encodeURIComponent(id)}`,
  /** `GET`: the JPEG of the identity's window, only while it is open (409 `not_open`; 503 `busy` when a call holds it; 502 `frame_failed` or `crashed`). */
  browserIdentityFrame: (id: string) => `/browser-identities/${encodeURIComponent(id)}/frame`,
  /** `POST` (204): end the identity's browser, keep its profile. Closing a closed identity is not an error. */
  browserIdentityClose: (id: string) => `/browser-identities/${encodeURIComponent(id)}/close`,
  tools: "/tools",
  skills: "/skills",
  prepareSleep: "/prepare-sleep",
} as const;

/**
 * How long the host waits for `POST /prepare-sleep` before it gives up and stops the guest anyway (architecture
 * section 9.5). The engine's work inside it (the grace of a tool in flight, the wait for the cancelled turns,
 * the close of every open browser) has to fit; nanobot/dots/protocol.py holds the same number in seconds
 * and tests/dots/test_engine.py checks the sum of those steps against it.
 */
export const PREPARE_SLEEP_TIMEOUT_MS = 60_000;

/**
 * The HTTP status of each error code the engine answers on the identity routes (architecture section 5.3):
 * `invalid`, `not_found`, `limit` and `not_open` are the caller's, `busy` is a call holding the browser, and
 * `crashed` and `frame_failed` are the browser's. There is no `launch_failed` here: no route launches (the model's
 * tools do), so no answer of a route carries it. nanobot/dots/protocol.py holds the same
 * table and serves its answers from it; the control plane passes an answer with one of these pairs through
 * as it is, so the UI can tell a busy or crashed browser from an unreachable computer.
 */
export const IDENTITY_ERROR_STATUS = {
  invalid: 400,
  not_found: 404,
  limit: 409,
  not_open: 409,
  busy: 503,
  crashed: 502,
  frame_failed: 502,
} as const;

export type IdentityErrorCode = keyof typeof IDENTITY_ERROR_STATUS;

/** Whether a guest answer with this `{ error }` code and status is one of the engine's identity answers. */
export function isIdentityAnswer(code: string | undefined, status: number): code is IdentityErrorCode {
  return code !== undefined && Object.hasOwn(IDENTITY_ERROR_STATUS, code) && IDENTITY_ERROR_STATUS[code as IdentityErrorCode] === status;
}

/** Guest self-checks the host needs before it calls a Dot READY (section 9.3). */
export interface GuestChecks {
  filesystem_writable: boolean;
  network_reachable: boolean;
  browser_installed: boolean;
}

/**
 * `GET /health` of the agent. The guest checks live here, not in dot-agentd:
 * the agent writes the state, reaches OpenRouter and starts the browser layer,
 * so it is the process that can tell whether those work.
 */
export interface AgentHealthAnswer {
  status: "ok" | "starting";
  state: AgentState;
  openrouter_configured: boolean;
  browser: { identities: number; open: number };
  checks: GuestChecks;
}

/** What dot-agentd reports for the agent when its socket does not answer. */
export interface AgentDown {
  status: "down";
  /** Why dot-agentd could not reach the agent (socket missing, timeout, bad answer). */
  error?: string;
}

/** `GET /v1/health` of dot-agentd. */
export interface HealthAnswer {
  agentd: "ok";
  agent: AgentHealthAnswer | AgentDown;
  uptime_s: number;
}

/** `GET /v1/system`. */
export interface SystemAnswer {
  hostname: string;
  uptime_s: number;
  cpus: number;
  mem_total_bytes: number;
  mem_available_bytes: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
}

/** `POST /v1/exec` body. The command runs as `bash -lc <command>`. */
export interface ExecRequest {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

/** `POST /v1/exec` answer. `exit_code` is -1 when the process was killed by the timeout or a signal. */
export interface ExecAnswer {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export type FileEntryType = "file" | "dir" | "other";

export interface FileEntry {
  name: string;
  type: FileEntryType;
  size: number;
  /** Modification time, RFC 3339 / ISO 8601 in UTC. */
  mtime: string;
}

/** `GET /v1/files/list`. */
export interface FileListAnswer {
  entries: FileEntry[];
}

/**
 * `POST /secrets`: what the engine keeps in memory only, pushed again whenever it starts. `mcp_secrets` are the values
 * of the secrets the config's MCP servers name (`mcp_servers.<server>.secrets`), by server and name; a server's secret
 * that is not set is absent.
 */
export interface SecretsRequest {
  openrouter_api_key: string;
  mcp_secrets: Record<string, Record<string, string>>;
}

/**
 * What an OpenRouter key is made of, as one rule with two readers: the host refuses a key that breaks it when the
 * user enters it (`checkOpenRouterKey`), and the guest engine refuses it again on `POST /secrets`
 * (nanobot/dots/protocol.py keeps a copy of these two constants; tests/repo/vendored-nanobot.test.ts keeps the
 * copy equal). The key travels in an Authorization header, so it is printable ASCII with no space; any other
 * character makes the HTTP stack refuse the request with an error whose text is the whole header.
 */
export const OPENROUTER_KEY_PATTERN = "[!-~]+";
export const OPENROUTER_KEY_RULE = "the key must be printable ASCII without spaces, as it travels in a header";

/** A key as the host stores it (the value with its ends trimmed), or why the value is not one. The key is never in the problem. */
export type OpenRouterKeyCheck = { ok: true; key: string } | { ok: false; problem: string };

export function checkOpenRouterKey(value: unknown): OpenRouterKeyCheck {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: "value must be a non-empty string" };
  const key = value.trim();
  if (!new RegExp(`^${OPENROUTER_KEY_PATTERN}$`).test(key)) return { ok: false, problem: `value is not an OpenRouter key: ${OPENROUTER_KEY_RULE}` };
  return { ok: true, key };
}

/**
 * What the value of an MCP server's secret is made of, as one rule with two readers like the OpenRouter key's: the host
 * refuses a value that breaks it when the person sets it (`checkMcpSecret`), and the engine again on `POST /secrets`
 * (nanobot/dots/protocol.py keeps a copy; tests/repo/vendored-nanobot.test.ts keeps it equal). A secret becomes an
 * environment variable or an HTTP header, often `Bearer <token>`, so a space is allowed and a control character,
 * which would end a header or cut a variable, is not.
 */
export const MCP_SECRET_PATTERN = "[ -~]+";
export const MCP_SECRET_RULE = "a secret must be printable ASCII, as it travels in an environment variable or a header";

/** A secret's value as the host stores it (its ends trimmed), or why the value is not one. The value is never in the problem. */
export type McpSecretCheck = { ok: true; value: string } | { ok: false; problem: string };

export function checkMcpSecret(value: unknown): McpSecretCheck {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: "value must be a non-empty string" };
  const trimmed = value.trim();
  if (!new RegExp(`^${MCP_SECRET_PATTERN}$`).test(trimmed)) return { ok: false, problem: `value is not a secret: ${MCP_SECRET_RULE}` };
  return { ok: true, value: trimmed };
}

/** One secret a declared MCP server names, and whether its value is set; never the value. */
export interface McpSecretState {
  server: string;
  name: string;
  set: boolean;
}

/** `GET /api/dots/:id/mcp-secrets`: every secret the config's MCP servers name, the servers by name, each one's in its order. */
export interface McpSecretsAnswer {
  dot_id: string;
  secrets: McpSecretState[];
}

/** `PUT /config` body. */
export type PutConfigRequest = DotRuntimeConfig;

/** `POST /events` answer (status 202). */
export interface PostEventAnswer {
  accepted: true;
}

/**
 * `GET /state`. `pending_approval` is the id of the oldest tool call parked until the host's decision (the same
 * id as `ApprovalRequestedData.approval_id` and the host's approval row), never the approval itself: the host
 * holds the rest, and the engine's answer is the one place that says which approval the engine waits on.
 */
export interface AgentStateAnswer {
  state: AgentState;
  current_task_id: string | null;
  pending_approval: string | null;
}

/**
 * The engine's error codes of a failed read of an identity's frame that the UI tells apart: the browser is closed
 * (409) or a call of the Dot holds it (503). The others (`frame_failed`, `crashed`) are shown with the answer's own
 * message; a computer that is off answers the host's `COMPUTER_STOPPED`.
 */
export const FRAME_ERROR_CODES = { notOpen: "not_open", busy: "busy" } as const satisfies Record<string, IdentityErrorCode>;

export const BROWSER_IDENTITY_STATUSES = ["available", "open", "archived"] as const;
export type BrowserIdentityStatus = (typeof BROWSER_IDENTITY_STATUSES)[number];

/** One browser identity, as the engine's identity routes return it (the row of `dots_browser_identities`). */
export interface BrowserIdentity {
  id: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, null until the first launch. */
  lastUsedAt: string | null;
  status: BrowserIdentityStatus;
  profilePath: string;
  /**
   * Whether the identity has a proxy of its own. Only that: the proxy is a secret (it may carry a user and a password), so
   * nothing of it leaves the engine. False is the normal case: no proxy, and the browser inherits the VM's egress.
   */
  hasProxy: boolean;
}

/** `POST /browser-identities` body. */
export interface CreateBrowserIdentityRequest {
  name: string;
  /**
   * An explicit option, off by default: leave it out and the identity's browser uses the egress of the Dot's VM. When set
   * it is the proxy URL as invisible-playwright-mcp reads it (`http://user:pass@host:port` or `socks5://host:port`), kept as
   * written and given to the browser unchanged: the library judges it when the identity launches. It is stored as a secret.
   */
  proxy?: string;
}

/** `GET /browser-identities`. */
export interface BrowserIdentityListAnswer {
  identities: BrowserIdentity[];
}

/**
 * The last moment an automation may run, in milliseconds since the epoch: 9999-12-31T23:59:59.999Z, the last one a
 * Postgres timestamp and a JavaScript Date both hold. The engine refuses a schedule past it
 * (`MAX_RUN_AT_MS` of nanobot/cron/types.py; the engine's wire-shapes test pins the two equal), so a time the host cannot
 * store or show never reaches it.
 */
export const MAX_RUN_AT_MS = 253_402_300_799_999;

// The shape below is the one description of what the engine's `GET /tools` answers (nanobot/dots/permissions.py
// `tool_table`). The engine is Python and cannot import it: its test writes what it answers into
// `invisible_engine_dots/tests/dots/wire_shapes.json`, and a test of the host parses that file with this schema, so a
// key renamed on either side fails a suite.
/** One tool of the Dot, as `GET /tools` shows it (the engine owns the table: nanobot/dots/permissions.py). */
export const toolInfoSchema = z
  .object({
    name: z.string(),
    /** The key of the Dot config's `permissions` the tool exercises: one of `PERMISSIONS`, or `mcp.<server>`. */
    permission: z.string().refine(isPermissionName, "unknown permission"),
    /** Whether the model is offered the tool now: its permission is not denied. */
    offered: z.boolean(),
    /** What the tool's schema tells the model it does. */
    description: z.string(),
  })
  .strict();
export type ToolInfo = z.infer<typeof toolInfoSchema>;

/**
 * Where a declared MCP server is: `connecting` while the engine starts it or reaches it, `connected` while its tools
 * are offered, `failed` when it could not (the error says why; the engine tries again when the next turn starts).
 */
export const MCP_SERVER_STATES = ["connecting", "connected", "failed"] as const;
export type McpServerState = (typeof MCP_SERVER_STATES)[number];

/** One MCP server of the Dot's config as the engine has it (nanobot/dots/mcp_servers.py), for `GET /tools`, by name. */
export const mcpServerStatusSchema = z
  .object({
    name: z.string(),
    state: z.enum(MCP_SERVER_STATES),
    /** Why a `failed` server is not connected (the command is not installed, a secret is not set); null otherwise. */
    error: z.string().nullable(),
    /** How many tools it serves (0 while it is not connected). */
    tools: z.number().int().nonnegative(),
  })
  .strict();
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

/**
 * `GET /tools`: the engine's tools in its table order, which groups them by permission, then the tools of the
 * declared MCP servers that are connected; and every declared server with its state.
 */
export interface ToolListAnswer {
  tools: ToolInfo[];
  mcp_servers: McpServerStatus[];
}

/** Where a skill comes from: it ships with invisible_dots, or the Dot wrote it under /home/dot/skills. */
export const SKILL_SOURCES = ["builtin", "dot"] as const;

/**
 * One skill of the Dot, as `GET /skills` shows it (the engine owns the list: nanobot/dots/skills.py): how it does a
 * kind of task, a SKILL.md whose frontmatter names it and says when it applies. One of the Dot's own replaces a
 * built-in one of the same name.
 */
export const skillSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source: z.enum(SKILL_SOURCES),
    /** The SKILL.md on the Dot's computer. */
    path: z.string(),
    /** The whole file, frontmatter included. */
    content: z.string(),
  })
  .strict();
export type Skill = z.infer<typeof skillSchema>;

/** `GET /skills`, by name. */
export interface SkillListAnswer {
  skills: Skill[];
}

/** Every error body, on the host API and in the guest (section 9.6). */
export interface ErrorAnswer {
  error: string;
  message: string;
}
