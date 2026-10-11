/**
 * The real-VM end-to-end run (tests/e2e/run.ts) cannot run in CI: it needs an
 * accelerator, 15 GB of disk and a real OpenRouter key. What can run here is
 * everything it is made of that needs no VM:
 *
 * - the contract: every route, command, flag, tool, permission, event type and
 *   doctor check the run names still exists in the product, so a change to the
 *   product that the run has not followed fails here, in CI, and not an hour
 *   into a manual run;
 * - the helpers: its byte checks (PNG, JPEG), its scans for a secret, the Dot's
 *   YAML, the guest proof and the token it reads from a seed, and its waiting,
 *   against bytes and rows built in the test.
 *
 * The run imports nothing from the workspace, so these tests are where the two
 * meet.
 */
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { USAGE } from "@invisible-dots/cli";
import {
  type AgentStateAnswer as SharedAgentStateAnswer,
  HOST_EVENT_TYPES,
  mcpServerOf,
  OUTBOUND_EVENT_TYPES,
  PERMISSIONS,
  parseDotConfig,
  resolvePermission,
  toRuntimeConfig,
} from "@invisible-dots/shared";
import { guestProof as productGuestProof, loadSeedTemplates, renderSeed, writeSeedIso } from "@invisible-dots/vm-manager";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_COMMANDS,
  CLI_FLAGS,
  DOCTOR_CHECKS,
  dotName,
  dotTokenFromSeed,
  dotYaml,
  eventLines,
  EVENTS,
  Failure,
  fileContains,
  filesHolding,
  filesUnder,
  guestProof,
  identityEvents,
  identityTarget,
  isSpend,
  jpegSize,
  journalCleanHash,
  journalCountCommand,
  keyFromFile,
  lastEventId,
  pngInfo,
  proxyIsMasked,
  ROUTE_CALLS,
  ROUTES,
  route,
  rowsHolding,
  selfExcludingPattern,
  sha256File,
  sha256Text,
  taskEvents,
  TOOLS,
  toolCalls,
  toolOk,
  utcStamp,
  waitFor,
  type AgentStateAnswer,
  type Clock,
  type StoredEvent,
} from "../e2e/lib.ts";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n");

let dir: string | undefined;
function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), "idots-e2e-"));
  return dir;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function event(id: number, type: string, data: Record<string, unknown>): StoredEvent {
  return { id, type, data, created_at: "2026-10-06T10:00:00.000Z" };
}

describe("the e2e run's contract with the product", () => {
  it("is TypeScript that Node runs as it is: every file of the runs strips to JavaScript", () => {
    // The runs are started with plain Node (type stripping), which refuses what only a compiler can turn
    // into JavaScript (a parameter property, an enum); the typecheck alone accepts those.
    for (const file of ["tests/e2e/run.ts", "tests/e2e/scale.ts", "tests/e2e/driver.ts", "tests/e2e/lib.ts", "tests/bench/bridge.ts"]) {
      expect(() => stripTypeScriptTypes(read(file)), file).not.toThrow();
    }
  });

  it("calls only routes the architecture lists (section 9.6) and the API registers, with the method it uses", () => {
    const architecture = read("docs/architecture.md");
    const section = architecture.slice(architecture.indexOf("### 9.6 API"), architecture.indexOf("### 9.7 Web client"));
    const listed = new Set(
      [...section.matchAll(/^([A-Z]+)\s+(\/\S+)/gm)].map((m) => `${m[1]} ${m[2]}`),
    );
    const server = read("apps/api/src/server.ts");
    for (const [method, template] of ROUTE_CALLS) {
      expect(listed.has(`${method} ${template}`), `architecture 9.6 lists ${method} ${template}`).toBe(true);
      const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(new RegExp(`app\\.${method.toLowerCase()}[^"]*"${escaped}"`).test(server), `apps/api/src/server.ts registers ${method} ${template}`).toBe(true);
    }
  });

  it("names a route template for every route it calls", () => {
    const templates = new Set(ROUTE_CALLS.map(([, template]) => template));
    for (const template of Object.values(ROUTES)) expect(templates.has(template), `${template} is in ROUTE_CALLS`).toBe(true);
  });

  it("runs only commands and flags the invisible-dots usage text lists", () => {
    for (const command of CLI_COMMANDS) expect(USAGE, command).toContain(`invisible-dots ${command}`);
    for (const flag of CLI_FLAGS) expect(USAGE, flag).toContain(flag);
  });

  it("asserts only on tools of the engine's permission table, under the permission it names", () => {
    const table = read("invisible_engine_dots/nanobot/dots/permissions.py");
    const rows = new Map([...table.matchAll(/^\s+"(\w+)": ToolEntry\("([a-z.]+)"/gm)].map((m) => [m[1]!, m[2]!]));
    expect(rows.size).toBeGreaterThan(20);
    for (const [tool, permission] of Object.entries(TOOLS)) {
      expect(rows.get(tool), `TOOL_PERMISSIONS row of ${tool}`).toBe(permission);
      expect(PERMISSIONS as readonly string[], permission).toContain(permission);
    }
  });

  it("names in run.ts only tools, event types and permissions it declares and the product has", () => {
    const run = read("tests/e2e/run.ts");
    // A tool is named where the run reads a call of it or waits for the approval of it.
    const tools = [
      ...run.matchAll(/(?:toolOk|toolCalls|call|waitApproval)\([^"\n]*"([a-z_]+)"/g),
      ...run.matchAll(/^\s+\["([a-z_]+)", "[a-z.]+"\],?$/gm),
    ].map((m) => m[1]!);
    expect(tools.length).toBeGreaterThan(10);
    // A tool of an MCP server is the server's, not the table's: its server is one the run declares (`mcpServers`).
    const declared = (server: string) => new RegExp(`mcpServers: \\{[^}]*\\b${server}\\b`).test(run);
    for (const tool of tools) {
      const server = /^mcp_([a-z0-9-]+)_/.exec(tool)?.[1];
      if (server !== undefined) expect(declared(server), `run.ts names ${tool} of an MCP server it does not declare`).toBe(true);
      else expect(Object.keys(TOOLS), `run.ts names the tool ${tool}`).toContain(tool);
    }
    // A dotted name in quotes is an event type or a permission, unless it is one of the few hosts and files the run writes.
    const other = new Set(["example.com", "title.txt", "approval.txt", "approval-counter.txt", "exec-marker.txt", "api.token", "qemu.json", "seed.iso", "serial.log", "disk.qcow2", "screenshot.png", "frame.jpg", "summary.json", "summary.txt", "events.txt", "server.log", "image-build.log", "cli.log", "dot.yaml"]);
    const dotted = [...run.matchAll(/"([a-z]+(?:\.[a-z]+)+)"/g)].map((m) => m[1]!).filter((name) => !other.has(name));
    expect(dotted.length).toBeGreaterThan(10);
    const mcpPermissionOfDeclared = (name: string) => {
      const server = mcpServerOf(name);
      return server !== null && declared(server);
    };
    for (const name of new Set(dotted)) {
      expect(
        (EVENTS as readonly string[]).includes(name) || (PERMISSIONS as readonly string[]).includes(name) || mcpPermissionOfDeclared(name),
        `run.ts names ${name}: not in EVENTS, not a permission, not the permission of an MCP server it declares`,
      ).toBe(true);
    }
    // Every permission the run sets is one of the Dot's, or the permission of an MCP server it declares.
    for (const m of run.matchAll(/permissions: \{([^}]*)\}/g)) {
      for (const key of m[1]!.matchAll(/"([a-z0-9.-]+)":/g)) {
        expect((PERMISSIONS as readonly string[]).includes(key[1]!) || mcpPermissionOfDeclared(key[1]!), key[1]).toBe(true);
      }
    }
  });

  it("reads the events a host route causes only by waiting for them: the guest's events reach the host's log through the pump", () => {
    const run = read("tests/e2e/run.ts");
    // A read of the log right after a route, asserted at once, races the pump (an event of a task that has ended is
    // already there: the pump delivers in order, and the task's end is one of its events).
    expect(run).not.toMatch(/assert\(identityEvents\(await events\(dotId\), "browser\.identity\.closed"/);
    expect(run).not.toMatch(/assert\(closedAt && deletedAt/);
    expect(run).toContain('waitFor("browser.identity.closed for the host\'s close", TIMEOUTS.pump');
    expect(run).toContain('waitFor("browser.identity.deleted for the host\'s delete", TIMEOUTS.pump');
  });

  it("reads only event types the host knows", () => {
    const known = new Set<string>([...OUTBOUND_EVENT_TYPES, ...HOST_EVENT_TYPES]);
    for (const type of EVENTS) expect(known.has(type), type).toBe(true);
  });

  it("requires exactly the doctor checks the CLI has", () => {
    const source = read("packages/shared/src/api.ts");
    const union = source.slice(source.indexOf("export type DoctorCheckId ="), source.indexOf(";", source.indexOf("export type DoctorCheckId =")));
    const ids = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    expect([...DOCTOR_CHECKS].sort()).toEqual([...ids].sort());
  });

  it("writes Dot configs the product accepts, with the permissions it asks for", () => {
    const plain = parseDotConfig(dotYaml({ name: "e2e-1006-101500", model: "z-ai/glm-5.3-flash" }));
    expect(plain.name).toBe("e2e-1006-101500");
    expect(plain.model.id).toBe("z-ai/glm-5.3-flash");
    expect(plain.computer.idle_timeout).toBe("0");
    expect("browser" in plain).toBe(false);

    const strict = parseDotConfig(
      dotYaml({
        name: "e2e-x",
        model: "m/x",
        permissions: { "files.write": "ask", "computer.exec": "ask", "browser.identity.create": "ask", "browser.identity.delete": "ask" },
      }),
    );
    const runtime = toRuntimeConfig(strict);
    for (const permission of ["files.write", "computer.exec", "browser.identity.create", "browser.identity.delete"]) {
      expect(resolvePermission(runtime, permission), permission).toBe("ask");
    }
    // What the run relies on being allowed without a word: the browser, reading files (the memory too) and commands.
    for (const permission of ["browser.identity.launch", "browser.navigate", "browser.read", "files.read"]) {
      expect(resolvePermission(runtime, permission), permission).toBe("allow");
    }
    expect(resolvePermission(toRuntimeConfig(plain), "computer.exec")).toBe("allow");
    expect(resolvePermission(toRuntimeConfig(plain), "files.write")).toBe("allow");
    // The default of the identity delete is the one the run's approval step overrides to be explicit.
    expect(resolvePermission(toRuntimeConfig(plain), "browser.identity.delete")).toBe("ask");
  });

  it("reads GET /v1/agent/state in the shape packages/shared declares, the engine's pending approval being its id", () => {
    // Compile time: what the shared package declares must be assignable to what the run reads (typecheck fails otherwise).
    const shared: SharedAgentStateAnswer = { state: "WAITING_APPROVAL", current_task_id: "t1", pending_approval: "appr_1" };
    const asRead: AgentStateAnswer = shared;
    expect(asRead.pending_approval).toBe("appr_1");
    // The engine's side: the answer holds the id of the oldest pending approval (tests/dots/test_server.py runs it).
    expect(read("invisible_engine_dots/nanobot/dots/engine.py")).toContain("pending_approval=pending[0].approval_id if pending else None");
    expect(read("invisible_engine_dots/nanobot/dots/server.py")).toContain('"pending_approval": answer.pending_approval');
  });

  it("expects the target of a call on an identity as the engine writes it: the identity's id, a colon, the detail", () => {
    expect(identityTarget("research-a1b2c3", "https://example.com")).toBe("research-a1b2c3: https://example.com");
    const targets = read("invisible_engine_dots/nanobot/dots/targets.py");
    expect(targets).toContain('return f"{identity}: {detail}" if detail else identity');
    const navigate = targets.slice(targets.indexOf("def browser_navigate_target"));
    expect(navigate.slice(0, navigate.indexOf("\n\n\n"))).toContain("return _on_identity(params, ");
  });

  it("reads the Dot's token from a real seed.iso, and the proof it checks is the product's", async () => {
    const seed = renderSeed(await loadSeedTemplates(), "dot_01abc", "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789");
    const path = join(scratch(), "seed.iso");
    await writeSeedIso(path, seed);
    expect(dotTokenFromSeed(readFileSync(path))).toBe("tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789");
    expect(guestProof("tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789", "00ff")).toBe(productGuestProof("tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789", "00ff"));
  });

  it("refuses a seed without a token", () => {
    expect(() => dotTokenFromSeed(Buffer.from("no config here"))).toThrow(Failure);
  });
});

describe("routes and names", () => {
  it("fills and encodes a route template, with its query", () => {
    expect(route(ROUTES.events, { id: "dot_1" }, { after: 5, limit: 1000 })).toBe("/api/dots/dot_1/events?after=5&limit=1000");
    expect(route(ROUTES.frame, { id: "dot_1", identityId: "a b/c" })).toBe("/api/dots/dot_1/browser-identities/a%20b%2Fc/frame");
    expect(route(ROUTES.approvals, {}, { status: "pending" })).toBe("/api/approvals?status=pending");
  });

  it("refuses a template with a segment left unfilled", () => {
    expect(() => route(ROUTES.identity, { id: "dot_1" })).toThrow(/needs "identityId"/);
  });

  it("names the Dot after the run's time, to the minute", () => {
    const stamp = utcStamp(new Date("2026-10-06T10:15:42.123Z"));
    expect(stamp).toBe("20261006T101542Z");
    expect(dotName("e2e-", stamp)).toBe("e2e-1006-101542");
    expect(dotName("e2e-", stamp)).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});

describe("the key file", () => {
  const key = "sk-or-v1-0123456789abcdef0123456789";
  it("takes one OpenRouter key, trimmed", () => {
    expect(keyFromFile(`${key}\n`, "key.txt", "sk-or-")).toBe(key);
  });
  it("refuses an empty file, a short one, two words and a key without the prefix", () => {
    for (const text of ["", "sk-or-short", `${key} ${key}`, "x".repeat(40)]) {
      expect(() => keyFromFile(text, "key.txt", "sk-or-"), text).toThrow(Failure);
    }
  });
});

describe("the pictures", () => {
  function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
    const stride = 1 + width * 3;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * stride + 1 + x * 3);
    }
    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }

  it("reads a PNG's size and tells a flat picture from a drawn one", () => {
    expect(pngInfo(png(64, 48, () => [255, 255, 255]))).toEqual({ width: 64, height: 48, blank: true });
    const drawn = pngInfo(png(64, 48, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y) % 256]));
    expect(drawn).toEqual({ width: 64, height: 48, blank: false });
  });

  it("refuses bytes that are not a PNG", () => {
    expect(() => pngInfo(Buffer.from("not a picture at all, but long enough to pass the length check"))).toThrow(/not a PNG/);
  });

  function jpeg(width: number, height: number, withEnd = true): Buffer {
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")]);
    const sof = Buffer.alloc(19);
    sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x12, 0x34]), withEnd ? Buffer.from([0xff, 0xd9]) : Buffer.alloc(0)]);
  }

  it("reads a JPEG's size past its other segments", () => {
    expect(jpegSize(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("refuses a frame that is not a whole JPEG", () => {
    expect(() => jpegSize(jpeg(10, 10, false))).toThrow(/end marker/);
    expect(() => jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))).toThrow(/not a JPEG/);
  });
});

describe("looking for a secret", () => {
  it("finds a needle across the boundary of two chunks, and in no other place", async () => {
    const path = join(scratch(), "disk.bin");
    const body = Buffer.alloc(100, 0x61);
    body.write("SECRET-VALUE", 45);
    writeFileSync(path, body);
    // A chunk of 50 bytes cuts the needle (45 to 57) in two.
    expect(await fileContains(path, Buffer.from("SECRET-VALUE"), 50)).toBe(true);
    expect(await fileContains(path, Buffer.from("SECRET-VALUES"), 50)).toBe(false);
    expect(await fileContains(path, Buffer.from("secret-value"), 50)).toBe(false);
  });

  it("reports which files hold it, never the needle", async () => {
    const root = scratch();
    mkdirSync(join(root, "logs"));
    writeFileSync(join(root, "a.log"), "nothing here");
    writeFileSync(join(root, "logs", "b.log"), "has sk-or-v1-abc inside");
    const files = await filesUnder(root);
    expect(files).toHaveLength(2);
    expect(await filesHolding(files, Buffer.from("sk-or-v1-abc"))).toEqual([join(root, "logs", "b.log")]);
    expect(await filesUnder(join(root, "missing"))).toEqual([]);
  });

  it("counts the rows (API answers) that hold it in any field", () => {
    const rows = [{ a: 1, nested: { text: "has the-needle in it" } }, { a: 2 }, "the-needle"];
    expect(rowsHolding(rows, Buffer.from("the-needle"))).toBe(2);
  });

  it("hashes a file like sha256Text hashes its text", async () => {
    const path = join(scratch(), "f.txt");
    writeFileSync(path, "Example Domain");
    expect(await sha256File(path)).toBe(sha256Text("Example Domain"));
    expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("writes a pattern that matches the prefix and not its own text", () => {
    const pattern = selfExcludingPattern("sk-or-");
    expect(pattern).toBe("sk-o[r]-");
    const regex = new RegExp(pattern);
    expect(regex.test("key sk-or-v1-abc")).toBe(true);
    expect(regex.test(`grep '${pattern}' file`)).toBe(false);
    expect(new RegExp(selfExcludingPattern("pw-1a2b3c")).test("pw-1a2b3c")).toBe(true);
  });

  it("proves a shown proxy is masked whole: no password, no user, no host", () => {
    expect(proxyIsMasked("***")).toBe(true);
    expect(proxyIsMasked("socks5://e2euser:***@127.0.0.1:9")).toBe(false);
    expect(proxyIsMasked("socks5://e2euser:pw-1a2b@127.0.0.1:9")).toBe(false);
    expect(proxyIsMasked(undefined)).toBe(false);
  });
});

describe("the journal check", () => {
  /** The command as the guest runs it, with a journal made of `lines` instead of journalctl. */
  function runCommand(command: string, lines: string[]): { code: number | null; out: string } {
    // The journal comes in on stdin, so the test does not depend on which bash is on PATH being able to open a host path.
    const done = spawnSync("bash", ["-c", `journalctl() { cat; }; ${command}`], { encoding: "utf8", input: `${lines.join("\n")}\n` });
    return { code: done.status, out: done.stdout.trim().split(/\s+/)[0] ?? "" };
  }

  const nonce = "0123456789abcdef";
  const command = journalCountCommand("sk-or-", nonce);

  it("does not contain the prefix it looks for", () => {
    expect(command).not.toContain("sk-or-");
  });

  it("prints the hash of a count of 0 for a journal without the prefix", () => {
    const done = runCommand(command, ["_TRANSPORT=kernel", "MESSAGE=booted", "MESSAGE=a line"]);
    expect(done.code).toBe(0);
    expect(done.out).toBe(journalCleanHash(nonce));
  });

  it("prints another hash when a line holds the prefix", () => {
    const done = runCommand(command, ["_TRANSPORT=kernel", "MESSAGE=Authorization sk-or-v1-leak"]);
    expect(done.code).toBe(0);
    expect(done.out).not.toBe(journalCleanHash(nonce));
  });

  it("prints no hash when the journal has no kernel entries: it could not be read in full", () => {
    const done = runCommand(command, ["_TRANSPORT=journal", "MESSAGE=only a user's entries"]);
    expect(done.code).not.toBe(0);
    expect(done.out).toBe("");
  });
});

describe("events", () => {
  const all = [
    event(1, "task.created", { task_id: "t1" }),
    event(2, "browser.identity.launched", { identity_id: "research-a1b2c3", name: "research" }),
    event(3, "tool.called", { task_id: "t1", tool: "browser_navigate", ok: true }),
    event(4, "tool.called", { task_id: "t1", tool: "exec", ok: false }),
    event(5, "tool.called", { task_id: "t2", tool: "exec", ok: true }),
    event(6, "browser.identity.closed", { identity_id: "research-a1b2c3", name: "research" }),
  ];

  it("selects a task's events and its calls of a tool", () => {
    expect(taskEvents(all, "t1").map((e) => e.id)).toEqual([1, 3, 4]);
    expect(toolCalls(all, "t1", "exec").map((e) => e.id)).toEqual([4]);
    expect(toolOk(all, "t1", "browser_navigate")).toBe(true);
    expect(toolOk(all, "t1", "exec")).toBe(false);
    expect(toolOk(all, "t2", "exec")).toBe(true);
  });

  it("selects the identity events of a type after an event", () => {
    expect(identityEvents(all, "browser.identity.closed", "research-a1b2c3", 5).map((e) => e.id)).toEqual([6]);
    expect(identityEvents(all, "browser.identity.closed", "research-a1b2c3", 6)).toEqual([]);
    expect(identityEvents(all, "browser.identity.launched").map((e) => e.id)).toEqual([2]);
    expect(identityEvents(all, "browser.identity.launched", "other")).toEqual([]);
  });

  it("finds the last event id, and 0 for none", () => {
    expect(lastEventId(all)).toBe(6);
    expect(lastEventId([])).toBe(0);
  });

  it("writes one line per event and cuts a long text", () => {
    const lines = eventLines([event(7, "message.assistant", { text: "x".repeat(400) })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("#7 message.assistant");
    expect(lines[0]).toContain(`${"x".repeat(300)}...`);
    expect(lines[0]).not.toContain("x".repeat(301));
  });

  it("takes a spend that is a finite number that is not negative", () => {
    expect(isSpend(0)).toBe(true);
    expect(isSpend(0.0123)).toBe(true);
    for (const value of [-1, Number.NaN, Infinity, "0.1", undefined, null]) expect(isSpend(value), String(value)).toBe(false);
  });
});

describe("waiting", () => {
  function clock(): Clock & { slept: number[] } {
    let now = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    };
  }

  it("returns the first value the probe gives, polling at the interval", async () => {
    const c = clock();
    let calls = 0;
    const value = await waitFor("a value", 10_000, async () => (++calls === 3 ? "ready" : undefined), 500, c);
    expect(value).toBe("ready");
    expect(c.slept).toEqual([500, 500]);
  });

  it("fails with what it waited for once the time is over", async () => {
    const c = clock();
    await expect(waitFor("the Dot to be READY", 2000, async () => undefined, 1000, c)).rejects.toThrow("timed out after 2 s waiting for the Dot to be READY");
  });

  it("stops at once when the probe fails", async () => {
    const c = clock();
    await expect(
      waitFor("a thing", 60_000, async () => {
        throw new Failure("the task ended FAILED");
      }, 1000, c),
    ).rejects.toThrow("the task ended FAILED");
    expect(c.slept).toEqual([]);
  });
});

describe("the guest proof", () => {
  it("is the HMAC-SHA256 of the context and the nonce under the token", () => {
    const expected = createHmac("sha256", "tok").update("invisible-dots guest proof v1\nabcd").digest("hex");
    expect(guestProof("tok", "abcd")).toBe(expected);
  });
});
