/**
 * The host's client for one Dot: every dot-agentd route (architecture 5.2) and
 * every agent route behind `/v1/agent` (5.3), over HTTP/1.1 to
 * 127.0.0.1:<guest port>, which QEMU forwards to dot-agentd's TCP port 1024
 * (5.1). Every request carries the Dot's bearer token: the port is not a
 * credential, any local process and any guest can reach it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import {
  abortableSleep,
  AGENTD_ROUTES,
  AGENT_ROUTES,
  FILE_TOO_LARGE,
  GUEST_PROOF_CONTEXT,
  GUEST_UNPROVEN,
  GuestHealthTimeoutError,
  isFatalGuestError,
  parseOutboundEvent,
  pollGuestHealth,
  PREPARE_SLEEP_TIMEOUT_MS,
  REFUSED_PROBLEM_MAX,
  SseParser,
  type AgentHealthAnswer,
  type AgentStateAnswer,
  type BrowserIdentity,
  type BrowserIdentityListAnswer,
  type CreateBrowserIdentityRequest,
  type DotRuntimeConfig,
  type ExecAnswer,
  type ExecRequest,
  type FileListAnswer,
  type HealthAnswer,
  type InboundEvent,
  type OutboundEvent,
  type PollGuestHealthOptions,
  type PostEventAnswer,
  type ProofAnswer,
  type RefusedEvent,
  type SystemAnswer,
  type SecretsRequest,
  type SkillListAnswer,
  type ToolListAnswer,
} from "@invisible-dots/shared";
import { GuestRequestError } from "./errors.js";
import { silentLogger, type Logger } from "./logger.js";
import { GUEST_PORT_HOST } from "./ports.js";

export interface GuestClientOptions {
  /** Per-request timeout. Default 30 s; exec adds its own timeout on top. */
  timeoutMs?: number;
  logger?: Logger;
  /** Default 127.0.0.1, where QEMU binds the forward. */
  host?: string;
}

export interface EventStreamOptions {
  /** Resume after this outbound `seq`; the stream sends only newer events. Default 0. */
  after?: number;
  /**
   * Called, in order with the events, for a message the host refused, and awaited before the stream goes on. A refused
   * message with a `seq` is passed once (the stream resumes after it); one without cannot be told apart on a reconnect.
   */
  onRefused?: (info: RefusedEvent) => void | Promise<void>;
  signal?: AbortSignal;
  /** First reconnect delay; doubles up to `maxReconnectDelayMs`. Default 500 ms. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Called before each reconnect, e.g. to log it. */
  onReconnect?: (info: { after: number; attempt: number; error: Error }) => void;
}

/** The proof a guest holding `token` gives for `nonce` (`GET /v1/proof`, section 5.1). */
export function guestProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`${GUEST_PROOF_CONTEXT}${nonce}`).digest("hex");
}

interface Call {
  /** Sent without the token; only the proof route is. */
  unauthenticated?: boolean;
  method?: string;
  path: string;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The most the answer may hold; a larger one ends the call with `FILE_TOO_LARGE` and is not buffered. */
  maxBytes?: number;
}

interface Answer {
  status: number;
  body: Buffer;
  /** The media type of the answer, without parameters, lower case; "" when it sent none. */
  contentType: string;
}

function filesQuery(path: string): string {
  return `?path=${encodeURIComponent(path)}`;
}

function parseError(route: string, answer: Pick<Answer, "status" | "body">): GuestRequestError {
  const text = answer.body.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return new GuestRequestError(
        route,
        answer.status,
        typeof parsed.message === "string" ? `${parsed.error}: ${parsed.message}` : parsed.error,
        parsed.error,
      );
    }
  } catch {
    // Not JSON: the raw text is the most useful message.
  }
  const hint = answer.status === 401 ? " (the Dot token was refused)" : "";
  return new GuestRequestError(route, answer.status, `${text.trim().slice(0, 500) || "no body"}${hint}`);
}

export class GuestClient {
  readonly host: string;
  readonly port: number;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  /** Settles once whatever listens on the port proved it holds the token; until then the token is never sent. */
  private proven: Promise<void> | undefined;

  constructor(port: number, token: string, options: GuestClientOptions = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`GuestClient needs a TCP port, got ${port}`);
    if (!token) throw new Error("GuestClient needs the Dot token");
    this.host = options.host ?? GUEST_PORT_HOST;
    this.port = port;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger ?? silentLogger;
  }

  /** Where this client sends requests, for logs and errors. */
  get address(): string {
    return `${this.host}:${this.port}`;
  }

  private open(method: string, path: string, headers: OutgoingHttpHeaders, signal: AbortSignal | undefined) {
    // No keep-alive agent: after a VM restart the same port may lead to a new guest, and a pooled socket would not.
    return request({ host: this.host, port: this.port, method, path, headers, agent: false, signal });
  }

  /**
   * Make whatever listens on the port prove it holds the Dot token before
   * the token is sent there (section 5.1). A port is not a credential: after
   * a host restart or a QEMU that died, another process can listen on a
   * port the host still has on record. A failed proof is GUEST_UNPROVEN,
   * which no caller retries; a guest that is not up yet is retried as usual.
   */
  async prove(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const nonce = randomBytes(16).toString("hex");
    const path = `${AGENTD_ROUTES.proof}?nonce=${nonce}`;
    const answer = await this.json<ProofAnswer>({ path, unauthenticated: true, ...options });
    const expected = Buffer.from(guestProof(this.token, nonce), "utf8");
    const given = Buffer.from(typeof answer?.proof === "string" ? answer.proof : "", "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new GuestRequestError(
        `GET ${AGENTD_ROUTES.proof}`,
        0,
        `${this.address} is not this Dot's guest: it could not prove it holds the Dot token, so the token was not sent to it`,
        GUEST_UNPROVEN,
      );
    }
  }

  private ensureProven(signal: AbortSignal | undefined): Promise<void> {
    this.proven ??= this.prove({ signal }).catch((error: unknown) => {
      // A guest still booting fails the same way; the next request asks again.
      this.proven = undefined;
      throw error;
    });
    return this.proven;
  }

  private async send(call: Call): Promise<Answer> {
    if (!call.unauthenticated) await this.ensureProven(call.signal);
    return this.sendRaw(call);
  }

  private sendRaw(call: Call): Promise<Answer> {
    const method = call.method ?? "GET";
    const route = `${method} ${call.path}`;
    const headers: OutgoingHttpHeaders = call.unauthenticated ? {} : { authorization: `Bearer ${this.token}` };
    let body: Buffer | undefined;
    if (call.rawBody !== undefined) {
      body = Buffer.from(call.rawBody);
      headers["content-type"] = call.contentType ?? "application/octet-stream";
    } else if (call.body !== undefined) {
      body = Buffer.from(JSON.stringify(call.body), "utf8");
      headers["content-type"] = "application/json";
    }
    if (body !== undefined) headers["content-length"] = body.length;
    const timeoutMs = call.timeoutMs ?? this.timeoutMs;

    return new Promise<Answer>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, answer?: Answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          req.destroy();
          reject(error);
        } else if (answer!.status < 200 || answer!.status >= 300) {
          reject(parseError(route, answer!));
        } else {
          resolve(answer!);
        }
      };
      const req = this.open(method, call.path, headers, call.signal);
      const timer = setTimeout(() => finish(new GuestRequestError(route, 0, `no answer from ${this.address} within ${timeoutMs} ms`)), timeoutMs);
      req.on("response", (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const tooLarge = () => new GuestRequestError(route, 413, `the answer is larger than ${call.maxBytes} bytes`, FILE_TOO_LARGE);
        // An error answer is small and its text is the reason; only a successful body is held to the limit.
        const limited = call.maxBytes !== undefined && (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        if (limited && Number(res.headers["content-length"]) > call.maxBytes!) return finish(tooLarge());
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (limited && received > call.maxBytes!) return finish(tooLarge());
          chunks.push(chunk);
        });
        res.on("error", (error) => finish(new GuestRequestError(route, 0, `answer interrupted: ${error.message}`)));
        res.on("end", () => finish(undefined, { status: res.statusCode ?? 0, body: Buffer.concat(chunks), contentType: String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() }));
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        const hint = error.code === "ECONNREFUSED" ? " (nothing listens on the guest port: is the VM running?)" : "";
        finish(new GuestRequestError(route, 0, `${this.address}: ${error.message}${hint}`, error.code));
      });
      req.end(body);
    });
  }

  private async json<T>(call: Call): Promise<T> {
    const answer = await this.send(call);
    const text = answer.body.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GuestRequestError(`${call.method ?? "GET"} ${call.path}`, answer.status, `answer is not JSON: ${text.slice(0, 200)}`);
    }
  }

  private async noContent(call: Call): Promise<void> {
    await this.send(call);
  }

  private agentPath(path: string): string {
    return `${AGENTD_ROUTES.agent}${path}`;
  }

  // dot-agentd (5.2)

  health(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HealthAnswer> {
    return this.json({ path: AGENTD_ROUTES.health, ...options });
  }

  system(): Promise<SystemAnswer> {
    return this.json({ path: AGENTD_ROUTES.system });
  }

  exec(body: ExecRequest): Promise<ExecAnswer> {
    // The command may legitimately run for timeout_ms; give the transport that long plus a margin.
    const timeoutMs = body.timeout_ms === undefined ? undefined : body.timeout_ms + this.timeoutMs;
    return this.json({ method: "POST", path: AGENTD_ROUTES.exec, body, timeoutMs });
  }

  /** The file's bytes; with `maxBytes`, a larger file is refused (413 `FILE_TOO_LARGE`) without being read in full. */
  async readFile(path: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    return (await this.send({ path: `${AGENTD_ROUTES.files}${filesQuery(path)}`, maxBytes: options.maxBytes })).body;
  }

  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const rawBody = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.noContent({ method: "PUT", path: `${AGENTD_ROUTES.files}${filesQuery(path)}`, rawBody });
  }

  listFiles(path: string): Promise<FileListAnswer> {
    return this.json({ path: `${AGENTD_ROUTES.filesList}${filesQuery(path)}` });
  }

  /**
   * Ask the guest to power itself off (`/usr/bin/sudo -n /usr/bin/systemctl poweroff`). The 202
   * comes back before the shutdown begins; QEMU exits when the guest is off,
   * which is what the vm-manager then waits for.
   */
  powerOff(timeoutMs?: number): Promise<void> {
    return this.noContent({ method: "POST", path: AGENTD_ROUTES.poweroff, timeoutMs });
  }

  /** PNG bytes of display :0. */
  async screenshot(): Promise<Buffer> {
    return (await this.send({ path: AGENTD_ROUTES.screenshot })).body;
  }

  // invisible-dots-agent (5.3), through /v1/agent

  agentHealth(): Promise<AgentHealthAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.health) });
  }

  pushSecrets(secrets: SecretsRequest): Promise<void> {
    return this.noContent({ method: "POST", path: this.agentPath(AGENT_ROUTES.secrets), body: secrets });
  }

  putConfig(config: DotRuntimeConfig): Promise<void> {
    return this.noContent({ method: "PUT", path: this.agentPath(AGENT_ROUTES.config), body: config });
  }

  postEvent(event: InboundEvent): Promise<PostEventAnswer> {
    return this.json({ method: "POST", path: this.agentPath(AGENT_ROUTES.events), body: event });
  }

  state(): Promise<AgentStateAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.state) });
  }

  listBrowserIdentities(): Promise<BrowserIdentityListAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.browserIdentities) });
  }

  createBrowserIdentity(body: CreateBrowserIdentityRequest): Promise<BrowserIdentity> {
    return this.json({ method: "POST", path: this.agentPath(AGENT_ROUTES.browserIdentities), body });
  }

  getBrowserIdentity(id: string): Promise<BrowserIdentity> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.browserIdentity(id)) });
  }

  deleteBrowserIdentity(id: string): Promise<void> {
    return this.noContent({ method: "DELETE", path: this.agentPath(AGENT_ROUTES.browserIdentity(id)) });
  }

  /**
   * JPEG bytes of the open identity's window. The route's contract is a JPEG (architecture section 5.3), and the engine
   * is its one owner: it answers `frame_failed` for any other media type, so the host labels the bytes `image/jpeg`
   * all the way to the browser without looking again.
   */
  async getBrowserIdentityFrame(id: string): Promise<Buffer> {
    return (await this.send({ path: this.agentPath(AGENT_ROUTES.browserIdentityFrame(id)) })).body;
  }

  closeBrowserIdentity(id: string): Promise<void> {
    return this.noContent({ method: "POST", path: this.agentPath(AGENT_ROUTES.browserIdentityClose(id)) });
  }

  /** The Dot's tools and whether the model is offered each now. */
  listTools(): Promise<ToolListAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.tools) });
  }

  /** The Dot's skills, the built-in ones and its own, each with its whole file. */
  listSkills(): Promise<SkillListAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.skills) });
  }

  /** Flushes state and closes browser sessions; can take a while with several browsers open. */
  prepareSleep(timeoutMs = PREPARE_SLEEP_TIMEOUT_MS): Promise<void> {
    return this.noContent({ method: "POST", path: this.agentPath(AGENT_ROUTES.prepareSleep), timeoutMs });
  }

  /**
   * The outbound event stream, as an async iterator that survives disconnects:
   * on a network error or end of stream it reconnects with `?after=<last
   * seq seen>`, so an event is neither lost nor delivered twice. It ends when
   * `signal` aborts or the consumer stops iterating. Not retried: a 401 or
   * 404 (a wrong token or a wrong guest does not get better by waiting), a
   * failed proof, and a refused connection: QEMU listens on the guest port
   * for as long as it runs, so nothing listening means the VM is gone and
   * the caller has to look at the VM, not at this port.
   */
  async *events(options: EventStreamOptions = {}): AsyncGenerator<OutboundEvent, void, undefined> {
    let after = options.after ?? 0;
    const firstDelay = options.reconnectDelayMs ?? 500;
    const maxDelay = options.maxReconnectDelayMs ?? 15_000;
    let attempt = 0;
    const signal = options.signal;
    while (!signal?.aborted) {
      const stream = this.openStream(after, signal);
      let lastError: Error | undefined;
      try {
        for await (const item of stream) {
          attempt = 0;
          if ("refused" in item) {
            const { seq } = item.refused;
            if (seq !== null && seq <= after) continue;
            await options.onRefused?.(item.refused);
            if (seq !== null) after = seq;
            continue;
          }
          const event = item.event;
          if (event.seq <= after) continue;
          after = event.seq;
          yield event;
        }
        lastError = new Error("event stream ended");
      } catch (error) {
        if (error instanceof GuestRequestError && (error.status === 401 || error.status === 404)) throw error;
        if (isFatalGuestError(error) || (error as { code?: unknown }).code === "ECONNREFUSED") throw error;
        lastError = error as Error;
      } finally {
        await stream.return(undefined);
      }
      if (signal?.aborted) return;
      attempt++;
      options.onReconnect?.({ after, attempt, error: lastError });
      this.logger.warn("guest event stream reconnecting", { guest: this.address, after, attempt, reason: lastError.message });
      await abortableSleep(Math.min(firstDelay * 2 ** (attempt - 1), maxDelay), signal);
    }
  }

  /** One connection to `/events/stream`, parsed into events and the messages that are none; ends when the connection ends. */
  private async *openStream(
    after: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<{ event: OutboundEvent } | { refused: RefusedEvent }, void, undefined> {
    const path = `${this.agentPath(AGENT_ROUTES.eventsStream)}?after=${after}`;
    const route = `GET ${path}`;
    await this.ensureProven(signal);
    const req = this.open("GET", path, { authorization: `Bearer ${this.token}`, accept: "text/event-stream" }, signal);
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        req.once("response", resolve);
        req.once("error", (error: NodeJS.ErrnoException) =>
          reject(new GuestRequestError(route, 0, `${this.address}: ${error.message}`, error.code)),
        );
        req.end();
      });
      if ((response.statusCode ?? 0) !== 200) {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(chunk as Buffer);
        throw parseError(route, { status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
      }
      response.setEncoding("utf8");
      const parser = new SseParser();
      for await (const chunk of response) {
        for (const message of parser.feed(chunk as string)) {
          if (message.data === "") continue;
          let event: OutboundEvent;
          try {
            event = parseOutboundEvent(JSON.parse(message.data));
          } catch (error) {
            // One malformed message must not stall the stream forever; it is logged, handed to the consumer to be
            // recorded, and skipped.
            this.logger.error("guest sent an invalid event, skipped", { id: message.id, error: (error as Error).message });
            yield { refused: refusedOf(message.data, error as Error) };
            continue;
          }
          yield { event };
        }
      }
    } finally {
      req.destroy();
    }
  }
}

/** What a refused message is called: the `seq` and `type` it carried, when it was JSON that carried them, and why it was refused. */
function refusedOf(data: string, error: Error): RefusedEvent {
  let seq: number | null = null;
  let type: string | null = null;
  try {
    const raw = JSON.parse(data) as { seq?: unknown; type?: unknown };
    if (typeof raw.seq === "number" && Number.isSafeInteger(raw.seq) && raw.seq > 0) seq = raw.seq;
    if (typeof raw.type === "string") type = raw.type.slice(0, 64);
  } catch {
    // Not JSON: nothing of it can be named.
  }
  const problem = error.message.length > REFUSED_PROBLEM_MAX ? `${error.message.slice(0, REFUSED_PROBLEM_MAX - 3)}...` : error.message;
  return { seq, type, problem };
}

export type WaitForGuestHealthOptions = PollGuestHealthOptions;

export { GuestHealthTimeoutError };

/**
 * Poll `GET /v1/health` until the guest is up: the shared rule and loop of
 * `pollGuestHealth`, over this client. The first request of a client asks
 * the listener for its proof, so a port taken over by another process fails
 * at once, without the token ever being sent to it.
 */
export function waitForGuestHealth(client: GuestClient, options: WaitForGuestHealthOptions = {}): Promise<HealthAnswer> {
  return pollGuestHealth(client, options);
}
