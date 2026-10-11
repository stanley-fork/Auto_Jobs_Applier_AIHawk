/**
 * dot-agentd's HTTP surface (architecture sections 5.1 to 5.3) in front of
 * the scheduler's FakeGuest, so the real GuestClient of vm-manager talks to
 * it over real TCP exactly as it talks to a guest through QEMU's port
 * forward. Only the routes the control plane calls are served, including
 * the unauthenticated proof route, computed the guest's way.
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { FakeGuest } from "@invisible-dots/scheduler/testing";
import { GUEST_PROOF_CONTEXT, type SecretsRequest } from "@invisible-dots/shared";

export interface FakeGuestServer {
  port: number;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const IDENTITIES = "/v1/agent/browser-identities";

/**
 * Serve `guest()` (looked up per request: a test may swap the guest) on
 * `port` of 127.0.0.1 (0 picks one). Every request is appended to
 * `requests` as "METHOD /path". `onPowerOff` is what the guest's poweroff
 * ends in: the test's QEMU exits.
 */
export async function serveFakeGuest(
  guest: () => FakeGuest | undefined,
  options: { port?: number; requests?: string[]; onPowerOff?: () => void } = {},
): Promise<FakeGuestServer> {
  const requests = options.requests ?? [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://guest");
    requests.push(`${request.method} ${url.pathname}`);
    const current = guest();
    // A powered-off VM: QEMU's forward accepts and drops, which the client sees as a reset.
    if (!current?.running) {
      request.socket.destroy();
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/proof") {
      const nonce = url.searchParams.get("nonce") ?? "";
      return send(response, 200, { proof: createHmac("sha256", current.token).update(`${GUEST_PROOF_CONTEXT}${nonce}`).digest("hex") });
    }
    if (request.headers.authorization !== `Bearer ${current.token}`) {
      send(response, 401, { error: "unauthorized", message: "bad token" });
      return;
    }
    try {
      const route = `${request.method} ${url.pathname}`;
      if (url.pathname.startsWith(`${IDENTITIES}/`)) {
        const [rawId, action] = url.pathname.slice(IDENTITIES.length + 1).split("/");
        const id = decodeURIComponent(rawId!);
        if (action === "frame" && request.method === "GET") {
          response.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from(await current.getBrowserIdentityFrame(id)));
          return;
        }
        if (action === "close" && request.method === "POST") {
          await current.closeBrowserIdentity(id);
          return send(response, 204);
        }
        if (action === undefined && request.method === "GET") return send(response, 200, await current.getBrowserIdentity(id));
        if (action === undefined && request.method === "DELETE") {
          await current.deleteBrowserIdentity(id);
          return send(response, 204);
        }
      }
      switch (route) {
        case "GET /v1/health":
          return send(response, 200, await current.health());
        case "GET /v1/system":
          return send(response, 200, await current.system());
        case "POST /v1/system/poweroff":
          send(response, 202, { status: "powering_off" });
          options.onPowerOff?.();
          return;
        case "GET /v1/screenshot":
          response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(await current.screenshot()));
          return;
        case "POST /v1/agent/secrets":
          await current.pushSecrets((await readJson(request)) as SecretsRequest);
          return send(response, 204);
        case "PUT /v1/agent/config":
          await current.putConfig((await readJson(request)) as never);
          return send(response, 204);
        case "POST /v1/agent/events":
          return send(response, 202, await current.postEvent((await readJson(request)) as never));
        case "GET /v1/agent/state":
          return send(response, 200, await current.state());
        case "POST /v1/agent/prepare-sleep":
          await current.prepareSleep();
          return send(response, 204);
        case `GET ${IDENTITIES}`:
          return send(response, 200, await current.listBrowserIdentities());
        case `POST ${IDENTITIES}`:
          return send(response, 201, await current.createBrowserIdentity((await readJson(request)) as never));
        case "GET /v1/agent/events/stream": {
          const controller = new AbortController();
          request.on("close", () => controller.abort());
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": open\n\n");
          try {
            for await (const event of current.events({ after: Number(url.searchParams.get("after") ?? 0), signal: controller.signal })) {
              response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            }
          } catch {
            // A disconnect inside the fake ends the stream; the client reconnects.
          }
          response.end();
          return;
        }
        default:
          return send(response, 404, { error: "not_found", message: route });
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!status) {
        request.socket.destroy();
        return;
      }
      send(response, status, { error: (error as { code?: string }).code ?? "error", message: (error as Error).message });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
