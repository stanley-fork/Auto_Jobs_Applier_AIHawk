/**
 * The product driven from the outside, as a person drives it: the `invisible-dots` command, the HTTP API
 * of docs/architecture.md section 9.6, and dot-agentd on a running computer's forwarded port. The
 * end-to-end run (run.ts) and the runs that load the product (scale.ts) share it. Like them, it imports
 * nothing from the workspace.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assert,
  dotTokenFromSeed,
  Failure,
  guestProof,
  ROUTES,
  route,
  waitFor as waitForWith,
  type Computer,
  type Dot,
  type Identity,
  type StoredEvent,
  type Task,
} from "./lib.ts";

export const MINUTE = 60_000;
export const ENDED = ["COMPLETED", "FAILED", "CANCELLED"];

export function say(text: string): void {
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, everyMs = 2000): Promise<T> {
  return waitForWith(what, timeoutMs, probe, everyMs);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProductOptions {
  repo: string;
  /** INVISIBLE_DOTS_HOME of the server this drives. */
  home: string;
  logDir: string;
  /** The built `invisible-dots` command (apps/cli/dist/invisible-dots.mjs). */
  cli: string;
  apiUrl: string;
  webUrl: string;
  /** Whether the server runs its web client. */
  web: boolean;
  timeouts: { cli: number; server: number; ready: number; task: number; delete: number };
}

export class Product {
  readonly options: ProductOptions;
  readonly env: NodeJS.ProcessEnv;
  #server: ChildProcess | undefined;
  #cliLog: WriteStream | undefined;

  constructor(options: ProductOptions) {
    this.options = options;
    this.env = { ...process.env, INVISIBLE_DOTS_HOME: options.home };
  }

  /** Where every `invisible-dots` call and its output is written from now on. */
  logCliTo(file: string): void {
    this.#cliLog = createWriteStream(file, { flags: "a" });
  }

  closeCliLog(): void {
    this.#cliLog?.end();
  }

  /** Whether the server this started is still running. */
  get serverRunning(): boolean {
    return this.#server !== undefined && this.#server.exitCode === null;
  }

  /**
   * One `invisible-dots` call. Its arguments and output go to the CLI log; stdin
   * (only ever a secret: the key, an MCP server's) does not. With `stream`, output is also appended to
   * that file as it arrives, for a long command whose progress is followed.
   */
  cli = async (args: string[], options: { stdin?: string; timeoutMs?: number; stream?: string } = {}): Promise<CliResult> => {
    const timeoutMs = options.timeoutMs ?? this.options.timeouts.cli;
    const child = spawn(process.execPath, [this.options.cli, ...args], { cwd: this.options.repo, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const streamTo = options.stream ? createWriteStream(options.stream, { flags: "a" }) : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
      streamTo?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
      streamTo?.write(chunk);
    });
    child.stdin.end(options.stdin ?? "");
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolveExit(exitCode));
    });
    clearTimeout(timer);
    streamTo?.end();
    const result = { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
    this.#cliLog?.write(`$ invisible-dots ${args.join(" ")}\n${result.stdout}${result.stderr ? `[stderr]\n${result.stderr}` : ""}[exit ${code}]\n\n`);
    return result;
  };

  /** A `--json` call that must succeed: its parsed output. */
  cliJson = async <T>(args: string[]): Promise<T> => {
    const done = await this.cli([...args, "--json"]);
    assert(done.code === 0, `invisible-dots ${args[0]} exited with ${done.code}: ${done.stderr.trim()}`);
    return JSON.parse(done.stdout) as T;
  };

  startServer = async (): Promise<void> => {
    const { logDir, web, webUrl, timeouts } = this.options;
    const log = createWriteStream(join(logDir, "server.log"), { flags: "a" });
    const server = spawn(process.execPath, [this.options.cli, "server", ...(web ? [] : ["--no-web"])], { cwd: this.options.repo, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.#server = server;
    server.stdout!.pipe(log);
    server.stderr!.pipe(log);
    const started = Date.now();
    for (;;) {
      assert(server.exitCode === null, `invisible-dots server exited with ${server.exitCode}; see ${join(logDir, "server.log")}`);
      try {
        const health = await this.api<{ status: string; database: string }>("GET", ROUTES.health);
        if (health.status === "ok") break;
      } catch {
        // Not listening yet, or the token file is not written yet.
      }
      assert(Date.now() - started < timeouts.server, "the server did not answer /api/health in time");
      await sleep(500);
    }
    if (web) {
      // The web client starts after the control plane listens, and never stops it when it cannot start.
      await waitFor("the web client to answer", timeouts.server, async () => {
        assert(server.exitCode === null, `invisible-dots server exited with ${server.exitCode}`);
        return (await fetch(`${webUrl}/`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => undefined)) ? true : undefined;
      }, 500).catch((error: unknown) => {
        throw new Failure(`${(error as Error).message}; see ${join(logDir, "server.log")} (the web client is built with: npm run build --workspace @invisible-dots/web, or run with E2E_WEB=0)`);
      });
    }
  };

  /**
   * Stops the server the way a person does with Ctrl+C or a service manager.
   * On Linux SIGTERM runs the server's own shutdown (it closes the database and
   * releases server.lock); on Windows Node's kill() is TerminateProcess, so the
   * same call would test a hard kill instead. The runs are written for Linux
   * hosts (README), where step j restarts the server gracefully.
   */
  stopServer = async (): Promise<void> => {
    const child = this.#server;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(timer);
  };

  // API

  apiToken = async (): Promise<string> => {
    const fromEnv = process.env.INVISIBLE_DOTS_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    return (await readFile(join(this.options.home, "config", "api.token"), "utf8")).split(/\r?\n/)[0]!.trim();
  };

  /** A call that returns whatever the server answers, error statuses included. */
  raw = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.apiToken()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${this.options.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  };

  request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await this.raw(method, path, body);
    if (!response.ok) throw new HttpError(response.status, `${method} ${path}: ${response.status} ${await response.text()}`);
    return response;
  };

  api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await this.request(method, path, body);
    return (response.status === 204 || response.status === 202 ? undefined : await response.json()) as T;
  };

  /** The status and the error code of an answer that is expected to be a refusal. */
  refusal = async (method: string, path: string): Promise<{ status: number; error: string }> => {
    const response = await this.raw(method, path);
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { status: response.status, error: body.error ?? "" };
  };

  events = async (dotId: string, after = 0): Promise<StoredEvent[]> => {
    const all: StoredEvent[] = [];
    for (;;) {
      const page = (await this.api<{ events: StoredEvent[] }>("GET", route(ROUTES.events, { id: dotId }, { after, limit: 1000 }))).events;
      all.push(...page);
      if (page.length < 1000) return all;
      after = page.at(-1)!.id;
    }
  };

  identities = async (dotId: string): Promise<Identity[]> => {
    return (await this.api<{ identities: Identity[] }>("GET", route(ROUTES.identities, { id: dotId }))).identities;
  };

  computerOf = async (dotId: string): Promise<Computer> => {
    return this.api<Computer>("GET", route(ROUTES.computer, { id: dotId }));
  };

  waitReady = async (dotId: string): Promise<{ dot: Dot; computer: Computer }> => {
    return waitFor("the Dot to be READY", this.options.timeouts.ready, async () => {
      const dot = await this.api<Dot>("GET", route(ROUTES.dot, { id: dotId }));
      const computer = await this.computerOf(dotId);
      assert(dot.status !== "ERROR", `the Dot went to ERROR: ${dot.error ?? "(no error)"}; computer last_error: ${computer.last_error ?? "-"}`);
      return dot.status === "READY" && computer.ready ? { dot, computer } : undefined;
    }, 3000);
  };

  waitComputerState = async (dotId: string, state: string, timeoutMs: number): Promise<Computer> => {
    return waitFor(`the computer to be ${state}`, timeoutMs, async () => {
      const computer = await this.computerOf(dotId);
      assert(!(computer.state === "ERROR" && state !== "ERROR"), `the computer went to ERROR: ${computer.last_error ?? "-"}`);
      return computer.state === state ? computer : undefined;
    });
  };

  waitDeleted = async (dotId: string, what: string): Promise<void> => {
    await waitFor(what, this.options.timeouts.delete, async () => {
      try {
        await this.api("GET", route(ROUTES.dot, { id: dotId }));
        return undefined;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return true;
        throw error;
      }
    });
  };

  /** Waits for a task to end; a task that does not complete fails. */
  waitTask = async (taskId: string): Promise<Task> => {
    const done = await this.waitEnded(taskId);
    assert(done.status === "COMPLETED", `task ${taskId} ended ${done.status}: ${done.error ?? done.summary ?? "(no detail)"}`);
    return done;
  };

  /** Waits for a task to end, however it ends. */
  waitEnded = async (taskId: string): Promise<Task> => {
    return waitFor(`task ${taskId} to end`, this.options.timeouts.task, async () => {
      const task = await this.api<Task>("GET", route(ROUTES.task, { id: taskId }));
      return ENDED.includes(task.status) ? task : undefined;
    }, 3000);
  };

  // The guest

  /**
   * One request to dot-agentd on the forwarded port of the running computer: the
   * proof handshake first (the Dot's token goes only to a process that proves it
   * holds it), then the request with the Dot's own token, read from its seed.
   * This is how a run does to a guest what the model is not allowed to do to
   * its own computer: read what it wrote, with no tool and no permission.
   */
  guestRequest = async (dotId: string, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> => {
    const raw = body instanceof Uint8Array;
    const computer = await this.computerOf(dotId);
    assert(computer.guest_port, `the computer is ${computer.state}: it has no guest port`);
    const token = dotTokenFromSeed(await readFile(join(this.options.home, "vms", dotId, "seed.iso")));
    const base = `http://127.0.0.1:${computer.guest_port}`;
    const nonce = randomBytes(16).toString("hex");
    const proofResponse = await fetch(`${base}/v1/proof?nonce=${nonce}`, { signal: AbortSignal.timeout(30_000) });
    assert(proofResponse.ok, `GET /v1/proof: ${proofResponse.status}`);
    assert(((await proofResponse.json()) as { proof?: string }).proof === guestProof(token, nonce), "dot-agentd did not prove it holds this Dot's token");
    return fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  /** `PUT /v1/files`: writes a file under the guest's home, as dot. */
  guestPut = async (dotId: string, path: string, content: Uint8Array): Promise<void> => {
    const response = await this.guestRequest(dotId, "PUT", `/v1/files?path=${encodeURIComponent(path)}`, content, 10 * MINUTE);
    if (!response.ok) throw new Error(`PUT /v1/files ${path}: ${response.status} ${await response.text()}`);
  };

  /** `GET /v1/files`: reads a file under the guest's home. */
  guestGet = async (dotId: string, path: string): Promise<Uint8Array> => {
    const response = await this.guestRequest(dotId, "GET", `/v1/files?path=${encodeURIComponent(path)}`, undefined, 10 * MINUTE);
    if (!response.ok) throw new Error(`GET /v1/files ${path}: ${response.status} ${await response.text()}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  /** `POST /v1/exec` (architecture section 5.2): a command as the user dot, whatever the Dot's permissions say. */
  guestExec = async (dotId: string, command: string, timeoutMs = 30_000): Promise<{ exit_code: number; stdout: string; stderr: string; timed_out: boolean }> => {
    const response = await this.guestRequest(dotId, "POST", "/v1/exec", { command, timeout_ms: timeoutMs }, timeoutMs + 30_000);
    if (!response.ok) throw new Error(`POST /v1/exec: ${response.status} ${await response.text()}`);
    return (await response.json()) as { exit_code: number; stdout: string; stderr: string; timed_out: boolean };
  };
}
