/**
 * What the end-to-end run (run.ts) is made of that needs no VM: the product's
 * names the run relies on, the shapes of the API's answers, and the pure
 * helpers (event queries, byte checks, scans for a secret, the Dot's YAML).
 *
 * It imports nothing from the workspace, so a product change cannot quietly
 * change what the run checks. tests/repo/e2e.test.ts is the other direction:
 * it runs in CI and fails when a name below stops existing in the product, and
 * it exercises every helper against bytes and rows built in the test.
 *
 * Node runs run.ts itself (it strips the types), so every import here carries
 * its `.ts`; the root tsconfig.json allows that (allowImportingTsExtensions).
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

// Failing

/** A check of the run failed; the message is what a person reads. */
export class Failure extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

// The product's names the run relies on

export const enc = encodeURIComponent;

/** The host API's routes (architecture section 9.6), `:name` standing for a segment `route()` fills. */
export const ROUTES = {
  health: "/api/health",
  dots: "/api/dots",
  dot: "/api/dots/:id",
  messages: "/api/dots/:id/messages",
  tasks: "/api/dots/:id/tasks",
  task: "/api/tasks/:id",
  computer: "/api/dots/:id/computer",
  screenshot: "/api/dots/:id/computer/screenshot",
  identities: "/api/dots/:id/browser-identities",
  identity: "/api/dots/:id/browser-identities/:identityId",
  frame: "/api/dots/:id/browser-identities/:identityId/frame",
  closeIdentity: "/api/dots/:id/browser-identities/:identityId/close",
  approvals: "/api/approvals",
  events: "/api/dots/:id/events",
  usage: "/api/dots/:id/usage",
} as const;

/** The method each route is called with, as `[method, template]`: the list the contract test reads. */
export const ROUTE_CALLS: readonly (readonly [string, string])[] = [
  ["GET", ROUTES.health],
  ["GET", ROUTES.dots],
  ["POST", ROUTES.dots],
  ["GET", ROUTES.dot],
  ["PATCH", ROUTES.dot],
  ["DELETE", ROUTES.dot],
  ["GET", ROUTES.messages],
  ["POST", ROUTES.messages],
  ["POST", ROUTES.tasks],
  ["GET", ROUTES.task],
  ["GET", ROUTES.computer],
  ["GET", ROUTES.screenshot],
  ["GET", ROUTES.identities],
  ["POST", ROUTES.identities],
  ["GET", ROUTES.identity],
  ["DELETE", ROUTES.identity],
  ["GET", ROUTES.frame],
  ["POST", ROUTES.closeIdentity],
  ["GET", ROUTES.approvals],
  ["GET", ROUTES.events],
  ["GET", ROUTES.usage],
];

/** A route template with its `:name` segments filled (and encoded), and an optional query string. */
export function route(template: string, params: Record<string, string> = {}, query: Record<string, string | number> = {}): string {
  const path = template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Failure(`route ${template} needs "${name}"`);
    return enc(value);
  });
  const pairs = Object.entries(query).map(([key, value]) => `${enc(key)}=${enc(String(value))}`);
  return pairs.length > 0 ? `${path}?${pairs.join("&")}` : path;
}

/** The first word(s) of each `invisible-dots` command the run calls, and the flags it passes. */
export const CLI_COMMANDS = ["doctor", "image build", "server", "secret openrouter", "create", "task", "message", "computer", "approve", "reject"] as const;
export const CLI_FLAGS = ["--json", "--note", "--always", "--no-web"] as const;

/** The Dot's tools the run asserts on (nanobot/dots/permissions.py `TOOL_PERMISSIONS`), with the permission each exercises. */
export const TOOLS = {
  exec: "computer.exec",
  write_file: "files.write",
  grep: "files.read",
  browser_identity_create: "browser.identity.create",
  browser_identity_delete: "browser.identity.delete",
  browser_identity_launch: "browser.identity.launch",
  browser_identity_list: "browser.identity.list",
  browser_navigate: "browser.navigate",
  browser_snapshot: "browser.read",
} as const;
export type ToolName = keyof typeof TOOLS;

/**
 * What the engine shows as the target of a call on a browser identity: `<identity id>: <detail>`
 * (nanobot/dots/targets.py `_on_identity`). tests/repo/e2e.test.ts keeps it equal to the engine's.
 */
export function identityTarget(identityId: string, detail: string): string {
  return `${identityId}: ${detail}`;
}

/** The event types the run reads (packages/shared events.ts). */
export const EVENTS = [
  "agent.started",
  "message.assistant",
  "task.progress",
  "task.completed",
  "approval.requested",
  "approval.resolved",
  "tool.called",
  "browser.identity.created",
  "browser.identity.launched",
  "browser.identity.closed",
  "browser.identity.deleted",
  "computer.stopped",
  "dot.deleted",
] as const;

/** The doctor checks the run requires to be ok (apps/cli/src/doctor/checks.ts). */
export const DOCTOR_CHECKS = ["node", "qemu", "qemu-img", "accelerator", "accelerator-probe", "disk", "golden-image", "runtime-image", "openrouter", "web"] as const;

// The API's shapes (packages/shared/src/api.ts), the fields the run reads

export interface Dot {
  id: string;
  name: string;
  status: string;
  error: string | null;
  computer_state: string | null;
}
/**
 * `GET /v1/agent/state` as the engine answers it and `AgentStateAnswer` of packages/shared declares it:
 * `pending_approval` is the id of the oldest approval the engine waits on, not the approval.
 * tests/repo/e2e.test.ts keeps this equal to the shared type.
 */
export interface AgentStateAnswer {
  state: string;
  current_task_id: string | null;
  pending_approval: string | null;
}
export interface Computer {
  state: string;
  ready: boolean;
  pid: number | null;
  guest_port: number | null;
  last_error: string | null;
}
export interface Task {
  id: string;
  status: string;
  summary: string | null;
  error: string | null;
  spent_usd: number;
}
export interface StoredEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}
export interface Identity {
  id: string;
  name: string;
  status: string;
  profilePath: string;
  lastUsedAt: string | null;
  hasProxy: boolean;
}
export interface Approval {
  id: string;
  task_id: string | null;
  tool: string;
  permission: string;
  arguments: Record<string, unknown>;
  status: string;
}
export interface CheckResult {
  id: string;
  status: string;
  detail: string;
}

// Hashes and the bytes of an answer

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngInfo {
  width: number;
  height: number;
  /** Whether the picture holds (next to) a single value: an empty desktop, a page that did not paint. */
  blank: boolean;
}

/** Channels per pixel of a PNG color type, for the types a screenshot can be. */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Width, height and whether the picture is blank, from a PNG's own bytes: the signature, the IHDR chunk and the
 * decompressed pixel rows. A row starts with its filter byte, which is left out; a picture whose remaining bytes
 * hold more than a handful of distinct values has something drawn on it (every filter turns a flat picture into
 * zeros after its first pixel).
 */
export function pngInfo(bytes: Uint8Array): PngInfo {
  const buffer = Buffer.from(bytes);
  assert(buffer.length > 33 && buffer.subarray(0, 8).equals(PNG_SIGNATURE), "the screenshot is not a PNG");
  assert(buffer.toString("latin1", 12, 16) === "IHDR", "the PNG has no IHDR chunk first");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const depth = buffer[24]!;
  const channels = PNG_CHANNELS[buffer[25]!];
  assert(channels !== undefined, `the PNG has color type ${buffer[25]}`);
  assert(buffer[28] === 0, "the PNG is interlaced");
  const data: Buffer[] = [];
  for (let at = 8; at + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") data.push(buffer.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  assert(data.length > 0, "the PNG has no pixel data");
  const raw = inflateSync(Buffer.concat(data));
  const stride = 1 + Math.ceil((width * depth * channels) / 8);
  const seen = new Set<number>();
  for (let row = 0; row + stride <= raw.length && seen.size <= 8; row++) {
    for (let i = 1; i < stride && seen.size <= 8; i++) seen.add(raw[row * stride + i]!);
  }
  return { width, height, blank: seen.size <= 8 };
}

/** The size of a JPEG from its own markers, after checking that it starts and ends as one. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  assert(buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff, "the frame is not a JPEG");
  assert(buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9, "the JPEG does not end with its end marker");
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = buffer[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // A start-of-frame marker (not DHT, JPG or DAC, which share the range) holds the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
    }
    at += 2 + buffer.readUInt16BE(at + 2);
  }
  throw new Failure("the JPEG has no frame header");
}

// Looking for a secret

/**
 * Whether `needle` occurs in the file, read in chunks: a Dot's overlay disk is gigabytes, more than one Buffer
 * holds. Each chunk is searched together with the end of the previous one, so a match across a boundary is found.
 */
export async function fileContains(path: string, needle: Buffer, chunkBytes = 4 * 2 ** 20): Promise<boolean> {
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
    const window = Buffer.concat([tail, chunk as Buffer]);
    if (window.includes(needle)) return true;
    tail = window.subarray(Math.max(0, window.length - (needle.length - 1)));
  }
  return false;
}

/** The files that hold the needle; a caller reports only where, never the needle. */
export async function filesHolding(files: string[], needle: Buffer): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    if (await fileContains(file, needle)) found.push(file);
  }
  return found;
}

export async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/** How many rows (API answers) hold the needle in any field. */
export function rowsHolding(rows: unknown[], needle: Buffer): number {
  return rows.filter((row) => Buffer.from(JSON.stringify(row), "utf8").includes(needle)).length;
}

/**
 * A grep pattern for `prefix` that does not match its own text, so the journal line that records the very
 * command that searches for it (the engine logs tool calls) cannot match itself: `sk-or-` becomes `sk-o[r]-`.
 */
export function selfExcludingPattern(prefix: string): string {
  assert(prefix.length >= 2, "a prefix to search for needs two characters");
  const last = prefix.length - 1;
  return `${prefix.slice(0, last - 1)}[${prefix[last - 1]}]${prefix.slice(last)}`;
}

/**
 * The shell command that counts, inside the guest, the lines of the whole system journal that hold `prefix`, and
 * prints the SHA-256 of "<count> <nonce>". It fails (and prints no hash) when the journal cannot be read in full:
 * the kernel's own entries, which only a reader of the system journal sees, must be there. Only the command itself
 * can produce the hash of a count of 0, so a model that relays it cannot make the answer up.
 */
export function journalCountCommand(prefix: string, nonce: string): string {
  return (
    `set -eu; j=$(mktemp); journalctl --no-pager -q -o export > "$j"; grep -aq '^_TRANSPORT=kernel$' "$j"; ` +
    `n=$(grep -ac '${selfExcludingPattern(prefix)}' "$j" || true); rm -f "$j"; printf '%s %s' "$n" ${nonce} | sha256sum`
  );
}

/** What `journalCountCommand` prints when nothing matched. */
export function journalCleanHash(nonce: string): string {
  return sha256Text(`0 ${nonce}`);
}

/** A proxy as an approval shows it: masked whole, so that neither its password nor its user nor its host is there. */
export function proxyIsMasked(shown: unknown): boolean {
  return shown === "***";
}

// The Dot's token and the guest's proof (architecture section 5.1)

/** What every guest request carries after `GET /v1/proof`. */
export const GUEST_PROOF_CONTEXT = "invisible-dots guest proof v1\n";

/** The Dot's token as the seed's user-data carries it, in the boot config JSON (whose quotes are escaped there). */
export function dotTokenFromSeed(seed: Buffer): string {
  const match = /\\?"token\\?":\s*\\?"([A-Za-z0-9_-]{20,})\\?"/.exec(seed.toString("latin1"));
  assert(match, "could not read the Dot token from the seed");
  return match[1]!;
}

/** The proof a guest holding `token` gives for `nonce`: lowercase hex. */
export function guestProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`${GUEST_PROOF_CONTEXT}${nonce}`).digest("hex");
}

// Events

export function taskEvents(all: StoredEvent[], taskId: string): StoredEvent[] {
  return all.filter((event) => event.data.task_id === taskId);
}

/** The `tool.called` events of one task for one tool. */
export function toolCalls(all: StoredEvent[], taskId: string, tool: string): StoredEvent[] {
  return taskEvents(all, taskId).filter((e) => e.type === "tool.called" && e.data.tool === tool);
}

/** Whether a task's call of a tool ran and succeeded. */
export function toolOk(all: StoredEvent[], taskId: string, tool: string): boolean {
  return toolCalls(all, taskId, tool).some((e) => e.data.ok === true);
}

export function describeTools(all: StoredEvent[], taskId: string): string {
  return taskEvents(all, taskId)
    .filter((e) => e.type === "tool.called")
    .map((e) => `${String(e.data.tool)}:${e.data.ok === true ? "ok" : "failed"}`)
    .join(", ");
}

/** The events of a type after an event id, for one identity when `identityId` is given. */
export function identityEvents(all: StoredEvent[], type: string, identityId?: string, afterId = 0): StoredEvent[] {
  return all.filter((e) => e.id > afterId && e.type === type && (identityId === undefined || e.data.identity_id === identityId));
}

/** The highest event id, 0 for none: where "after this" starts. */
export function lastEventId(all: StoredEvent[]): number {
  return all.reduce((max, event) => Math.max(max, event.id), 0);
}

/** A Dot's event log as events.txt: one line per event, long strings cut so the file stays readable. */
export function eventLines(all: StoredEvent[]): string[] {
  return all.map((event) => {
    const data = Object.fromEntries(Object.entries(event.data).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : v]));
    return `${event.created_at} #${event.id} ${event.type} ${JSON.stringify(data)}`;
  });
}

/** Whether a number is the spend an event reports: finite and not negative. */
export function isSpend(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Waiting

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Polls `probe` until it returns a value; `probe` throws a Failure to stop early. */
export async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, everyMs = 2000, clock: Clock = realClock): Promise<T> {
  const started = clock.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    assert(clock.now() - started < timeoutMs, `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await clock.sleep(everyMs);
  }
}

// The input of a run

/** The OpenRouter key from the key file's text: one key, with the prefix every OpenRouter key has. */
export function keyFromFile(text: string, where: string, prefix: string): string {
  const key = text.trim();
  assert(key.length >= 20 && !/\s/.test(key), `${where} does not hold one OpenRouter key`);
  // The journal check looks for this prefix; a key without it would let that check pass without having looked for anything.
  assert(key.startsWith(prefix), `${where} does not hold an OpenRouter key: it does not start with ${prefix}`);
  return key;
}

export interface DotYamlOptions {
  name: string;
  model: string;
  /** Permissions written into the config, as `permission: decision`. */
  permissions?: Record<string, "allow" | "ask" | "deny">;
  /** The computer's size; 2 CPUs and 4gb when not given. */
  computer?: { cpu: number; memory: string };
  /** MCP servers the Dot runs on its computer, by name (architecture section 7). */
  mcpServers?: Record<string, { command: string; args?: string[]; secrets?: string[] }>;
}

/** The Dot's config (architecture section 7) as YAML. */
export function dotYaml(options: DotYamlOptions): string {
  const permissions = Object.entries(options.permissions ?? {});
  return [
    `name: ${options.name}`,
    "instructions: >",
    "  Follow each task literally. When asked to answer with only a value, answer with that value and nothing else.",
    "model:",
    "  provider: openrouter",
    `  id: ${options.model}`,
    "computer:",
    `  cpu: ${options.computer?.cpu ?? 2}`,
    `  memory: ${options.computer?.memory ?? "4gb"}`,
    "  idle_timeout: 0",
    ...(permissions.length > 0 ? ["permissions:", ...permissions.map(([permission, decision]) => `  ${permission}: ${decision}`)] : []),
    ...(options.mcpServers
      ? [
          "mcp_servers:",
          ...Object.entries(options.mcpServers).flatMap(([name, server]) => [
            `  ${name}:`,
            `    command: ${server.command}`,
            ...(server.args ? [`    args: ${JSON.stringify(server.args)}`] : []),
            ...(server.secrets ? [`    secrets: ${JSON.stringify(server.secrets)}`] : []),
          ]),
        ]
      : []),
    "",
  ].join("\n");
}

/** The Dot's name in a run: the prefix, then the UTC time to the minute, so a later run can remove what a failed one left. */
export function dotName(prefix: string, stamp: string): string {
  return `${prefix}${stamp.slice(4, 15).replace("T", "-").toLowerCase()}`;
}

/** A compact UTC stamp: 20261006T101500Z. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
