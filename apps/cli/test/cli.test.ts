import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotConfig } from "@invisible-dots/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commandOf, EXIT, interruptIsAsked, run, SAMPLE_DOT, type CliIo, type HostCommands } from "../src/index.js";

const TOKEN = "cli-test-token-0123456789";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const now = "2026-10-02T08:00:00.000Z";
const dot = {
  id: "dot_01abc",
  name: "fare-watch",
  config: {
    name: "fare-watch",
    model: { provider: "openrouter", id: "test/model" },
    computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" },
  },
  status: "READY",
  error: null,
  config_version: 1,
  created_at: now,
  updated_at: now,
  computer_state: "RUNNING",
};
const computer = {
  dot_id: dot.id,
  vm_name: "invisible-dot-dot_01abc",
  guest_port: 40123,
  pid: 4242,
  state: "RUNNING",
  golden_image: null,
  runtime_image: null,
  event_cursor: 3,
  last_active_at: now,
  next_automation_at: "2030-01-01T09:00:00.000Z",
  stop_reason: null,
  last_error: null,
  updated_at: now,
  ready: true,
};
const task = {
  id: "task_01",
  dot_id: dot.id,
  description: "find the cheapest day",
  priority: 0,
  status: "COMPLETED",
  created_at: now,
  scheduled_at: null,
  started_at: now,
  finished_at: now,
  summary: "tuesday",
  error: null,
};
const channel = {
  kind: "telegram",
  enabled: true,
  status: "connected",
  status_detail: null,
  account: "dot_helper_bot",
  settings: { approvals: true, notify_tasks: true, show_arguments: true },
  peers: [{ peer_id: "10", role: "owner", label: "Ann (@ann)", created_at: now }],
  created_at: now,
};
const events = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  dot_id: dot.id,
  type: i % 2 ? "agent.state" : "automation.next_run",
  data: i % 2 ? { state: "IDLE", guest_event_id: "x", guest_ts: now } : { next_run_at_ms: null },
  source: "guest",
  guest_seq: i + 1,
  created_at: now,
}));

let server: Server;
let base: string;
const requests: Recorded[] = [];
let stopped = false;
let stoppedByPerson = false;
/** The Dot has no automation due: the engine reported none. */
let noAutomationDue = false;
/** What the fake server answers about WhatsApp. */
let whatsappLinked = false;
let whatsappOff = false;
let linkFrames: { state: string; [key: string]: unknown }[] = [];

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : undefined;
  requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, body });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized", message: "bad token" });
  const route = `${req.method} ${url.pathname}`;
  const byName = (p: string) => p.replace("/fare-watch", `/${dot.id}`);
  switch (byName(route)) {
    case "GET /api/health":
      return send(res, 200, { status: "ok", database: "ok", version: "9.9.9" });
    case "POST /api/dots":
      if (typeof body?.config === "string" && body.config.includes("Bad Name")) {
        return send(res, 400, {
          error: "invalid_config",
          message: "invalid Dot configuration: name: must be lowercase",
          details: [{ path: "name", message: "must be lowercase" }],
        });
      }
      return send(res, 201, { ...dot, status: "CREATING" });
    case "GET /api/dots":
      return send(res, 200, { dots: [dot] });
    case `GET /api/dots/${dot.id}`:
      return send(res, 200, dot);
    case `GET /api/dots/${dot.id}/computer`:
      return send(res, 200, { ...(stoppedByPerson ? { ...computer, state: "STOPPED", stop_reason: "user", ready: false } : computer), ...(noAutomationDue ? { next_automation_at: null } : {}) });
    case `GET /api/dots/${dot.id}/tasks`:
      return send(res, 200, { tasks: [task] });
    case `POST /api/dots/${dot.id}/tasks`:
      return send(res, 201, { ...task, id: "task_02", status: "PENDING", description: body.description });
    case `POST /api/dots/${dot.id}/messages`:
      return send(res, 202, { message_id: "msg_1", event_id: 9, delivery: "queued" });
    case `POST /api/dots/${dot.id}/computer/start`:
    case `POST /api/dots/${dot.id}/computer/stop`:
    case `POST /api/dots/${dot.id}/computer/reboot`:
      return send(res, 202, { accepted: true });
    case `GET /api/dots/${dot.id}/browser-identities`:
      if (stopped) return send(res, 409, { error: "computer_stopped", message: "the computer of Dot fare-watch is STOPPED; start it first" });
      return send(res, 200, {
        identities: [
          { id: "shop-abc123", name: "Shop", createdAt: now, lastUsedAt: null, status: "available", profilePath: "/p", hasProxy: false },
          { id: "work-def456", name: "Work", createdAt: now, lastUsedAt: null, status: "available", profilePath: "/q", hasProxy: true },
        ],
      });
    case "GET /api/approvals":
      return send(res, 200, {
        approvals: [{ id: "apr_1", dot_id: dot.id, task_id: null, tool: "browser_identity_delete", permission: "browser.identity.delete", arguments: {}, reason: "cleanup", status: "pending", note: null, created_at: now, resolved_at: null }],
      });
    case "POST /api/approvals/apr_1/approve":
      return send(res, 200, { id: "apr_1", status: "approved", note: body?.note ?? null });
    case "POST /api/approvals/apr_1/reject":
      return send(res, 200, { id: "apr_1", status: "rejected", note: body?.note ?? null });
    case "PUT /api/secrets/openrouter":
      return send(res, 200, { pushed: 2 });
    case `GET /api/dots/${dot.id}/mcp-secrets`:
      return send(res, 200, { dot_id: dot.id, secrets: [{ server: "web", name: "Authorization", set: false }] });
    case `PUT /api/dots/${dot.id}/mcp-secrets/web/Authorization`:
      return send(res, 200, { dot_id: dot.id, secrets: [{ server: "web", name: "Authorization", set: true }] });
    case `DELETE /api/dots/${dot.id}/mcp-secrets/web/Authorization`:
      return send(res, 200, { dot_id: dot.id, secrets: [{ server: "web", name: "Authorization", set: false }] });
    case `GET /api/dots/${dot.id}/tools`:
      if (stopped) return send(res, 409, { error: "computer_stopped", message: "the computer of Dot fare-watch is STOPPED; start it first" });
      return send(res, 200, {
        tools: [],
        mcp_servers: [
          { name: "time", state: "connected", error: null, tools: 2 },
          { name: "web", state: "failed", error: "its secret Authorization is not set", tools: 0 },
        ],
      });
    case `GET /api/dots/${dot.id}/channels`:
      return send(res, 200, { channels: whatsappLinked ? [channel, { ...channel, kind: "whatsapp", account: "15550001111", peers: [] }] : [channel] });
    case `PUT /api/dots/${dot.id}/channels/telegram`:
      if (body?.token === "9:REFUSED-TOKEN-VALUE") {
        return send(res, 400, { error: "invalid_credentials", message: "Telegram refused the bot token: it is wrong, or it was revoked in @BotFather. Paste a current token." });
      }
      return send(res, 201, channel);
    case `POST /api/dots/${dot.id}/channels/telegram/pairing`:
      return send(res, 201, { code: "ABCD2345", deep_link: "https://t.me/dot_helper_bot?start=ABCD2345", message: "/start ABCD2345", expires_at: "2026-10-02T08:10:00.000Z" });
    case `POST /api/dots/${dot.id}/channels/whatsapp/pairing`:
      if (whatsappLinked) {
        return send(res, 201, { code: "WXYZ6789", deep_link: "https://wa.me/15550001111?text=pair%20WXYZ6789", message: "pair WXYZ6789", expires_at: "2026-10-02T08:10:00.000Z" });
      }
      return send(res, 201, { code: "WXYZ6789", deep_link: null, message: "pair WXYZ6789", expires_at: "2026-10-02T08:10:00.000Z" });
    case `POST /api/dots/${dot.id}/channels/whatsapp/link`:
      if (whatsappOff) return send(res, 400, { error: "invalid_request", message: 'no "whatsapp" channel: it is off: set INVISIBLE_DOTS_WHATSAPP=1 and restart the server to turn it on' });
      return send(res, 202, { ...channel, kind: "whatsapp", status: "connecting", account: null, peers: [] });
    case `GET /api/dots/${dot.id}/channels/whatsapp/qr`:
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      for (const frame of linkFrames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      if (linkFrames.at(-1)?.state === "linked" || linkFrames.at(-1)?.state === "failed") return res.end();
      return; // left open, like the real stream
    case `DELETE /api/dots/${dot.id}/channels/telegram`:
    case `DELETE /api/dots/${dot.id}/channels/whatsapp`:
      return send(res, 204);
    case `GET /api/dots/${dot.id}/events`: {
      const after = Number(url.searchParams.get("after") ?? 0);
      return send(res, 200, { events: events.filter((e) => e.id > after) });
    }
    case "GET /api/stream": {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const after = Number(url.searchParams.get("after") ?? 0);
      res.write(": connected\n\n");
      const live = { ...events[0]!, id: after + 1, type: "task.completed", data: { task_id: "task_02", summary: "done" } };
      res.write(`id: ${live.id}\ndata: ${JSON.stringify(live)}\n\n`);
      return; // left open, like the real stream
    }
    default:
      return send(res, 404, { error: "not_found", message: `no route ${route}` });
  }
}

let configDir: string;

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configDir = await mkdtemp(join(tmpdir(), "idots-cli-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  stopped = false;
  stoppedByPerson = false;
  noAutomationDue = false;
  whatsappLinked = false;
  whatsappOff = false;
  linkFrames = [];
});

async function cli(
  argv: string[],
  options: { env?: Record<string, string>; stdin?: string; line?: string; tty?: boolean; signal?: AbortSignal; host?: HostCommands } = {},
) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => options.stdin ?? "",
    readSecret: async () => options.line ?? "",
    stdinIsTTY: options.tty ?? false,
    env: { INVISIBLE_DOTS_URL: base, INVISIBLE_DOTS_TOKEN: TOKEN, INVISIBLE_DOTS_HOME: configDir, ...options.env },
    cwd: configDir,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.host ? { host: options.host } : {}),
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

describe("usage", () => {
  it("prints help with exit 0, and exit 2 with no command, an unknown command or an unknown flag", async () => {
    expect((await cli(["--help"])).code).toBe(EXIT.ok);
    const none = await cli([]);
    expect(none.code).toBe(EXIT.usage);
    expect(none.stdout).toContain("invisible-dots setup");
    expect((await cli(["launch"])).stderr).toMatch(/unknown command "launch"/);
    expect((await cli(["list", "--bogus"])).code).toBe(EXIT.usage);
    expect((await cli(["status"])).stderr).toMatch(/missing <dot>/);
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("server and token", () => {
  it("reads the token from <INVISIBLE_DOTS_HOME>/config/api.token when INVISIBLE_DOTS_TOKEN is unset", async () => {
    await mkdir(join(configDir, "config"), { recursive: true });
    await writeFile(join(configDir, "config", "api.token"), `${TOKEN}\n`);
    const result = await cli(["list"], { env: { INVISIBLE_DOTS_TOKEN: "" } });
    expect(result.code).toBe(EXIT.ok);
    await rm(join(configDir, "config"), { recursive: true });
  });

  it("exit 4 without a token or with a refused one, exit 3 when the server is unreachable", async () => {
    const missing = await cli(["list"], { env: { INVISIBLE_DOTS_TOKEN: "", INVISIBLE_DOTS_HOME: join(configDir, "none") } });
    expect(missing.code).toBe(EXIT.auth);
    expect(missing.stderr).toMatch(/no API token: .*api\.token does not exist yet; start the server once/);
    const refused = await cli(["list"], { env: { INVISIBLE_DOTS_TOKEN: "wrong-token-123456789" } });
    expect(refused.code).toBe(EXIT.auth);
    expect(refused.stderr).toMatch(/refused the API token/);
    const down = await cli(["list"], { env: { INVISIBLE_DOTS_URL: "http://127.0.0.1:1" } });
    expect(down.code).toBe(EXIT.unreachable);
    expect(down.stderr).toMatch(/cannot reach the invisible_dots API/);
  });
});

describe("commands", () => {
  it("init writes the sample, checks the server and refuses to overwrite without --force", async () => {
    const first = await cli(["init", "sample.yaml"]);
    expect(first.code).toBe(EXIT.ok);
    expect(first.stdout).toMatch(/is reachable \(version 9\.9\.9/);
    expect(await readFile(join(configDir, "sample.yaml"), "utf8")).toBe(SAMPLE_DOT);
    const again = await cli(["init", "sample.yaml"]);
    expect(again.code).toBe(EXIT.failed);
    expect(again.stderr).toMatch(/already exists/);
    expect((await cli(["init", "sample.yaml", "--force"])).code).toBe(EXIT.ok);
  });

  it("writes a sample the host accepts as it is: every key of it is one the schema knows", () => {
    expect(parseDotConfig(SAMPLE_DOT).name).toBe("my-first-dot");
  });

  it("create sends the YAML text and prints validation details on 400", async () => {
    await writeFile(join(configDir, "good.yaml"), SAMPLE_DOT);
    const ok = await cli(["create", "good.yaml"]);
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.stdout).toMatch(/created Dot fare-watch/);
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ config: SAMPLE_DOT });

    await writeFile(join(configDir, "bad.yaml"), "name: Bad Name\n");
    const bad = await cli(["create", "bad.yaml"]);
    expect(bad.code).toBe(EXIT.failed);
    expect(bad.stderr).toMatch(/\[400 invalid_config\]/);
    expect(bad.stderr).toMatch(/name: must be lowercase/);
    expect((await cli(["create", "missing.yaml"])).code).toBe(EXIT.usage);
  });

  it("list, status and tasks print tables, and --json prints the data", async () => {
    const list = await cli(["list"]);
    expect(list.stdout).toMatch(/^NAME\s+STATUS\s+COMPUTER/);
    expect(list.stdout).toContain("fare-watch  READY");
    const json = await cli(["list", "--json"]);
    expect(JSON.parse(json.stdout)[0].id).toBe(dot.id);
    const status = await cli(["status", "fare-watch"]);
    expect(status.code).toBe(EXIT.ok);
    expect(status.stdout).toMatch(/computer\s+RUNNING, ready/);
    expect(status.stdout).toMatch(/next automation\s+2030-01-01T09:00:00.000Z/);
    expect(status.stdout).toContain("task_01");
    expect((await cli(["tasks", "fare-watch"])).stdout).toContain("COMPLETED");
  });

  it("status does not say paused for a Dot the person stopped that has no automation due", async () => {
    stoppedByPerson = true;
    noAutomationDue = true;
    const status = await cli(["status", "fare-watch"]);
    expect(status.stdout).toMatch(/next automation\s+none due/);
    expect(status.stdout).not.toMatch(/paused/);
  });

  it("status says the automations are paused while the person's stop lasts, and stop says so when it is asked for", async () => {
    stoppedByPerson = true;
    const status = await cli(["status", "fare-watch"]);
    expect(status.stdout).toMatch(/computer\s+STOPPED/);
    expect(status.stdout).toMatch(/next automation\s+paused: the computer was stopped by you \(start it to resume\)/);
    expect(status.stdout).not.toContain("2030-01-01T09:00:00.000Z");

    const stop = await cli(["computer", "fare-watch", "stop"]);
    expect(stop.stdout).toMatch(/automations are paused while the computer is stopped; resume them with: invisible-dots computer fare-watch start/);
    expect((await cli(["computer", "fare-watch", "start"])).stdout).not.toMatch(/paused/);
  });

  it("message and task send what was typed", async () => {
    const message = await cli(["message", "fare-watch", "how", "is", "it", "going?"]);
    expect(message.stdout).toMatch(/message queued/);
    expect(requests.at(-1)?.body).toEqual({ text: "how is it going?" });
    const queued = await cli(["task", "fare-watch", "check", "Lisbon", "--priority", "3", "--at", "2030-01-01T08:00:00Z"]);
    expect(queued.code).toBe(EXIT.ok);
    expect(requests.at(-1)?.body).toEqual({ description: "check Lisbon", priority: 3, scheduled_at: "2030-01-01T08:00:00.000Z" });
    expect((await cli(["task", "fare-watch", "x", "--priority", "high"])).code).toBe(EXIT.usage);
    expect((await cli(["message", "fare-watch"])).code).toBe(EXIT.usage);
  });

  it("computer actions, and browser identities with the server's 409 shown", async () => {
    for (const action of ["start", "stop", "reboot"]) {
      expect((await cli(["computer", "fare-watch", action])).code).toBe(EXIT.ok);
      expect(requests.at(-1)?.path).toBe(`/api/dots/fare-watch/computer/${action}`);
    }
    expect((await cli(["computer", "fare-watch", "pause"])).code).toBe(EXIT.usage);
    const listed = (await cli(["browser", "fare-watch", "identities"])).stdout;
    expect(listed).toContain("shop-abc123");
    // The identity has no proxy of its own, the normal case: the column says none instead of asking for one; one that has a
    // proxy says only that.
    expect(listed).toMatch(/shop-abc123\s+Shop\s+available\s+never\s+-\s*$/m);
    expect(listed).toMatch(/work-def456\s+Work\s+available\s+never\s+yes\s*$/m);
    stopped = true;
    const conflict = await cli(["browser", "fare-watch", "identities"]);
    expect(conflict.code).toBe(EXIT.failed);
    expect(conflict.stderr).toMatch(/start it first \[409 computer_stopped\]/);
  });

  it("approvals, approve and reject", async () => {
    expect((await cli(["approvals"])).stdout).toContain("apr_1");
    expect(requests.at(-1)?.query.get("status")).toBe("pending");
    await cli(["approvals", "--all"]);
    expect(requests.at(-1)?.query.get("status")).toBeNull();
    const approved = await cli(["approve", "apr_1", "--note", "fine"]);
    expect(approved.stdout).toBe("approval apr_1 approved\n");
    expect(requests.at(-1)?.body).toEqual({ note: "fine" });
    expect((await cli(["reject", "apr_1"])).stdout).toBe("approval apr_1 rejected\n");
    expect(requests.at(-1)?.body).toEqual({});
    await cli(["approve", "apr_1", "--always"]);
    expect(requests.at(-1)?.body).toEqual({ always: true });
    await cli(["approve", "apr_1", "--always", "--note", "ok"]);
    expect(requests.at(-1)?.body).toEqual({ note: "ok", always: true });
    const refused = await cli(["reject", "apr_1", "--always"]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("--always applies to approve");
  });

  it("secret openrouter reads the key from stdin only", async () => {
    const stored = await cli(["secret", "openrouter"], { stdin: "sk-or-v1-abc\n" });
    expect(stored.code).toBe(EXIT.ok);
    expect(stored.stdout).toMatch(/pushed to 2 running Dots/);
    expect(requests.at(-1)?.body).toEqual({ value: "sk-or-v1-abc" });
    await cli(["secret", "openrouter", "--dot", "fare-watch"], { stdin: "sk-or-v1-abc" });
    expect(requests.at(-1)?.body).toEqual({ value: "sk-or-v1-abc", dot_id: "fare-watch" });
    const inArgs = await cli(["secret", "openrouter", "sk-or-v1-abc"]);
    expect(inArgs.code).toBe(EXIT.usage);
    expect(inArgs.stderr).toMatch(/never from arguments/);
    expect((await cli(["secret", "openrouter"], { stdin: "  " })).code).toBe(EXIT.usage);
  });

  it("secret mcp reads the value from stdin only, keeps a space a header needs, and --clear removes it", async () => {
    const stored = await cli(["secret", "mcp", "--dot", "fare-watch", "web", "Authorization"], { stdin: "Bearer tok-1\n" });
    expect(stored.code).toBe(EXIT.ok);
    expect(stored.stdout).toContain("Authorization of the MCP server web stored");
    expect(requests.at(-1)).toMatchObject({ method: "PUT", body: { value: "Bearer tok-1" } });
    expect(stored.stdout).not.toContain("tok-1");
    const cleared = await cli(["secret", "mcp", "--dot", "fare-watch", "web", "Authorization", "--clear"]);
    expect(cleared.stdout).toContain("cleared");
    expect(requests.at(-1)?.method).toBe("DELETE");
    const inArgs = await cli(["secret", "mcp", "--dot", "fare-watch", "web", "Authorization", "tok-1"]);
    expect(inArgs.code).toBe(EXIT.usage);
    expect(inArgs.stderr).toMatch(/never from arguments/);
    expect((await cli(["secret", "mcp", "web", "Authorization"], { stdin: "x" })).stderr).toContain("missing --dot");
  });

  it("mcp lists the declared servers with where each is and which secrets are set, and still the secrets of a stopped Dot", async () => {
    const listed = await cli(["mcp", "fare-watch"]);
    expect(listed.code).toBe(EXIT.ok);
    expect(listed.stdout).toMatch(/time\s+connected, 2 tools\s+-/);
    expect(listed.stdout).toMatch(/web\s+failed: its secret Authorization is not set\s+Authorization \(not set\)/);
    stopped = true;
    try {
      const off = await cli(["mcp", "fare-watch"]);
      expect(off.code).toBe(EXIT.ok);
      expect(off.stdout).toMatch(/web\s+computer stopped\s+Authorization \(not set\)/);
    } finally {
      stopped = false;
    }
  });

  it("secret openrouter in a terminal reads one line, which Enter ends on every host", async () => {
    // A terminal never reaches end of input by itself, and the key that ends it differs by host:
    // only the line is read, so the command never waits for it.
    const typed = await cli(["secret", "openrouter"], {
      tty: true,
      line: "sk-or-v1-typed",
      stdin: "never read: a terminal does not end",
    });
    expect(typed.code).toBe(EXIT.ok);
    expect(typed.stderr).toBe("paste the OpenRouter API key, then press Enter:\n");
    expect(typed.stderr).not.toMatch(/Ctrl/);
    expect(requests.at(-1)?.body).toEqual({ value: "sk-or-v1-typed" });
    const empty = await cli(["secret", "openrouter"], { tty: true, line: "" });
    expect(empty.code).toBe(EXIT.usage);
    // The hint is a command that runs as printed in PowerShell too: no "<" redirection.
    expect(empty.stderr).toContain('run "invisible-dots secret openrouter" in a terminal');
    expect(empty.stderr).not.toContain("<");
  });

  it("channel add reads the token from stdin or one line of a terminal, never from arguments, and never prints it", async () => {
    const piped = await cli(["channel", "add", "telegram", "--dot", "fare-watch"], { stdin: "123456:SECRET-TOKEN-VALUE\n" });
    expect(piped.code).toBe(EXIT.ok);
    expect(requests.at(-1)).toMatchObject({ method: "PUT", path: `/api/dots/fare-watch/channels/telegram`, body: { token: "123456:SECRET-TOKEN-VALUE" } });
    expect(piped.stdout).toContain("linked Telegram bot @dot_helper_bot to Dot fare-watch\n");
    expect(piped.stdout).toContain("next: invisible-dots channel pair telegram --dot fare-watch\n");
    expect(piped.stdout).toMatch(/not end-to-end encrypted/);
    expect(piped.stdout + piped.stderr).not.toContain("SECRET-TOKEN");

    const typed = await cli(["channel", "add", "telegram", "--dot", "fare-watch"], { tty: true, line: "123456:TYPED-TOKEN-VALUE", stdin: "never read" });
    expect(typed.code).toBe(EXIT.ok);
    expect(typed.stderr).toBe("paste the Telegram bot token from @BotFather, then press Enter:\n");
    expect(requests.at(-1)?.body).toEqual({ token: "123456:TYPED-TOKEN-VALUE" });

    const inArgs = await cli(["channel", "add", "telegram", "123456:SECRET-TOKEN-VALUE", "--dot", "fare-watch"]);
    expect(inArgs.code).toBe(EXIT.usage);
    expect(inArgs.stderr).toMatch(/never from arguments/);
    expect(inArgs.stderr).not.toContain("SECRET-TOKEN");
    const empty = await cli(["channel", "add", "telegram", "--dot", "fare-watch"], { tty: true, line: "" });
    expect(empty.code).toBe(EXIT.usage);
    expect(empty.stderr).toContain('run "invisible-dots channel add telegram --dot fare-watch" in a terminal');
    expect((await cli(["channel", "add", "telegram"], { stdin: "123456:SECRET-TOKEN-VALUE" })).stderr).toMatch(/missing --dot <dot>/);
    expect((await cli(["channel", "add", "whatsapp", "--dot", "fare-watch"])).stderr).toMatch(/only telegram is supported/);
    const json = await cli(["channel", "add", "telegram", "--dot", "fare-watch", "--json"], { stdin: "123456:SECRET-TOKEN-VALUE" });
    expect(JSON.parse(json.stdout)).toMatchObject({ kind: "telegram", account: "dot_helper_bot" });
  });

  it("channel add shows what the server said about a refused token, without the token", async () => {
    const refused = await cli(["channel", "add", "telegram", "--dot", "fare-watch"], { stdin: "9:REFUSED-TOKEN-VALUE" });
    expect(refused.code).toBe(EXIT.failed);
    expect(refused.stderr).toMatch(/refused the bot token.*\[400 invalid_credentials\]/);
    expect(refused.stderr).not.toContain("REFUSED-TOKEN-VALUE");
  });

  it("channel list prints a table of every Dot's channels, or one Dot's, and --json the data", async () => {
    const all = await cli(["channel", "list"]);
    expect(all.code).toBe(EXIT.ok);
    expect(all.stdout.split("\n")[0]).toMatch(/^DOT\s+CHANNEL\s+STATUS\s+ACCOUNT\s+PEOPLE\s+NOTE/);
    expect(all.stdout).toMatch(/fare-watch\s+telegram\s+connected\s+@dot_helper_bot\s+Ann \(@ann\)/);
    const one = await cli(["channel", "list", "--dot", "fare-watch"]);
    expect(one.stdout).toBe(all.stdout);
    expect(JSON.parse((await cli(["channel", "list", "--json"])).stdout)).toEqual([{ dot: "fare-watch", channel }]);
    expect((await cli(["channel", "list", "extra"])).code).toBe(EXIT.usage);
  });

  it("channel pair prints the link and the code, or only the code where a channel has no link", async () => {
    const paired = await cli(["channel", "pair", "telegram", "--dot", "fare-watch"]);
    expect(paired.code).toBe(EXIT.ok);
    expect(paired.stdout).toBe(
      "open this link on the device where you use telegram, then press Start (valid until 2026-10-02T08:10:00.000Z):\n  https://t.me/dot_helper_bot?start=ABCD2345\nor send the bot: /start ABCD2345\n",
    );
    expect((await cli(["channel", "pair", "whatsapp", "--dot", "fare-watch"])).stdout).toBe("pairing code WXYZ6789, valid until 2026-10-02T08:10:00.000Z\n");
    expect((await cli(["channel", "pair", "carrier-pigeon", "--dot", "fare-watch"])).stderr).toMatch(/unknown channel "carrier-pigeon": use telegram or whatsapp/);
    expect((await cli(["channel", "pair", "telegram"])).stderr).toMatch(/missing --dot <dot>/);
  });

  it("channel remove unlinks, and an unknown subcommand is a usage error", async () => {
    const removed = await cli(["channel", "remove", "telegram", "--dot", "fare-watch"]);
    expect(removed.code).toBe(EXIT.ok);
    expect(removed.stdout).toBe("unlinked telegram from Dot fare-watch: its token and paired people are deleted\n");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/dots/fare-watch/channels/telegram" });
    expect((await cli(["channel", "remove", "whatsapp", "--dot", "fare-watch"])).stdout).toBe("unlinked whatsapp from Dot fare-watch: the linked device's keys and paired people are deleted\n");
    expect((await cli(["channel", "remove", "telegram"])).code).toBe(EXIT.usage);
    expect((await cli(["channel", "mute"])).stderr).toMatch(/unknown channel subcommand "mute": use add, link, list, pair or remove/);
    expect((await cli(["channel"])).stderr).toMatch(/missing add\|link\|list\|pair\|remove/);
  });

  it("channel link whatsapp warns of the risk, shows each code as a QR for the terminal and ends when the number is linked", async () => {
    linkFrames = [{ state: "waiting" }, { state: "code", code: "2@first-code" }, { state: "code", code: "2@second-code" }, { state: "linked", account: "15550001111" }];
    const linked = await cli(["channel", "link", "whatsapp", "--dot", "fare-watch"]);
    expect(linked.code).toBe(EXIT.ok);
    expect(requests.map((r) => `${r.method} ${r.path}`).slice(-2)).toEqual(["POST /api/dots/fare-watch/channels/whatsapp/link", "GET /api/dots/fare-watch/channels/whatsapp/qr"]);
    expect(linked.stderr).toContain("can answer by banning the account");
    expect(linked.stderr).toContain("Linked devices");
    // Two codes, drawn with the block characters of a terminal QR, and never printed as text.
    expect(linked.stdout.match(/█|▀|▄/g)?.length ?? 0).toBeGreaterThan(100);
    expect(linked.stdout).not.toContain("2@first-code");
    expect(linked.stdout).toContain("linked WhatsApp number +15550001111 to Dot fare-watch\nnext: invisible-dots channel pair whatsapp --dot fare-watch\n");
  });

  it("channel link whatsapp exits with the reason when the link fails, and says what the server said when WhatsApp is off", async () => {
    linkFrames = [{ state: "waiting" }, { state: "failed", detail: "The link was not completed: the code expired. Start linking again." }];
    const failed = await cli(["channel", "link", "whatsapp", "--dot", "fare-watch"]);
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.stderr).toContain("invisible-dots: The link was not completed: the code expired. Start linking again.\n");

    whatsappOff = true;
    const off = await cli(["channel", "link", "whatsapp", "--dot", "fare-watch"]);
    expect(off.code).toBe(EXIT.failed);
    expect(off.stderr).toContain("INVISIBLE_DOTS_WHATSAPP=1");
  });

  it("channel link whatsapp --json prints the frames, code included, as lines of JSON", async () => {
    linkFrames = [{ state: "code", code: "2@first-code" }, { state: "linked", account: "15550001111" }];
    const json = await cli(["channel", "link", "whatsapp", "--dot", "fare-watch", "--json"]);
    expect(json.code).toBe(EXIT.ok);
    expect(json.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual(linkFrames);
  });

  it("channel link takes only whatsapp and a Dot, and channel add points WhatsApp to link", async () => {
    expect((await cli(["channel", "link", "telegram", "--dot", "fare-watch"])).stderr).toMatch(/only whatsapp is linked that way/);
    expect((await cli(["channel", "link", "whatsapp"])).stderr).toMatch(/missing --dot <dot>/);
    expect((await cli(["channel", "link", "whatsapp", "extra", "--dot", "fare-watch"])).code).toBe(EXIT.usage);
    expect((await cli(["channel", "add", "whatsapp", "--dot", "fare-watch"])).stderr).toContain('invisible-dots channel link whatsapp --dot <dot>');
  });

  it("channel pair gives WhatsApp's link and words once the number is known, and list shows the number with a plus", async () => {
    whatsappLinked = true;
    const paired = await cli(["channel", "pair", "whatsapp", "--dot", "fare-watch"]);
    expect(paired.stdout).toBe(
      "open this link on the device where you use whatsapp, then press Send (valid until 2026-10-02T08:10:00.000Z):\n  https://wa.me/15550001111?text=pair%20WXYZ6789\nor send the number: pair WXYZ6789\n",
    );
    const list = await cli(["channel", "list", "--dot", "fare-watch"]);
    expect(list.stdout).toMatch(/fare-watch\s+telegram\s+connected\s+@dot_helper_bot/);
    expect(list.stdout).toMatch(/fare-watch\s+whatsapp\s+connected\s+\+15550001111/);
  });

  it("logs prints the tail without follow, and follows the stream until interrupted", async () => {
    const tail = await cli(["logs", "fare-watch", "--tail", "2", "--no-follow"]);
    expect(tail.code).toBe(EXIT.ok);
    const lines = tail.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/#4 agent\.state \{"state":"IDLE"\}$/);

    const controller = new AbortController();
    let output = "";
    const io: CliIo = {
      stdout: (t) => {
        output += t;
        if (t.includes("task.completed")) controller.abort();
      },
      stderr: () => {},
      readStdin: async () => "",
      readSecret: async () => "",
      stdinIsTTY: false,
      env: { INVISIBLE_DOTS_URL: base, INVISIBLE_DOTS_TOKEN: TOKEN },
      cwd: configDir,
      signal: controller.signal,
    };
    expect(await run(["logs", "fare-watch", "--tail", "1"], io)).toBe(EXIT.ok);
    expect(output).toMatch(/#5 automation\.next_run/);
    expect(output).toMatch(/#6 task\.completed/);
    const stream = requests.find((r) => r.path === "/api/stream");
    expect(stream?.query.get("after")).toBe("5");
    expect(stream?.query.get("dot_id")).toBe(dot.id);
  });
});

describe("host commands", () => {
  function fakeHost() {
    const calls: string[] = [];
    const host: HostCommands = {
      doctor: async (options, io) => {
        calls.push(`doctor json=${options.json}`);
        io.stdout("all 10 checks ok\n");
        return EXIT.ok;
      },
      setup: async () => {
        calls.push("setup");
        return EXIT.restart;
      },
      setupAll: async () => {
        calls.push("setup --all");
        return EXIT.ok;
      },
      imageBuild: async () => {
        calls.push("image build");
        return EXIT.failed;
      },
      server: async (_io, options) => {
        calls.push(`server web=${options.web}`);
        return EXIT.ok;
      },
    };
    return { host, calls };
  }

  it("routes setup, doctor, image build and server, and returns their exit codes", async () => {
    const { host, calls } = fakeHost();
    expect((await cli(["doctor"], { host })).stdout).toBe("all 10 checks ok\n");
    expect((await cli(["doctor", "--json"], { host })).code).toBe(EXIT.ok);
    expect((await cli(["setup"], { host })).code).toBe(EXIT.restart);
    expect((await cli(["setup", "--all"], { host })).code).toBe(EXIT.ok);
    expect((await cli(["image", "build"], { host })).code).toBe(EXIT.failed);
    expect((await cli(["server"], { host })).code).toBe(EXIT.ok);
    expect((await cli(["server", "--no-web"], { host })).code).toBe(EXIT.ok);
    expect(calls).toEqual(["doctor json=false", "doctor json=true", "setup", "setup --all", "image build", "server web=true", "server web=false"]);
    // None of them needs the API or its token.
    expect(requests).toHaveLength(0);
  });

  it("refuses stray arguments with exit 2, and reports a host command that throws with exit 1", async () => {
    const { host, calls } = fakeHost();
    expect((await cli(["image"], { host })).stderr).toMatch(/missing build/);
    expect((await cli(["image", "pull"], { host })).stderr).toMatch(/unknown image subcommand "pull"/);
    expect((await cli(["image", "build", "now"], { host })).code).toBe(EXIT.usage);
    expect((await cli(["setup", "x"], { host })).code).toBe(EXIT.usage);
    expect((await cli(["setup", "--all", "x"], { host })).code).toBe(EXIT.usage);
    expect((await cli(["doctor", "all"], { host })).stderr).toMatch(/doctor takes no arguments/);
    expect(calls).toEqual([]);

    host.server = async () => {
      throw new Error("another invisible-dots server (pid 42) is already running");
    };
    const failed = await cli(["server"], { host });
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.stderr).toBe("invisible-dots: another invisible-dots server (pid 42) is already running\n");
  });

  it("lists setup --all in the help, first among the host commands", async () => {
    const help = (await cli(["--help"])).stdout;
    expect(help).toMatch(/invisible-dots setup --all .*everything in one run/);
    expect(help.indexOf("setup --all")).toBeLessThan(help.indexOf("invisible-dots setup  "));
  });

  it("asks the process to stop on Ctrl-C only for logs, image build and setup --all", () => {
    expect(interruptIsAsked(["logs", "fare-watch"])).toBe(true);
    expect(interruptIsAsked(["image", "build"])).toBe(true);
    expect(interruptIsAsked(["setup", "--all"])).toBe(true);
    expect(interruptIsAsked(["--all", "setup"])).toBe(true);
    expect(interruptIsAsked(["setup"])).toBe(false);
    expect(interruptIsAsked(["server"])).toBe(false);
    expect(interruptIsAsked(["approvals", "--all"])).toBe(false);
  });

  it("finds the command word for main.ts wherever the flags are", () => {
    expect(commandOf(["--json", "doctor"])).toBe("doctor");
    expect(commandOf(["logs", "fare-watch", "--tail", "3"])).toBe("logs");
    expect(commandOf(["--help"])).toBeUndefined();
  });
});
