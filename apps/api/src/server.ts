/**
 * The control-plane HTTP API of architecture section 9.6. Every route needs
 * the bearer token; every error is `{ error, message }`. The handlers are
 * thin: the work happens in the Scheduler.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { TELEGRAM_TOKEN_SECRET, type ChannelHub } from "@invisible-dots/channels";
import { StreamOverflowError } from "@invisible-dots/events";
import { ControlPlaneError, errorMessage, silentLogger, type Logger, type Scheduler } from "@invisible-dots/scheduler";
import { STREAM_ERROR_EVENT } from "@invisible-dots/sdk";
import type {
  ApprovalsAnswer,
  ChannelPairingAnswer,
  ChannelRecord,
  ChannelsAnswer,
  DoctorAnswer,
  DotsAnswer,
  EventsAnswer,
  FilesListAnswer,
  HealthResponse,
  HostFacts,
  IdentitiesAnswer,
  MessagesAnswer,
  TasksAnswer,
  UsageAnswer,
} from "@invisible-dots/sdk/types";
import {
  APPROVAL_LIST_LIMIT,
  CONVERSATION_LIST_LIMIT,
  APPROVAL_STATUSES,
  CHANNEL_KINDS,
  LIST_ORDERS,
  MAX_EVENT_PAGE,
  TASK_LIST_LIMIT,
  type ApprovalStatus,
  type ChannelKind,
  type DoctorCheck,
  type ListOrder,
  type SkillListAnswer,
  type McpSecretsAnswer,
  type ToolListAnswer,
} from "@invisible-dots/shared";
import { doctorAnswer } from "@invisible-dots/vm-manager";
import { serveFile } from "./file-types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

export const API_VERSION = "0.1.0";

/** A comment line on idle SSE connections, so proxies and clients see the connection is alive. */
export const SSE_HEARTBEAT_MS = 15_000;

export interface ServerOptions {
  scheduler: Scheduler;
  channels: ChannelHub;
  /** Runs the host checks of architecture section 11.1 on the machine this server runs on; `startServer` binds the real ones. */
  doctor(): Promise<DoctorCheck[]>;
  /** What `GET /api/health` says about where the state lives; `startServer` reads it from the paths and the database it opened. */
  host: HostFacts;
  token: string;
  logger?: Logger;
  heartbeatMs?: number;
}

type Params = { id: string; identityId: string; kind: string; peer: string };
type Body = Record<string, unknown> | undefined;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bad(message: string): ControlPlaneError {
  return new ControlPlaneError(400, "invalid_request", message);
}

/** A non-negative integer query parameter, or undefined when absent. */
function intParam(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) > max) {
    throw bad(`${name} must be a non-negative integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ""}`);
  }
  return Number(value);
}

/** The `order` of a list route, which only an `order=desc` list can be paged on (`before`) from. */
function orderParam(order: unknown, before: unknown): ListOrder | undefined {
  if (order !== undefined && !(LIST_ORDERS as readonly unknown[]).includes(order)) throw bad(`order must be one of ${LIST_ORDERS.join(", ")}`);
  if (before !== undefined && order !== "desc") throw bad("before pages a list in order=desc");
  return order as ListOrder | undefined;
}

/** An ISO 8601 date-time query parameter, or undefined when absent. */
function sinceParam(value: unknown): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : undefined;
  if (parsed === undefined || Number.isNaN(parsed.getTime())) {
    throw bad("since must be an ISO 8601 timestamp such as 2026-10-05T00:00:00Z");
  }
  return parsed;
}

function channelKind(value: string): ChannelKind {
  if (!(CHANNEL_KINDS as readonly string[]).includes(value)) throw bad(`no "${value}" channel: the channels are ${CHANNEL_KINDS.join(", ")}`);
  return value as ChannelKind;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body as Body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw bad("the body must be a JSON object");
  return body;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { scheduler, channels } = options;
  const log = options.logger ?? silentLogger;
  const expected = digest(options.token);
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const streams = new Set<AbortController>();

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, return503OnClosing: true });

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    // Comparing digests keeps the comparison constant-time whatever the length of the guess.
    if (!match || !timingSafeEqual(digest(match[1]!.trim()), expected)) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="invisible-dots"')
        .send({ error: "unauthorized", message: "a valid Authorization: Bearer <api token> header is required" });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: "not_found", message: `no route ${request.method} ${request.url.split("?")[0]}` });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ControlPlaneError) {
      const body: Record<string, unknown> = { error: error.code, message: error.message };
      if (error.details !== undefined) body.details = error.details;
      // A busy browser is the answer a polling page expects, not a failure.
      if (error.status >= 500 && error.code !== "busy") log.error("request failed", { method: request.method, url: request.url, error: error.message });
      return reply.code(error.status).send(body);
    }
    const e = error as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      const code = e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "unsupported_media_type" : "invalid_request";
      return reply.code(e.statusCode).send({ error: code, message: e.message ?? "invalid request" });
    }
    log.error("unhandled error", { method: request.method, url: request.url, error: errorMessage(error) });
    return reply.code(500).send({ error: "internal", message: errorMessage(error) });
  });

  /**
   * Answer with a server-sent event stream, the one way every stream of this API starts: headers, a heartbeat comment
   * so proxies and clients see the connection is alive, and an abort when the client goes or the server closes. `body`
   * writes the frames and returns when there are no more.
   */
  const eventStream = async (reply: FastifyReply, controller: AbortController, body: (raw: FastifyReply["raw"]) => Promise<void>): Promise<void> => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write(": connected\n\n");
    streams.add(controller);
    const heartbeat = setInterval(() => raw.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref();
    raw.on("close", () => controller.abort());
    try {
      await body(raw);
    } finally {
      clearInterval(heartbeat);
      streams.delete(controller);
      raw.end();
    }
  };

  // Before the server stops listening and waits for its connections: a stream only ends when it is told to, so a hook that
  // ran after that wait (`onClose`) would wait for the person to close the tab.
  app.addHook("preClose", async () => {
    for (const controller of streams) controller.abort();
  });

  app.get("/api/health", async (): Promise<HealthResponse> => {
    const { database, openrouter_configured } = await scheduler.health();
    return { status: "ok", database, version: API_VERSION, openrouter_configured, ...options.host };
  });

  // The host report `invisible-dots doctor` prints: what is missing for a Dot to run, and the command that fixes it. It runs QEMU's accelerator probe, so it takes a moment:
  // one run at a time, and a request that arrives while it runs shares its answer (the onboarding checklist re-checks and polls).
  let doctorRun: Promise<DoctorAnswer> | undefined;
  app.get("/api/doctor", (): Promise<DoctorAnswer> => {
    doctorRun ??= options.doctor().then(doctorAnswer).finally(() => {
      doctorRun = undefined;
    });
    return doctorRun;
  });

  // Dots

  app.post("/api/dots", async (request, reply) => {
    const dot = await scheduler.createDot(bodyOf(request).config);
    return reply.code(201).send(dot);
  });

  app.get("/api/dots", async (): Promise<DotsAnswer> => ({ dots: await scheduler.listDots() }));

  app.get<{ Params: Params }>("/api/dots/:id", async (request) => scheduler.requireDot(request.params.id));

  app.patch<{ Params: Params }>("/api/dots/:id", async (request) => {
    const { config, expected_config_version } = bodyOf(request);
    return scheduler.updateDot(request.params.id, config, expected_config_version);
  });

  app.delete<{ Params: Params }>("/api/dots/:id", async (request, reply) => {
    return reply.code(202).send(await scheduler.deleteDot(request.params.id));
  });

  // Messages and tasks

  app.post<{ Params: Params }>("/api/dots/:id/messages", async (request, reply) => {
    const text = bodyOf(request).text;
    if (typeof text !== "string") throw bad("text must be a string");
    return reply.code(202).send(await scheduler.sendMessage(request.params.id, text));
  });

  // The conversation pages like the event log: oldest first by default, `order=desc` the newest, `before` (the
  // event id of the oldest message of the previous page) the ones older than that.
  app.get<{ Params: Params; Querystring: { limit?: string; order?: unknown; before?: string } }>(
    "/api/dots/:id/messages",
    async (request): Promise<MessagesAnswer> => {
      const limit = intParam(request.query.limit, "limit", CONVERSATION_LIST_LIMIT);
      if (limit === 0) throw bad(`limit must be between 1 and ${CONVERSATION_LIST_LIMIT}`);
      const before = intParam(request.query.before, "before");
      const order = orderParam(request.query.order, before);
      return { messages: await scheduler.conversation(request.params.id, { limit, order, before }) };
    },
  );

  app.post<{ Params: Params }>("/api/dots/:id/tasks", async (request, reply) => {
    const body = bodyOf(request);
    const task = await scheduler.createTask(request.params.id, {
      description: body.description as string,
      priority: body.priority as number | undefined,
      scheduled_at: body.scheduled_at as string | undefined,
    });
    return reply.code(201).send(task);
  });

  // The newest tasks first; `before` (the id of the last task of the previous page) goes on, older.
  app.get<{ Params: Params; Querystring: { limit?: unknown; before?: unknown } }>("/api/dots/:id/tasks", async (request): Promise<TasksAnswer> => {
    const limit = intParam(request.query.limit, "limit", TASK_LIST_LIMIT);
    if (limit === 0) throw bad(`limit must be between 1 and ${TASK_LIST_LIMIT}`);
    const { before } = request.query;
    if (before !== undefined && (typeof before !== "string" || before === "")) throw bad("before must be the id of a task");
    return { tasks: await scheduler.listTasks(request.params.id, { limit, before }) };
  });

  app.get<{ Params: Params }>("/api/tasks/:id", async (request) => scheduler.getTask(request.params.id));

  app.post<{ Params: Params }>("/api/tasks/:id/cancel", async (request) => scheduler.cancelTask(request.params.id));

  // Computer

  app.get<{ Params: Params }>("/api/dots/:id/computer", async (request) => scheduler.computer(request.params.id));

  const lifecycleRoute = (action: "start" | "stop" | "reboot") =>
    app.post<{ Params: Params }>(`/api/dots/:id/computer/${action}`, async (request, reply) => {
      const id = request.params.id;
      const answer =
        action === "start"
          ? await scheduler.startComputer(id)
          : action === "stop"
            ? await scheduler.stopComputer(id)
            : await scheduler.rebootComputer(id);
      return reply.code(202).send(answer);
    });
  lifecycleRoute("start");
  lifecycleRoute("stop");
  lifecycleRoute("reboot");

  app.get<{ Params: Params }>("/api/dots/:id/computer/screenshot", async (request, reply) => {
    const png = await scheduler.screenshot(request.params.id);
    return reply.code(200).header("content-type", "image/png").header("cache-control", "no-store").send(Buffer.from(png));
  });

  // Browser identities

  app.get<{ Params: Params }>(
    "/api/dots/:id/browser-identities",
    async (request): Promise<IdentitiesAnswer> => ({ identities: await scheduler.listIdentities(request.params.id) }),
  );

  app.post<{ Params: Params }>("/api/dots/:id/browser-identities", async (request, reply) => {
    const body = bodyOf(request);
    const identity = await scheduler.createIdentity(request.params.id, {
      name: body.name as string,
      proxy: body.proxy as string | undefined,
    });
    return reply.code(201).send(identity);
  });

  app.get<{ Params: Params }>("/api/dots/:id/browser-identities/:identityId", async (request) =>
    scheduler.getIdentity(request.params.id, request.params.identityId),
  );

  app.delete<{ Params: Params }>("/api/dots/:id/browser-identities/:identityId", async (request, reply) => {
    await scheduler.deleteIdentity(request.params.id, request.params.identityId);
    return reply.code(204).send();
  });

  app.get<{ Params: Params }>("/api/dots/:id/browser-identities/:identityId/frame", async (request, reply) => {
    const jpeg = await scheduler.identityFrame(request.params.id, request.params.identityId);
    return reply.code(200).header("content-type", "image/jpeg").header("cache-control", "no-store").send(Buffer.from(jpeg));
  });

  app.post<{ Params: Params }>("/api/dots/:id/browser-identities/:identityId/close", async (request, reply) => {
    await scheduler.closeIdentity(request.params.id, request.params.identityId);
    return reply.code(204).send();
  });

  // The tools (its table) and the skills are the engine's, so they need the computer running

  app.get<{ Params: Params }>(
    "/api/dots/:id/tools",
    async (request): Promise<ToolListAnswer> => scheduler.listTools(request.params.id),
  );

  app.get<{ Params: Params }>(
    "/api/dots/:id/skills",
    async (request): Promise<SkillListAnswer> => ({ skills: await scheduler.listSkills(request.params.id) }),
  );

  // Channels (the hub never returns a credential, and no route here echoes one)

  app.get<{ Params: Params }>(
    "/api/dots/:id/channels",
    async (request): Promise<ChannelsAnswer> => ({ channels: await channels.list(request.params.id), available: channels.kinds }),
  );

  // Link the Dot to a Telegram bot, or give the linked one a new token (a revoked token is the only way back from needs_relink).
  app.put<{ Params: Params }>("/api/dots/:id/channels/telegram", async (request, reply): Promise<ChannelRecord> => {
    const token = bodyOf(request).token;
    if (typeof token !== "string" || token.trim() === "") throw bad("token must be the bot token from @BotFather");
    const credentials = { [TELEGRAM_TOKEN_SECRET]: token.trim() };
    const linked = (await channels.list(request.params.id)).some((channel) => channel.kind === "telegram");
    if (linked) return channels.setCredentials(request.params.id, "telegram", credentials);
    return reply.code(201).send(await channels.add(request.params.id, "telegram", { credentials }));
  });

  // Link WhatsApp: the channel starts and shows a code; the person scans it (the stream below) with the phone that holds the number.
  app.post<{ Params: Params }>("/api/dots/:id/channels/whatsapp/link", async (request, reply): Promise<ChannelRecord> => {
    return reply.code(202).send(await channels.link(request.params.id, "whatsapp"));
  });

  // The codes to scan and how the link ends, as server-sent events of `ChannelLinkFrame`. The code is a way into the account for as long as it is shown: it is not stored and the reply is never cached.
  app.get<{ Params: Params }>("/api/dots/:id/channels/whatsapp/qr", async (request, reply) => {
    const controller = new AbortController();
    const frames = await channels.watchLink(request.params.id, "whatsapp", controller.signal);
    await eventStream(reply, controller, async (raw) => {
      for await (const frame of frames) raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    });
  });

  app.patch<{ Params: Params }>("/api/dots/:id/channels/:kind", async (request): Promise<ChannelRecord> => {
    const kind = channelKind(request.params.kind);
    const { settings, enabled } = bodyOf(request);
    if (settings === undefined && enabled === undefined) throw bad("give settings, enabled, or both");
    if (enabled !== undefined && typeof enabled !== "boolean") throw bad("enabled must be true or false");
    let record: ChannelRecord | undefined;
    if (settings !== undefined) record = await channels.setSettings(request.params.id, kind, settings);
    if (enabled !== undefined) record = await channels.setEnabled(request.params.id, kind, enabled);
    return record!;
  });

  app.delete<{ Params: Params }>("/api/dots/:id/channels/:kind", async (request, reply) => {
    await channels.remove(request.params.id, channelKind(request.params.kind));
    return reply.code(204).send();
  });

  app.post<{ Params: Params }>("/api/dots/:id/channels/:kind/pairing", async (request, reply): Promise<ChannelPairingAnswer> => {
    return reply.code(201).send(await channels.pair(request.params.id, channelKind(request.params.kind)));
  });

  app.delete<{ Params: Params }>("/api/dots/:id/channels/:kind/peers/:peer", async (request, reply) => {
    await channels.removePeer(request.params.id, channelKind(request.params.kind), request.params.peer);
    return reply.code(204).send();
  });

  // Approvals

  app.get<{ Querystring: { status?: unknown; limit?: unknown; order?: unknown; before?: unknown; dot_id?: unknown } }>("/api/approvals", async (request): Promise<ApprovalsAnswer> => {
    const { status, order, before, dot_id: dotId } = request.query;
    if (dotId !== undefined && (typeof dotId !== "string" || dotId === "")) throw bad("dot_id must be the id or the name of one Dot");
    if (status !== undefined && typeof status !== "string") throw bad("status must be one list, comma-separated");
    const statuses = status?.split(",").map((one) => one.trim());
    if (statuses?.some((one) => !(APPROVAL_STATUSES as readonly string[]).includes(one))) {
      throw bad(`status must be one or more of ${APPROVAL_STATUSES.join(", ")}`);
    }
    const limit = intParam(request.query.limit, "limit", APPROVAL_LIST_LIMIT);
    if (limit === 0) throw bad(`limit must be between 1 and ${APPROVAL_LIST_LIMIT}`);
    if (before !== undefined && (typeof before !== "string" || before === "")) throw bad("before must be the id of an approval");
    return {
      approvals: await scheduler.listApprovals(statuses as ApprovalStatus[] | undefined, { limit, order: orderParam(order, before), before, dot: dotId }),
    };
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: Params }>(`/api/approvals/:id/${decision}`, async (request) => {
      const { note, always } = bodyOf(request);
      if (note !== undefined && typeof note !== "string") throw bad("note must be a string");
      if (always !== undefined && always !== true) throw bad("always must be true");
      return scheduler.resolveApproval(request.params.id, decision, {
        ...(note !== undefined ? { note } : {}),
        ...(always !== undefined ? { always } : {}),
      });
    });
  }

  // Events and usage

  app.get<{ Params: Params; Querystring: { since?: string } }>(
    "/api/dots/:id/usage",
    async (request): Promise<UsageAnswer> => scheduler.usage(request.params.id, sinceParam(request.query.since)),
  );

  app.get<{ Params: Params; Querystring: { after?: string; before?: string; limit?: string; types?: unknown; tools?: unknown; task_id?: unknown; order?: unknown } }>(
    "/api/dots/:id/events",
    async (request): Promise<EventsAnswer> => {
      const after = intParam(request.query.after, "after");
      const before = intParam(request.query.before, "before");
      const limit = intParam(request.query.limit, "limit", MAX_EVENT_PAGE);
      const { types, tools, task_id: taskId, order } = request.query;
      if (types !== undefined && typeof types !== "string") throw bad("types must be one comma-separated list");
      if (tools !== undefined && typeof tools !== "string") throw bad("tools must be one comma-separated list");
      if (taskId !== undefined && typeof taskId !== "string") throw bad("task_id must be a single value");
      const listOrder = orderParam(order, request.query.before);
      const list = (value: string | undefined) => value?.split(",").map((one) => one.trim()).filter(Boolean);
      return {
        events: await scheduler.listEvents(request.params.id, {
          after,
          before,
          limit,
          types: list(types),
          tools: list(tools),
          taskId,
          order: listOrder,
        }),
      };
    },
  );

  // Files of the Dot's computer, under /home/dot, read-only; they need the computer running (409 computer_stopped).

  app.get<{ Params: Params; Querystring: { path?: unknown } }>(
    "/api/dots/:id/files/list",
    async (request): Promise<FilesListAnswer> => scheduler.listFiles(request.params.id, request.query.path as string | undefined),
  );

  app.get<{ Params: Params; Querystring: { path?: unknown } }>("/api/dots/:id/files", async (request, reply) => {
    const { path, content } = await scheduler.readFile(request.params.id, request.query.path);
    const { contentType, disposition } = serveFile(path);
    return reply
      .code(200)
      .header("content-type", contentType)
      .header("content-disposition", disposition)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "no-store")
      .send(Buffer.from(content));
  });

  app.get<{ Querystring: { dot_id?: string; after?: string } }>("/api/stream", async (request, reply) => {
    let dotId: string | undefined;
    if (request.query.dot_id) {
      const dot = await scheduler.db.dots.resolve(request.query.dot_id);
      if (!dot && !request.query.dot_id.includes("_")) throw new ControlPlaneError(404, "not_found", `Dot "${request.query.dot_id}" not found`);
      dotId = dot?.id ?? request.query.dot_id;
    }
    // EventSource sends the last id it saw when it reconnects; it wins over the query.
    const lastEventId = request.headers["last-event-id"];
    const after = intParam(typeof lastEventId === "string" ? lastEventId : request.query.after, "after");

    const controller = new AbortController();
    await eventStream(reply, controller, async (raw) => {
      try {
        for await (const event of scheduler.events.stream(dotId === undefined ? {} : { dotId }, { after, signal: controller.signal })) {
          raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        // The client reconnects with its last id; tell it why the server hung up.
        const code = error instanceof StreamOverflowError ? "stream_overflow" : "stream_error";
        raw.write(`event: ${STREAM_ERROR_EVENT}\ndata: ${JSON.stringify({ error: code, message: errorMessage(error) })}\n\n`);
        log.warn("event stream closed with an error", { error: errorMessage(error) });
      }
    });
  });

  // Secrets

  app.put("/api/secrets/openrouter", async (request) => {
    const body = bodyOf(request);
    return scheduler.setOpenRouterKey(body.value, body.dot_id);
  });

  // A Dot's VM proxy: write-only, the answers say only whether there is one.
  app.get<{ Params: { id: string } }>("/api/dots/:id/proxy", async (request) => scheduler.vmProxy(request.params.id));
  app.put<{ Params: { id: string } }>("/api/dots/:id/proxy", async (request) => scheduler.setVmProxy(request.params.id, bodyOf(request).value));
  app.delete<{ Params: { id: string } }>("/api/dots/:id/proxy", async (request) => scheduler.setVmProxy(request.params.id, null));

  // The secrets of a Dot's MCP servers: write-only, the answers say only which are set.
  type McpSecretParams = { id: string; server: string; name: string };
  app.get<{ Params: Params }>("/api/dots/:id/mcp-secrets", async (request): Promise<McpSecretsAnswer> => scheduler.mcpSecrets(request.params.id));
  app.put<{ Params: McpSecretParams }>(
    "/api/dots/:id/mcp-secrets/:server/:name",
    async (request): Promise<McpSecretsAnswer> => // A PUT sets: a null value is no value (a clear is the DELETE).
      scheduler.setMcpSecret(request.params.id, request.params.server, request.params.name, bodyOf(request).value ?? undefined),
  );
  app.delete<{ Params: McpSecretParams }>(
    "/api/dots/:id/mcp-secrets/:server/:name",
    async (request): Promise<McpSecretsAnswer> => scheduler.setMcpSecret(request.params.id, request.params.server, request.params.name, null),
  );

  return app;
}

export type { FastifyInstance, FastifyReply };
