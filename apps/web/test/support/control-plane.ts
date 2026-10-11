/**
 * A stand-in for the control plane as the browser sees it: the routes the shell reads and the computer actions it
 * sends, answered from memory, and `/api/stream` as a live SSE body the test pushes events into. `install()` puts
 * it behind the global `fetch`, which is where the web client's SDK looks.
 */
import { COMPUTER_STOPPED, CONVERSATION_LIST_LIMIT, TASK_LIST_LIMIT, computerIsUp, MAX_EVENT_PAGE, type ApprovalRecord, type BrowserIdentity, type ChannelKind, type ChannelLinkFrame, type ChannelRecord, type ChannelSettings, type ComputerAnswer, type DoctorCheck, type DotConfig, type DotSummary, type McpServerStatus, type Skill, type StoredEvent, type SystemAnswer, type ToolInfo, mcpServerNames } from "@invisible-dots/shared/browser";
import type { TaskRecord } from "@invisible-dots/sdk";
import { vi } from "vitest";

export function dotRecord(id: string, change: Partial<DotSummary> = {}): DotSummary {
  return {
    id,
    name: id,
    // The API parses every config with the schema's defaults, so these two always exist on a real record.
    config: { permissions: {} } as unknown as DotConfig,
    status: "READY",
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    computer_state: "RUNNING",
    config_version: 1,
    ...change,
  };
}

export function approvalRecord(id: string, dotId: string, change: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id,
    dot_id: dotId,
    task_id: null,
    tool: "exec",
    permission: "computer.exec",
    arguments: {},
    reason: "needs a command",
    status: "pending",
    note: null,
    created_at: "2026-01-01T00:00:00Z",
    resolved_at: null,
    ...change,
  };
}

export function channelRecord(kind: ChannelKind, change: Partial<ChannelRecord> = {}): ChannelRecord {
  const settings: ChannelSettings = { approvals: true, notify_tasks: true, show_arguments: false };
  return {
    kind,
    enabled: true,
    status: "connected",
    status_detail: null,
    account: kind === "telegram" ? "fake_bot" : "15550001111",
    settings,
    peers: [],
    created_at: "2026-01-01T00:00:00Z",
    ...change,
  };
}

export function taskRecord(id: string, change: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    dot_id: "d1",
    description: `task ${id}`,
    priority: 0,
    status: "PENDING",
    created_at: "2026-01-01T00:00:00Z",
    scheduled_at: null,
    started_at: null,
    finished_at: null,
    summary: null,
    error: null,
    spent_usd: 0,
    ...change,
  };
}

export class FakeControlPlane {
  dots: DotSummary[] = [];
  approvals: ApprovalRecord[] = [];
  tasks: TaskRecord[] = [];
  /** The stored event log, as `GET /api/dots/:id/events` pages through it; `push` and `store` add to it. */
  events: StoredEvent[] = [];
  /** What each `GET .../events` asked for, so a test can see that a page cut by type was asked for by type. */
  eventQueries: Array<{ after: number; before?: number; limit: number; types: string[] | null; tools: string[] | null; taskId: string | null; order: string | null }> = [];
  /** What the shell asked for to know the agent's state when a page opened: the newest `agent.state` or `agent.started`. */
  agentQueries: Array<{ after: number; before?: number; limit: number; types: string[] | null; tools: string[] | null; taskId: string | null; order: string | null }> = [];
  /** What each `GET .../tasks` asked for. */
  taskQueries: Array<{ limit: number | null; before: string | null }> = [];
  /** While set, `GET /api/stream` answers 503, as a control plane that does not answer does. */
  streamDown = false;
  /** What each `GET /api/approvals` asked for. */
  approvalQueries: Array<{ status: string[] | null; limit: number | null; order: string | null; before: string | null; dot_id: string | null }> = [];
  /** The body of every `POST /api/dots/:id/tasks`, as the browser sent it. */
  createdTasks: unknown[] = [];
  /** Answer `POST /api/dots/:id/tasks` with this error instead of 201. */
  failCreateTask: { status: number; error: string; message: string } | null = null;
  /** Answer `POST /api/tasks/:id/cancel` with this error instead of cancelling. */
  failCancel: { status: number; error: string; message: string } | null = null;
  /** Every `POST /api/approvals/:id/approve|reject` the browser sent, in order, with the body it carried. */
  answers: Array<{ id: string; decision: "approve" | "reject"; body: { note?: string; always?: true } }> = [];
  /** Answer approval answers with this error instead of recording them. */
  failAnswer: { status: number; error: string; message: string } | null = null;
  /** The skills `GET /api/dots/:id/skills` answers with; null answers 409 computer_stopped, as a stopped computer does. */
  skills: Skill[] | null = [
    {
      name: "invisible-playwright",
      description: "Use the Dot's browser for any task on a website.",
      source: "builtin",
      path: "/opt/invisible-dots/engine/skills/invisible-playwright/SKILL.md",
      content: "---\nname: invisible-playwright\ndescription: Use the Dot's browser for any task on a website.\n---\n\n# The browser\n\nOpen an **identity** first.\n",
    },
  ];
  /** The tool table `GET /api/dots/:id/tools` answers with; null answers 409 computer_stopped, as a stopped computer does. */
  tools: ToolInfo[] | null = [
    { name: "exec", permission: "computer.exec", offered: true, description: "Run a shell command." },
    { name: "exec_session", permission: "computer.exec", offered: true, description: "Use a command session." },
    { name: "read_file", permission: "files.read", offered: true, description: "Read a file." },
  ];
  /** The MCP servers' states `GET /api/dots/:id/tools` answers with, beside the tools. */
  mcpServers: McpServerStatus[] = [];
  /** The MCP secrets that are set, as `<server>/<name>`; never their values, as the host answers. */
  readonly mcpSecretsSet = new Set<string>();
  /** Every `PUT` (a value) and `DELETE` (null) of an MCP secret, as the browser sent it. */
  readonly mcpSecretWrites: Array<{ server: string; name: string; value: string | null }> = [];
  /** The channels `GET /api/dots/:id/channels` lists, by Dot id. */
  channels: Record<string, ChannelRecord[]> = {};
  /** The kinds of channel the server can run, as `GET .../channels` says. */
  channelsAvailable: ChannelKind[] = ["telegram"];
  /** Every change of a channel as "METHOD kind sub body", in order (a token is never written here). */
  channelActions: string[] = [];
  /** Answer the channel routes that change something with this error instead of doing it. */
  failChannel: { status: number; error: string; message: string } | null = null;
  /** Answer `GET .../channels` with this error instead of the list. */
  failChannels: { status: number; error: string; message: string } | null = null;
  /** The code `POST .../pairing` makes next, and how long it lasts. */
  pairing = { code: "K7M2QX9P", expiresInMs: 600_000 };
  /** The token of every `PUT .../channels/telegram`, as the browser sent it. */
  sentTokens: string[] = [];
  /** The body of every `PATCH /api/dots/:id`, as the browser sent it. */
  updates: Array<{ config: unknown; expected_config_version?: number }> = [];
  /** Answer `PATCH /api/dots/:id` with this error instead of saving. */
  failUpdate: { status: number; error: string; message: string } | null = null;
  /** The ids of the Dots the browser deleted (`DELETE /api/dots/:id`), in order. */
  deleted: string[] = [];
  /** Answer `DELETE /api/dots/:id` with this error instead of accepting it. */
  failDelete: { status: number; error: string; message: string } | null = null;
  /** The most events one `GET .../events` page holds (the real route's is 1000). */
  eventPage = MAX_EVENT_PAGE;
  /** Answer `GET .../events` with this status instead of the log. */
  failEvents: number | null = null;
  /** The text of every `POST /api/dots/:id/messages`, as the browser sent it. */
  sentMessages: string[] = [];
  /** Answer `POST /api/dots/:id/messages` with this error instead of 201. */
  failSend: { status: number; error: string; message: string } | null = null;
  /** What `POST /api/dots/:id/messages` says of the delivery. */
  delivery: "delivered" | "queued" = "delivered";
  /** While set, `POST /api/dots/:id/messages` waits for it to resolve before it answers. */
  holdSend: Promise<void> | null = null;
  /** What each `GET .../messages` asked for. */
  messageQueries: Array<{ limit: number | null; order: string | null; before: number | null }> = [];
  /** The identities `GET .../browser-identities` lists. */
  identities: BrowserIdentity[] = [];
  /** Answer `GET .../computer/screenshot` and `.../frame` with this error instead of a picture. */
  failPicture: { status: number; error: string; message: string } | null = null;
  /** Spend today, as `GET /api/dots/:id/usage?since=` answers it, and in total, as it answers without `since`. */
  spentUsd = 0;
  spentTotalUsd = 0;
  /** The body of every `POST .../browser-identities`, as the browser sent it. */
  createdIdentities: Array<{ name: string; proxy?: string }> = [];
  /** The ids of the identities the browser closed (`POST .../close`) and deleted, in order. */
  closedIdentities: string[] = [];
  deletedIdentities: string[] = [];
  /** Answer an identity's create, close or delete with this error instead of doing it. */
  failIdentityAction: { status: number; error: string; message: string } | null = null;
  /** Answer `GET .../browser-identities` with this error instead of the list. */
  failIdentities: { status: number; error: string; message: string } | null = null;
  /** The files of the Dot's computer by absolute path; a folder exists where a file is under it (and home always). */
  files = new Map<string, { content: Uint8Array; mtime: string }>();
  /** Answer the files routes with this error instead of the folder or the file. */
  failFiles: { status: number; error: string; message: string } | null = null;
  /** What `GET .../computer` says of the guest while it runs. */
  system: SystemAnswer | null = null;
  computerImages: { golden_image: string | null; runtime_image: string | null } = { golden_image: "golden-1.qcow2", runtime_image: "runtime-1.iso" };
  /** `ready` of `GET .../computer`. */
  ready = true;
  keyConfigured = true;
  healthy = true;
  /** The value of every `PUT /api/secrets/openrouter`, as the browser sent it. */
  savedKeys: string[] = [];
  /** How many running Dots `PUT /api/secrets/openrouter` says it pushed the key to. */
  keyPushedTo = 0;
  /** Answer `PUT /api/secrets/openrouter` with this error instead of storing the key. */
  failKey: { status: number; error: string; message: string } | null = null;
  /** What `GET /api/doctor` reports, in the contract's order (the real one has nine rows, the last the key). */
  doctor: DoctorCheck[] = [
    { id: "node", label: "Node.js", status: "ok", detail: "24.1.0" },
    { id: "qemu", label: "QEMU", status: "ok", detail: "8.2.2" },
    { id: "golden-image", label: "golden image", status: "ok", detail: "golden-1.qcow2 matches its manifest" },
    { id: "openrouter", label: "OpenRouter key", status: "ok", detail: "stored" },
  ];
  /** Answer `GET /api/doctor` with this status instead of the report. */
  failDoctor: number | null = null;
  computerLastError: string | null = null;
  /** `stop_reason` and `next_automation_at` of `GET .../computer`: what the host records, which is there while the computer is off. */
  computerStopReason: ComputerAnswer["stop_reason"] = null;
  nextAutomationAt: string | null = null;
  /** Every request as "METHOD path", in order. */
  requests: string[] = [];
  /** Answer a computer action with this error status instead of 202. */
  failComputerAction: number | null = null;
  /** The `config` of every `POST /api/dots`, as the browser sent it (YAML text or an object). */
  created: unknown[] = [];
  /** Answer `POST /api/dots` with this error instead of 201. */
  failCreate: { status: number; error: string; message: string; details?: unknown } | null = null;
  #stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** The WhatsApp link streams that are open, by Dot id. */
  #links = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  #nextEventId = 1;

  /** `fetch` as the browser would have it: the routes of this class and nothing else. */
  fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => this.#answer(String(input), init);

  install(): void {
    vi.stubGlobal("fetch", vi.fn(this.fetch));
  }

  /** Put a file on the Dot's computer. */
  putFile(path: string, content: string | Uint8Array, mtime = "2026-03-10T12:00:00Z"): void {
    this.files.set(path, { content: typeof content === "string" ? new TextEncoder().encode(content) : content, mtime });
  }

  /** Put an event in the stored log without telling the stream: it happened before the page opened. */
  store(dotId: string, type: string, data: Record<string, unknown> = {}, createdAt = new Date().toISOString()): StoredEvent {
    const event = { id: this.#nextEventId++, dot_id: dotId, type, data, source: "guest", guest_seq: null, created_at: createdAt } as StoredEvent;
    this.events.push(event);
    return event;
  }

  /** Push a live event to everything listening on the stream (it is stored too, as the real one is). */
  push(dotId: string, type: string, data: Record<string, unknown> = {}): void {
    const event = this.store(dotId, type, data);
    this.#stream?.enqueue(new TextEncoder().encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
  }

  /** The connection of the live stream ends without a last event: the control plane stopped, or the network dropped. */
  dropStream(): void {
    const stream = this.#stream;
    this.#stream = null;
    stream?.close();
  }

  get streamOpen(): boolean {
    return this.#stream !== null;
  }

  /** Whether a page follows the WhatsApp link of this Dot (`GET .../channels/whatsapp/qr` is open). */
  linkOpen(dotId: string): boolean {
    return this.#links.has(dotId);
  }

  /** The connection of the WhatsApp link ends without a last frame: the server went away. */
  dropLink(dotId: string): void {
    const link = this.#links.get(dotId);
    if (!link) throw new Error(`nothing follows the WhatsApp link of ${dotId}`);
    this.#links.delete(dotId);
    link.close();
  }

  /** A frame of the WhatsApp link, to the page that follows it; a last frame (`linked`, `failed`) ends the stream, as the host's does. */
  linkFrame(dotId: string, frame: ChannelLinkFrame): void {
    const link = this.#links.get(dotId);
    if (!link) throw new Error(`nothing follows the WhatsApp link of ${dotId}`);
    link.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
    if (frame.state === "linked" || frame.state === "failed") {
      this.#links.delete(dotId);
      link.close();
    }
  }

  async #answer(url: string, init?: RequestInit): Promise<Response> {
    const { pathname, searchParams } = new URL(url, "http://web.test");
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${pathname}`);
    const json = (body: unknown, status = 200) => Response.json(body, { status });

    if (pathname === "/api/stream") {
      if (this.streamDown) return json({ error: "down", message: "the control plane is down" }, 503);
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.#stream = controller;
            init?.signal?.addEventListener("abort", () => {
              this.#stream = null;
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (pathname === "/session" && method === "DELETE") return new Response(null, { status: 204 });
    if (pathname === "/api/doctor") {
      if (this.failDoctor) return json({ error: "broken", message: "the doctor could not run" }, this.failDoctor);
      return json({ ok: this.doctor.every((check) => check.status === "ok"), checks: this.doctor });
    }
    if (pathname === "/api/health") {
      return this.healthy
        ? json({
            status: "ok",
            database: "ok",
            version: "9.9.9",
            openrouter_configured: this.keyConfigured,
            database_kind: "pglite",
            data_dir: "/home/me/.invisible-dots",
            logs_dir: "/home/me/.invisible-dots/logs",
          })
        : json({ error: "down", message: "down" }, 503);
    }
    if (pathname === "/api/secrets/openrouter" && method === "PUT") {
      if (this.failKey) return json({ error: this.failKey.error, message: this.failKey.message }, this.failKey.status);
      this.savedKeys.push((JSON.parse(String(init?.body)) as { value: string }).value);
      this.keyConfigured = true;
      return json({ pushed: this.keyPushedTo });
    }
    if (pathname === "/api/dots" && method === "POST") {
      const { config } = JSON.parse(String(init?.body)) as { config: unknown };
      this.created.push(config);
      if (this.failCreate) return json({ error: this.failCreate.error, message: this.failCreate.message, details: this.failCreate.details }, this.failCreate.status);
      return json(dotRecord("created-1", { name: "created", status: "CREATING", computer_state: null }), 201);
    }
    if (pathname === "/api/dots") return json({ dots: this.dots });
    if (pathname === "/api/approvals") {
      const status = searchParams.get("status")?.split(",") ?? null;
      const limit = searchParams.get("limit") === null ? null : Number(searchParams.get("limit"));
      const order = searchParams.get("order");
      const before = searchParams.get("before");
      const dotId = searchParams.get("dot_id");
      this.approvalQueries.push({ status, limit, order, before, dot_id: dotId });
      // The real route: oldest first, or with order=desc the newest by last change, a cursor being the id of the last row seen.
      const changed = (a: ApprovalRecord) => Date.parse(a.resolved_at ?? a.created_at);
      const listed = this.approvals.filter((a) => (!status || status.includes(a.status)) && (dotId === null || a.dot_id === dotId));
      const ordered = order === "desc" ? [...listed].sort((a, b) => changed(b) - changed(a) || b.id.localeCompare(a.id)) : listed;
      const from = before === null ? 0 : ordered.findIndex((a) => a.id === before) + 1 || ordered.length;
      return json({ approvals: ordered.slice(from, from + (limit ?? 500)) });
    }
    const answer = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
    if (answer && method === "POST") {
      const id = decodeURIComponent(answer[1]!);
      const decision = answer[2] as "approve" | "reject";
      const body = JSON.parse(String(init?.body ?? "{}")) as { note?: string; always?: true };
      this.answers.push({ id, decision, body });
      if (this.failAnswer) return json({ error: this.failAnswer.error, message: this.failAnswer.message }, this.failAnswer.status);
      const record = this.approvals.find((a) => a.id === id);
      if (!record) return json({ error: "not_found", message: `no approval ${id}` }, 404);
      if (record.status !== "pending") return json({ error: "already_resolved", message: `approval ${id} is already ${record.status}` }, 409);
      Object.assign(record, { status: decision === "approve" ? "approved" : "rejected", note: body.note ?? null, resolved_at: new Date().toISOString() });
      // The host logs the answer and publishes it: the page hears it as it would from the real one.
      this.push(record.dot_id, "approval.resolved", { approval_id: id, decision, ...(record.task_id ? { task_id: record.task_id } : {}), ...(body.note ? { note: body.note } : {}), ...(body.always ? { always: true } : {}) });
      return json(record);
    }
    const task = /^\/api\/tasks\/([^/]+)(\/cancel)?$/.exec(pathname);
    if (task) {
      const record = this.tasks.find((t) => t.id === decodeURIComponent(task[1]!));
      if (!record) return json({ error: "not_found", message: "no such task" }, 404);
      if (!task[2]) return json(record);
      if (this.failCancel) return json({ error: this.failCancel.error, message: this.failCancel.message }, this.failCancel.status);
      Object.assign(record, { status: "CANCELLED", error: "cancelled by the user", finished_at: new Date().toISOString() });
      return json(record);
    }
    const dot = /^\/api\/dots\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (dot) {
      // The real routes take a Dot's id or its name (requireDot).
      const address = decodeURIComponent(dot[1]!);
      const record = this.dots.find((d) => d.id === address) ?? this.dots.find((d) => d.name === address);
      if (!record) return json({ error: "not_found", message: "no such Dot" }, 404);
      const rest = dot[2] ?? "";
      if (rest === "" && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { config: DotConfig; expected_config_version?: number };
        this.updates.push(body);
        if (this.failUpdate) return json({ error: this.failUpdate.error, message: this.failUpdate.message }, this.failUpdate.status);
        if (body.expected_config_version !== undefined && body.expected_config_version !== record.config_version) {
          return json({ error: "dot_changed", message: `Dot ${record.name} changed after you read it` }, 409);
        }
        record.config = body.config;
        record.config_version += 1;
        this.push(record.id, "dot.updated", { name: record.name });
        return json(record);
      }
      if (rest === "" && method === "DELETE") {
        if (this.failDelete) return json({ error: this.failDelete.error, message: this.failDelete.message }, this.failDelete.status);
        this.deleted.push(record.id);
        return json({ accepted: true }, 202);
      }
      if (rest === "") return json(record);
      if (rest === "tasks" && method === "GET") {
        // The real route: the newest created first, at most TASK_LIST_LIMIT a page, `before` the id of the last task of the page before.
        const limit = Math.min(Number(searchParams.get("limit") ?? TASK_LIST_LIMIT), TASK_LIST_LIMIT);
        const before = searchParams.get("before");
        this.taskQueries.push({ limit: searchParams.has("limit") ? limit : null, before });
        const newest = this.tasks.filter((t) => t.dot_id === record.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : -1));
        const from = before === null ? 0 : newest.findIndex((t) => t.id === before) + 1 || newest.length;
        return json({ tasks: newest.slice(from, from + limit) });
      }
      if (rest === "tasks" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { description: string; priority?: number; scheduled_at?: string };
        this.createdTasks.push(body);
        if (this.failCreateTask) return json({ error: this.failCreateTask.error, message: this.failCreateTask.message }, this.failCreateTask.status);
        const created = taskRecord(`created-${this.createdTasks.length}`, {
          dot_id: record.id,
          description: body.description,
          priority: body.priority ?? 0,
          scheduled_at: body.scheduled_at ?? null,
          created_at: new Date().toISOString(),
        });
        this.tasks.push(created);
        return json(created, 201);
      }
      if (rest === "events") {
        if (this.failEvents) return json({ error: "broken", message: "the event log is not available" }, this.failEvents);
        const after = Number(searchParams.get("after") ?? 0);
        const limit = Math.min(Number(searchParams.get("limit") ?? 500), this.eventPage);
        // The real route's filters: `types` (a comma-separated list) and `task_id` (data.task_id).
        const types = searchParams.get("types")?.split(",");
        const tools = searchParams.get("tools")?.split(",");
        const taskId = searchParams.get("task_id");
        const order = searchParams.get("order");
        const before = searchParams.has("before") ? Number(searchParams.get("before")) : undefined;
        if (before !== undefined && order !== "desc") return json({ error: "invalid_request", message: "before pages a list in order=desc" }, 400);
        const query = { after, ...(before === undefined ? {} : { before }), limit, types: types ?? null, tools: tools ?? null, taskId, order };
        // The shell's one read of the agent's newest state is kept apart, so a test of what a view reads sees its own requests.
        (types?.length === 2 && types.includes("agent.state") && types.includes("agent.started") ? this.agentQueries : this.eventQueries).push(query);
        // `tools` narrows tool.called only, `order=desc` is the newest first and the limit keeps the newest.
        const kept = this.events.filter(
          (e) =>
            e.dot_id === record.id &&
            e.id > after &&
            (before === undefined || e.id < before) &&
            (!types || types.includes(e.type)) &&
            (!tools || e.type !== "tool.called" || tools.includes(String(e.data.tool))) &&
            (taskId === null || e.data.task_id === taskId),
        );
        return json({ events: (order === "desc" ? [...kept].reverse() : kept).slice(0, limit) });
      }
      if (rest === "messages" && method === "GET") {
        // The host logs the person's side as `user.message`, which the shared event type list does not hold.
        const type = (e: StoredEvent) => e.type as string;
        const limit = searchParams.has("limit") ? Number(searchParams.get("limit")) : null;
        const order = searchParams.get("order");
        const before = searchParams.has("before") ? Number(searchParams.get("before")) : null;
        if (before !== null && order !== "desc") return json({ error: "invalid_request", message: "before pages a list in order=desc" }, 400);
        this.messageQueries.push({ limit, order, before });
        // The real route: oldest first, or with order=desc the newest first, a cursor being the event id of the oldest message seen; a page holds at most CONVERSATION_LIST_LIMIT.
        const kept = this.events.filter((e) => e.dot_id === record.id && (type(e) === "user.message" || type(e) === "message.assistant") && (before === null || e.id < before));
        const messages = (order === "desc" ? [...kept].reverse() : kept)
          .slice(0, Math.min(limit ?? CONVERSATION_LIST_LIMIT, CONVERSATION_LIST_LIMIT))
          .map((e) => ({ event_id: e.id, role: type(e) === "user.message" ? "user" : "assistant", text: String(e.data.text ?? ""), in_reply_to: null, ...(type(e) === "user.message" && e.data.origin ? { origin: e.data.origin } : {}), created_at: e.created_at }));
        return json({ messages });
      }
      if (rest === "messages" && method === "POST") {
        const { text } = JSON.parse(String(init?.body)) as { text: string };
        this.sentMessages.push(text);
        if (this.holdSend) await this.holdSend;
        if (this.failSend) return json({ error: this.failSend.error, message: this.failSend.message }, this.failSend.status);
        const stored = this.store(record.id, "user.message", { message_id: `msg-${this.sentMessages.length}`, text });
        this.#stream?.enqueue(new TextEncoder().encode(`id: ${stored.id}\ndata: ${JSON.stringify(stored)}\n\n`));
        return json({ message_id: `msg-${this.sentMessages.length}`, event_id: stored.id, delivery: this.delivery }, 201);
      }
      if (rest === "computer/screenshot") {
        if (this.failPicture) return json({ error: this.failPicture.error, message: this.failPicture.message }, this.failPicture.status);
        return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
      }
      if (rest === "browser-identities" && method === "GET") {
        if (this.failIdentities) return json({ error: this.failIdentities.error, message: this.failIdentities.message }, this.failIdentities.status);
        return json({ identities: this.identities });
      }
      if (rest === "browser-identities" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string; proxy?: string };
        this.createdIdentities.push(body);
        if (this.failIdentityAction) return json({ error: this.failIdentityAction.error, message: this.failIdentityAction.message }, this.failIdentityAction.status);
        const created: BrowserIdentity = { id: `${body.name}-x${this.createdIdentities.length}`, name: body.name, status: "available", createdAt: new Date().toISOString(), lastUsedAt: null, profilePath: "/home/dot/browsers/x", hasProxy: Boolean(body.proxy) };
        this.identities.push(created);
        this.push(record.id, "browser.identity.created", { identity_id: created.id, name: created.name });
        return json(created, 201);
      }
      const identity = /^browser-identities\/([^/]+)(?:\/(close))?$/.exec(rest);
      if (identity && (identity[2] ? method === "POST" : method === "DELETE")) {
        const id = decodeURIComponent(identity[1]!);
        if (this.failIdentityAction) return json({ error: this.failIdentityAction.error, message: this.failIdentityAction.message }, this.failIdentityAction.status);
        const found = this.identities.find((i) => i.id === id);
        if (!found) return json({ error: "not_found", message: `no browser identity "${id}"` }, 404);
        if (identity[2]) {
          this.closedIdentities.push(id);
          found.status = "available";
          this.push(record.id, "browser.identity.closed", { identity_id: id, name: found.name });
        } else {
          this.deletedIdentities.push(id);
          this.identities = this.identities.filter((i) => i.id !== id);
          this.push(record.id, "browser.identity.deleted", { identity_id: id, name: found.name });
        }
        return new Response(null, { status: 204 });
      }
      if (/^browser-identities\/[^/]+\/frame$/.test(rest)) {
        if (this.failPicture) return json({ error: this.failPicture.error, message: this.failPicture.message }, this.failPicture.status);
        return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
      }
      if (rest === "channels" && method === "GET") {
        if (this.failChannels) return json({ error: this.failChannels.error, message: this.failChannels.message }, this.failChannels.status);
        return json({ channels: this.channels[record.id] ?? [], available: this.channelsAvailable });
      }
      const channel = /^channels\/(telegram|whatsapp)(?:\/(pairing|link|qr|peers\/([^/]+)))?$/.exec(rest);
      if (channel) {
        const kind = channel[1] as ChannelKind;
        const sub = channel[2] ?? "";
        const list = (this.channels[record.id] ??= []);
        const found = list.find((c) => c.kind === kind);
        if (sub === "qr" && method === "GET") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                this.#links.set(record.id, controller);
                init?.signal?.addEventListener("abort", () => {
                  if (this.#links.get(record.id) === controller) this.#links.delete(record.id);
                  try {
                    controller.close();
                  } catch {
                    // already closed
                  }
                });
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const isToken = sub === "" && method === "PUT";
        this.channelActions.push(`${method} ${kind}${sub ? ` ${sub}` : ""}${init?.body && !isToken ? ` ${JSON.stringify(body)}` : ""}`);
        if (this.failChannel) return json({ error: this.failChannel.error, message: this.failChannel.message }, this.failChannel.status);
        const announce = (next: ChannelRecord) => this.push(record.id, "channel.status", { kind, status: next.status });
        if (isToken && kind === "telegram") {
          this.sentTokens.push(String(body.token));
          const next = found ?? channelRecord("telegram");
          if (!found) list.push(next);
          Object.assign(next, { status: "connected", status_detail: null });
          announce(next);
          return json(next, found ? 200 : 201);
        }
        if (sub === "link" && method === "POST") {
          const next = found ?? channelRecord(kind, { status: "connecting", account: null });
          if (!found) list.push(next);
          // As the host does: a new link clears the account of the old one and keeps the people paired.
          Object.assign(next, { status: "connecting", status_detail: null, account: null });
          return json(next, 202);
        }
        if (!found) return json({ error: "not_found", message: `Dot has no ${kind} channel` }, 404);
        if (sub === "" && method === "PATCH") {
          if (body.settings) Object.assign(found.settings, body.settings);
          if (typeof body.enabled === "boolean") {
            const changed = found.enabled !== body.enabled;
            found.enabled = body.enabled;
            // The host announces what the person did to a channel, which no status says.
            if (changed) this.push(record.id, "channel.changed", { kind, change: body.enabled ? "resumed" : "paused" });
          }
          return json(found);
        }
        if (sub === "" && method === "DELETE") {
          this.channels[record.id] = list.filter((c) => c !== found);
          this.push(record.id, "channel.changed", { kind, change: "removed" });
          return new Response(null, { status: 204 });
        }
        if (sub === "pairing" && method === "POST") {
          const message = kind === "telegram" ? `/start ${this.pairing.code}` : `pair ${this.pairing.code}`;
          const deepLink = kind === "telegram" ? `https://t.me/${found.account}?start=${this.pairing.code}` : `https://wa.me/${found.account}?text=${encodeURIComponent(message)}`;
          return json({ code: this.pairing.code, deep_link: deepLink, message, expires_at: new Date(Date.now() + this.pairing.expiresInMs).toISOString() }, 201);
        }
        if (channel[3] && method === "DELETE") {
          const peer = decodeURIComponent(channel[3]);
          if (!found.peers.some((p) => p.peer_id === peer)) return json({ error: "not_found", message: `no peer ${peer}` }, 404);
          found.peers = found.peers.filter((p) => p.peer_id !== peer);
          return new Response(null, { status: 204 });
        }
      }
      if (rest === "skills") return this.skills === null ? json({ error: "computer_stopped", message: "the computer is STOPPED" }, 409) : json({ skills: this.skills });
      if (rest === "tools") return this.tools === null ? json({ error: "computer_stopped", message: "the computer is STOPPED" }, 409) : json({ tools: this.tools, mcp_servers: this.mcpServers });
      const secretsOf = () => ({
        dot_id: record.id,
        secrets: mcpServerNames(record.config).flatMap((server) =>
          record.config.mcp_servers[server]!.secrets.map((name) => ({ server, name, set: this.mcpSecretsSet.has(`${server}/${name}`) })),
        ),
      });
      if (rest === "mcp-secrets" && method === "GET") return json(secretsOf());
      const secret = /^mcp-secrets\/([^/]+)\/([^/]+)$/.exec(rest);
      if (secret && (method === "PUT" || method === "DELETE")) {
        const [server, name] = [decodeURIComponent(secret[1]!), decodeURIComponent(secret[2]!)];
        if (!record.config.mcp_servers[server]?.secrets.includes(name)) return json({ error: "not_found", message: `no secret ${server}/${name}` }, 404);
        const value = method === "PUT" ? (JSON.parse(String(init?.body)) as { value: string }).value : null;
        this.mcpSecretWrites.push({ server, name, value });
        if (value === null) this.mcpSecretsSet.delete(`${server}/${name}`);
        else this.mcpSecretsSet.add(`${server}/${name}`);
        return json(secretsOf());
      }
      if (rest === "usage") return json({ dot_id: record.id, since: searchParams.get("since"), spent_usd: searchParams.get("since") ? this.spentUsd : this.spentTotalUsd });
      if (rest === "computer") {
        const state = record.computer_state ?? "STOPPED";
        const answer: Partial<ComputerAnswer> = {
          dot_id: record.id,
          state,
          last_error: this.computerLastError,
          stop_reason: this.computerStopReason,
          next_automation_at: this.nextAutomationAt,
          ready: this.ready,
          system: computerIsUp(state) ? this.system : null,
          last_active_at: "2026-03-10T12:00:00Z",
          ...this.computerImages,
        };
        return json(answer);
      }
      if (rest === "files/list" || rest === "files") {
        if (!computerIsUp(record.computer_state)) return json({ error: COMPUTER_STOPPED, message: `the computer is ${record.computer_state}` }, 409);
        if (this.failFiles) return json({ error: this.failFiles.error, message: this.failFiles.message }, this.failFiles.status);
        const asked = searchParams.get("path") ?? "";
        const path = asked === "" || asked === "~" ? "/home/dot" : asked.startsWith("/") ? asked.replace(/\/+$/, "") : `/home/dot/${asked.replace(/\/+$/, "")}`;
        if (!path.startsWith("/home/dot")) return json({ error: "invalid_path", message: "path must be inside /home/dot" }, 400);
        const isDir = path === "/home/dot" || [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
        if (rest === "files") {
          const file = this.files.get(path);
          if (isDir) return json({ error: "is_a_directory", message: `${path} is a directory` }, 400);
          if (!file) return json({ error: "not_found", message: `no such file ${path}` }, 404);
          return new Response(file.content as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream" } });
        }
        if (this.files.has(path)) return json({ error: "not_a_directory", message: `${path} is not a directory` }, 400);
        if (!isDir) return json({ error: "not_found", message: `no such folder ${path}` }, 404);
        const entries = new Map<string, { name: string; type: "file" | "dir"; size: number; mtime: string }>();
        for (const [file, { content, mtime }] of this.files) {
          if (!file.startsWith(`${path}/`)) continue;
          const [name, ...more] = file.slice(path.length + 1).split("/");
          entries.set(name!, more.length > 0 ? { name: name!, type: "dir", size: 0, mtime } : { name: name!, type: "file", size: content.length, mtime });
        }
        return json({ path, entries: [...entries.values()] });
      }
      if (/^computer\/(start|stop|reboot)$/.test(rest) && method === "POST") {
        return this.failComputerAction ? json({ error: "refused", message: `the computer refused (${this.failComputerAction})` }, this.failComputerAction) : json({ accepted: true }, 202);
      }
    }
    return json({ error: "not_found", message: `${method} ${pathname}` }, 404);
  }
}
