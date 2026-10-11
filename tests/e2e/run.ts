/**
 * The end-to-end acceptance run of invisible_dots against real VMs on a real
 * accelerator (tests/e2e/README.md). It drives the product only from the
 * outside, the way a person does: the `invisible-dots` command and the HTTP
 * API of docs/architecture.md section 9.6 (and the web server's proxy of it),
 * plus reads of the documented host data directory (section 3.2). It imports
 * nothing from the workspace, so a product change cannot quietly change what
 * this run checks.
 *
 * Run with plain Node 24 (type stripping), from the repository root, after
 * `npm ci`, the builds and the dot-agentd binary (README):
 *
 *   INVISIBLE_DOTS_HOME=<dir> E2E_OPENROUTER_KEY_FILE=<file> node tests/e2e/run.ts
 *   ... node tests/e2e/run.ts --check        # step a only: what the run needs, no image, no VM
 *
 * The OpenRouter key is read from E2E_OPENROUTER_KEY_FILE and only ever
 * written to the stdin of `invisible-dots secret openrouter`; it is never
 * printed, logged or passed on a command line. Steps m and o look for it in
 * every log, database row and file the run leaves.
 *
 * Every output file goes to E2E_LOG_DIR (default tmp/e2e/<UTC time>, which git
 * ignores): the CLI calls, the server's output, the image build, the
 * screenshots and summary.json with each step's result and duration.
 *
 * What does not need a VM (the names this run relies on, its byte checks and
 * scans, its YAML) is in lib.ts, tested in CI by tests/repo/e2e.test.ts.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDED, MINUTE, Product, processAlive, say, sleep, waitFor } from "./driver.ts";
import {
  assert,
  describeTools,
  DOCTOR_CHECKS,
  dotName,
  dotYaml,
  enc,
  eventLines,
  Failure,
  filesHolding,
  filesUnder,
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
  rowsHolding,
  ROUTES,
  route,
  sha256File,
  sha256Text,
  taskEvents,
  toolCalls,
  toolOk,
  utcStamp,
  type AgentStateAnswer,
  type Approval,
  type CheckResult,
  type Computer,
  type Dot,
  type DotYamlOptions,
  type Identity,
  type StoredEvent,
  type Task,
} from "./lib.ts";

// Configuration

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAMP = utcStamp(new Date());
const HOME = resolve(process.env.INVISIBLE_DOTS_HOME?.trim() || join(homedir(), ".invisible-dots"));
const LOG_DIR = resolve(process.env.E2E_LOG_DIR?.trim() || join(REPO, "tmp", "e2e", STAMP));
const CLI = resolve(process.env.E2E_CLI?.trim() || join(REPO, "apps", "cli", "dist", "invisible-dots.mjs"));
const KEY_FILE = process.env.E2E_OPENROUTER_KEY_FILE?.trim();
const API_URL = (process.env.INVISIBLE_DOTS_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
const WEB_URL = `http://${process.env.INVISIBLE_DOTS_WEB_LISTEN?.trim() || "127.0.0.2:3000"}`;
/** E2E_WEB=0 runs the server without the web client (`server --no-web`) and skips what needs it. */
const WEB = process.env.E2E_WEB?.trim() !== "0";
/** A paid model: step e requires the spend it reports to be above zero. */
const MODEL = process.env.E2E_MODEL?.trim() || "z-ai/glm-5.3-flash";
const CHECK_ONLY = process.argv.includes("--check");
/** Dots this run creates are named with this prefix, so a later run can remove what a failed one left. */
const DOT_PREFIX = "e2e-";
const DOT_NAME = dotName(DOT_PREFIX, STAMP);

const TIMEOUTS = {
  cli: 2 * MINUTE,
  /** Downloads the cloud image and the browser engine and provisions a builder VM. */
  imageBuild: 90 * MINUTE,
  server: 2 * MINUTE,
  ready: 15 * MINUTE,
  task: 15 * MINUTE,
  stop: 3 * MINUTE,
  delete: 3 * MINUTE,
  /** A killed VM is noticed, recorded and started again by the control plane, and its engine comes up. */
  recover: 10 * MINUTE,
  /** A guest event reaches the host's log through the scheduler's pump, a moment after the route that caused it has answered. */
  pump: 30_000,
};

/** What every OpenRouter key starts with; the journal checks search the guest for it. */
const KEY_PREFIX = "sk-or-";
const PHRASE = "blue-harbor-42";
/** The title of https://example.com, which step e writes into title.txt and remembers. */
const TITLE = "Example Domain";
const WORKSPACE = "/home/dot/workspace";
const MEMORY_NOTE = "example-title.md";
const BROWSERS = "/home/dot/browsers";
/** A secret of an MCP server, set in step m through the CLI; steps n and p look for it as for the key. */
const MCP_SECRET = `mcp-e2e-${randomBytes(12).toString("hex")}`;

// The product, driven from the outside (driver.ts)

const product = new Product({ repo: REPO, home: HOME, logDir: LOG_DIR, cli: CLI, apiUrl: API_URL, webUrl: WEB_URL, web: WEB, timeouts: TIMEOUTS });
const {
  cli,
  cliJson,
  startServer,
  stopServer,
  raw,
  request,
  api,
  refusal,
  events,
  identities,
  computerOf,
  waitReady,
  waitComputerState,
  waitDeleted,
  waitTask,
  guestRequest,
  guestExec,
} = product;

async function identityNamed(dotId: string, name: string): Promise<Identity> {
  const found = (await identities(dotId)).find((i) => i.name === name);
  assert(found, `GET browser-identities does not list ${name}`);
  return found;
}

/** Queues a task through the CLI. */
async function queueTask(description: string): Promise<Task> {
  return cliJson<Task>(["task", DOT_NAME, description]);
}

/** Queues a task and waits for it to end; a task that does not complete fails the step. */
async function runTask(description: string): Promise<Task> {
  return waitTask((await queueTask(description)).id);
}

/** The approval a running task parks on, for the tool named; the task must not end first. */
async function waitApproval(taskId: string, tool: string): Promise<Approval> {
  const approval = await waitFor(`an approval request of ${tool}`, TIMEOUTS.task, async () => {
    const task = await api<Task>("GET", route(ROUTES.task, { id: taskId }));
    assert(!ENDED.includes(task.status), `the task ended ${task.status} without asking: ${task.summary ?? task.error}`);
    const pending = (await api<{ approvals: Approval[] }>("GET", route(ROUTES.approvals, {}, { status: "pending" }))).approvals;
    return pending.find((a) => a.task_id === taskId && a.tool === tool);
  }, 3000);
  const waiting = await api<Task>("GET", route(ROUTES.task, { id: taskId }));
  assert(waiting.status === "WAITING_APPROVAL", `the task is ${waiting.status} while its approval is pending`);
  return approval;
}

async function approve(approvalId: string, note?: string, options: { always?: boolean } = {}): Promise<void> {
  const done = await cli(["approve", approvalId, ...(note ? ["--note", note] : []), ...(options.always ? ["--always"] : []), "--json"]);
  assert(done.code === 0, `invisible-dots approve exited with ${done.code}: ${done.stderr.trim()}`);
}

async function reject(approvalId: string, note: string): Promise<void> {
  const done = await cli(["reject", approvalId, "--note", note, "--json"]);
  assert(done.code === 0, `invisible-dots reject exited with ${done.code}: ${done.stderr.trim()}`);
}

async function sendMessage(text: string): Promise<string> {
  return (await cliJson<{ message_id: string }>(["message", DOT_NAME, text])).message_id;
}

async function waitReply(dotId: string, messageId: string): Promise<StoredEvent> {
  return waitFor(`the reply to ${messageId}`, TIMEOUTS.task, async () => {
    return (await events(dotId)).find((e) => e.type === "message.assistant" && e.data.in_reply_to === messageId);
  }, 3000);
}

/** Rewrites the Dot's config (it is pushed to the guest at once): every step names the whole config it needs. */
async function configure(options: Pick<DotYamlOptions, "permissions" | "mcpServers"> = {}): Promise<void> {
  await api("PATCH", route(ROUTES.dot, { id: state.dotId! }), { config: dotYaml({ name: DOT_NAME, model: MODEL, ...options }) });
}

async function doctor(): Promise<{ code: number | null; checks: Map<string, CheckResult> }> {
  const result = await cli(["doctor", "--json"], { timeoutMs: 3 * MINUTE });
  const report = JSON.parse(result.stdout) as { ok: boolean; checks: CheckResult[] };
  return { code: result.code, checks: new Map(report.checks.map((check) => [check.id, check])) };
}

function expectChecks(checks: Map<string, CheckResult>, ids: readonly string[]): void {
  for (const id of ids) {
    const check = checks.get(id);
    assert(check, `doctor has no "${id}" check`);
    assert(check.status === "ok", `doctor: ${id} is ${check.status}: ${check.detail}`);
  }
}

// The guest, reached the way the control plane reaches it (architecture section 5.1)

/** The engine's own state, through dot-agentd's proxy to its socket (`GET /v1/agent/state`). */
async function agentState(dotId: string): Promise<AgentStateAnswer> {
  const response = await guestRequest(dotId, "GET", "/v1/agent/state");
  assert(response.ok, `GET /v1/agent/state: ${response.status}`);
  return (await response.json()) as AgentStateAnswer;
}

/** What a file of the guest holds, without its trailing newlines (whether a model ends a file with one is not what is tested). */
async function guestText(dotId: string, path: string): Promise<string> {
  const read = await guestExec(dotId, `cat -- ${path}`);
  assert(read.exit_code === 0, `${path} cannot be read in the guest: ${read.stderr.trim()}`);
  return read.stdout.replace(/\n+$/, "");
}

async function guestSha256(dotId: string, path: string): Promise<string> {
  const read = await guestExec(dotId, `sha256sum -- ${path}`);
  assert(read.exit_code === 0, `${path} cannot be hashed in the guest: ${read.stderr.trim()}`);
  return /^[0-9a-f]{64}/.exec(read.stdout)![0];
}

/**
 * The identities that have a browser server running, read inside the guest: every process of the user dot whose
 * command line names invisible-playwright-mcp (the server, and the relay that started it), by the
 * INVISIBLE_MCP_SESSION_ID its environment holds, which is the identity's id. The brackets keep pgrep from
 * matching the shell that runs it.
 */
async function mcpSessions(dotId: string): Promise<string[]> {
  const read = await guestExec(
    dotId,
    "for p in $(pgrep -u dot -f 'invisible-playwright-mc[p]'); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^INVISIBLE_MCP_SESSION_ID=//p'; done | sort -u",
  );
  return read.stdout.split("\n").filter((line) => line !== "");
}

/**
 * Has the Dot run `command`, which ends by printing a sha256sum line, with its
 * exec tool, and returns the hash it answers with. The model only relays a
 * value it cannot make up: every caller compares it with a hash computed
 * somewhere the model has no hand in.
 */
async function hashTask(what: string, command: string): Promise<string> {
  const task = await runTask(`Run this exact command with the exec tool: ${command}\nThen answer with only the 64-character hash it printed.`);
  const all = await events(state.dotId!);
  assert(toolOk(all, task.id, "exec"), `the ${what} task did not run exec successfully (tools: ${describeTools(all, task.id)})`);
  const hash = /\b[0-9a-f]{64}\b/.exec(task.summary ?? "")?.[0];
  assert(hash, `the ${what} task's answer holds no SHA-256: ${JSON.stringify(task.summary)}`);
  return hash;
}

/**
 * Searches the guest's whole system journal for the key's prefix, inside the
 * guest, without giving the model any part of the key. The Dot's own exec
 * tool runs the command, so the journal is read as the user the model's
 * commands run as; the answer is the hash of "<count> <nonce>", which only
 * the command itself can produce for a count of 0.
 */
async function assertJournalClean(prefix: string, what: string): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  const hash = await hashTask("journal", journalCountCommand(prefix, nonce));
  assert(hash === journalCleanHash(nonce), `the guest journal holds ${what}, or the journal could not be read in full`);
}

// Stopping, starting and killing a computer

/**
 * `invisible-dots computer stop`, then proof that it was the clean shutdown
 * of section 3.4: the guest took the poweroff and QEMU exited on its own
 * (`forced: false` on the computer.stopped event), well within the 60 s
 * after which the control plane kills it. A broken poweroff route would
 * still reach STOPPED, through the kill, and pass every other check here.
 * Returns how long the stop took, in seconds.
 */
async function stopComputer(dotId: string, pid: number): Promise<number> {
  const started = Date.now();
  const mark = lastEventId(await events(dotId));
  const stopped = await cli(["computer", DOT_NAME, "stop"]);
  assert(stopped.code === 0, `invisible-dots computer stop exited with ${stopped.code}: ${stopped.stderr.trim()}`);
  await waitComputerState(dotId, "STOPPED", TIMEOUTS.stop);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  assert(!processAlive(pid), `QEMU pid ${pid} is still alive after STOPPED`);
  assert(!existsSync(join(HOME, "vms", dotId, "qemu.json")), "qemu.json is still there after STOPPED");
  const event = (await events(dotId)).filter((e) => e.id > mark && e.type === "computer.stopped").at(-1);
  assert(event, "no computer.stopped event");
  assert(event.data.forced === false, `the stop was not clean: computer.stopped says ${JSON.stringify(event.data)}`);
  assert(seconds < 45, `the clean stop took ${seconds} s, close to the 60 s after which QEMU is killed`);
  return seconds;
}

/**
 * The computer is killed with SIGKILL, the way a power cut ends it: nothing
 * of the engine inside gets to shut down. The engine cannot be killed alone
 * from outside, by design (it runs as dotengine, dot-agentd as dotagentd and the
 * model's commands as dot, and no rule lets one end another), so the VM is what
 * dies. The control plane must notice, record `computer.stopped` with
 * `reason: "exited"`, and, because the Dot still has a task, start the
 * computer again by itself (architecture section 9.5). Returns when the new
 * computer is READY.
 */
async function killComputerAndWaitRecovered(dotId: string): Promise<Computer> {
  const before = await computerOf(dotId);
  assert(before.pid && processAlive(before.pid), `QEMU pid ${before.pid} is not alive to be killed`);
  const mark = lastEventId(await events(dotId));
  process.kill(before.pid, "SIGKILL");
  await waitFor("the control plane to record the stop of the killed VM", TIMEOUTS.stop, async () => {
    return (await events(dotId)).find((e) => e.id > mark && e.type === "computer.stopped" && e.data.reason === "exited");
  }, 1000);
  const recovered = await waitFor("the control plane to start the computer again and the Dot to be READY", TIMEOUTS.recover, async () => {
    const computer = await computerOf(dotId);
    const dot = await api<Dot>("GET", route(ROUTES.dot, { id: dotId }));
    assert(dot.status !== "ERROR", `the Dot went to ERROR after its VM was killed: ${dot.error ?? "(no error)"}`);
    return computer.ready && dot.status === "READY" && computer.pid !== null && computer.pid !== before.pid ? computer : undefined;
  }, 3000);
  state.pid = recovered.pid!;
  return recovered;
}

// The run

interface StepResult {
  step: string;
  title: string;
  ok: boolean;
  seconds: number;
  detail: string;
}

const results: StepResult[] = [];

async function step(id: string, title: string, body: () => Promise<string>): Promise<void> {
  say(`step ${id}: ${title}`);
  const started = Date.now();
  try {
    const detail = await body();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push({ step: id, title, ok: true, seconds, detail });
    say(`step ${id}: PASS in ${seconds} s${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ step: id, title, ok: false, seconds, detail });
    say(`step ${id}: FAIL after ${seconds} s: ${detail}`);
    throw error;
  } finally {
    await saveEvents();
  }
}

/**
 * The Dot's whole event log as events.txt, one line per event, rewritten
 * after every step: the evidence of what the Dot did, kept even when a step
 * fails.
 */
async function saveEvents(): Promise<void> {
  if (!state.dotId || !product.serverRunning) return;
  try {
    await writeFile(join(LOG_DIR, "events.txt"), `${eventLines(await events(state.dotId)).join("\n")}\n`);
  } catch (error) {
    say(`could not save the event log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Shared between steps. */
const state: {
  key?: string;
  dotId?: string;
  pid?: number;
  identity?: Identity;
  seedHash?: string;
  rememberedMessageId?: string;
} = {};

const SEED_FILE = (identity: Identity) => `${identity.profilePath.replace(/\/+$/, "")}/.stealth-identity.json`;

/** An ELF header's machine field (x86-64) and class (64-bit): what dot-agentd must be to run in the guest. */
async function assertLinuxAmd64Elf(path: string): Promise<string> {
  const file = await open(path, "r").catch(() => undefined);
  assert(file, `${path} does not exist: build dot-agentd first (README)`);
  try {
    const header = Buffer.alloc(20);
    await file.read(header, 0, 20, 0);
    const elf = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    assert(elf && header[4] === 2 && header.readUInt16LE(18) === 0x3e, `${path} is not a linux/amd64 ELF: build it with CGO_ENABLED=0 GOOS=linux GOARCH=amd64 (README)`);
  } finally {
    await file.close();
  }
  return `${Math.round((await stat(path)).size / 2 ** 20)} MiB`;
}

/** Whether something already answers HTTP at `url` (a server of an earlier run, another program). */
async function answers(url: string): Promise<boolean> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) }).then(
    (response) => response.body?.cancel().then(() => true, () => true) ?? true,
    () => false,
  );
}

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  product.logCliTo(join(LOG_DIR, "cli.log"));
  say(`home ${HOME}, logs ${LOG_DIR}, Dot ${DOT_NAME}, model ${MODEL}, web ${WEB ? WEB_URL : "off"}${CHECK_ONLY ? ", --check" : ""}`);

  await step("a", "host: key, binaries, ports, doctor (accelerator and QEMU)", async () => {
    assert(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node} is older than 24`);
    assert(process.platform === "linux", "this run is for a Linux host (README, \"Linux only\")");
    assert(existsSync(CLI), `${CLI} does not exist: build it first (npm run build --workspace @invisible-dots/cli)`);
    const version = await cli(["--version"]);
    assert(version.code === 0, `${CLI} --version exited with ${version.code}: ${version.stderr.trim()}`);
    assert(KEY_FILE, "set E2E_OPENROUTER_KEY_FILE to a file holding the OpenRouter key");
    const keyText = await readFile(KEY_FILE, "utf8").catch((error: NodeJS.ErrnoException) => {
      throw new Failure(`cannot read ${KEY_FILE}: ${error.code ?? error.message}`);
    });
    state.key = keyFromFile(keyText, KEY_FILE, KEY_PREFIX);
    const agentd = await assertLinuxAmd64Elf(join(REPO, "guest", "dot-agentd", "bin", "dot-agentd"));
    assert(!(await answers(`${API_URL}${ROUTES.health}`)), `something already answers at ${API_URL}: stop that server, or set INVISIBLE_DOTS_LISTEN and INVISIBLE_DOTS_URL together`);
    assert(!WEB || !(await answers(WEB_URL)), `something already answers at ${WEB_URL}: stop it, or set INVISIBLE_DOTS_WEB_LISTEN, or run with E2E_WEB=0`);
    const { checks } = await doctor();
    const needed = DOCTOR_CHECKS.filter((id) => ["node", "qemu", "qemu-img", "accelerator", "accelerator-probe", "disk", ...(WEB ? ["web"] : [])].includes(id));
    expectChecks(checks, needed);
    const accel = checks.get("accelerator-probe")!.detail;
    assert(/kvm/.test(accel), `the accelerator probe did not use kvm: ${accel}`);
    return `${checks.get("qemu")!.detail}; ${accel}; dot-agentd ${agentd}; key file ok`;
  });
  if (CHECK_ONLY) return;
  const key = state.key!;

  await step("b", "image build: golden image and runtime ISO", async () => {
    const buildLog = join(LOG_DIR, "image-build.log");
    say(`  progress: ${buildLog}`);
    const built = await cli(["image", "build"], { timeoutMs: TIMEOUTS.imageBuild, stream: buildLog });
    assert(built.code === 0, `invisible-dots image build exited with ${built.code}: ${built.stderr.trim().split("\n").slice(-5).join(" | ")}`);
    const imagesDir = join(HOME, "images");
    const names = (await readdir(imagesDir)).sort();
    const newest = (kind: string, ext: string) => names.filter((n) => n.startsWith(`${kind}-`) && n.endsWith(ext)).at(-1);
    const checked: string[] = [];
    for (const [kind, ext] of [["golden", ".qcow2"], ["runtime", ".iso"]] as const) {
      const image = newest(kind, ext);
      assert(image, `no ${kind} image in ${imagesDir}`);
      const manifestPath = join(imagesDir, image.slice(0, -ext.length) + ".json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { kind: string; file: string; sha256: string };
      assert(manifest.kind === kind && manifest.file === image, `${manifestPath} does not describe ${image}`);
      const actual = await sha256File(join(imagesDir, image));
      assert(actual === manifest.sha256, `${image} hashes to ${actual}, its manifest says ${manifest.sha256}`);
      checked.push(`${image} (${Math.round((await stat(join(imagesDir, image))).size / 2 ** 20)} MiB)`);
    }
    const { checks } = await doctor();
    expectChecks(checks, ["golden-image", "runtime-image"]);
    return checked.join(", ");
  });

  await step("c", "server (and the web client) in the background, OpenRouter key through the CLI", async () => {
    await startServer();
    // What an earlier failed run left: its Dots are removed so this run starts clean.
    const leftovers = (await api<{ dots: Dot[] }>("GET", ROUTES.dots)).dots.filter((d) => d.name.startsWith(DOT_PREFIX));
    for (const dot of leftovers) await api("DELETE", route(ROUTES.dot, { id: dot.id }));
    for (const dot of leftovers) await waitDeleted(dot.id, `leftover Dot ${dot.name} to be deleted`);
    const stored = await cli(["secret", "openrouter", "--json"], { stdin: `${key}\n` });
    assert(stored.code === 0, `invisible-dots secret openrouter exited with ${stored.code}: ${stored.stderr.trim()}`);
    const health = await api<{ openrouter_configured: boolean }>("GET", ROUTES.health);
    assert(health.openrouter_configured === true, "GET /api/health does not report the key as stored");
    let web = "web client off";
    if (WEB) {
      // The one command serves the web client too (architecture section 9.7), with no login: it listens on an
      // address no Dot's VM reaches and its proxy adds the API token itself.
      const home = await fetch(`${WEB_URL}/`, { signal: AbortSignal.timeout(30_000) });
      assert(home.status === 200 && (home.headers.get("content-type") ?? "").startsWith("text/html"), `${WEB_URL}/ answered ${home.status} ${home.headers.get("content-type")}`);
      const proxied = await fetch(`${WEB_URL}${ROUTES.health}`, { signal: AbortSignal.timeout(30_000) });
      assert(proxied.status === 200 && ((await proxied.json()) as { openrouter_configured?: boolean }).openrouter_configured === true, `the web proxy answered ${proxied.status}`);
      web = `web client at ${WEB_URL}: the pages, and the proxy reaches the API`;
    }
    return `server up; key stored; ${web}${leftovers.length ? `; removed ${leftovers.length} leftover Dot(s)` : ""}`;
  });

  await step("d", "create a Dot from YAML, READY, a chat reply with its spend", async () => {
    const file = join(LOG_DIR, "dot.yaml");
    await writeFile(file, dotYaml({ name: DOT_NAME, model: MODEL }));
    const dot = await cliJson<Dot>(["create", file]);
    state.dotId = dot.id;
    const { computer } = await waitReady(dot.id);
    assert(computer.state === "RUNNING" && computer.pid && computer.guest_port, `READY without a running QEMU: ${JSON.stringify(computer)}`);
    state.pid = computer.pid;
    const qemuJson = JSON.parse(await readFile(join(HOME, "vms", dot.id, "qemu.json"), "utf8")) as { pid: number; guest_port: number };
    assert(qemuJson.pid === computer.pid && qemuJson.guest_port === computer.guest_port, `qemu.json ${JSON.stringify(qemuJson)} disagrees with the computer record`);
    assert(processAlive(computer.pid), `QEMU pid ${computer.pid} is not alive`);
    const report = await doctor();
    expectChecks(report.checks, ["openrouter", "golden-image", "runtime-image"]);
    // Everything ok is exit 0; without the web client (E2E_WEB=0) the web build is the one check that may not be.
    if (WEB) assert(report.code === 0, `doctor exited with ${report.code} with everything in place`);
    state.rememberedMessageId = await sendMessage(`Remember this phrase for later in our conversation: ${PHRASE}. Do not use any tool. Reply with only OK.`);
    const reply = await waitReply(dot.id, state.rememberedMessageId);
    assert(isSpend(reply.data.spent_usd), `the chat reply carries no spend: ${JSON.stringify(reply.data)}`);
    // The engine up and holding the key: its own state, through dot-agentd.
    const engine = await waitFor("the engine to be IDLE after the reply", 60_000, async () => {
      const answer = await agentState(dot.id);
      return answer.state === "IDLE" ? answer : undefined;
    }, 1000);
    assert(engine.pending_approval === null, `the engine holds an approval after a chat reply: ${JSON.stringify(engine)}`);
    return `${dot.id} READY, QEMU pid ${computer.pid} on port ${computer.guest_port}; chat reply ${JSON.stringify(String(reply.data.text ?? "").slice(0, 40))}, spent ${String(reply.data.spent_usd)} USD`;
  });

  await step("e", "task: browser identity, explicit launch, example.com, file, memory note, progress, spend", async () => {
    const dotId = state.dotId!;
    const mark = lastEventId(await events(dotId));
    // The page's title, read from browser_snapshot's `title`: example.com's body has changed more than once (its <h1>
    // went, then the line that stood in for it), and a step that asks for a heading tests the site and the model's
    // reading of it. Its <title> has stayed "Example Domain".
    // The sentence before each call is what a `task.progress` event is made of.
    const task = await runTask(
      "Do these steps in order, one tool call at a time, and before each tool call write one short sentence saying what you are about to do.\n" +
        "1. Create a browser identity named research with browser_identity_create.\n" +
        "2. Open its browser with browser_identity_launch.\n" +
        "3. Open https://example.com in it with browser_navigate.\n" +
        "4. Read the page with browser_snapshot. Its answer has the page's title in its title field.\n" +
        `5. Write that title, and nothing else, into ${WORKSPACE}/title.txt with write_file.\n` +
        `6. Write that title, and nothing else, into /home/dot/memory/${MEMORY_NOTE} with write_file.\n` +
        "Then answer with only DONE.",
    );
    const all = await events(dotId);
    const mine = taskEvents(all, task.id);
    const research = await identityNamed(dotId, "research");
    state.identity = research;
    const created = identityEvents(all, "browser.identity.created", research.id, mark);
    const launched = identityEvents(all, "browser.identity.launched", research.id, mark);
    assert(created.length === 1 && created[0]!.data.name === "research", "no browser.identity.created event for research");
    assert(launched.length === 1, `${launched.length} browser.identity.launched events for research, not one`);
    assert(research.status === "open", `research is ${research.status} after the task, not open`);
    assert(research.profilePath === `${BROWSERS}/${research.id}/profile`, `research's profile is at ${research.profilePath}`);

    // Every tool ran, under the permission the table gives it, and the launch came before the first page action.
    const call = (tool: string) => {
      const found = toolCalls(all, task.id, tool);
      assert(found.some((e) => e.data.ok === true), `no successful ${tool} (tools: ${describeTools(all, task.id)})`);
      return found.find((e) => e.data.ok === true)!;
    };
    for (const [tool, permission] of [
      ["browser_identity_create", "browser.identity.create"],
      ["browser_identity_launch", "browser.identity.launch"],
      ["browser_navigate", "browser.navigate"],
      ["browser_snapshot", "browser.read"],
      ["write_file", "files.write"],
    ] as const) {
      const event = call(tool);
      assert(event.data.permission === permission && event.data.decision === "allow", `${tool} ran under ${String(event.data.permission)}/${String(event.data.decision)}, not ${permission}/allow`);
    }
    assert(launched[0]!.id < call("browser_navigate").id, "the page was opened before the identity was launched");
    assert(String(call("browser_navigate").data.target ?? "").startsWith(identityTarget(research.id, "https://example.com")), `browser_navigate's target is ${JSON.stringify(call("browser_navigate").data.target)}, not one that starts with ${JSON.stringify(identityTarget(research.id, "https://example.com"))}`);
    const writes = toolCalls(all, task.id, "write_file").filter((e) => e.data.ok === true).map((e) => String(e.data.target));
    assert(writes.includes(`${WORKSPACE}/title.txt`) && writes.includes(`/home/dot/memory/${MEMORY_NOTE}`), `write_file targets: ${JSON.stringify(writes)}`);

    // task.progress: the text written beside a tool call, once each, before the task completes.
    const progress = mine.filter((e) => e.type === "task.progress");
    assert(progress.length >= 1 && progress.every((e) => typeof e.data.text === "string" && String(e.data.text).trim() !== ""), `task.progress events: ${progress.length}`);
    const completed = mine.find((e) => e.type === "task.completed");
    assert(completed && progress.every((e) => e.id < completed.id), "a task.progress event is not before task.completed");

    // The files, by what the model's hash says and by what the host reads.
    const hash = await hashTask("title.txt hash", `printf '%s' "$(cat ${WORKSPACE}/title.txt)" | sha256sum`);
    assert(hash === sha256Text(TITLE), `title.txt does not hold exactly ${JSON.stringify(TITLE)} (the Dot hashed it to ${hash})`);
    assert((await guestText(dotId, `${WORKSPACE}/title.txt`)) === TITLE, "title.txt read from the host differs");
    assert((await guestText(dotId, `/home/dot/memory/${MEMORY_NOTE}`)) === TITLE, `the memory note does not hold ${JSON.stringify(TITLE)}`);
    state.seedHash = await guestSha256(dotId, SEED_FILE(research));

    // The spend: on the events, on the task and in the usage total, and they agree.
    assert(isSpend(completed.data.spent_usd) && completed.data.spent_usd > 0, `task.completed reports spend ${String(completed.data.spent_usd)} (use a paid model: E2E_MODEL)`);
    assert(isSpend(task.spent_usd) && Math.abs(task.spent_usd - Number(completed.data.spent_usd)) < 1e-9, `the task record says ${task.spent_usd} USD, task.completed ${String(completed.data.spent_usd)}`);
    const usage = await api<{ spent_usd: number }>("GET", route(ROUTES.usage, { id: dotId }));
    assert(usage.spent_usd >= task.spent_usd - 1e-9, `GET usage says ${usage.spent_usd} USD, less than the task's ${task.spent_usd}`);
    return `identity ${research.id} open; title.txt and the note hold exactly "${TITLE}"; ${progress.length} task.progress; seed ${state.seedHash.slice(0, 12)}...; spent ${task.spent_usd} USD (usage ${usage.spent_usd}); tools: ${describeTools(all, task.id)}`;
  });

  await step("f", "the desktop screenshot and the identity's frame, through the API and the web client", async () => {
    const dotId = state.dotId!;
    const shot = await request("GET", route(ROUTES.screenshot, { id: dotId }));
    assert(shot.headers.get("content-type")?.startsWith("image/png"), `screenshot content-type ${shot.headers.get("content-type")}`);
    const png = new Uint8Array(await shot.arrayBuffer());
    const picture = pngInfo(png);
    assert(!picture.blank, "the desktop screenshot is blank");
    await writeFile(join(LOG_DIR, "screenshot.png"), png);

    const research = state.identity!;
    const frameRoute = route(ROUTES.frame, { id: dotId, identityId: research.id });
    const frame = await request("GET", frameRoute);
    assert(frame.headers.get("content-type")?.startsWith("image/jpeg"), `frame content-type ${frame.headers.get("content-type")}`);
    const jpeg = new Uint8Array(await frame.arrayBuffer());
    const size = jpegSize(jpeg);
    assert(size.width >= 200 && size.height >= 200, `the frame is ${size.width}x${size.height}`);
    await writeFile(join(LOG_DIR, "frame.jpg"), jpeg);
    let viaWeb = "";
    if (WEB) {
      const proxied = await fetch(`${WEB_URL}${frameRoute}`, { signal: AbortSignal.timeout(60_000) });
      assert(proxied.status === 200 && proxied.headers.get("content-type")?.startsWith("image/jpeg"), `the frame through the web client: ${proxied.status} ${proxied.headers.get("content-type")}`);
      jpegSize(new Uint8Array(await proxied.arrayBuffer()));
      viaWeb = ", and the same through the web client";
    }
    return `desktop ${picture.width}x${picture.height} PNG, not blank; frame of ${research.id} ${size.width}x${size.height} JPEG (${jpeg.byteLength} bytes)${viaWeb}`;
  });

  await step("g", "approval: files.write is ask; approve, reject, and approve always through the CLI", async () => {
    const dotId = state.dotId!;
    await configure({ permissions: { "files.write": "ask" } });
    const task = await queueTask(`Write the text approved-write, and nothing else, into ${WORKSPACE}/approval.txt with the write_file tool, then answer with only DONE.`);
    const approval = await waitApproval(task.id, "write_file");
    assert(approval.permission === "files.write", `the approval is for ${approval.permission}`);
    assert(approval.arguments.path === `${WORKSPACE}/approval.txt`, `the approval shows ${JSON.stringify(approval.arguments)}`);
    assert(taskEvents(await events(dotId), task.id).some((e) => e.type === "approval.requested"), "no approval.requested event");
    assert((await agentState(dotId)).pending_approval === approval.id, "the engine does not hold the approval the host lists");
    const missing = await guestExec(dotId, `test ! -e ${WORKSPACE}/approval.txt && echo missing`);
    assert(missing.stdout.trim() === "missing", "the file exists while its write waits for approval");
    await approve(approval.id);
    await waitTask(task.id);
    const all = await events(dotId);
    assert(all.some((e) => e.type === "approval.resolved" && e.data.approval_id === approval.id), "no approval.resolved event");
    assert(toolOk(all, task.id, "write_file"), `the approved write_file did not succeed (tools: ${describeTools(all, task.id)})`);
    assert((await guestText(dotId, `${WORKSPACE}/approval.txt`)) === "approved-write", "approval.txt does not hold exactly the approved text");

    // Rejected: the write never runs, and the task ends without the file.
    const refused = await queueTask(`Write the text rejected-write into ${WORKSPACE}/rejected.txt with the write_file tool. If the user rejects it, do not try again or any other way: answer with only REJECTED.`);
    const refusal = await waitApproval(refused.id, "write_file");
    await reject(refusal.id, "not this file");
    await waitFor(`task ${refused.id} to end after the rejection`, TIMEOUTS.task, async () => {
      const task = await api<Task>("GET", route(ROUTES.task, { id: refused.id }));
      return ENDED.includes(task.status) ? task : undefined;
    }, 3000);
    const afterRefusal = await events(dotId);
    assert(afterRefusal.some((e) => e.type === "approval.resolved" && e.data.approval_id === refusal.id && e.data.decision === "reject"), "no approval.resolved reject event");
    assert(!toolOk(afterRefusal, refused.id, "write_file"), `a rejected write_file ran (tools: ${describeTools(afterRefusal, refused.id)})`);
    const absent = await guestExec(dotId, `test ! -e ${WORKSPACE}/rejected.txt && echo absent`);
    assert(absent.stdout.trim() === "absent", "rejected.txt exists after its write was rejected");

    // Approved always: this write runs, and the next one runs without asking.
    const first = await queueTask(`Write the text always-write, and nothing else, into ${WORKSPACE}/always.txt with the write_file tool, then answer with only DONE.`);
    const always = await waitApproval(first.id, "write_file");
    await approve(always.id, undefined, { always: true });
    await waitTask(first.id);
    assert((await guestText(dotId, `${WORKSPACE}/always.txt`)) === "always-write", "always.txt does not hold exactly the approved text");
    const next = await runTask(`Write the text after-always, and nothing else, into ${WORKSPACE}/after-always.txt with the write_file tool, then answer with only DONE.`);
    const afterAlways = await events(dotId);
    assert(!taskEvents(afterAlways, next.id).some((e) => e.type === "approval.requested"), "a write asked again after it was approved always");
    assert(toolCalls(afterAlways, next.id, "write_file").some((e) => e.data.ok === true && e.data.decision === "allow"), `the write after always did not run as allowed (tools: ${describeTools(afterAlways, next.id)})`);
    assert((await guestText(dotId, `${WORKSPACE}/after-always.txt`)) === "after-always", "after-always.txt does not hold exactly the text");
    return `approval ${approval.id} approved, approval.txt holds exactly the approved text; ${refusal.id} rejected, nothing written; ${always.id} approved always, and the next write ran as allowed without asking`;
  });

  await step("h", "identities: no implicit launch, max_open evicts the least recently used, close and delete from the host", async () => {
    const dotId = state.dotId!;
    const research = state.identity!;
    const make = async (name: string): Promise<Identity> => {
      const made = await api<Identity>("POST", route(ROUTES.identities, { id: dotId }), { name });
      assert(made.status === "available" && made.profilePath === `${BROWSERS}/${made.id}/profile`, `a new identity is ${JSON.stringify(made)}`);
      return made;
    };
    const alpha = await make("alpha");
    const beta = await make("beta");
    const gamma = await make("gamma");
    const opened = async () => new Set((await identities(dotId)).filter((i) => i.status === "open").map((i) => i.id));
    assert((await opened()).size === 1 && (await opened()).has(research.id), "only research should be open before this step");

    // A page tool on an identity that is not open says so; it does not open it (so browser.identity.launch alone decides).
    const refusedAt = lastEventId(await events(dotId));
    const refused = await runTask(
      `Call browser_navigate once with identity_id ${alpha.id} and url https://example.com. Do not call browser_identity_launch or any other tool. Then answer with only the tool's error message.`,
    );
    const afterRefused = await events(dotId);
    const navigations = toolCalls(afterRefused, refused.id, "browser_navigate");
    assert(navigations.length === 1 && navigations[0]!.data.ok === false, `browser_navigate on a closed identity: ${describeTools(afterRefused, refused.id)}`);
    assert(toolCalls(afterRefused, refused.id, "browser_identity_launch").length === 0, "the model launched the identity, so the refusal was not tested");
    assert(identityEvents(afterRefused, "browser.identity.launched", alpha.id, refusedAt).length === 0, "browser_navigate launched a closed identity");
    assert((await opened()).size === 1, "an identity was opened by a page tool");

    // The engine keeps at most 3 open: the fourth launch closes the one used least recently, which is research.
    const lruAt = lastEventId(afterRefused);
    const lru = await runTask(
      `Call browser_identity_launch for the identity ${alpha.id}, then for the identity ${beta.id}, then for the identity ${gamma.id}, one call at a time. Then call browser_identity_list and answer with only the ids of the identities whose status is open, separated by commas.`,
    );
    const afterLru = await events(dotId);
    for (const id of [alpha.id, beta.id, gamma.id]) assert(identityEvents(afterLru, "browser.identity.launched", id, lruAt).length === 1, `no single browser.identity.launched for ${id}`);
    assert(identityEvents(afterLru, "browser.identity.closed", research.id, lruAt).length === 1, "research was not closed to make room (browser.identity.closed)");
    assert(identityEvents(afterLru, "browser.identity.closed", alpha.id, lruAt).length === 0, "the identity used last was closed instead of the oldest");
    const open = await opened();
    assert(open.size === 3 && open.has(alpha.id) && open.has(beta.id) && open.has(gamma.id), `open identities after the fourth launch: ${JSON.stringify([...open])}`);
    assert(toolOk(afterLru, lru.id, "browser_identity_list"), "browser_identity_list did not run");
    const answer = lru.summary ?? "";
    assert(answer.includes(alpha.id) && answer.includes(beta.id) && answer.includes(gamma.id) && !answer.includes(research.id), `the model listed the open identities as ${JSON.stringify(answer)}`);
    const servers = await mcpSessions(dotId);
    assert([...servers].sort().join() === [alpha.id, beta.id, gamma.id].sort().join(), `browser servers run for ${JSON.stringify(servers)}, the open identities are ${alpha.id}, ${beta.id} and ${gamma.id}`);

    // The host closes one: the profile stays, the frame says not_open.
    const closeAt = lastEventId(afterLru);
    await api("POST", route(ROUTES.closeIdentity, { id: dotId, identityId: beta.id }));
    assert((await identities(dotId)).find((i) => i.id === beta.id)?.status === "available", "beta is not available after POST close");
    // The event reaches the host through the pump, after the route has answered.
    await waitFor("browser.identity.closed for the host's close", TIMEOUTS.pump, async () => {
      const closed = identityEvents(await events(dotId), "browser.identity.closed", beta.id, closeAt);
      assert(closed.length <= 1, `${closed.length} browser.identity.closed for the host's close`);
      return closed.length === 1 ? true : undefined;
    }, 1000);
    const noFrame = await refusal("GET", route(ROUTES.frame, { id: dotId, identityId: beta.id }));
    assert(noFrame.status === 409 && noFrame.error === "not_open", `the frame of a closed identity answered ${noFrame.status} ${noFrame.error}`);
    await api("POST", route(ROUTES.closeIdentity, { id: dotId, identityId: beta.id }));

    // The host deletes an identity that is open: its browser ends, its directory goes.
    const deleteAt = lastEventId(await events(dotId));
    await api("DELETE", route(ROUTES.identity, { id: dotId, identityId: alpha.id }));
    // The events reach the host through the pump, in order, after the route has answered: once deleted is there, closed is too.
    const { closedAt, deletedAt } = await waitFor("browser.identity.deleted for the host's delete", TIMEOUTS.pump, async () => {
      const afterDelete = await events(dotId);
      const deleted = identityEvents(afterDelete, "browser.identity.deleted", alpha.id, deleteAt)[0];
      if (!deleted) return undefined;
      return { closedAt: identityEvents(afterDelete, "browser.identity.closed", alpha.id, deleteAt)[0], deletedAt: deleted };
    }, 1000);
    assert(closedAt && closedAt.id < deletedAt.id, "an open identity's delete must close it first, then report deleted");
    assert((await refusal("GET", route(ROUTES.identity, { id: dotId, identityId: alpha.id }))).status === 404, "a deleted identity is still found");
    const gone = await guestExec(dotId, `test ! -e ${BROWSERS}/${alpha.id} && echo gone`);
    assert(gone.stdout.trim() === "gone", `${BROWSERS}/${alpha.id} is still in the guest`);
    await api("DELETE", route(ROUTES.identity, { id: dotId, identityId: beta.id }));
    await api("DELETE", route(ROUTES.identity, { id: dotId, identityId: gamma.id }));
    await waitFor("every browser server to be gone", 60_000, async () => ((await mcpSessions(dotId)).length === 0 ? true : undefined), 1000);
    assert((await identities(dotId)).map((i) => i.id).join() === research.id, "research should be the only identity left");
    return `closed identity not launched by a page tool; the engine's max_open of 3 closed ${research.id} for the fourth launch; frame of a closed identity 409 not_open; host close, and host delete of an open identity, leave no browser server and no directory`;
  });

  await step("i", "approvals of identity create and delete: proxy masked, nothing deleted before the approval", async () => {
    const dotId = state.dotId!;
    const password = `pw-${randomBytes(6).toString("hex")}`;
    const proxy = `socks5://e2euser:${password}@127.0.0.1:9`;
    await configure({ permissions: { "browser.identity.create": "ask", "browser.identity.delete": "ask" } });
    const task = await queueTask(
      `Create a browser identity named disposable with the proxy ${proxy} using browser_identity_create. Then delete that identity with browser_identity_delete, using the id the creation gave. Then answer with only DONE.`,
    );
    const creating = await waitApproval(task.id, "browser_identity_create");
    assert(creating.permission === "browser.identity.create", `the creation asks under ${creating.permission}`);
    assert(proxyIsMasked(creating.arguments.proxy), `the approval shows the proxy as ${JSON.stringify(creating.arguments.proxy)}`);
    assert(!(await identities(dotId)).some((i) => i.name === "disposable"), "the identity exists while its creation waits for approval");
    await approve(creating.id);
    const deleting = await waitApproval(task.id, "browser_identity_delete");
    assert(deleting.permission === "browser.identity.delete", `the delete asks under ${deleting.permission}`);
    const target = (await identities(dotId)).find((i) => i.name === "disposable");
    assert(target && deleting.arguments.identity_id === target.id, `the delete approval names ${JSON.stringify(deleting.arguments)}, the identity is ${target?.id}`);
    assert(target.hasProxy === true && !("proxy" in target), `the host lists the identity as ${JSON.stringify(target)}: it should say only that it has a proxy`);
    assert((await guestExec(dotId, `test -d ${BROWSERS}/${target.id} && echo there`)).stdout.trim() === "there", "the identity's directory is gone while its delete waits for approval");
    await approve(deleting.id);
    await waitTask(task.id);
    const all = await events(dotId);
    assert(identityEvents(all, "browser.identity.deleted", target.id).length === 1, "no browser.identity.deleted event");
    assert(!(await identities(dotId)).some((i) => i.id === target.id), "the deleted identity is still listed");
    // What the product shows of the proxy: the approvals, the identity records and the call events hold no password.
    const shown = [
      ...all.filter((e) => ["approval.requested", "tool.called", "browser.identity.created", "browser.identity.deleted"].includes(e.type)),
      ...(await api<{ approvals: Approval[] }>("GET", route(ROUTES.approvals))).approvals,
      ...(await identities(dotId)),
    ];
    assert(rowsHolding(shown, Buffer.from(password, "utf8")) === 0, "the proxy password is in an approval, an identity record or a call event");
    await assertJournalClean(password.slice(0, 7), "the proxy password");
    await configure();
    return `create approval shows the proxy masked, delete approval names ${target.id}; both approved; the password is in no approval, identity record or call event, nor in the guest journal`;
  });

  await step("j", "stop, start, and everything is still there; the browser is closed on the way down and launched again", async () => {
    const dotId = state.dotId!;
    const research = state.identity!;
    const oldPid = state.pid!;

    // research open, as it would be left at night
    const relaunch = async (what: string): Promise<void> => {
      const task = await runTask(
        `With the existing browser identity whose id is ${research.id}: open its browser with browser_identity_launch if it is not open, open https://example.com in it with browser_navigate, and answer with only the page title. Do not create a new identity. (${what})`,
      );
      const all = await events(dotId);
      assert(toolOk(all, task.id, "browser_navigate"), `the ${what} task did not navigate (tools: ${describeTools(all, task.id)})`);
      assert((await identityNamed(dotId, "research")).status === "open", `research is not open after the ${what} task`);
    };
    await relaunch("before the stop");
    const beforeStop = lastEventId(await events(dotId));

    // The control plane restarts without stopping Dots, and adopts the running VM from its qemu.json (section 3.4).
    await stopServer();
    assert(processAlive(oldPid), `QEMU pid ${oldPid} exited with the server`);
    await startServer();
    const adopted = (await waitReady(dotId)).computer;
    assert(adopted.pid === oldPid, `after a server restart the computer names pid ${adopted.pid}, not the running ${oldPid}`);
    assert((await identityNamed(dotId, "research")).status === "open", "the server restart closed the open browser");

    const stopSeconds = await stopComputer(dotId, oldPid);
    const started = await cli(["computer", DOT_NAME, "start"]);
    assert(started.code === 0, `invisible-dots computer start exited with ${started.code}: ${started.stderr.trim()}`);
    const { computer } = await waitReady(dotId);
    state.pid = computer.pid!;
    const restartedAt = lastEventId(await events(dotId));

    // The stop closed the browser before the guest went down (prepare-sleep): the event reaches the host, at the latest after the restart.
    await waitFor("browser.identity.closed for research after the stop", 2 * MINUTE, async () => {
      return identityEvents(await events(dotId), "browser.identity.closed", research.id, beforeStop)[0];
    }, 2000);
    assert((await identityNamed(dotId, "research")).status === "available", "research is not merely available after a restart: a browser does not survive it");
    assert((await mcpSessions(dotId)).length === 0, "a browser server runs after the restart, before any launch");

    await relaunch("after the restart");
    assert(identityEvents(await events(dotId), "browser.identity.launched", research.id, restartedAt).length >= 1, "no browser.identity.launched for research after the restart");
    const seedHash = await guestSha256(dotId, SEED_FILE(research));
    assert(seedHash === state.seedHash, `the identity's .stealth-identity.json changed: ${state.seedHash} -> ${seedHash}`);
    assert((await guestText(dotId, `${WORKSPACE}/title.txt`)) === TITLE, "title.txt changed across the restart");
    assert((await guestText(dotId, `/home/dot/memory/${MEMORY_NOTE}`)) === TITLE, "the memory note changed across the restart");

    // A memory is a file: the Dot finds it with its file tools, after the restart too.
    const recall = await runTask(`Use the grep tool to search /home/dot/memory for ${TITLE} and answer with only the file name of the note that holds it.`);
    const all = await events(dotId);
    assert(toolOk(all, recall.id, "grep"), `no successful grep (tools: ${describeTools(all, recall.id)})`);
    assert((recall.summary ?? "").includes(MEMORY_NOTE), `grep answer: ${JSON.stringify(recall.summary)}`);

    const history = (await api<{ messages: { role: string; text: string }[] }>("GET", route(ROUTES.messages, { id: dotId }))).messages;
    assert(history.some((m) => m.role === "user" && m.text.includes(PHRASE)), "the conversation lost the first message");
    // The host's event log keeps the conversation anyway; the engine's own database is what the model answers from.
    const asked = await sendMessage("Which phrase did I ask you to remember earlier in this conversation? Do not use any tool. Reply with only the phrase.");
    const reply = await waitReply(dotId, asked);
    assert(String(reply.data.text ?? "").includes(PHRASE), `the Dot does not remember the conversation: ${JSON.stringify(reply.data.text)}`);

    // The guest's own logs, read inside the guest (journald compresses large entries, which a scan of the disk from outside would miss).
    await assertJournalClean(KEY_PREFIX, "the OpenRouter key's prefix");
    return (
      `server restart adopted pid ${oldPid}; graceful stop in ${stopSeconds} s, STOPPED then READY (new pid ${computer.pid}); ` +
      "the open browser was closed on the way down and launched again with the same seed file; title.txt, the note, memory search and the conversation kept; journal readable and without the key"
    );
  });

  await step("k", "the computer is killed while an approval waits; it comes back, the same approval is pending", async () => {
    const dotId = state.dotId!;
    const counter = `${WORKSPACE}/approval-counter.txt`;
    await guestExec(dotId, `rm -f ${counter}`);
    await configure({ permissions: { "computer.exec": "ask" } });
    const task = await queueTask(
      `Run this exact command with the exec tool: printf x >> ${counter}\nThen answer with only the note the user attached when approving the call, or NONE if there was none.`,
    );
    const approval = await waitApproval(task.id, "exec");
    assert(approval.permission === "computer.exec", `the approval is for ${approval.permission}`);
    const startedBefore = (await events(dotId)).filter((e) => e.type === "agent.started").length;

    const recovered = await killComputerAndWaitRecovered(dotId);
    await waitFor("the restarted engine to be up", TIMEOUTS.recover, async () => {
      return (await events(dotId)).filter((e) => e.type === "agent.started").length > startedBefore ? true : undefined;
    }, 2000);
    // The engine's own record, read through its socket: the same approval waits, and the host pushed the key again.
    const engine = await waitFor("the restarted engine to hold the approval", TIMEOUTS.recover, async () => {
      const answer = await agentState(dotId);
      return answer.pending_approval ? answer : undefined;
    }, 2000);
    assert(engine.pending_approval === approval.id, `after the restart the engine waits on ${engine.pending_approval}, not ${approval.id}`);
    const pending = (await api<{ approvals: Approval[] }>("GET", route(ROUTES.approvals, {}, { status: "pending" }))).approvals;
    assert(pending.some((a) => a.id === approval.id), "the host no longer lists the approval as pending");
    assert((await api<Task>("GET", route(ROUTES.task, { id: task.id }))).status === "WAITING_APPROVAL", "the task is not waiting for its approval after the restart");

    const note = `once-${randomBytes(3).toString("hex")}`;
    await approve(approval.id, note);
    const done = await waitTask(task.id);
    // The tool ran exactly once, which the counter file proves.
    assert((await guestText(dotId, counter)) === "x", "the approved command did not run exactly once");
    // The note followed the call's result into the model's next request: the model relays it.
    assert((done.summary ?? "").includes(note), `the note did not reach the model: the answer is ${JSON.stringify(done.summary)}`);
    return `VM killed (SIGKILL), recorded as exited and started again (pid ${recovered.pid}); the engine resumed from its database with ${approval.id} pending and the key pushed again; approved with a note, the command ran once and the note reached the model`;
  });

  await step("l", "the computer is killed during a command; the interrupted call is reported, not run again", async () => {
    const dotId = state.dotId!;
    const marker = `${WORKSPACE}/exec-marker.txt`;
    await configure();
    await guestExec(dotId, `rm -f ${marker}`);
    // A command long enough that the kill lands while it runs; it appends one line, once, at its end.
    const task = await queueTask(
      `Run this exact command with the exec tool: sleep 8; echo ran >> ${marker}\n` +
        "If the call is reported as interrupted, do not run it again: answer with only the word INTERRUPTED. Otherwise answer with only the word DONE.",
    );
    // Wait until the command is in flight (computer.exec is not replay-safe), then kill the computer.
    await waitFor("the command to be in flight", TIMEOUTS.task, async () => {
      const current = await api<Task>("GET", route(ROUTES.task, { id: task.id }));
      assert(!ENDED.includes(current.status), `the task ended ${current.status} before the command ran`);
      const probe = await guestExec(dotId, "pgrep -u dot -f 'sleep [8]' >/dev/null && echo yes || echo no");
      return probe.stdout.trim() === "yes" ? true : undefined;
    }, 500);
    await killComputerAndWaitRecovered(dotId);
    const done = await waitTask(task.id);
    const all = await events(dotId);
    const calls = toolCalls(all, task.id, "exec");
    assert(calls.some((e) => e.data.interrupted === true && e.data.ok === false), `no interrupted exec event for the task (tools: ${describeTools(all, task.id)})`);
    assert(calls.length === 1, `exec was called ${calls.length} times in the task, not once (tools: ${describeTools(all, task.id)})`);
    // The command died with the computer and nothing ran it again: once its 8 seconds would be over, no sleep is left and the marker was never written.
    await sleep(10_000);
    const after = await guestExec(dotId, `pgrep -u dot -f 'sleep [8]' >/dev/null && echo running || (wc -l < ${marker} 2>/dev/null || echo 0)`);
    assert(after.stdout.trim() === "0", `after the restart the command left "${after.stdout.trim()}", not 0 lines: it outlived its computer or ran again`);
    return `VM killed during exec; tool.called with interrupted: true for the call, which was not run again; the model answered ${JSON.stringify(done.summary)}`;
  });

  await step("m", "MCP servers: one runs as dot and asks before its tool, one waits for its secret, set through the CLI", async () => {
    const dotId = state.dotId!;
    // mcp-server-time through uvx, which the image has: the engine starts it at the config push, from PyPI the first time.
    const time = { command: "uvx", args: ["mcp-server-time", "--local-timezone", "Europe/Rome"] };
    await configure({ permissions: { "mcp.time": "ask" }, mcpServers: { time, keyed: { ...time, secrets: ["TIME_TOKEN"] } } });
    type ToolTable = { tools: { name: string; permission: string; offered: boolean }[]; mcp_servers: { name: string; state: string; error: string | null; tools: number }[] };
    const tableRoute = `/api/dots/${dotId}/tools`;
    const keyed = await waitFor("the keyed server to wait for its secret", 3 * MINUTE, async () => {
      const table = await api<ToolTable>("GET", tableRoute);
      return table.mcp_servers.find((s) => s.name === "keyed" && s.state === "failed");
    }, 2000);
    assert(String(keyed.error).includes("TIME_TOKEN is not set"), `the keyed server failed with ${JSON.stringify(keyed.error)}`);

    // A tool of the server asks (mcp.time: ask); always allowed, the next call runs without asking.
    const task = await queueTask("Use the time MCP server's get_current_time tool to get the current time in Asia/Tokyo, then answer with only the time as HH:MM.");
    const approval = await waitApproval(task.id, "mcp_time_get_current_time");
    assert(approval.permission === "mcp.time", `the approval is for ${approval.permission}`);
    await approve(approval.id, undefined, { always: true });
    await waitTask(task.id);
    const all = await events(dotId);
    const call = toolCalls(all, task.id, "mcp_time_get_current_time").find((e) => e.data.ok === true);
    assert(call && call.data.permission === "mcp.time", `no successful mcp_time_get_current_time under mcp.time (tools: ${describeTools(all, task.id)})`);
    const table = await api<ToolTable>("GET", tableRoute);
    const server = table.mcp_servers.find((s) => s.name === "time");
    assert(server?.state === "connected" && server.tools > 0, `the time server is ${JSON.stringify(server)}`);
    assert(table.tools.some((t) => t.name === "mcp_time_get_current_time" && t.permission === "mcp.time" && t.offered), "GET tools does not list the server's tool as offered");
    // It runs as dot, like every program of the model; only the engine's relay, which starts it, is another user's.
    const owner = await guestExec(dotId, "ps -eo user=,args= | grep 'mcp-server-tim[e]' | grep -v 'dot-agentd relay' | awk '{print $1}' | sort -u");
    assert(owner.stdout.trim() === "dot", `mcp-server-time runs as ${JSON.stringify(owner.stdout.trim())}, not dot`);

    // The secret, from stdin through the CLI; the server starts with it.
    const set = await cli(["secret", "mcp", "--dot", DOT_NAME, "keyed", "TIME_TOKEN", "--json"], { stdin: `${MCP_SECRET}\n` });
    assert(set.code === 0, `invisible-dots secret mcp exited with ${set.code}: ${set.stderr.trim()}`);
    assert(!set.stdout.includes(MCP_SECRET), "the CLI echoed the secret");
    const started = await waitFor("the keyed server to start with its secret", 3 * MINUTE, async () => {
      await runTask("Answer with only OK.");
      const now = await api<ToolTable>("GET", tableRoute);
      return now.mcp_servers.find((s) => s.name === "keyed" && s.state === "connected");
    }, 5000);
    const listed = await cli(["mcp", DOT_NAME]);
    assert(listed.code === 0 && /keyed\s+connected/.test(listed.stdout), `invisible-dots mcp says: ${listed.stdout}`);
    // The secret is in the server's environment, which only its own user reads, and on no command line.
    const environ = await guestExec(dotId, `for p in $(pgrep -u dot -f mcp-server-time); do tr '\\0' '\\n' < /proc/$p/environ; done | grep -c '^TIME_TOKEN=${MCP_SECRET}$' || true`);
    assert(Number(environ.stdout.trim()) >= 1, "no mcp-server-time process holds TIME_TOKEN in its environment");
    const cmdlines = await guestExec(dotId, `cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' | grep -c '${MCP_SECRET}' || true`);
    assert(cmdlines.stdout.trim() === "0", "the secret is on a command line");
    return `time connected with ${server.tools} tools, its tool asked under mcp.time and ran once always allowed (${String(call.data.target ?? "no target")}); keyed waited for TIME_TOKEN, then connected with ${started.tools} tools once it was set through the CLI; the secret is in its environment and on no command line`;
  });

  await step("n", "the key and the MCP secret are in none of the Dot's own files and rows", async () => {
    const dotId = state.dotId!;
    const needles = [Buffer.from(key.slice(0, 12), "utf8"), Buffer.from(MCP_SECRET, "utf8")];
    // The database stores large jsonb values compressed (TOAST), so a key in a long event would not show in its files
    // (step p): the rows are read back decompressed through the API, while the Dot's approvals still exist.
    const rows = [...(await events(dotId)), ...(await api<{ approvals: unknown[] }>("GET", route(ROUTES.approvals))).approvals];
    for (const needle of needles) assert(rowsHolding(rows, needle) === 0, "found in an event or approval row of the database");
    // Stopped first, so the guest has flushed its disk and QEMU has closed its files; scanned before step o deletes them.
    await stopComputer(dotId, state.pid!);
    await copyFile(join(HOME, "vms", dotId, "serial.log"), join(LOG_DIR, "serial.log")).catch(() => undefined);
    const files = [...(await filesUnder(join(HOME, "vms", dotId))), join(HOME, "logs", `qemu-${dotId}.log`)];
    // An empty or missing directory must not pass as "nothing found".
    for (const name of ["disk.qcow2", "seed.iso", "serial.log"]) {
      assert(files.includes(join(HOME, "vms", dotId, name)), `vms/${dotId}/${name} is not there to be scanned`);
    }
    assert(existsSync(join(HOME, "logs", `qemu-${dotId}.log`)), `logs/qemu-${dotId}.log is not there to be scanned`);
    const found = (await Promise.all(needles.map((needle) => filesHolding(files, needle)))).flat();
    // Only "found" or "not found", and where: never the key or any part of it.
    assert(found.length === 0, `found in ${found.length} file(s): ${found.join(", ")}`);
    const bytes = (await Promise.all(files.map((file) => stat(file)))).reduce((sum, s) => sum + s.size, 0);
    return (
      `not found in ${rows.length} event and approval rows, nor in ${files.length} files of the stopped Dot ` +
      `(${Math.round(bytes / 2 ** 20)} MiB: its overlay disk, seed, serial log and QEMU log)`
    );
  });

  await step("o", "delete the Dot", async () => {
    const dotId = state.dotId!;
    const pid = state.pid!;
    await api("DELETE", route(ROUTES.dot, { id: dotId }));
    await waitDeleted(dotId, "the Dot to be gone");
    await waitFor("the VM process to exit", 30_000, async () => (processAlive(pid) ? undefined : true), 500);
    assert(!existsSync(join(HOME, "vms", dotId)), `${join(HOME, "vms", dotId)} is still there`);
    assert((await events(dotId)).some((e) => e.type === "dot.deleted"), "no dot.deleted event");
    return `pid ${pid} gone, vms/${dotId} removed`;
  });

  await step("p", "the key and the MCP secret appear in no log and no database file", async () => {
    const needles = [Buffer.from(key.slice(0, 12), "utf8"), Buffer.from(MCP_SECRET, "utf8")];
    // Events outlive their Dot: read back once more, decompressed, after the delete.
    const rows = await events(state.dotId!);
    for (const needle of needles) assert(rowsHolding(rows, needle) === 0, "found in an event row of the database");
    await stopServer();
    const scanned = [
      ...(await filesUnder(LOG_DIR)),
      ...(await filesUnder(join(HOME, "logs"))),
      // The embedded database's files, for whatever is stored uncompressed.
      ...(await filesUnder(join(HOME, "db"))),
    ];
    const found = (await Promise.all(needles.map((needle) => filesHolding(scanned, needle)))).flat();
    // Only "found" or "not found", and where: never the key or any part of it.
    assert(found.length === 0, `found in ${found.length} file(s): ${found.join(", ")}`);
    return `not found in ${rows.length} event rows, nor in ${scanned.length} files (run logs, ${join(HOME, "logs")}, db)`;
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  if (!(error instanceof Failure) && !results.some((r) => !r.ok)) say(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await stopServer().catch(() => undefined);
  product.closeCliLog();
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(join(LOG_DIR, "summary.json"), `${JSON.stringify({ dot: DOT_NAME, model: MODEL, web: WEB, results }, null, 2)}\n`);
  for (const r of results) await appendFile(join(LOG_DIR, "summary.txt"), `${r.ok ? "PASS" : "FAIL"} ${r.step} ${r.seconds}s ${r.title}: ${r.detail}\n`);
  say(`${results.filter((r) => r.ok).length}/${results.length} steps passed; summary in ${join(LOG_DIR, "summary.json")}`);
}
process.exit(exitCode);
