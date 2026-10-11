/**
 * VmManagerDriver over the real VmManager. QEMU is vm-manager's own fake at
 * the process boundary (it parses the real argv); qemu-img is a fake runner;
 * the guest is a FakeGuest behind real HTTP on the port VmManager picked and
 * passed to the "QEMU", listening only while that QEMU runs, as QEMU's
 * forward does; its poweroff stops the QEMU. The last test runs the whole
 * Scheduler on top of it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@invisible-dots/database/testing";
import { prefixedStderrLogger, Scheduler } from "@invisible-dots/scheduler";
import { FAKE_MAX_IDENTITIES, FakeGuest, waitFor } from "@invisible-dots/scheduler/testing";
import { computerResources, hostPaths, parseDotConfig, type HostPaths } from "@invisible-dots/shared";
import { silentLogger, VmManager } from "@invisible-dots/vm-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeQemuHost, FakeRunner, type FakeVm } from "../../vm-manager/test/fakes.js";
import { compareVersions, latestImage, VmManagerDriver } from "../src/index.js";
import { serveFakeGuest, type FakeGuestServer } from "./guest-http.js";

const DOT = "dot_01k6h3w2ze8m4qv7r1xk9bntc5";
const QEMU = { system: "/opt/qemu/bin/qemu-system-x86_64", img: "/opt/qemu/bin/qemu-img" };
const TOKEN = "dot-token-0123456789";

/**
 * The fake QEMU host whose forward is a fake guest server on the guest port
 * of the argv, up from the spawn until the process ends: the guest boots and
 * powers off together with its VM, with the token of its seed.
 */
class GuestQemuHost extends FakeQemuHost {
  /** Guest requests of every VM, as "METHOD /path", in order. */
  readonly requests: string[] = [];
  readonly #servers = new Map<number, FakeGuestServer>();

  constructor(
    private readonly guest: () => FakeGuest | undefined,
    private readonly replaceGuest: (guest: FakeGuest) => void,
  ) {
    super();
  }

  protected override async openForward(vm: FakeVm): Promise<void> {
    if (this.guest()?.token !== vm.token) this.replaceGuest(new FakeGuest(vm.token));
    this.guest()?.boot();
    const server = await serveFakeGuest(() => this.guest(), {
      port: vm.guestPort,
      requests: this.requests,
      onPowerOff: () => setTimeout(() => this.terminate(vm), 5),
    });
    this.#servers.set(vm.pid, server);
  }

  protected override closeForward(vm: FakeVm): void {
    this.guest()?.powerOff();
    void this.#servers.get(vm.pid)?.close();
    this.#servers.delete(vm.pid);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#servers.values()].map((s) => s.close()));
    this.#servers.clear();
  }
}

let root: string;
let paths: HostPaths;
let diskSize: number;
let runner: FakeRunner;
let guest: FakeGuest | undefined;
let host: GuestQemuHost;

function manager(): VmManager {
  return new VmManager({
    paths,
    logger: silentLogger,
    qemu: QEMU,
    accelerator: "kvm",
    runner,
    processes: host,
    pollIntervalMs: 1,
    startSettleMs: 1,
    shutdownTimeoutMs: 200,
    killTimeoutMs: 100,
    startTimeoutMs: 1_000,
  });
}

function input(dotId = DOT, disk = "40gb") {
  const config = parseDotConfig({ name: "drv", model: { provider: "openrouter", id: "m" }, computer: { disk } });
  return { dotId, token: TOKEN, resources: computerResources(config) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idots-drv-"));
  paths = hostPaths({ INVISIBLE_DOTS_HOME: root });
  await mkdir(paths.imagesDir, { recursive: true });
  for (const name of ["golden-2026.9.0.qcow2", "golden-2026.10.0.qcow2", "runtime-1.2.iso", "runtime-1.10.iso", "noise.txt"]) {
    await writeFile(join(paths.imagesDir, name), name);
  }
  diskSize = 0;
  runner = new FakeRunner(async (_command, args) => {
    if (args[0] === "create") {
      diskSize = Number(args.at(-1));
      await writeFile(args.at(-2)!, "qcow2");
    }
    if (args[0] === "info") return { stdout: JSON.stringify({ "virtual-size": diskSize, format: "qcow2" }), stderr: "" };
    if (args[0] === "resize") diskSize = Number(args.at(-1));
    return undefined;
  });
  guest = new FakeGuest(TOKEN);
  host = new GuestQemuHost(
    () => guest,
    (next) => {
      guest = next;
    },
  );
});

afterEach(async () => {
  guest?.powerOff();
  await host.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("image selection", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("2026.10.1", "2026.9.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.10")).toBeLessThan(0);
  });

  it("picks the newest golden image and runtime ISO, and names the command that builds one", async () => {
    const driver = new VmManagerDriver(manager());
    expect(await driver.latestGolden()).toBe(join(paths.imagesDir, "golden-2026.10.0.qcow2"));
    expect(await driver.latestRuntime()).toBe(join(paths.imagesDir, "runtime-1.10.iso"));
    await expect(latestImage(join(root, "missing"), "golden")).rejects.toThrow(/cannot list/);
    await rm(join(paths.imagesDir, "runtime-1.2.iso"));
    await rm(join(paths.imagesDir, "runtime-1.10.iso"));
    await expect(driver.latestRuntime()).rejects.toThrow(/no runtime ISO .*invisible-dots image build/);
  });
});

describe("VmManagerDriver over VmManager", () => {
  it("create, start, health, stop, start again on a grown disk, reboot to a new process, destroy", async () => {
    const driver = new VmManagerDriver(manager());
    expect(await driver.state(DOT)).toEqual({ exists: false, state: "STOPPED", pid: null, guestPort: null, detail: null });

    const created = await driver.create(input());
    expect(created).toEqual({
      goldenImage: join(paths.imagesDir, "golden-2026.10.0.qcow2"),
      runtimeImage: join(paths.imagesDir, "runtime-1.10.iso"),
    });
    const started = await driver.start({ ...input(), goldenImage: created.goldenImage });
    expect(started).toMatchObject({ alreadyRunning: false, runtimeImage: created.runtimeImage });
    expect(await driver.state(DOT)).toMatchObject({ exists: true, state: "RUNNING", pid: started.pid, guestPort: started.guestPort });
    const argv = host.spawned.at(-1)!.args;
    // The newest runtime ISO is the one attached.
    expect(argv.some((arg) => arg.includes("runtime-1.10.iso"))).toBe(true);

    const endpoint = { dotId: DOT, port: started.guestPort };
    const health = await driver.waitForHealth(endpoint, TOKEN, { timeoutMs: 2_000, intervalMs: 5, requestTimeoutMs: 1_000 });
    expect(health).toMatchObject({ agentd: "ok", agent: { status: "ok" } });
    await driver.guest(endpoint, TOKEN).pushSecrets({ openrouter_api_key: "sk-or-x", mcp_secrets: { time: { TOKEN: "t-1" } } });
    expect(guest?.mcpSecrets).toEqual({ time: { TOKEN: "t-1" } });
    expect(guest?.openrouterKey).toBe("sk-or-x");
    // Another token cannot check the guest's proof, so it is never sent; waiting does not help.
    await expect(driver.guest(endpoint, "wrong-token-0000").health()).rejects.toMatchObject({ code: "guest_unproven" });
    await expect(driver.waitForHealth(endpoint, "wrong-token-0000", { timeoutMs: 2_000, intervalMs: 5, requestTimeoutMs: 1_000 })).rejects.toMatchObject({
      code: "guest_unproven",
    });

    // Identities through the real client, with the agent's own rules: a bad request and the limit come back as the guest's 4xx.
    const client = driver.guest(endpoint, TOKEN);
    const identity = await client.createBrowserIdentity({ name: "Shop" });
    expect((await client.listBrowserIdentities()).identities.map((i) => i.id)).toEqual([identity.id]);
    expect((await client.getBrowserIdentity(identity.id)).name).toBe("Shop");
    await expect(client.createBrowserIdentity({ name: "proxied", proxy: 8080 as never })).rejects.toMatchObject({ status: 400, code: "invalid" });
    const more = [];
    for (let n = 1; n < FAKE_MAX_IDENTITIES; n++) more.push(await client.createBrowserIdentity({ name: `extra-${n}` }));
    await expect(client.createBrowserIdentity({ name: "one-too-many" })).rejects.toMatchObject({ status: 409, code: "limit" });
    for (const made of [identity, ...more]) await client.deleteBrowserIdentity(made.id);

    expect(await driver.stop(DOT, TOKEN)).toEqual({ forced: false });
    expect(host.requests).toContain("POST /v1/system/poweroff");
    // Like QEMU's forward, the guest port is gone with the process.
    await expect(driver.guest(endpoint, TOKEN).health()).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(await driver.state(DOT)).toMatchObject({ exists: true, state: "STOPPED", pid: null, guestPort: null });

    // A PATCH made computer.disk bigger: the next start grows the overlay first.
    await driver.start({ ...input(DOT, "60gb"), goldenImage: created.goldenImage });
    expect(runner.lines().some((line) => line.includes(" resize ") && line.endsWith(String(60 * 1024 ** 3)))).toBe(true);

    const before = (await driver.state(DOT)).pid;
    const rebooted = await driver.reboot({ ...input(DOT, "60gb"), goldenImage: created.goldenImage });
    expect(rebooted.pid).not.toBe(before);
    expect(rebooted.alreadyRunning).toBe(false);

    await driver.destroy(DOT);
    expect(await driver.state(DOT)).toMatchObject({ exists: false, state: "STOPPED" });
  });

  it("waitForHealth fails at once when QEMU is gone instead of waiting out the timeout", async () => {
    const driver = new VmManagerDriver(manager());
    const created = await driver.create(input());
    const started = await driver.start({ ...input(), goldenImage: created.goldenImage });
    guest!.bootPolls = Number.MAX_SAFE_INTEGER;
    const waiting = driver.waitForHealth({ dotId: DOT, port: started.guestPort }, TOKEN, { timeoutMs: 60_000, intervalMs: 5, requestTimeoutMs: 1_000 });
    host.terminate([...host.vms.values()][0]!);
    await expect(waiting).rejects.toThrow(/not running any more/);
  });
});

describe("Scheduler over VmManagerDriver", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase("pglite");
    await t.db.secrets.put("global", "openrouter_api_key", "sk-or-real-path");
  });

  afterEach(async () => {
    await t.drop();
  });

  function scheduler(): Scheduler {
    return new Scheduler({
      db: t.db,
      driver: new VmManagerDriver(manager()),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 5_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0 },
      dispatchIntervalMs: 60_000,
      idleCheckIntervalMs: 60_000,
      ...(process.env.IDOTS_TEST_DEBUG ? { logger: prefixedStderrLogger("scheduler", true) } : {}),
    });
  }

  it("create -> READY -> task over HTTP -> sleep -> restart of the control plane -> wake", { timeout: 30_000 }, async () => {
    let s = scheduler();
    const yaml = "name: real-path\nmodel:\n  provider: openrouter\n  id: m\n";
    const dot = await s.createDot(yaml);
    await waitFor(async () => (await t.db.dots.get(dot.id))?.status === "READY", "READY", 10_000);
    const computer = await t.db.computers.get(dot.id);
    expect(computer).toMatchObject({ state: "RUNNING", vm_name: `invisible-dot-${dot.id}` });
    expect(computer?.guest_port).toBe((await new VmManagerDriver(manager()).state(dot.id)).guestPort);
    expect(computer?.pid).toEqual(expect.any(Number));
    expect(guest?.openrouterKey).toBe("sk-or-real-path");
    expect(guest?.config?.name).toBe("real-path");

    const task = await s.createTask(dot.id, { description: "over http" });
    await waitFor(async () => (await t.db.tasks.get(task.id))?.status === "COMPLETED", "task COMPLETED over HTTP", 10_000);

    // A control plane restart: QEMU keeps running and the new process adopts it from its pid file.
    await s.close();
    const spawnedBefore = host.spawned.length;
    s = scheduler();
    await s.start();
    await waitFor(() => s.lifecycle.isReady(dot.id), "READY after restart", 10_000);
    expect(host.spawned.length).toBe(spawnedBefore);

    await s.lifecycle.stop(dot.id, "idle");
    expect(host.requests).toContain("POST /v1/agent/prepare-sleep");
    expect(host.requests).toContain("POST /v1/system/poweroff");
    expect(await t.db.computers.get(dot.id)).toMatchObject({ state: "STOPPED", guest_port: null, pid: null });
    expect([...host.vms.values()]).toHaveLength(0);
    expect(host.killed).toEqual([]);

    const wake = await s.createTask(dot.id, { description: "after sleep" });
    await waitFor(async () => (await t.db.tasks.get(wake.id))?.status === "COMPLETED", "task after wake", 10_000);
    expect(host.spawned.length).toBe(spawnedBefore + 1);
    await s.close();
  });
});
