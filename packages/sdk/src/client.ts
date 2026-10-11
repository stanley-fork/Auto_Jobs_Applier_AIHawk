/**
 * Typed client for every route of the control-plane API (architecture
 * section 9.6), built on `fetch` so it runs in Node and in browsers.
 */
import {
  SseParser,
  type ApprovalStatus,
  type BrowserIdentity,
  type ChannelKind,
  type ListOrder,
  type McpSecretsAnswer,
  type StoredEvent,
  type ToolInfo,
  type Skill,
  type SkillListAnswer,
  type ToolListAnswer,
} from "@invisible-dots/shared/browser";
import type {
  AcceptedAnswer,
  ApprovalRecord,
  ApprovalsAnswer,
  ApproveRequest,
  ChannelLinkFrame,
  ChannelPairingAnswer,
  ChannelRecord,
  ChannelsAnswer,
  ComputerAnswer,
  ConversationMessage,
  CreateTaskRequest,
  DoctorAnswer,
  DotRecord,
  DotsAnswer,
  DotSummary,
  EventsAnswer,
  FilesListAnswer,
  HealthResponse,
  IdentitiesAnswer,
  MessageAnswer,
  MessagesAnswer,
  PatchChannelRequest,
  PatchDotRequest,
  RejectRequest,
  TaskRecord,
  TasksAnswer,
  UsageAnswer,
} from "./types.js";

/** An `{ error, message }` answer of the API, or a failure to reach it (`status` 0, `code` "unreachable"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  /** e.g. `http://127.0.0.1:8787`; "" for same-origin requests from a page served next to the API. */
  baseUrl: string;
  /**
   * The API token. Omitted by the web client, whose same-origin server adds
   * it, so the token never reaches the browser.
   */
  token?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (not applied to the event stream). Default 30 s. */
  timeoutMs?: number;
}

export interface StreamOptions {
  /** Only events of this Dot (id or name are both accepted by the server for other routes; the stream takes the id). */
  dotId?: string;
  /** Replay stored events with an id greater than this first. */
  after?: number;
  signal?: AbortSignal;
  /** Reconnect after a dropped connection, resuming after the last event seen. Default true. */
  reconnect?: boolean;
  /** Called each time a connection is established, before its first event. */
  onOpen?: () => void;
  /** Called before every reconnect. */
  onReconnect?: (info: { after: number | undefined; attempt: number; error: Error }) => void;
}

type Query = Record<string, string | number | undefined>;

/** The SSE event name the server sends right before it ends a stream because of an error. */
export const STREAM_ERROR_EVENT = "stream-error";

const enc = encodeURIComponent;

export class InvisibleDotsClient {
  readonly baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #authHeaders(): Record<string, string> {
    return this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` };
  }

  #url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  async #send(method: string, path: string, options: { body?: unknown; query?: Query; accept?: string } = {}): Promise<Response> {
    const headers = this.#authHeaders();
    if (options.accept) headers.accept = options.accept;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const url = this.#url(path, options.query);
    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new ApiError(0, "unreachable", `cannot reach the invisible_dots API at ${this.baseUrl}: ${reason}`);
    }
    if (!response.ok) throw await toApiError(response, `${method} ${path}`);
    return response;
  }

  async #json<T>(method: string, path: string, options: { body?: unknown; query?: Query } = {}): Promise<T> {
    const response = await this.#send(method, path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // Health and secrets

  health(): Promise<HealthResponse> {
    return this.#json("GET", "/api/health");
  }

  /** The host checks of `invisible-dots doctor`, run on the machine the server runs on; it takes a moment (the accelerator probe). */
  doctor(): Promise<DoctorAnswer> {
    return this.#json("GET", "/api/doctor");
  }

  setOpenRouterKey(value: string, dotId?: string): Promise<{ pushed: number }> {
    return this.#json("PUT", "/api/secrets/openrouter", { body: dotId === undefined ? { value } : { value, dot_id: dotId } });
  }

  /** Set a Dot's VM proxy (`socks5://...`), or clear it with null; used from the Dot's next start. Never echoed back. */
  setVmProxy(idOrName: string, value: string | null): Promise<{ dot_id: string; proxy: boolean }> {
    return value === null
      ? this.#json("DELETE", `/api/dots/${encodeURIComponent(idOrName)}/proxy`)
      : this.#json("PUT", `/api/dots/${encodeURIComponent(idOrName)}/proxy`, { body: { value } });
  }

  /** Whether a Dot has a VM proxy, never its value. */
  vmProxy(idOrName: string): Promise<{ dot_id: string; proxy: boolean }> {
    return this.#json("GET", `/api/dots/${encodeURIComponent(idOrName)}/proxy`);
  }

  /** Every secret the Dot's MCP servers name, and whether each is set; never a value. */
  mcpSecrets(idOrName: string): Promise<McpSecretsAnswer> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/mcp-secrets`);
  }

  /** Set a secret an MCP server of the Dot names, or clear it with null; the server starts again with it. Never echoed back. */
  setMcpSecret(idOrName: string, server: string, name: string, value: string | null): Promise<McpSecretsAnswer> {
    const path = `/api/dots/${enc(idOrName)}/mcp-secrets/${enc(server)}/${enc(name)}`;
    return value === null ? this.#json("DELETE", path) : this.#json("PUT", path, { body: { value } });
  }

  // Dots

  createDot(config: string | Record<string, unknown>): Promise<DotRecord> {
    return this.#json("POST", "/api/dots", { body: { config } });
  }

  async listDots(): Promise<DotSummary[]> {
    return (await this.#json<DotsAnswer>("GET", "/api/dots")).dots;
  }

  /** By id or by name. */
  getDot(idOrName: string): Promise<DotSummary> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}`);
  }

  /** With `expectedConfigVersion` (the `config_version` of the Dot as read), a Dot whose config changed since is a 409 `dot_changed` and nothing is saved. */
  updateDot(idOrName: string, config: string | Record<string, unknown>, expectedConfigVersion?: number): Promise<DotRecord> {
    const body: PatchDotRequest = { config, ...(expectedConfigVersion !== undefined && { expected_config_version: expectedConfigVersion }) };
    return this.#json("PATCH", `/api/dots/${enc(idOrName)}`, { body });
  }

  deleteDot(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("DELETE", `/api/dots/${enc(idOrName)}`);
  }

  // Messages and tasks

  sendMessage(idOrName: string, text: string): Promise<MessageAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/messages`, { body: { text } });
  }

  /**
   * The Dot's conversation, oldest first. With `order: "desc"` it is the newest first, `limit` keeps the newest, and
   * `before` (the `event_id` of the oldest message of the previous page) pages on, older, from there.
   */
  async messages(idOrName: string, options: { limit?: number; order?: ListOrder; before?: number } = {}): Promise<ConversationMessage[]> {
    return (
      await this.#json<MessagesAnswer>("GET", `/api/dots/${enc(idOrName)}/messages`, {
        query: { limit: options.limit, order: options.order, before: options.before },
      })
    ).messages;
  }

  createTask(idOrName: string, request: CreateTaskRequest): Promise<TaskRecord> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/tasks`, { body: request });
  }

  /** The Dot's tasks, the newest created first, at most TASK_LIST_LIMIT; `before` (the id of the last task of the previous page) goes on, older. */
  async listTasks(idOrName: string, page: { limit?: number; before?: string } = {}): Promise<TaskRecord[]> {
    return (await this.#json<TasksAnswer>("GET", `/api/dots/${enc(idOrName)}/tasks`, { query: { limit: page.limit, before: page.before } })).tasks;
  }

  getTask(taskId: string): Promise<TaskRecord> {
    return this.#json("GET", `/api/tasks/${enc(taskId)}`);
  }

  cancelTask(taskId: string): Promise<TaskRecord> {
    return this.#json("POST", `/api/tasks/${enc(taskId)}/cancel`);
  }

  // Computer

  computer(idOrName: string): Promise<ComputerAnswer> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/computer`);
  }

  startComputer(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/computer/start`);
  }

  stopComputer(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/computer/stop`);
  }

  rebootComputer(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/computer/reboot`);
  }

  /** PNG bytes of the Dot's display. */
  async screenshot(idOrName: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.#send("GET", `/api/dots/${enc(idOrName)}/computer/screenshot`, { accept: "image/png" });
    return new Uint8Array(await response.arrayBuffer());
  }

  // Browser identities

  async listIdentities(idOrName: string): Promise<BrowserIdentity[]> {
    return (await this.#json<IdentitiesAnswer>("GET", `/api/dots/${enc(idOrName)}/browser-identities`)).identities;
  }

  createIdentity(idOrName: string, request: { name: string; proxy?: string }): Promise<BrowserIdentity> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/browser-identities`, { body: request });
  }

  getIdentity(idOrName: string, identityId: string): Promise<BrowserIdentity> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/browser-identities/${enc(identityId)}`);
  }

  async deleteIdentity(idOrName: string, identityId: string): Promise<void> {
    await this.#json("DELETE", `/api/dots/${enc(idOrName)}/browser-identities/${enc(identityId)}`);
  }

  /** JPEG bytes of an open identity's window (409 `not_open` when it is closed, 503 `busy` while a call holds it). */
  async getIdentityFrame(idOrName: string, identityId: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.#send("GET", `/api/dots/${enc(idOrName)}/browser-identities/${enc(identityId)}/frame`, {
      accept: "image/jpeg",
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  /** End an identity's browser and keep its profile. Closing a closed identity is not an error. */
  async closeIdentity(idOrName: string, identityId: string): Promise<void> {
    await this.#json("POST", `/api/dots/${enc(idOrName)}/browser-identities/${enc(identityId)}/close`);
  }

  // Channels

  /** The Dot's messaging channels with the people paired to each. Never a token. */
  async channels(idOrName: string): Promise<ChannelRecord[]> {
    return (await this.channelsOverview(idOrName)).channels;
  }

  /** The Dot's channels and the kinds this server can run (WhatsApp is there only when the server was started with it). */
  channelsOverview(idOrName: string): Promise<ChannelsAnswer> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/channels`);
  }

  /** Start linking WhatsApp (opt-in on the server): read the codes to scan from `whatsappLink`. */
  linkWhatsApp(idOrName: string): Promise<ChannelRecord> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/channels/whatsapp/link`);
  }

  /**
   * `GET /api/dots/:id/channels/whatsapp/qr`: the state of the link now, then each new code and how it ends, as
   * `ChannelLinkFrame`s. The iterator ends after the last frame (`linked` or `failed`) or when `signal` aborts; a
   * connection that drops is thrown, because a code missed is a code that is gone.
   */
  async *whatsappLink(idOrName: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<ChannelLinkFrame, void, undefined> {
    const response = await this.#openEvents(`/api/dots/${enc(idOrName)}/channels/whatsapp/qr`, {}, options.signal);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const message of parser.feed(value)) yield JSON.parse(message.data) as ChannelLinkFrame;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Link the Dot to a Telegram bot, or give the linked bot a new token. The server checks the token with
   * Telegram, stores it encrypted and never returns it.
   */
  putTelegramChannel(idOrName: string, token: string): Promise<ChannelRecord> {
    return this.#json("PUT", `/api/dots/${enc(idOrName)}/channels/telegram`, { body: { token } });
  }

  /** Change settings, or pause (`enabled: false`) and resume the channel. */
  patchChannel(idOrName: string, kind: ChannelKind, patch: PatchChannelRequest): Promise<ChannelRecord> {
    return this.#json("PATCH", `/api/dots/${enc(idOrName)}/channels/${enc(kind)}`, { body: patch });
  }

  /** Unlink: the token, the paired people and the channel's record are deleted. */
  async removeChannel(idOrName: string, kind: ChannelKind): Promise<void> {
    await this.#json("DELETE", `/api/dots/${enc(idOrName)}/channels/${enc(kind)}`);
  }

  /** A one-time code (valid ten minutes) and, where the channel has one, the link that opens the chat with the code filled in. */
  pairChannel(idOrName: string, kind: ChannelKind): Promise<ChannelPairingAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/channels/${enc(kind)}/pairing`);
  }

  /** Revoke a paired person: they are strangers again. */
  async removeChannelPeer(idOrName: string, kind: ChannelKind, peerId: string): Promise<void> {
    await this.#json("DELETE", `/api/dots/${enc(idOrName)}/channels/${enc(kind)}/peers/${enc(peerId)}`);
  }

  // Approvals

  /**
   * The approvals with one status or any of several (every one when omitted), oldest first and at most
   * `APPROVAL_LIST_LIMIT`. With `order: "desc"` they come newest first by the time of their last change (the answer,
   * for an answered one), so a `limit` keeps the newest, and `before` (the id of the last approval of the previous
   * page) pages on from there; `before` needs `order: "desc"`. With `dot` (an id or a name) only that Dot's.
   */
  async listApprovals(
    status?: ApprovalStatus | readonly ApprovalStatus[],
    page: { limit?: number; order?: ListOrder; before?: string; dot?: string } = {},
  ): Promise<ApprovalRecord[]> {
    const statuses = status === undefined ? undefined : typeof status === "string" ? status : status.join(",");
    const { dot, ...rest } = page;
    return (await this.#json<ApprovalsAnswer>("GET", "/api/approvals", { query: { status: statuses, ...rest, dot_id: dot } })).approvals;
  }

  /** Allow what the Dot asked for; with `always` its permission is also set to `allow` in the Dot's config. */
  approve(approvalId: string, request: ApproveRequest = {}): Promise<ApprovalRecord> {
    return this.#json("POST", `/api/approvals/${enc(approvalId)}/approve`, { body: request });
  }

  reject(approvalId: string, request: RejectRequest = {}): Promise<ApprovalRecord> {
    return this.#json("POST", `/api/approvals/${enc(approvalId)}/reject`, { body: request });
  }

  // Events

  /**
   * The Dot's stored events, oldest first. `types` keeps only those type names and `taskId` only the events of that
   * task (`data.task_id`); an unknown type name is a 400. `tools` narrows the `tool.called` events to those of these
   * tools and leaves the other types alone. With `order: "desc"` the newest come first, so a `limit` keeps the newest
   * of what the filters keep, and `before` (the id of the oldest event of the previous page) pages on, older, from
   * there; `before` needs `order: "desc"`.
   */
  async events(
    idOrName: string,
    options: { after?: number; before?: number; limit?: number; types?: readonly string[]; tools?: readonly string[]; taskId?: string; order?: ListOrder } = {},
  ): Promise<StoredEvent[]> {
    return (
      await this.#json<EventsAnswer>("GET", `/api/dots/${enc(idOrName)}/events`, {
        query: {
          after: options.after,
          before: options.before,
          limit: options.limit,
          types: options.types?.length ? options.types.join(",") : undefined,
          tools: options.tools?.length ? options.tools.join(",") : undefined,
          task_id: options.taskId,
          order: options.order,
        },
      })
    ).events;
  }

  // The tools and the skills of the Dot's engine: the computer must be running (409 computer_stopped)

  /**
   * The Dot's tools, each with the permission it exercises and whether the model is offered it now, and the MCP servers
   * its config declares with where each is.
   */
  listTools(idOrName: string): Promise<ToolListAnswer> {
    return this.#json<ToolListAnswer>("GET", `/api/dots/${enc(idOrName)}/tools`);
  }

  /** The Dot's skills, the built-in ones and its own, each with its whole file. */
  async listSkills(idOrName: string): Promise<Skill[]> {
    return (await this.#json<SkillListAnswer>("GET", `/api/dots/${enc(idOrName)}/skills`)).skills;
  }

  // Files of the Dot's computer: read-only, under /home/dot, and the computer must be running (409 computer_stopped)

  /** The entries of a directory (`path` is absolute, relative to /home/dot, or `~`; omitted: home) and the path listed. */
  listFiles(idOrName: string, path?: string): Promise<FilesListAnswer> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/files/list`, { query: { path } });
  }

  /** The bytes of a file; one over 16 MiB is a 413 `file_too_large`. */
  async readFile(idOrName: string, path: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.#send("GET", `/api/dots/${enc(idOrName)}/files`, { query: { path } });
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * The model spend the Dot's guest reported, in USD, since an ISO 8601 timestamp (omitted: ever).
   * See `UsageAnswer` for what it counts.
   */
  usage(idOrName: string, options: { since?: string } = {}): Promise<UsageAnswer> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/usage`, { query: { since: options.since } });
  }

  /**
   * `GET /api/stream` as an async iterator of stored events. With `reconnect`
   * (the default) a dropped connection is resumed after the last event seen,
   * so nothing is missed; authentication and other 4xx errors are thrown.
   */
  async *stream(options: StreamOptions = {}): AsyncGenerator<StoredEvent, void, undefined> {
    let after = options.after;
    let attempt = 0;
    const reconnect = options.reconnect ?? true;
    for (;;) {
      if (options.signal?.aborted) return;
      let failure: Error;
      try {
        const response = await this.#openEvents("/api/stream", { dot_id: options.dotId, after }, options.signal);
        options.onOpen?.();
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const message of parser.feed(value)) {
              if (message.event === STREAM_ERROR_EVENT) {
                const info = JSON.parse(message.data) as { message?: string };
                throw new Error(`the server closed the event stream: ${info.message ?? "unknown reason"}`);
              }
              const event = JSON.parse(message.data) as StoredEvent;
              after = event.id;
              attempt = 0;
              yield event;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        failure = new Error("the event stream ended");
      } catch (error) {
        if (options.signal?.aborted) return;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
        failure = error instanceof Error ? error : new Error(String(error));
      }
      if (!reconnect || options.signal?.aborted) {
        if (options.signal?.aborted) return;
        throw failure;
      }
      attempt++;
      options.onReconnect?.({ after, attempt, error: failure });
      await delay(Math.min(500 * 2 ** (attempt - 1), 15_000), options.signal);
    }
  }

  async #openEvents(path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<Response> {
    const url = this.#url(path, query);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { ...this.#authHeaders(), accept: "text/event-stream" },
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new ApiError(0, "unreachable", `cannot reach the invisible_dots API at ${this.baseUrl}: ${reason}`);
    }
    if (!response.ok) throw await toApiError(response, `GET ${path}`);
    if (!response.body) throw new ApiError(502, "bad_stream", "the event stream answer has no body");
    return response;
  }
}

async function toApiError(response: Response, route: string): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; details?: unknown };
    if (typeof body.error === "string") {
      return new ApiError(response.status, body.error, typeof body.message === "string" ? body.message : body.error, body.details);
    }
  } catch {
    // Not JSON; the text itself is the message.
  }
  return new ApiError(response.status, `http_${response.status}`, `${route}: HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
