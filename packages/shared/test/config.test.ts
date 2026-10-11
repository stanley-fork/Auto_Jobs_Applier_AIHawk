import { describe, expect, it } from "vitest";
import {
  CONFIG_BOUNDS,
  computerResources,
  DotConfigError,
  parseDotConfig,
  parseDuration,
  parseRuntimeConfig,
  parseSize,
  parseSizeMiB,
  PERMISSIONS,
  resolvePermission,
  safeParseDotConfig,
  toRuntimeConfig,
} from "../src/index.js";

const FULL_YAML = `
name: fare-watch
instructions: >
  Write findings to ~/workspace/fares.csv.
model:
  provider: openrouter
  id: z-ai/glm-5.3-flash
models:
  summary: openai/gpt-5-mini
computer:
  cpu: 2
  memory: 4gb
  disk: 40gb
  idle_timeout: 15m
permissions:
  computer.exec: allow
  browser.identity.delete: ask
limits:
  max_steps_per_task: 60
  max_cost_per_task_usd: 1.00
`;

const MINIMAL = { name: "a", model: { provider: "openrouter", id: "openrouter/auto" } };

function issuesOf(input: unknown): string[] {
  const result = safeParseDotConfig(input);
  if (result.ok) throw new Error("expected the config to be rejected");
  return result.error.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("parseSize", () => {
  it("parses binary units", () => {
    expect(parseSize("4gb")).toBe(4 * 1024 ** 3);
    expect(parseSize("512MB")).toBe(512 * 1024 ** 2);
    expect(parseSize("1.5 GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseSize("1tb")).toBe(1024 ** 4);
    expect(parseSize("100b")).toBe(100);
    expect(parseSizeMiB("4gb")).toBe(4096);
  });

  it("refuses bare numbers and unknown units", () => {
    expect(() => parseSize("4096")).toThrow(/followed by a unit/);
    expect(() => parseSize("4 parsecs")).toThrow(/unknown unit/);
    expect(() => parseSize("")).toThrow();
  });
});

describe("parseDuration", () => {
  it("parses single and compound durations", () => {
    expect(parseDuration("15m")).toBe(15 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("250ms")).toBe(250);
  });

  it("reads zero as never", () => {
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration(0)).toBeNull();
    expect(parseDuration("0s")).toBeNull();
  });

  it("refuses garbage", () => {
    expect(() => parseDuration("15")).toThrow(/invalid duration/);
    expect(() => parseDuration(15)).toThrow(/needs a unit/);
    expect(() => parseDuration("15 minutes")).toThrow(/invalid duration/);
    expect(() => parseDuration("")).toThrow();
  });
});

describe("parseDotConfig", () => {
  it("parses the example of section 7", () => {
    const config = parseDotConfig(FULL_YAML);
    expect(config.name).toBe("fare-watch");
    expect(config.model).toEqual({ provider: "openrouter", id: "z-ai/glm-5.3-flash" });
    expect(config.models).toEqual({ summary: "openai/gpt-5-mini" });
    expect(config.computer).toEqual({ cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" });
    expect(config.permissions).toEqual({ "computer.exec": "allow", "browser.identity.delete": "ask" });
    expect(config.instructions).toContain("fares.csv");
  });

  it("applies every default to a minimal config", () => {
    const config = parseDotConfig(MINIMAL);
    expect(config).toEqual({
      name: "a",
      model: { provider: "openrouter", id: "openrouter/auto" },
      models: {},
      computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" },
      permissions: {},
      limits: { max_steps_per_task: 60, max_cost_per_task_usd: 1 },
      mcp_servers: {},
    });
  });

  it("fills defaults inside a partially given section", () => {
    const config = parseDotConfig({ ...MINIMAL, computer: { cpu: 4 } });
    expect(config.computer).toEqual({ cpu: 4, memory: "4gb", disk: "40gb", idle_timeout: "15m" });
  });

  it("is idempotent, so a stored config can be parsed again", () => {
    const once = parseDotConfig(FULL_YAML);
    expect(parseDotConfig(once)).toEqual(once);
    expect(parseDotConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("accepts idle_timeout 0 written as a YAML number and keeps it a string", () => {
    const config = parseDotConfig(FULL_YAML.replace("idle_timeout: 15m", "idle_timeout: 0"));
    expect(config.computer.idle_timeout).toBe("0");
    expect(computerResources(config).idleTimeoutMs).toBeNull();
  });

  it("validates the name", () => {
    expect(issuesOf({ ...MINIMAL, name: "Fare Watch" })[0]).toMatch(/^name: /);
    expect(issuesOf({ ...MINIMAL, name: "" })[0]).toMatch(/^name: /);
    expect(issuesOf({ ...MINIMAL, name: "a".repeat(41) })[0]).toMatch(/^name: /);
    expect(parseDotConfig({ ...MINIMAL, name: "a".repeat(40) }).name).toHaveLength(40);
    expect(parseDotConfig({ ...MINIMAL, name: "dot-2" }).name).toBe("dot-2");
  });

  it("accepts only the openrouter provider", () => {
    const issues = issuesOf({ ...MINIMAL, model: { provider: "openai", id: "gpt-5" } });
    expect(issues).toEqual(['model.provider: model.provider must be "openrouter"']);
  });

  it("requires a model, and has no goal: what a Dot is for is what its person asks of it", () => {
    const issues = issuesOf({ name: "a" });
    expect(issues.some((i) => i.startsWith("model:"))).toBe(true);
    expect(issuesOf({ ...MINIMAL, goal: "watch the fares" })[0]).toMatch(/goal/);
  });

  it("enforces the resource ranges", () => {
    expect(issuesOf({ ...MINIMAL, computer: { cpu: 0 } })[0]).toMatch(/^computer\.cpu:/);
    expect(issuesOf({ ...MINIMAL, computer: { cpu: 17 } })[0]).toMatch(/^computer\.cpu:/);
    expect(issuesOf({ ...MINIMAL, computer: { cpu: 1.5 } })[0]).toMatch(/integer/);
    expect(issuesOf({ ...MINIMAL, computer: { memory: "1gb" } })[0]).toMatch(/between 2gb and 64gb/);
    expect(issuesOf({ ...MINIMAL, computer: { memory: "65gb" } })[0]).toMatch(/between 2gb and 64gb/);
    expect(issuesOf({ ...MINIMAL, computer: { disk: "10gb" } })[0]).toMatch(/between 20gb and 1024gb/);
    expect(issuesOf({ ...MINIMAL, computer: { disk: "2tb" } })[0]).toMatch(/between 20gb and 1024gb/);
    expect(issuesOf({ ...MINIMAL, computer: { memory: "4096" } })[0]).toMatch(/followed by a unit/);
    expect(issuesOf({ ...MINIMAL, computer: { idle_timeout: "soon" } })[0]).toMatch(/invalid duration/);
    expect(parseDotConfig({ ...MINIMAL, computer: { memory: "2048mb", disk: "1tb" } }).computer.disk).toBe("1tb");
  });

  it("refuses unknown keys and unknown permissions", () => {
    expect(issuesOf({ ...MINIMAL, extra: 1 })[0]).toMatch(/extra/);
    expect(issuesOf({ ...MINIMAL, computer: { gpu: 1 } })[0]).toMatch(/gpu/);
    expect(issuesOf({ ...MINIMAL, permissions: { "computer.exe": "deny" } })).toEqual([
      'permissions.computer.exe: unknown permission "computer.exe"',
    ]);
    expect(issuesOf({ ...MINIMAL, permissions: { "computer.exec": "maybe" } })[0]).toMatch(/^permissions\.computer\.exec:/);
  });

  it("has no memory to set: the Dot keeps its notes itself, so a memory switch or permission is refused", () => {
    expect(issuesOf({ ...MINIMAL, memory: { enabled: false } })[0]).toMatch(/memory/);
    expect(issuesOf({ ...MINIMAL, permissions: { "memory.read": "allow" } })).toEqual(['permissions.memory.read: unknown permission "memory.read"']);
  });

  it("accepts the summary model role", () => {
    expect(parseDotConfig({ ...MINIMAL, models: { summary: "openai/gpt-5-mini" } }).models).toEqual({
      summary: "openai/gpt-5-mini",
    });
  });

  it("refuses a model role the engine never asks for, naming the roles there are", () => {
    expect(issuesOf({ ...MINIMAL, models: { fast: "openai/gpt-5-mini" } })).toEqual([
      'models.fast: unknown model role "fast" (the roles are: summary)',
    ]);
    expect(issuesOf({ ...MINIMAL, models: { summary: "a/b", Vision: "a/b", fast: "a/b" } })).toEqual([
      'models.Vision: unknown model role "Vision" (the roles are: summary)',
      'models.fast: unknown model role "fast" (the roles are: summary)',
    ]);
  });

  it("refuses an empty model id for a role", () => {
    expect(issuesOf({ ...MINIMAL, models: { summary: "" } })[0]).toBe("models.summary: model id must not be empty");
  });

  it.each(["web.fetch", "web.search", "subagents", "message.send", "memory.write"])(
    "refuses %s: no tool of the Dot can exercise it",
    (name) => {
      expect(issuesOf({ ...MINIMAL, permissions: { [name]: "allow" } })).toEqual([
        `permissions.${name}: unknown permission "${name}"`,
      ]);
    },
  );

  it("reports invalid YAML as a config error", () => {
    expect(() => parseDotConfig("name: [unclosed")).toThrow(DotConfigError);
    expect(() => parseDotConfig("name: [unclosed")).toThrow(/not valid YAML/);
  });

  it("lists every issue in the error message", () => {
    try {
      parseDotConfig({ name: "BAD", model: { provider: "x", id: "y" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DotConfigError);
      expect((error as Error).message).toMatch(/name: .*model\.provider: /);
    }
  });
});

describe("CONFIG_BOUNDS", () => {
  const withComputer = (computer: Record<string, unknown>) => ({ ...MINIMAL, computer });
  const withLimits = (limits: Record<string, unknown>) => ({ ...MINIMAL, limits });

  it("are the defaults the schema applies to a config that leaves the numbers out", () => {
    const config = parseDotConfig(MINIMAL);
    expect(config.computer).toEqual({
      cpu: CONFIG_BOUNDS.cpu.default,
      memory: CONFIG_BOUNDS.memory.default,
      disk: CONFIG_BOUNDS.disk.default,
      idle_timeout: CONFIG_BOUNDS.idleTimeout.default,
    });
    expect(config.limits).toEqual({
      max_steps_per_task: CONFIG_BOUNDS.maxStepsPerTask.default,
      max_cost_per_task_usd: CONFIG_BOUNDS.maxCostPerTaskUsd.default,
    });
  });

  it("are the range the schema accepts: both ends in, one step outside refused", () => {
    const { cpu, memory, disk, maxCostPerTaskUsd } = CONFIG_BOUNDS;
    expect(safeParseDotConfig(withComputer({ cpu: cpu.min })).ok).toBe(true);
    expect(safeParseDotConfig(withComputer({ cpu: cpu.max })).ok).toBe(true);
    expect(safeParseDotConfig(withComputer({ cpu: cpu.min - 1 })).ok).toBe(false);
    expect(safeParseDotConfig(withComputer({ cpu: cpu.max + 1 })).ok).toBe(false);
    for (const [field, bounds] of [["memory", memory], ["disk", disk]] as const) {
      const gib = (size: string) => parseSize(size) / 1024 ** 3;
      expect(safeParseDotConfig(withComputer({ [field]: bounds.min })).ok).toBe(true);
      expect(safeParseDotConfig(withComputer({ [field]: bounds.max })).ok).toBe(true);
      expect(safeParseDotConfig(withComputer({ [field]: `${gib(bounds.min) - 1}gb` })).ok).toBe(false);
      expect(safeParseDotConfig(withComputer({ [field]: `${gib(bounds.max) + 1}gb` })).ok).toBe(false);
    }
    expect(safeParseDotConfig(withLimits({ max_cost_per_task_usd: maxCostPerTaskUsd.min })).ok).toBe(true);
    expect(safeParseDotConfig(withLimits({ max_cost_per_task_usd: maxCostPerTaskUsd.max })).ok).toBe(true);
    expect(safeParseDotConfig(withLimits({ max_cost_per_task_usd: maxCostPerTaskUsd.min / 2 })).ok).toBe(false);
    expect(safeParseDotConfig(withLimits({ max_cost_per_task_usd: maxCostPerTaskUsd.max + 1 })).ok).toBe(false);
  });

  it("are the range of the step number too", () => {
    const { maxStepsPerTask } = CONFIG_BOUNDS;
    expect(safeParseDotConfig(withLimits({ max_steps_per_task: maxStepsPerTask.min })).ok).toBe(true);
    expect(safeParseDotConfig(withLimits({ max_steps_per_task: maxStepsPerTask.max })).ok).toBe(true);
    expect(safeParseDotConfig(withLimits({ max_steps_per_task: maxStepsPerTask.min - 1 })).ok).toBe(false);
    expect(safeParseDotConfig(withLimits({ max_steps_per_task: maxStepsPerTask.max + 1 })).ok).toBe(false);
  });

  it("set no token limit: the model's own context window and answer length are used, so a config naming one is refused", () => {
    expect(CONFIG_BOUNDS).not.toHaveProperty("contextTokens");
    expect(parseDotConfig(MINIMAL).limits).not.toHaveProperty("context_tokens");
    const refused = safeParseDotConfig(withLimits({ context_tokens: 32_000 }));
    expect(refused.ok).toBe(false);
  });
});

describe("computerResources", () => {
  it("turns the strings into numbers", () => {
    expect(computerResources(parseDotConfig(FULL_YAML))).toEqual({
      cpus: 2,
      memoryBytes: 4 * 1024 ** 3,
      memoryMiB: 4096,
      diskBytes: 40 * 1024 ** 3,
      idleTimeoutMs: 900_000,
    });
  });
});

describe("toRuntimeConfig / parseRuntimeConfig", () => {
  it("drops the computer section and resolves permissions, and changes nothing else", () => {
    const config = parseDotConfig(FULL_YAML);
    const runtime = toRuntimeConfig(config);
    expect(runtime).not.toHaveProperty("computer");
    const { permissions, ...rest } = runtime;
    const { computer: _computer, permissions: _explicit, ...expectedRest } = config;
    expect(rest).toEqual(expectedRest);
    expect(Object.keys(permissions).sort()).toEqual([...PERMISSIONS].sort());
  });

  it("gives the guest every permission's decision, so the guest never needs the defaults", () => {
    const config = parseDotConfig({ ...MINIMAL, permissions: { "computer.exec": "deny" } });
    const runtime = toRuntimeConfig(config);
    for (const permission of PERMISSIONS) {
      expect(runtime.permissions[permission]).toBe(resolvePermission(config, permission));
    }
    expect(runtime.permissions["computer.exec"]).toBe("deny");
    expect(runtime.permissions.automations).toBe("ask");
  });

  it("round-trips through the guest validator", () => {
    const runtime = toRuntimeConfig(parseDotConfig(FULL_YAML));
    expect(parseRuntimeConfig(JSON.parse(JSON.stringify(runtime)))).toEqual(runtime);
  });

  it("refuses a runtime config that carries a computer section", () => {
    expect(() => parseRuntimeConfig(parseDotConfig(FULL_YAML))).toThrow(/no computer section/);
    expect(() => parseRuntimeConfig([])).toThrow(/must be an object/);
  });
});

describe("resolvePermission", () => {
  const defaults = parseDotConfig(MINIMAL);

  it("allows every known permission by default except those that act beyond the Dot's computer", () => {
    const asks = new Set(["browser.identity.delete", "automations"]);
    for (const permission of PERMISSIONS) {
      expect(resolvePermission(defaults, permission)).toBe(asks.has(permission) ? "ask" : "allow");
    }
  });

  it("lets the config override a default", () => {
    const config = parseDotConfig({
      ...MINIMAL,
      permissions: { "computer.exec": "deny", "browser.identity.delete": "allow", "files.write": "ask" },
    });
    expect(resolvePermission(config, "computer.exec")).toBe("deny");
    expect(resolvePermission(config, "browser.identity.delete")).toBe("allow");
    expect(resolvePermission(config, "files.write")).toBe("ask");
    expect(resolvePermission(config, "files.read")).toBe("allow");
  });

  it("denies a permission the registry does not know, whatever the config says", () => {
    expect(resolvePermission(defaults, "computer.reboot")).toBe("deny");
    expect(resolvePermission(defaults, "network.raw")).toBe("deny");
    expect(resolvePermission({ permissions: { "computer.reboot": "allow" } } as never, "computer.reboot")).toBe("deny");
  });
});
