/**
 * The `invisible-dots` command line. `run` takes its arguments and its world
 * (output streams, stdin, environment, fetch, the host commands) as
 * parameters, so the tests drive it in-process against a fake server and
 * fake host commands.
 *
 * Two kinds of command live here: the host commands of architecture
 * section 11 (setup, doctor, image build, server), which act on this
 * machine, and the API client commands, which talk to a running server.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { ApiError, type DotSummary, type InvisibleDotsClient, type TaskRecord } from "@invisible-dots/sdk";
import { CHANNEL_KINDS, COMPUTER_STOPPED, DEFAULT_WEB_LISTEN, ENV, type ChannelKind, type ChannelRecord, type ComputerAnswer, type McpSecretsAnswer, type StoredEvent, type ToolListAnswer } from "@invisible-dots/shared";
import { STORE_OPENROUTER_KEY } from "@invisible-dots/vm-manager";
import { apiUrl, AuthSetupError, connectApi, DEFAULT_URL } from "./api-client.js";
import { addTelegramChannel } from "./commands.js";
import { EXIT } from "./exit.js";

export { DEFAULT_URL } from "./api-client.js";
export { EXIT } from "./exit.js";

export const CLI_VERSION = "0.1.0";

/**
 * The commands that act on this host. The real ones (host.ts) load QEMU
 * discovery, the image builder and the whole control plane, so they are
 * imported only when one of them runs; tests pass fakes.
 */
/** `image build`: whether the golden image may be downloaded instead of built, and whether it is written compressed. */
export interface ImageBuildOptions {
  download: boolean;
  compress: boolean;
}

export interface HostCommands {
  doctor(options: { json: boolean }, io: CliIo): Promise<number>;
  setup(io: CliIo): Promise<number>;
  /** `setup --all`: setup, the builds and `image build` in one run that can be run again (setup/all.ts). */
  setupAll(io: CliIo): Promise<number>;
  imageBuild(io: CliIo, options?: ImageBuildOptions): Promise<number>;
  server(io: CliIo, options: { web: boolean }): Promise<number>;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** All of standard input, as text: for input that is piped in. */
  readStdin: () => Promise<string>;
  /**
   * One line of a secret typed in the terminal, with the echo off, so it stays out of the scrollback. Enter ends it
   * on every host; the end-of-input key differs (Ctrl-D on Linux, Ctrl-Z then Enter on Windows), so nothing a person
   * types depends on it. It rejects when the person cancels (Ctrl-C).
   */
  readSecret: () => Promise<string>;
  stdinIsTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C, to end `logs` and stop `image build`. */
  signal?: AbortSignal;
  /** Default: the real host commands. */
  host?: HostCommands;
}

class UsageError extends Error {}

export const USAGE = `invisible-dots - control your Dots

Getting this host ready (the same commands on Linux and Windows):
  invisible-dots setup --all                    everything in one run, in order: the guest daemon, QEMU and its accelerator, the web client, the images;
                                                run it again after a restart or a failure and it carries on
  invisible-dots setup                          just QEMU and its accelerator (may ask for administrator rights once)
  invisible-dots doctor [--json]                check everything; one line per check and the command that fixes a failure
  invisible-dots image build [--no-download] [--compress]
                                                the runtime ISO, and the golden image: downloaded when one is published for
                                                these inputs, built here otherwise (--no-download: always build; --compress:
                                                a compressed qcow2, as the published one is)
  invisible-dots server [--no-web]              run the control plane and the web client in the foreground (--no-web: the control plane only)

Using the server:
  invisible-dots init [file] [--force]          write a sample Dot config (default dot.yaml), check the server
  invisible-dots create <file.yaml>             create a Dot from a YAML config
  invisible-dots list                           list Dots
  invisible-dots status <dot>                   show a Dot, its computer and its recent tasks
  invisible-dots message <dot> <text...>        send a chat message
  invisible-dots task <dot> <description...> [--priority N] [--at ISO-8601]
                                                queue a task
  invisible-dots tasks <dot>                    list a Dot's tasks
  invisible-dots computer <dot> start|stop|reboot
  invisible-dots browser <dot> identities       list the Dot's browser identities
  invisible-dots mcp <dot>                      list the MCP servers the Dot's config declares: where each is on its computer, and which secrets are set
  invisible-dots approvals [--all]              list pending (or all) approvals
  invisible-dots approve <approval-id> [--note text] [--always]
                                                --always also allows that permission for the Dot from now on
  invisible-dots reject <approval-id> [--note text]
  invisible-dots secret openrouter [--dot <dot>]
                                                store the OpenRouter key: asked for in a terminal, read from stdin when piped (never from arguments)
  invisible-dots secret proxy --dot <dot> [--clear]
                                                set the Dot's VM proxy (socks5://user:pass@host:port), used from its next start; asked for like the key; --clear removes it
  invisible-dots secret mcp --dot <dot> <server> <name> [--clear]
                                                set a secret an MCP server of the Dot names (an environment variable or a header, e.g. "Bearer <token>"); asked for like the key; --clear removes it
  invisible-dots channel add telegram --dot <dot>
                                                link the Dot to a Telegram bot: the token from @BotFather is asked for in a terminal, read from stdin when piped (never from arguments)
  invisible-dots channel link whatsapp --dot <dot>
                                                link a WhatsApp number (opt-in on the server, unofficial, a ban of the account is possible): shows a code to scan in WhatsApp > Linked devices
  invisible-dots channel list [--dot <dot>]     list channels (of every Dot without --dot) with their status and paired people
  invisible-dots channel pair telegram --dot <dot>
                                                print a one-time link (valid 10 minutes) that pairs your Telegram account to the Dot
  invisible-dots channel remove telegram --dot <dot>
                                                unlink: the token and the paired people are deleted
  invisible-dots logs <dot> [--tail N] [--no-follow]
                                                print recent events, then follow new ones

<dot> is a Dot name or id. Add --json for machine-readable output.

Environment:
  ${ENV.HOME}       the data directory (default ~/.invisible-dots)
  ${ENV.WEB_LISTEN}   where the web client listens, host:port (default ${DEFAULT_WEB_LISTEN})
  ${ENV.QEMU_DIR}   the one directory QEMU is looked for in, when set (otherwise the official installer's directory, then PATH)
  ${ENV.URL}        server URL (default ${DEFAULT_URL})
  ${ENV.TOKEN}      API token (default: the first line of <${ENV.HOME}>/config/api.token)

Exit codes: 0 ok; 1 the server reported an error, a doctor check is not ok or a setup step failed;
2 usage error; 3 server unreachable; 4 missing or refused token; 5 restart the computer, then run doctor (or setup --all again).
`;

export const SAMPLE_DOT = `# A Dot configuration (docs/architecture.md, section 7).
name: my-first-dot                     # lowercase letters, digits and '-', up to 40
instructions: >
  Be concise. Write findings to files in ~/workspace.
model:
  provider: openrouter
  id: z-ai/glm-5.3-flash               # any OpenRouter model id
computer:
  cpu: 2
  memory: 4gb
  disk: 40gb
  idle_timeout: 15m                    # sleep after 15 minutes with nothing to do; 0 = never
permissions:
  computer.exec: allow
  browser.identity.delete: ask
limits:
  max_steps_per_task: 60
  max_cost_per_task_usd: 1.00
`;

const OPTIONS = {
  json: { type: "boolean" },
  force: { type: "boolean" },
  priority: { type: "string" },
  at: { type: "string" },
  note: { type: "string" },
  always: { type: "boolean" },
  dot: { type: "string" },
  tail: { type: "string" },
  "no-follow": { type: "boolean" },
  "no-web": { type: "boolean" },
  "no-download": { type: "boolean" },
  compress: { type: "boolean" },
  all: { type: "boolean" },
  clear: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/**
 * Whether Ctrl-C asks the command to stop (through `io.signal`) instead of ending the process at once: `logs` ends
 * cleanly, and `image build`, alone or as the last step of `setup --all`, kills its builder VM first. `server` installs
 * its own handlers.
 */
export function interruptIsAsked(argv: string[]): boolean {
  try {
    const { positionals, values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false });
    return positionals[0] === "logs" || positionals[0] === "image" || (positionals[0] === "setup" && values.all === true);
  } catch {
    return false;
  }
}

/** The command word of an argument list, so main.ts can decide what Ctrl-C does before `run` starts. */
export function commandOf(argv: string[]): string | undefined {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false }).positionals[0];
  } catch {
    return undefined;
  }
}

function noArguments(args: string[], command: string): void {
  if (args.length > 0) throw new UsageError(`${command} takes no arguments, got "${args.join(" ")}"`);
}

function need(args: string[], index: number, what: string): string {
  const value = args[index];
  if (value === undefined || value === "") throw new UsageError(`missing ${what}`);
  return value;
}

function pad(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n") + "\n";
}

function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** What `status` says about the Dot's automations: when the next one is due, or that the person's stop has paused them (when one was due: a Dot with none has nothing to pause). */
function nextAutomation(computer: ComputerAnswer): string {
  if (computer.stop_reason === "user" && computer.next_automation_at !== null) return "paused: the computer was stopped by you (start it to resume)";
  return computer.next_automation_at ?? "none due";
}

export function formatEvent(event: StoredEvent): string {
  const { guest_event_id: _id, guest_ts: _ts, ...data } = event.data;
  const detail = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
  return `${event.created_at} #${event.id} ${event.type}${detail}`;
}

function taskRows(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return "no tasks\n";
  return pad([
    ["ID", "STATUS", "PRIORITY", "CREATED", "DESCRIPTION"],
    ...tasks.map((t) => [t.id, t.status, String(t.priority), t.created_at, oneLine(t.description)]),
  ]);
}

function dotRows(dots: DotSummary[]): string {
  if (dots.length === 0) return "no Dots yet: create one with invisible-dots create <file.yaml>\n";
  return pad([
    ["NAME", "STATUS", "COMPUTER", "MODEL", "ID"],
    ...dots.map((d) => [d.name, d.status, d.computer_state ?? "-", d.config.model.id, d.id]),
  ]);
}

/** How a person is told to finish a pairing on each channel: Telegram's link opens the bot with a Start button, WhatsApp's opens a chat with the words ready to send. */
const PAIRING_WORDS: Record<ChannelKind, { action: string; to: string }> = {
  telegram: { action: "press Start", to: "the bot" },
  whatsapp: { action: "press Send", to: "the number" },
};

/** How a channel's account reads: a Telegram bot as @name, the number linked to WhatsApp as +number. */
function accountLabel(channel: ChannelRecord): string {
  if (channel.account === null) return "-";
  return channel.kind === "whatsapp" ? `+${channel.account}` : `@${channel.account}`;
}

function channelRows(rows: { dot: string; channel: ChannelRecord }[]): string {
  if (rows.length === 0) return "no channels: link one with invisible-dots channel add telegram --dot <dot>\n";
  return pad([
    ["DOT", "CHANNEL", "STATUS", "ACCOUNT", "PEOPLE", "NOTE"],
    ...rows.map(({ dot, channel: c }) => [
      dot,
      c.kind,
      c.enabled ? c.status : "paused",
      accountLabel(c),
      c.peers.length === 0 ? "-" : c.peers.map((p) => p.label).join(", "),
      c.status_detail ? oneLine(c.status_detail, 80) : "",
    ]),
  ]);
}

/** One line of a secret, from the terminal (echo off) or from stdin: never from the arguments, which end up in shell history and ps. */
async function secretFromInput(io: CliIo, what: { prompt: string; noun: string; command: string; spaces?: true }): Promise<string> {
  if (io.stdinIsTTY) io.stderr(`paste the ${what.prompt}, then press Enter:\n`);
  const value = (io.stdinIsTTY ? await io.readSecret() : await io.readStdin()).trim();
  if (!value) throw new UsageError(`no ${what.noun} given; run "${what.command}" in a terminal and paste it, or pipe it in`);
  // A header's value may be "Bearer <token>"; a key or a proxy never has a space, and a line break is never part of one.
  if (what.spaces ? /[\r\n]/.test(value) : /\s/.test(value)) {
    throw new UsageError(`the ${what.noun} on stdin contains ${what.spaces ? "a line break" : "whitespace"}; pass only the ${what.noun}`);
  }
  return value;
}

function mcpRows(tools: ToolListAnswer | null, secrets: McpSecretsAnswer): string {
  const servers = new Set([...(tools?.mcp_servers ?? []).map((server) => server.name), ...secrets.secrets.map((secret) => secret.server)]);
  if (servers.size === 0 && tools !== null) return "no MCP servers\n";
  const state = (name: string) => {
    if (tools === null) return "computer stopped";
    const server = tools.mcp_servers.find((s) => s.name === name);
    if (server === undefined) return "-";
    return server.state === "connected" ? `connected, ${server.tools} tools` : server.state === "failed" ? `failed: ${oneLine(server.error ?? "", 80)}` : server.state;
  };
  const secretsOf = (name: string) =>
    secrets.secrets.filter((secret) => secret.server === name).map((secret) => `${secret.name}${secret.set ? "" : " (not set)"}`).join(", ") || "-";
  return pad([["SERVER", "STATE", "SECRETS"], ...[...servers].map((name) => [name, state(name), secretsOf(name)])]);
}

function channelKind(value: string): ChannelKind {
  if (!(CHANNEL_KINDS as readonly string[]).includes(value)) throw new UsageError(`unknown channel "${value}": use ${CHANNEL_KINDS.join(" or ")}`);
  return value as ChannelKind;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`invisible-dots: ${(error as Error).message}\nRun "invisible-dots --help" for usage.\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...args] = positionals;
  if (values.help || !command || command === "help") {
    io.stdout(USAGE);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }

  const baseUrl = apiUrl(io.env);
  const out = (value: unknown, text: string) => io.stdout(values.json ? `${JSON.stringify(value, null, 2)}\n` : text);
  let client: InvisibleDotsClient | undefined;
  const api = async () => (client ??= await connectApi(io.env, io.fetch));
  const host = async (): Promise<HostCommands> => io.host ?? (await import("./host.js")).realHostCommands();

  try {
    switch (command) {
      case "setup":
        noArguments(args, "setup");
        return values.all === true ? await (await host()).setupAll(io) : await (await host()).setup(io);
      case "doctor":
        noArguments(args, "doctor");
        return await (await host()).doctor({ json: values.json === true }, io);
      case "image": {
        const what = need(args, 0, "build");
        if (what !== "build") throw new UsageError(`unknown image subcommand "${what}": use build`);
        noArguments(args.slice(1), "image build");
        return await (await host()).imageBuild(io, { download: values["no-download"] !== true, compress: values.compress === true });
      }
      case "server":
        noArguments(args, "server");
        return await (await host()).server(io, { web: values["no-web"] !== true });
      case "init": {
        const file = resolve(io.cwd, args[0] ?? "dot.yaml");
        try {
          await writeFile(file, SAMPLE_DOT, { flag: values.force ? "w" : "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            io.stderr(`invisible-dots: ${file} already exists; use --force to overwrite it\n`);
            return EXIT.failed;
          }
          throw error;
        }
        io.stdout(`wrote ${file}\n`);
        const health = await (await api()).health();
        io.stdout(`server ${baseUrl} is reachable (version ${health.version}, database ${health.database})\n`);
        io.stdout(`edit the file, then: invisible-dots create ${args[0] ?? "dot.yaml"}\n`);
        return EXIT.ok;
      }
      case "create": {
        const file = resolve(io.cwd, need(args, 0, "<file.yaml>"));
        let yaml: string;
        try {
          yaml = await readFile(file, "utf8");
        } catch (error) {
          throw new UsageError(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
        }
        const dot = await (await api()).createDot(yaml);
        out(dot, `created Dot ${dot.name} (${dot.id}); its computer is being provisioned.\nfollow it with: invisible-dots logs ${dot.name}\n`);
        return EXIT.ok;
      }
      case "list": {
        const dots = await (await api()).listDots();
        out(dots, dotRows(dots));
        return EXIT.ok;
      }
      case "status": {
        const name = need(args, 0, "<dot>");
        const c = await api();
        const [dot, computer, tasks] = await Promise.all([c.getDot(name), c.computer(name), c.listTasks(name)]);
        const text =
          pad([
            ["name", dot.name],
            ["id", dot.id],
            ["status", dot.status + (dot.error ? ` (${dot.error})` : "")],
            ["model", dot.config.model.id],
            ["computer", `${computer.state}${computer.ready ? ", ready" : ""}${computer.last_error ? ` (last error: ${computer.last_error})` : ""}`],
            ["resources", `${dot.config.computer.cpu} cpu, ${dot.config.computer.memory} memory, ${dot.config.computer.disk} disk, idle_timeout ${dot.config.computer.idle_timeout}`],
            ["last active", computer.last_active_at ?? "never"],
            ["next automation", nextAutomation(computer)],
          ]) +
          "\n" +
          taskRows(tasks.slice(0, 10));
        out({ dot, computer, tasks }, text);
        return EXIT.ok;
      }
      case "message": {
        const name = need(args, 0, "<dot>");
        const text = args.slice(1).join(" ");
        if (!text.trim()) throw new UsageError("missing <text>");
        const answer = await (await api()).sendMessage(name, text);
        out(
          answer,
          answer.delivery === "delivered"
            ? `message delivered (${answer.message_id})\n`
            : `message queued (${answer.message_id}): the Dot's computer is starting and gets it once READY\n`,
        );
        return EXIT.ok;
      }
      case "task": {
        const name = need(args, 0, "<dot>");
        const description = args.slice(1).join(" ");
        if (!description.trim()) throw new UsageError("missing <description>");
        let priority: number | undefined;
        if (values.priority !== undefined) {
          priority = Number(values.priority);
          if (!Number.isInteger(priority)) throw new UsageError("--priority must be an integer");
        }
        if (values.at !== undefined && Number.isNaN(new Date(values.at).getTime())) {
          throw new UsageError("--at must be an ISO 8601 time, e.g. 2026-10-03T08:00:00Z");
        }
        const task = await (await api()).createTask(name, {
          description,
          ...(priority !== undefined ? { priority } : {}),
          ...(values.at !== undefined ? { scheduled_at: new Date(values.at).toISOString() } : {}),
        });
        out(task, `queued task ${task.id}\n`);
        return EXIT.ok;
      }
      case "tasks": {
        const tasks = await (await api()).listTasks(need(args, 0, "<dot>"));
        out(tasks, taskRows(tasks));
        return EXIT.ok;
      }
      case "computer": {
        const name = need(args, 0, "<dot>");
        const action = need(args, 1, "start|stop|reboot");
        const c = await api();
        if (action === "start") await c.startComputer(name);
        else if (action === "stop") await c.stopComputer(name);
        else if (action === "reboot") await c.rebootComputer(name);
        else throw new UsageError(`unknown computer action "${action}": use start, stop or reboot`);
        const note = action === "stop" ? `automations are paused while the computer is stopped; resume them with: invisible-dots computer ${name} start\n` : "";
        out({ accepted: true }, `${action} requested; follow it with: invisible-dots logs ${name}\n${note}`);
        return EXIT.ok;
      }
      case "browser": {
        const name = need(args, 0, "<dot>");
        const what = need(args, 1, "identities");
        if (what !== "identities") throw new UsageError(`unknown browser subcommand "${what}": use identities`);
        const identities = await (await api()).listIdentities(name);
        out(
          identities,
          identities.length === 0
            ? "no browser identities\n"
            : pad([
                ["ID", "NAME", "STATUS", "LAST USED", "PROXY"],
                ...identities.map((i) => [i.id, i.name, i.status, i.lastUsedAt ?? "never", i.hasProxy ? "yes" : "-"]),
              ]),
        );
        return EXIT.ok;
      }
      case "approvals": {
        const approvals = await (await api()).listApprovals(values.all ? undefined : "pending");
        out(
          approvals,
          approvals.length === 0
            ? values.all
              ? "no approvals\n"
              : "no pending approvals\n"
            : pad([
                ["ID", "STATUS", "DOT", "TOOL", "REASON"],
                ...approvals.map((a) => [a.id, a.status, a.dot_id, a.tool, oneLine(a.reason)]),
              ]),
        );
        return EXIT.ok;
      }
      case "approve":
      case "reject": {
        const id = need(args, 0, "<approval-id>");
        const c = await api();
        if (values.always && command === "reject") throw new UsageError("--always applies to approve, not to reject");
        const note = values.note === undefined ? {} : { note: values.note };
        const approval =
          command === "approve"
            ? await c.approve(id, { ...note, ...(values.always ? { always: true as const } : {}) })
            : await c.reject(id, note);
        out(approval, `approval ${approval.id} ${approval.status}\n`);
        return EXIT.ok;
      }
      case "mcp": {
        const name = need(args, 0, "<dot>");
        const c = await api();
        const secrets = await c.mcpSecrets(name);
        let tools: ToolListAnswer | null = null;
        try {
          tools = await c.listTools(name);
        } catch (error) {
          // A stopped computer has no engine to ask where the servers are; their secrets are the host's.
          if (!(error instanceof ApiError && error.code === COMPUTER_STOPPED)) throw error;
        }
        out({ mcp_servers: tools?.mcp_servers ?? null, secrets: secrets.secrets }, mcpRows(tools, secrets));
        return EXIT.ok;
      }
      case "secret": {
        const kind = need(args, 0, "openrouter|proxy|mcp");
        if (kind === "mcp") {
          if (values.dot === undefined || values.dot === "") throw new UsageError("missing --dot <dot>");
          const server = need(args, 1, "<server>");
          const secretName = need(args, 2, "<name>");
          if (args.length > 3) throw new UsageError("the secret is read from stdin, never from arguments (they end up in shell history and ps)");
          const command = `invisible-dots secret mcp --dot ${values.dot} ${server} ${secretName}`;
          const value = values.clear ? null : await secretFromInput(io, { prompt: `value of ${secretName} for the MCP server ${server}`, noun: "secret", command, spaces: true });
          const result = await (await api()).setMcpSecret(values.dot, server, secretName, value);
          out(result, `${secretName} of the MCP server ${server} ${value === null ? "cleared" : "stored"} for Dot ${result.dot_id}; a running Dot starts the server again with it\n`);
          return EXIT.ok;
        }
        if (kind === "proxy") {
          if (values.dot === undefined || values.dot === "") throw new UsageError("missing --dot <dot>");
          if (args.length > 1) throw new UsageError("the proxy is read from stdin, never from arguments (they end up in shell history and ps)");
          const proxy = values.clear ? null : await secretFromInput(io, { prompt: "VM proxy (socks5://user:pass@host:port)", noun: "proxy", command: `invisible-dots secret proxy --dot ${values.dot}` });
          const result = await (await api()).setVmProxy(values.dot, proxy);
          out(result, result.proxy ? `VM proxy stored for Dot ${result.dot_id}; it is used from the Dot's next start\n` : `Dot ${result.dot_id} goes out directly from its next start\n`);
          return EXIT.ok;
        }
        if (kind !== "openrouter") throw new UsageError(`unknown secret "${kind}": openrouter, proxy or mcp`);
        if (args.length > 1) {
          throw new UsageError("the key is read from stdin, never from arguments (they end up in shell history and ps)");
        }
        const key = await secretFromInput(io, { prompt: "OpenRouter API key", noun: "key", command: STORE_OPENROUTER_KEY });
        const result = await (await api()).setOpenRouterKey(key, values.dot);
        out(
          result,
          `OpenRouter key stored ${values.dot ? `for Dot ${values.dot}` : "for every Dot"}; pushed to ${result.pushed} running Dot${result.pushed === 1 ? "" : "s"}\n`,
        );
        return EXIT.ok;
      }
      case "channel": {
        const what = need(args, 0, "add|link|list|pair|remove");
        const dotName = () => {
          if (values.dot === undefined || values.dot === "") throw new UsageError("missing --dot <dot>");
          return values.dot;
        };
        switch (what) {
          case "add": {
            const kind = need(args, 1, "telegram");
            if (kind !== "telegram") {
              throw new UsageError(`cannot add "${kind}" with a token: only telegram is supported there; WhatsApp is linked with "invisible-dots channel link whatsapp --dot <dot>"`);
            }
            if (args.length > 2) throw new UsageError("the token is read from stdin, never from arguments (they end up in shell history and ps)");
            const name = dotName();
            const token = await secretFromInput(io, { prompt: "Telegram bot token from @BotFather", noun: "token", command: addTelegramChannel(name) });
            const channel = await (await api()).putTelegramChannel(name, token);
            out(
              channel,
              `linked Telegram bot @${channel.account ?? "?"} to Dot ${name}\n` +
                `next: invisible-dots channel pair telegram --dot ${name}\n` +
                "note: Telegram chats are not end-to-end encrypted; Telegram can read what you and the Dot write there.\n",
            );
            return EXIT.ok;
          }
          case "link": {
            const kind = need(args, 1, "whatsapp");
            if (kind !== "whatsapp") throw new UsageError(`cannot link "${kind}" by scanning a code: only whatsapp is linked that way; telegram takes a token ("invisible-dots channel add telegram --dot <dot>")`);
            if (args.length > 2) throw new UsageError("channel link takes only the channel and --dot <dot>");
            const name = dotName();
            const c = await api();
            await c.linkWhatsApp(name);
            io.stderr(
              "WhatsApp: this links the number as a device of a personal account through an unofficial client, which WhatsApp can answer by banning the account. Use a number of its own, not the one you live on.\n" +
                "On the phone: WhatsApp > Settings > Linked devices > Link a device, then scan the code below (it is replaced every few seconds).\n",
            );
            for await (const frame of c.whatsappLink(name, { signal: io.signal })) {
              if (values.json) io.stdout(`${JSON.stringify(frame)}\n`);
              if (frame.state === "code") {
                if (!values.json) io.stdout(`${await QRCode.toString(frame.code, { type: "terminal", small: true })}\n`);
              } else if (frame.state === "linked") {
                if (!values.json) {
                  io.stdout(`linked WhatsApp${frame.account ? ` number +${frame.account}` : ""} to Dot ${name}\nnext: invisible-dots channel pair whatsapp --dot ${name}\n`);
                }
                return EXIT.ok;
              } else if (frame.state === "failed") {
                io.stderr(`invisible-dots: ${frame.detail}\n`);
                return EXIT.failed;
              } else if (frame.detail && !values.json) {
                io.stderr(`${frame.detail}; trying again\n`);
              }
            }
            io.stderr("invisible-dots: stopped before the link finished\n");
            return EXIT.failed;
          }
          case "list": {
            noArguments(args.slice(1), "channel list");
            const c = await api();
            const dots = values.dot === undefined ? await c.listDots() : [await c.getDot(values.dot)];
            const rows = (await Promise.all(dots.map(async (d) => (await c.channels(d.id)).map((channel) => ({ dot: d.name, channel }))))).flat();
            out(rows, channelRows(rows));
            return EXIT.ok;
          }
          case "pair": {
            const kind = channelKind(need(args, 1, "telegram"));
            const name = dotName();
            const pairing = await (await api()).pairChannel(name, kind);
            out(
              pairing,
              pairing.deep_link
                ? `open this link on the device where you use ${kind}, then ${PAIRING_WORDS[kind].action} (valid until ${pairing.expires_at}):\n  ${pairing.deep_link}\nor send ${PAIRING_WORDS[kind].to}: ${pairing.message}\n`
                : `pairing code ${pairing.code}, valid until ${pairing.expires_at}\n`,
            );
            return EXIT.ok;
          }
          case "remove": {
            const kind = channelKind(need(args, 1, "telegram"));
            const name = dotName();
            await (await api()).removeChannel(name, kind);
            out({ removed: true }, `unlinked ${kind} from Dot ${name}: ${kind === "whatsapp" ? "the linked device's keys" : "its token"} and paired people are deleted\n`);
            return EXIT.ok;
          }
          default:
            throw new UsageError(`unknown channel subcommand "${what}": use add, link, list, pair or remove`);
        }
      }
      case "logs": {
        const name = need(args, 0, "<dot>");
        const tail = values.tail === undefined ? 20 : Number(values.tail);
        if (!Number.isInteger(tail) || tail < 0) throw new UsageError("--tail must be a non-negative integer");
        const c = await api();
        const dot = await c.getDot(name).catch((error: unknown) => {
          // A deleted Dot's events stay readable by id.
          if (error instanceof ApiError && error.status === 404 && name.includes("_")) return { id: name };
          throw error;
        });
        let recent: StoredEvent[] = [];
        let after = 0;
        for (;;) {
          const page = await c.events(dot.id, { after, limit: 1000 });
          recent = [...recent, ...page].slice(-Math.max(tail, 1));
          if (page.length < 1000) break;
          after = page.at(-1)!.id;
        }
        const last = recent.at(-1)?.id ?? after;
        for (const event of tail === 0 ? [] : recent) io.stdout(values.json ? `${JSON.stringify(event)}\n` : `${formatEvent(event)}\n`);
        if (values["no-follow"]) return EXIT.ok;
        for await (const event of c.stream({
          dotId: dot.id,
          after: last,
          signal: io.signal,
          onReconnect: ({ error }) => io.stderr(`connection lost (${error.message}), reconnecting...\n`),
        })) {
          io.stdout(values.json ? `${JSON.stringify(event)}\n` : `${formatEvent(event)}\n`);
        }
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`invisible-dots: ${error.message}\nRun "invisible-dots --help" for usage.\n`);
      return EXIT.usage;
    }
    if (error instanceof AuthSetupError) {
      io.stderr(`invisible-dots: ${error.message}\n`);
      return EXIT.auth;
    }
    if (error instanceof ApiError) {
      if (error.status === 0) {
        io.stderr(`invisible-dots: ${error.message}\nIs the server running (invisible-dots server)? Set ${ENV.URL} if it listens elsewhere.\n`);
        return EXIT.unreachable;
      }
      if (error.status === 401) {
        io.stderr(`invisible-dots: the server refused the API token (401); check ${ENV.TOKEN} or api.token\n`);
        return EXIT.auth;
      }
      io.stderr(`invisible-dots: ${error.message} [${error.status} ${error.code}]\n`);
      const details = error.details;
      if (Array.isArray(details)) {
        for (const issue of details as { path?: string; message?: string }[]) {
          io.stderr(`  ${issue.path ? `${issue.path}: ` : ""}${issue.message ?? ""}\n`);
        }
      }
      return EXIT.failed;
    }
    // Ctrl-C is how `logs` ends; for every other command it is an interruption.
    if (io.signal?.aborted && command === "logs") return EXIT.ok;
    io.stderr(`invisible-dots: ${(error as Error).message}\n`);
    return EXIT.failed;
  }
}
