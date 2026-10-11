import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FILE_TOO_LARGE, GUEST_UNPROVEN, REFUSED_PROBLEM_MAX, type HealthAnswer, type OutboundEvent, type RefusedEvent } from "@invisible-dots/shared";
import { afterEach, describe, expect, it } from "vitest";
import { GuestClient, GuestHealthTimeoutError, GuestRequestError, guestProof, waitForGuestHealth } from "../src/index.js";

const TOKEN = "dot-token-123";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/**
 * A dot-agentd stand-in. It answers `GET /v1/proof` the guest's way (the
 * HMAC of the nonce under TOKEN), or, as `impostor`, with a proof it cannot
 * compute. Proof requests are kept apart from `seen`, which lists every
 * other request.
 */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
  options: { impostor?: boolean } = {},
): Promise<{ port: number; seen: Seen[]; proofs: Seen[] }> {
  const seen: Seen[] = [];
  const proofs: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      const url = new URL(req.url!, "http://guest");
      if (url.pathname === "/v1/proof") {
        proofs.push(entry);
        const nonce = url.searchParams.get("nonce") ?? "";
        return json(res, 200, { proof: options.impostor ? "0".repeat(64) : guestProof(TOKEN, nonce) });
      }
      seen.push(entry);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized", message: "bad token" }));
        return;
      }
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { port: (server!.address() as AddressInfo).port, seen, proofs };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function event(seq: number): OutboundEvent {
  return { seq, id: `evt_${seq}`, type: "automation.next_run", ts: "2026-10-02T10:00:00.000Z", data: { next_run_at_ms: seq } };
}

describe("GuestClient", () => {
  it("calls every dot-agentd route with the bearer token", async () => {
    const { port, seen } = await serve((req, res) => {
      if (req.url === "/v1/system") return json(res, 200, { hostname: "h", uptime_s: 1, cpus: 2, mem_total_bytes: 1, mem_available_bytes: 1, disk_total_bytes: 1, disk_free_bytes: 1 });
      if (req.url === "/v1/exec") return json(res, 200, { exit_code: 0, stdout: "hi\n", stderr: "", timed_out: false });
      if (req.url!.startsWith("/v1/files/list")) return json(res, 200, { entries: [] });
      if (req.url!.startsWith("/v1/files") && req.method === "GET") return res.writeHead(200).end(Buffer.from([1, 2, 3]));
      if (req.url!.startsWith("/v1/files") && req.method === "PUT") return res.writeHead(204).end();
      if (req.url === "/v1/screenshot") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("PNG"));
      if (req.url === "/v1/system/poweroff" && req.method === "POST") return json(res, 202, { status: "powering_off" });
      json(res, 404, { error: "not_found", message: req.url });
    });
    const client = new GuestClient(port, TOKEN);
    expect((await client.system()).hostname).toBe("h");
    expect(await client.exec({ command: "echo hi", timeout_ms: 1000 })).toMatchObject({ exit_code: 0, stdout: "hi\n" });
    expect(await client.readFile("workspace/a b.txt")).toEqual(Buffer.from([1, 2, 3]));
    await client.writeFile("/home/dot/x&y", "content");
    expect(await client.listFiles(".")).toEqual({ entries: [] });
    expect((await client.screenshot()).toString()).toBe("PNG");
    await client.powerOff();

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /v1/system",
      "POST /v1/exec",
      "GET /v1/files?path=workspace%2Fa%20b.txt",
      "PUT /v1/files?path=%2Fhome%2Fdot%2Fx%26y",
      "GET /v1/files/list?path=.",
      "GET /v1/screenshot",
      "POST /v1/system/poweroff",
    ]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.parse(seen[1]!.body)).toEqual({ command: "echo hi", timeout_ms: 1000 });
    expect(seen[3]!.body).toBe("content");
  });

  it("calls the agent routes under /v1/agent", async () => {
    const { port, seen } = await serve((req, res) => {
      switch (`${req.method} ${req.url}`) {
        case "POST /v1/agent/secrets":
        case "PUT /v1/agent/config":
        case "DELETE /v1/agent/browser-identities/shop-abc123":
        case "POST /v1/agent/prepare-sleep":
          return res.writeHead(204).end();
        case "POST /v1/agent/events":
          return json(res, 202, { accepted: true });
        case "GET /v1/agent/state":
          return json(res, 200, { state: "IDLE", current_task_id: null, pending_approval: null });
        case "GET /v1/agent/browser-identities":
          return json(res, 200, { identities: [] });
        case "POST /v1/agent/browser-identities":
          return json(res, 201, { id: "shop-abc123", name: "shop", createdAt: "x", lastUsedAt: null, status: "available", profilePath: "/p" });
        default:
          return json(res, 404, { error: "not_found", message: req.url });
      }
    });
    const client = new GuestClient(port, TOKEN);
    await client.pushSecrets({ openrouter_api_key: "sk-or-test", mcp_secrets: {} });
    await client.putConfig({ name: "n" } as never);
    expect(await client.postEvent({ id: "e1", type: "user.message", ts: "2026-10-02T10:00:00Z", data: { text: "hi" } })).toEqual({ accepted: true });
    expect((await client.state()).state).toBe("IDLE");
    expect(await client.listBrowserIdentities()).toEqual({ identities: [] });
    expect((await client.createBrowserIdentity({ name: "shop" })).id).toBe("shop-abc123");
    await client.deleteBrowserIdentity("shop-abc123");
    await client.prepareSleep();
    expect(JSON.parse(seen[0]!.body)).toEqual({ openrouter_api_key: "sk-or-test", mcp_secrets: {} });
    expect(seen.map((s) => s.url)).toContain("/v1/agent/browser-identities/shop-abc123");
  });

  it("asks an identity's frame as bytes and closes it with a POST, both under /v1/agent", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const { port, seen } = await serve((req, res) => {
      switch (`${req.method} ${req.url}`) {
        case "GET /v1/agent/browser-identities/shop-abc123/frame":
          return res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
        case "POST /v1/agent/browser-identities/shop-abc123/close":
          return res.writeHead(204).end();
        case "GET /v1/agent/browser-identities/shut-abc123/frame":
          return json(res, 409, { error: "not_open", message: "identity shut-abc123 is not open" });
        default:
          return json(res, 404, { error: "not_found", message: req.url });
      }
    });
    const client = new GuestClient(port, TOKEN);

    expect(await client.getBrowserIdentityFrame("shop-abc123")).toEqual(jpeg);
    await client.closeBrowserIdentity("shop-abc123");
    await expect(client.getBrowserIdentityFrame("shut-abc123")).rejects.toMatchObject({ status: 409, code: "not_open" });

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /v1/agent/browser-identities/shop-abc123/frame",
      "POST /v1/agent/browser-identities/shop-abc123/close",
      "GET /v1/agent/browser-identities/shut-abc123/frame",
    ]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("calls the tool and skill routes with the bearer token", async () => {
    const { port, seen } = await serve((req, res) => {
      switch (`${req.method} ${req.url}`) {
        case "GET /v1/agent/tools":
          return json(res, 200, { tools: [{ name: "exec", permission: "computer.exec", offered: true, description: "Run." }] });
        case "GET /v1/agent/skills":
          return json(res, 200, { skills: [{ name: "shop-login", description: "Log in.", source: "dot", path: "/home/dot/skills/shop-login/SKILL.md", content: "x" }] });
        default:
          return json(res, 404, { error: "not_found", message: req.url });
      }
    });
    const client = new GuestClient(port, TOKEN);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["exec"]);
    expect((await client.listSkills()).skills.map((skill) => skill.name)).toEqual(["shop-login"]);
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("passes the guest's outside_home refusal of a file path on", async () => {
    const { port } = await serve((_req, res) => json(res, 403, { error: "outside_home", message: "the path leads outside /home/dot" }));
    const client = new GuestClient(port, TOKEN);
    expect(await client.readFile("environ").catch((e: unknown) => e)).toMatchObject({ name: "GuestRequestError", status: 403, code: "outside_home" });
    expect(await client.listFiles("etc").catch((e: unknown) => e)).toMatchObject({ status: 403, code: "outside_home" });
    expect(await client.writeFile("etc/x", "y").catch((e: unknown) => e)).toMatchObject({ status: 403, code: "outside_home" });
  });

  it("turns error bodies into GuestRequestError", async () => {
    const { port } = await serve((_req, res) => json(res, 409, { error: "computer_busy", message: "try later" }));
    const error = await new GuestClient(port, TOKEN).state().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestRequestError);
    expect(error).toMatchObject({ status: 409, code: "computer_busy" });
    expect((error as Error).message).toContain("computer_busy: try later");

    // A client holding another token cannot check the guest's proof: it never sends that token.
    const unproven = await new GuestClient(port, "wrong").health().catch((e: unknown) => e);
    expect(unproven).toMatchObject({ code: GUEST_UNPROVEN });
  });

  it("computes the proof dot-agentd computes (the known answer its Go test checks too)", () => {
    expect(guestProof("dot-token-123", "00112233445566778899aabbccddeeff")).toBe("b1cb86aa470fe878a6366f62ea4493011c01d22736a9c89d3e7f88582920d1b9");
  });

  it("asks a listener for its proof before the token goes anywhere, once per client", async () => {
    const { port, seen, proofs } = await serve((_req, res) => json(res, 200, health("ok")));
    const client = new GuestClient(port, TOKEN);
    await client.health();
    await client.health();
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.auth).toBeUndefined();
    expect(proofs[0]!.url).toMatch(/^\/v1\/proof\?nonce=[0-9a-f]{32}$/);
    expect(seen).toHaveLength(2);
  });

  it("never sends the token to a listener that cannot prove it holds it", async () => {
    // What takes over a stale guest port after a host restart or a QEMU that died.
    const { port, seen, proofs } = await serve((_req, res) => json(res, 200, health("ok")), { impostor: true });
    const client = new GuestClient(port, TOKEN);
    await expect(client.pushSecrets({ openrouter_api_key: "sk-or-must-not-leak", mcp_secrets: {} })).rejects.toMatchObject({ code: GUEST_UNPROVEN });
    await expect(waitForGuestHealth(client, { intervalMs: 5, timeoutMs: 5000 })).rejects.toMatchObject({ code: GUEST_UNPROVEN });
    expect(proofs.length).toBeGreaterThan(0);
    expect(proofs.every((p) => p.auth === undefined)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("streams events, reconnecting with ?after= and never repeating one", async () => {
    let connection = 0;
    const { port, seen } = await serve((req, res) => {
      connection++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connection === 1) {
        // Two events, then the connection drops mid-message.
        res.write(`: hello\n\nid: 1\ndata: ${JSON.stringify(event(1))}\n\n`);
        res.write(`id: 2\r\ndata: ${JSON.stringify(event(2))}\r\n\r\n`);
        res.end(`id: 3\ndata: {"seq":3`);
      } else {
        const after = Number(new URL(req.url!, "http://x").searchParams.get("after"));
        // A server replaying one too many must not produce a duplicate.
        for (let seq = after; seq <= after + 2; seq++) res.write(`id: ${seq}\ndata: ${JSON.stringify(event(seq))}\n\n`);
      }
    });
    const client = new GuestClient(port, TOKEN);
    const controller = new AbortController();
    const got: number[] = [];
    const reconnects: number[] = [];
    for await (const evt of client.events({ signal: controller.signal, reconnectDelayMs: 10, onReconnect: (info) => reconnects.push(info.after) })) {
      got.push(evt.seq);
      if (got.length === 4) controller.abort();
    }
    expect(got).toEqual([1, 2, 3, 4]);
    expect(reconnects).toEqual([2]);
    expect(seen.map((s) => s.url)).toEqual(["/v1/agent/events/stream?after=0", "/v1/agent/events/stream?after=2"]);
  });

  it("hands over a message that is not an event the host knows, in order with the events, and resumes after it", async () => {
    let connection = 0;
    const bad = { ...event(2), type: "approval.requested", data: { approval_id: "a1", tool: "exec", permission: "computer.teleport", arguments: {}, reason: "x" } };
    const { port, seen } = await serve((req, res) => {
      connection++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connection === 1) {
        res.write(`id: 1\ndata: ${JSON.stringify(event(1))}\n\n`);
        res.write(`id: 2\ndata: ${JSON.stringify(bad)}\n\n`);
        res.write(`id: x\ndata: this is not json\n\n`);
        res.end(`id: 3\ndata: ${JSON.stringify(event(3))}\n\n`);
      } else {
        const after = Number(new URL(req.url!, "http://x").searchParams.get("after"));
        for (let seq = after + 1; seq <= after + 2; seq++) res.write(`id: ${seq}\ndata: ${JSON.stringify(event(seq))}\n\n`);
      }
    });
    const controller = new AbortController();
    const order: string[] = [];
    const refused: RefusedEvent[] = [];
    const client = new GuestClient(port, TOKEN);
    for await (const evt of client.events({
      signal: controller.signal,
      reconnectDelayMs: 10,
      onRefused: async (info) => {
        // Awaited before the stream goes on: the event after it is not yielded until this settles.
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`refused ${info.seq}`);
        refused.push(info);
      },
    })) {
      order.push(`event ${evt.seq}`);
      if (evt.seq === 5) controller.abort();
    }
    expect(order).toEqual(["event 1", "refused 2", "refused null", "event 3", "event 4", "event 5"]);
    expect(refused).toEqual([
      { seq: 2, type: "approval.requested", problem: expect.stringContaining("data.permission") },
      { seq: null, type: null, problem: expect.stringContaining("JSON") },
    ]);
    expect(refused[0]!.problem.length).toBeLessThanOrEqual(REFUSED_PROBLEM_MAX);
    // The reconnect resumed after the last event, the refused one behind it, so it was not handed over again.
    expect(seen.map((s) => s.url)).toEqual(["/v1/agent/events/stream?after=0", "/v1/agent/events/stream?after=3"]);
  });

  it("goes on past a refused message when nobody asked to hear of it", async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 1\ndata: {"seq":1}\n\n`);
      res.write(`id: 2\ndata: ${JSON.stringify(event(2))}\n\n`);
    });
    const client = new GuestClient(port, TOKEN);
    for await (const evt of client.events()) {
      expect(evt.seq).toBe(2);
      break;
    }
  });

  it("resumes from the given cursor and stops when the consumer breaks", async () => {
    const { port, seen } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 8\ndata: ${JSON.stringify(event(8))}\n\n`);
    });
    for await (const evt of new GuestClient(port, TOKEN).events({ after: 7 })) {
      expect(evt.seq).toBe(8);
      break;
    }
    expect(seen[0]!.url).toBe("/v1/agent/events/stream?after=7");
  });

  it("does not retry the stream on a refused token", async () => {
    const { port } = await serve((_req, res) => json(res, 401, { error: "unauthorized", message: "bad token" }));
    const stream = new GuestClient(port, TOKEN).events({ reconnectDelayMs: 1 });
    await expect(stream.next()).rejects.toMatchObject({ status: 401 });
  });

  it("ends the stream when nothing listens on the guest port: the VM is gone, waiting there cannot help", async () => {
    const port = await closedPort();
    const reconnects: number[] = [];
    const stream = new GuestClient(port, TOKEN).events({ reconnectDelayMs: 1, onReconnect: (info) => reconnects.push(info.attempt) });
    await expect(stream.next()).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(reconnects).toEqual([]);
  });
});

function health(agent: "ok" | "starting" | "down"): HealthAnswer {
  return {
    agentd: "ok",
    uptime_s: 3,
    agent:
      agent === "down"
        ? { status: "down" }
        : {
            status: agent,
            state: "IDLE",
            openrouter_configured: false,
            browser: { identities: 0, open: 0 },
            checks: { filesystem_writable: true, network_reachable: true, browser_installed: true },
          },
  };
}

/** A port nothing listens on: bound by the kernel, then released. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("GuestClient transport", () => {
  it("talks to 127.0.0.1 on the given port and reads one identity", async () => {
    const { port, seen } = await serve((req, res) =>
      json(res, 200, { id: "a b", name: "a", createdAt: "x", lastUsedAt: null, status: "available", profilePath: "/p" }),
    );
    const client = new GuestClient(port, TOKEN);
    expect(client.address).toBe(`127.0.0.1:${port}`);
    expect((await client.getBrowserIdentity("a b")).name).toBe("a");
    expect(seen[0]!.url).toBe("/v1/agent/browser-identities/a%20b");
  });

  describe("readFile with a size limit", () => {
    it("returns a file within the limit, whole", async () => {
      const { port } = await serve((req, res) => res.writeHead(200).end(Buffer.alloc(100, 7)));
      expect(await new GuestClient(port, TOKEN).readFile("a", { maxBytes: 100 })).toEqual(Buffer.alloc(100, 7));
    });

    it("refuses a file whose announced length is over it, before reading it", async () => {
      const { port } = await serve((req, res) => {
        res.writeHead(200, { "content-length": 101 });
        res.write(Buffer.alloc(10));
        // The rest is never sent: a client that waited for it would run into the test's timeout.
      });
      const error = await new GuestClient(port, TOKEN).readFile("a", { maxBytes: 100 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GuestRequestError);
      expect(error).toMatchObject({ status: 413, code: FILE_TOO_LARGE });
      expect((error as Error).message).toContain("larger than 100 bytes");
    });

    it("stops reading a body of unannounced length once it passes the limit", async () => {
      const { port } = await serve((req, res) => {
        // Chunked: no content-length, so only the running count can tell.
        res.writeHead(200);
        res.write(Buffer.alloc(60));
        res.write(Buffer.alloc(60));
        res.write(Buffer.alloc(60));
      });
      const error = await new GuestClient(port, TOKEN).readFile("a", { maxBytes: 100 }).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 413, code: FILE_TOO_LARGE });
    });

    it("keeps the guest's own error for a failed read, whatever the limit", async () => {
      const { port } = await serve((req, res) => json(res, 404, { error: "not_found", message: "no such file: " + "x".repeat(300) }));
      const error = await new GuestClient(port, TOKEN).readFile("a", { maxBytes: 10 }).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
    });

    it("reads without a limit as before", async () => {
      const { port } = await serve((req, res) => res.writeHead(200).end(Buffer.alloc(5000, 1)));
      expect((await new GuestClient(port, TOKEN).readFile("a")).length).toBe(5000);
    });
  });

  it("names the guest port when nothing listens there", async () => {
    const port = await closedPort();
    const error = await new GuestClient(port, TOKEN).system().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestRequestError);
    expect((error as Error).message).toContain(`127.0.0.1:${port}`);
    expect((error as GuestRequestError).code).toBe("ECONNREFUSED");
  });

  it("times out a request that gets no answer", async () => {
    const { port } = await serve(() => {});
    // The handler above only answers 401s; this request carries the right token and hangs.
    const error = await new GuestClient(port, TOKEN, { timeoutMs: 100 }).system().catch((e: unknown) => e);
    expect((error as Error).message).toContain("within 100 ms");
  });

  it("refuses a port that is not a TCP port", () => {
    expect(() => new GuestClient(0, TOKEN)).toThrow(/TCP port/);
    expect(() => new GuestClient(70000, TOKEN)).toThrow(/TCP port/);
    expect(() => new GuestClient(1234, "")).toThrow(/token/);
  });
});

describe("waitForGuestHealth", () => {
  it("retries while the guest boots and returns once the agent is ok", async () => {
    const answers = [health("down"), health("starting"), health("ok")];
    const { port, seen } = await serve((_req, res) => json(res, 200, answers.shift() ?? health("ok")));
    const answer = await waitForGuestHealth(new GuestClient(port, TOKEN), { intervalMs: 5, timeoutMs: 5000 });
    expect(answer.agent.status).toBe("ok");
    expect(seen.length).toBe(3);
  });

  it("stops at dot-agentd when asked to", async () => {
    const { port } = await serve((_req, res) => json(res, 200, health("down")));
    const answer = await waitForGuestHealth(new GuestClient(port, TOKEN), { until: "agentd", intervalMs: 5 });
    expect(answer.agentd).toBe("ok");
  });

  it("keeps trying through refused connections, then reports the last error", async () => {
    const port = await closedPort();
    const error = await waitForGuestHealth(new GuestClient(port, TOKEN), { intervalMs: 5, timeoutMs: 60 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestHealthTimeoutError);
    expect((error as Error).message).toMatch(/not healthy within 60 ms.*ECONNREFUSED|not healthy within 60 ms.*connect/);
  });

  it("fails at once on a refused token", async () => {
    const { port } = await serve((_req, res) => json(res, 401, { error: "unauthorized", message: "bad token" }));
    await expect(waitForGuestHealth(new GuestClient(port, TOKEN), { intervalMs: 5 })).rejects.toMatchObject({ status: 401 });
  });

  it("stops when the check says the VM is gone", async () => {
    const port = await closedPort();
    let calls = 0;
    const check = () => {
      if (++calls === 3) throw new Error("QEMU exited");
    };
    await expect(waitForGuestHealth(new GuestClient(port, TOKEN), { intervalMs: 5, check })).rejects.toThrow("QEMU exited");
  });
});
