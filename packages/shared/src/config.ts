/**
 * The Dot configuration of architecture section 7: one zod schema, used by the
 * API when a Dot is created or patched and by the guest when `PUT /config`
 * arrives.
 *
 * Sizes and durations stay strings in the parsed config ("4gb", "15m") so that
 * a parsed config is itself a valid input: it is stored as jsonb, sent back to
 * clients and re-parsed on PATCH. Use `computerResources()` for numbers.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  isPermission,
  isMcpServerName,
  mcpPermission,
  mcpServerOf,
  PERMISSIONS,
  type Permission,
  type PermissionName,
} from "./tools.js";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const TIB = GIB * 1024;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: KIB,
  kb: KIB,
  kib: KIB,
  m: MIB,
  mb: MIB,
  mib: MIB,
  g: GIB,
  gb: GIB,
  gib: GIB,
  t: TIB,
  tb: TIB,
  tib: TIB,
};

/**
 * Parse a size such as "4gb", "512mb" or "1.5 GiB" into bytes. Units are
 * binary (1gb = 1024^3 bytes): the values end up as QEMU `-m` MiB and
 * qemu-img sizes, which are binary too. A bare number is refused because
 * "4096" is ambiguous between bytes and MiB.
 */
export function parseSize(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value);
  if (!match) {
    throw new Error(`invalid size "${value}": expected a number followed by a unit, e.g. "4gb" or "512mb"`);
  }
  const unit = SIZE_UNITS[match[2]!.toLowerCase()];
  if (unit === undefined) {
    throw new Error(`invalid size "${value}": unknown unit "${match[2]}" (use b, kb, mb, gb or tb)`);
  }
  return Math.round(Number(match[1]) * unit);
}

/** Bytes to whole MiB, rounded down. */
export function bytesToMiB(bytes: number): number {
  return Math.floor(bytes / MIB);
}

/** Parse a size and return whole MiB, rounded down. */
export function parseSizeMiB(value: string): number {
  return bytesToMiB(parseSize(value));
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration such as "15m", "90s", "2h" or "1h30m" into milliseconds.
 * "0" (or the number 0) means never and returns null.
 */
export function parseDuration(value: string | number): number | null {
  if (value === 0 || (typeof value === "string" && /^\s*0+\s*$/.test(value))) return null;
  if (typeof value === "number") {
    throw new Error(`invalid duration ${value}: a non-zero duration needs a unit, e.g. "15m"`);
  }
  const text = value.trim().toLowerCase();
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/y;
  let total = 0;
  let index = 0;
  while (index < text.length) {
    part.lastIndex = index;
    const match = part.exec(text);
    if (!match) {
      throw new Error(`invalid duration "${value}": expected e.g. "15m", "90s", "2h", "1h30m" or "0" for never`);
    }
    total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
    index = part.lastIndex;
  }
  if (text.length === 0) {
    throw new Error(`invalid duration "${value}": empty`);
  }
  const ms = Math.round(total);
  // "0s" is a zero written with a unit; treat it like "0" rather than as "sleep at once".
  return ms === 0 ? null : ms;
}

/**
 * The range of each number a Dot's config bounds, and the value used when it is left out. The schema below takes
 * them from here, and so does the web client's form, so a slider can never offer what the API would refuse.
 */
export const CONFIG_BOUNDS = {
  cpu: { min: 1, max: 16, default: 2 },
  memory: { min: "2gb", max: "64gb", default: "4gb" },
  disk: { min: "20gb", max: "1024gb", default: "40gb" },
  idleTimeout: { default: "15m" },
  maxCostPerTaskUsd: { min: 0.01, max: 100, default: 1 },
  maxStepsPerTask: { min: 1, max: 1000, default: 60 },
} as const;

export const DOT_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;

export function isValidDotName(name: string): boolean {
  return DOT_NAME_PATTERN.test(name);
}

function sizeField(label: string, min: string, max: string, fallback: string) {
  const minBytes = parseSize(min);
  const maxBytes = parseSize(max);
  return z
    .string()
    .default(fallback)
    .superRefine((value, ctx) => {
      let bytes: number;
      try {
        bytes = parseSize(value);
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
        return;
      }
      if (bytes < minBytes || bytes > maxBytes) {
        ctx.addIssue({ code: "custom", message: `${label} must be between ${min} and ${max}, got "${value}"` });
      }
    })
    .transform((value) => value.trim().toLowerCase());
}

const durationField = z
  .union([z.string(), z.number()])
  .default(CONFIG_BOUNDS.idleTimeout.default)
  .superRefine((value, ctx) => {
    try {
      parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  })
  // YAML reads `idle_timeout: 0` as a number; keep the field a string either way.
  .transform((value) => String(value).trim().toLowerCase());

const modelId = z
  .string()
  .min(1, "model id must not be empty")
  .regex(/^\S+$/, "model id must not contain whitespace");

/**
 * The roles a Dot's `models` map may name: the jobs the engine can give to a model other than `model.id`. The
 * list is closed because a role the engine never asks for would be a setting that does nothing. `summary` is the
 * model that writes the summary when the conversation outgrows the model's context window (section 8.6). The engine keeps a copy
 * in nanobot/dots/protocol.py, kept equal by tests/repo/vendored-nanobot.test.ts.
 */
export const MODEL_ROLES = ["summary"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export function isModelRole(name: string): name is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(name);
}

const permissionDecision = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof permissionDecision>;

/**
 * The longest a call to a tool of a declared MCP server may take, in seconds, and its default: what Codex
 * (`tool_timeout_sec`), Hermes (`timeout`) and OpenClaw (`requestTimeoutMs`) let a server's entry set. 120 is the
 * engine's own for the browser server's calls.
 */
export const MCP_TIMEOUT_BOUNDS = { min: 1, max: 600, default: 120 } as const;

/**
 * The longest a declared MCP server may take to start and list its tools, in seconds, and its default: Codex's
 * `startup_timeout_sec`. A first start through uvx or npx downloads the server, so the default is above Codex's 10 s
 * and Claude Code's 30 s. A server that does not start within it is not started again until its entry changes.
 */
export const MCP_STARTUP_TIMEOUT_BOUNDS = { min: 1, max: 600, default: 60 } as const;

// An environment variable's name, as POSIX writes one, and an HTTP header's name (an RFC 9110 token).
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const mcpTimeout = z
  .number()
  .int("timeout_s must be a whole number of seconds")
  .min(MCP_TIMEOUT_BOUNDS.min)
  .max(MCP_TIMEOUT_BOUNDS.max)
  .default(MCP_TIMEOUT_BOUNDS.default);

const mcpStartupTimeout = z
  .number()
  .int("startup_timeout_s must be a whole number of seconds")
  .min(MCP_STARTUP_TIMEOUT_BOUNDS.min)
  .max(MCP_STARTUP_TIMEOUT_BOUNDS.max)
  .default(MCP_STARTUP_TIMEOUT_BOUNDS.default);

/**
 * An MCP server the engine starts on the Dot's computer, as the user `dot`, and talks to over its standard input and
 * output: Claude Code's, Codex's and nanobot's stdio entry. `secrets` names environment variables whose values are
 * the Dot's secrets (set apart from the config, section 9.6), never written in it.
 */
const mcpStdioServer = z
  .object({
    command: z.string().min(1, "command must not be empty"),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().regex(ENV_NAME, "an environment variable is named by letters, digits and '_'"), z.string()).default({}),
    secrets: z.array(z.string().regex(ENV_NAME, "a secret is named as the environment variable it becomes")).default([]),
    timeout_s: mcpTimeout,
    startup_timeout_s: mcpStartupTimeout,
  })
  .strict();

/**
 * An MCP server the engine reaches over streamable HTTP (or SSE, for a URL ending in /sse, as nanobot detects it).
 * `secrets` names headers whose values are the Dot's secrets, such as `Authorization`.
 */
const mcpHttpServer = z
  .object({
    url: z
      .string()
      .url("url must be an http or https URL")
      .refine((url) => /^https?:\/\//i.test(url), "url must be an http or https URL"),
    headers: z.record(z.string().regex(HEADER_NAME, "a header is named by an HTTP token"), z.string()).default({}),
    secrets: z.array(z.string().regex(HEADER_NAME, "a secret is named as the header it becomes")).default([]),
    timeout_s: mcpTimeout,
    startup_timeout_s: mcpStartupTimeout,
  })
  .strict();

const mcpServer = z.union([mcpStdioServer, mcpHttpServer], {
  error: "an MCP server is either { command, args?, env?, secrets?, timeout_s?, startup_timeout_s? } or { url, headers?, secrets?, timeout_s?, startup_timeout_s? }",
});
export type McpServerConfig = z.output<typeof mcpServer>;
export type McpStdioServerConfig = z.output<typeof mcpStdioServer>;
export type McpHttpServerConfig = z.output<typeof mcpHttpServer>;

export function isMcpStdioServer(server: McpServerConfig): server is McpStdioServerConfig {
  return "command" in server;
}

/** The names a server's secrets become: environment variables of a stdio server, headers of an HTTP one. */
function mcpLiteralNames(server: McpServerConfig): string[] {
  return Object.keys(isMcpStdioServer(server) ? server.env : server.headers);
}

export const dotConfigSchema = z
  .object({
    name: z
      .string()
      .regex(DOT_NAME_PATTERN, "name must be 1 to 40 characters of lowercase letters, digits and '-'"),
    instructions: z.string().optional(),
    model: z
      .object({
        provider: z.literal("openrouter", { error: 'model.provider must be "openrouter"' }),
        id: modelId,
      })
      .strict(),
    models: z
      .record(z.string(), modelId)
      .default({})
      .superRefine((models, ctx) => {
        for (const role of Object.keys(models)) {
          if (!isModelRole(role)) {
            ctx.addIssue({
              code: "custom",
              path: [role],
              message: `unknown model role "${role}" (the roles are: ${MODEL_ROLES.join(", ")})`,
            });
          }
        }
      }),
    computer: z
      .object({
        cpu: z
          .number()
          .int("computer.cpu must be an integer")
          .min(CONFIG_BOUNDS.cpu.min)
          .max(CONFIG_BOUNDS.cpu.max)
          .default(CONFIG_BOUNDS.cpu.default),
        memory: sizeField("computer.memory", CONFIG_BOUNDS.memory.min, CONFIG_BOUNDS.memory.max, CONFIG_BOUNDS.memory.default),
        disk: sizeField("computer.disk", CONFIG_BOUNDS.disk.min, CONFIG_BOUNDS.disk.max, CONFIG_BOUNDS.disk.default),
        idle_timeout: durationField,
      })
      .strict()
      .default({
        cpu: CONFIG_BOUNDS.cpu.default,
        memory: CONFIG_BOUNDS.memory.default,
        disk: CONFIG_BOUNDS.disk.default,
        idle_timeout: CONFIG_BOUNDS.idleTimeout.default,
      }),
    permissions: z.record(z.string(), permissionDecision).default({}),
    // The MCP servers whose tools the Dot may use, by name (section 7): the person declares them, as Claude Code,
    // Codex and nanobot have their user declare them; the Dot can install a server's program, not add a server.
    mcp_servers: z.record(z.string(), mcpServer).default({}),
    limits: z
      .object({
        max_steps_per_task: z.number().int().min(CONFIG_BOUNDS.maxStepsPerTask.min).max(CONFIG_BOUNDS.maxStepsPerTask.max).default(CONFIG_BOUNDS.maxStepsPerTask.default),
        // USD a task, or a chat turn, may spend on the model before it stops (section 8.2).
        max_cost_per_task_usd: z
          .number()
          .min(CONFIG_BOUNDS.maxCostPerTaskUsd.min)
          .max(CONFIG_BOUNDS.maxCostPerTaskUsd.max)
          .default(CONFIG_BOUNDS.maxCostPerTaskUsd.default),
      })
      .strict()
      .default({
        max_steps_per_task: CONFIG_BOUNDS.maxStepsPerTask.default,
        max_cost_per_task_usd: CONFIG_BOUNDS.maxCostPerTaskUsd.default,
      }),
  })
  .strict()
  .superRefine((config, ctx) => {
    // A typo such as "computer.exe: deny" would otherwise be silently ignored and leave the real permission at its
    // default, and the permission of a server the config does not declare would hold for nothing.
    for (const key of Object.keys(config.permissions)) {
      const server = mcpServerOf(key);
      if (isPermission(key) || (server !== null && server in config.mcp_servers)) continue;
      const message = server !== null ? `"${key}" is the permission of an MCP server this config does not declare in mcp_servers` : `unknown permission "${key}"`;
      ctx.addIssue({ code: "custom", path: ["permissions", key], message });
    }
    for (const [name, server] of Object.entries(config.mcp_servers)) {
      // Checked here and not as the record's key, whose failure zod words as "Invalid key in record".
      if (!isMcpServerName(name)) {
        ctx.addIssue({ code: "custom", path: ["mcp_servers", name], message: `"${name}" is not an MCP server's name: 1 to 32 lowercase letters, digits and '-', starting with a letter or a digit` });
      }
      const literal = new Set(mcpLiteralNames(server).map((n) => n.toLowerCase()));
      const seen = new Set<string>();
      for (const secret of server.secrets) {
        const key = secret.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", path: ["mcp_servers", name, "secrets"], message: `secret "${secret}" is named twice` });
        }
        if (literal.has(key)) {
          const where = isMcpStdioServer(server) ? "env" : "headers";
          ctx.addIssue({ code: "custom", path: ["mcp_servers", name, "secrets"], message: `"${secret}" is both a secret and a value written in ${where}` });
        }
        seen.add(key);
      }
    }
  });

export type DotConfig = z.output<typeof dotConfigSchema>;
export type DotConfigInput = z.input<typeof dotConfigSchema>;
/** What `PUT /config` sends to the guest: the config minus `computer` (section 7). */
export type DotRuntimeConfig = Omit<DotConfig, "computer">;

export class DotConfigError extends Error {
  readonly issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super(`invalid Dot configuration: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`);
    this.name = "DotConfigError";
    this.issues = issues;
  }
}

function loadInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return parseYaml(input);
  } catch (error) {
    throw new DotConfigError([{ path: "", message: `not valid YAML: ${(error as Error).message}` }]);
  }
}

/** Parse YAML text or an already-decoded object into a DotConfig with every default applied. */
export function parseDotConfig(input: unknown): DotConfig {
  const result = dotConfigSchema.safeParse(loadInput(input));
  if (!result.success) {
    throw new DotConfigError(
      result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
    );
  }
  return result.data;
}

/** Like `parseDotConfig`, without throwing. */
export function safeParseDotConfig(
  input: unknown,
): { ok: true; config: DotConfig } | { ok: false; error: DotConfigError } {
  try {
    return { ok: true, config: parseDotConfig(input) };
  } catch (error) {
    if (error instanceof DotConfigError) return { ok: false, error };
    throw error;
  }
}

/**
 * Validate a runtime config as the guest receives it. The guest has no
 * `computer` section to check, so the full schema is applied with the
 * defaults in its place and then removed again.
 */
export function parseRuntimeConfig(input: unknown): DotRuntimeConfig {
  const value = loadInput(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DotConfigError([{ path: "", message: "runtime config must be an object" }]);
  }
  if ("computer" in value) {
    throw new DotConfigError([{ path: "computer", message: "a runtime config has no computer section" }]);
  }
  return toRuntimeConfig(parseDotConfig(value));
}

/**
 * What the guest is given (`PUT /config`): the Dot config without its
 * computer section, with `permissions` resolved for every permission the
 * registry knows. The defaults live here and nowhere else; the engine in the
 * guest applies the map as it comes and denies a permission it does not
 * find in it.
 */
export function toRuntimeConfig(config: DotConfig): DotRuntimeConfig {
  const { computer: _computer, ...runtime } = config;
  const permissions = Object.fromEntries(permissionNames(config).map((permission) => [permission, resolvePermission(config, permission)]));
  return { ...runtime, permissions };
}

/**
 * The MCP servers a config declares, by name. Every list of them is in this order: the host keeps a config as jsonb,
 * which does not keep the order of an object's keys.
 */
export function mcpServerNames(config: Pick<DotRuntimeConfig, "mcp_servers">): string[] {
  return Object.keys(config.mcp_servers ?? {}).sort();
}

/** Every permission a config has: those of `PERMISSIONS`, then one for each MCP server it declares, by name. */
export function permissionNames(config: Pick<DotRuntimeConfig, "mcp_servers">): PermissionName[] {
  return [...PERMISSIONS, ...mcpServerNames(config).map(mcpPermission)];
}

export interface ComputerResources {
  cpus: number;
  memoryBytes: number;
  memoryMiB: number;
  diskBytes: number;
  /** Milliseconds of inactivity before the Dot sleeps; null means never. */
  idleTimeoutMs: number | null;
}

export function computerResources(config: Pick<DotConfig, "computer">): ComputerResources {
  const memoryBytes = parseSize(config.computer.memory);
  return {
    cpus: config.computer.cpu,
    memoryBytes,
    memoryMiB: bytesToMiB(memoryBytes),
    diskBytes: parseSize(config.computer.disk),
    idleTimeoutMs: parseDuration(config.computer.idle_timeout),
  };
}

/**
 * The decision for one permission (section 7). An explicit entry in the
 * config wins. Otherwise everything under computer.*, files.* and browser.*
 * is allowed, except browser.identity.delete, which asks; the automations
 * permission asks too, because an automation keeps working after the turn,
 * and so does the permission of a declared MCP server, whose tools do what
 * that server decides (Claude Code asks before an MCP tool by default too).
 * A permission the registry does not know, or of a server the config does
 * not declare, is denied whatever the config says.
 */
export function resolvePermission(
  config: Pick<DotRuntimeConfig, "permissions"> & { mcp_servers?: DotRuntimeConfig["mcp_servers"] },
  permission: string,
): PermissionDecision {
  const server = mcpServerOf(permission);
  if (server !== null && !(server in (config.mcp_servers ?? {}))) return "deny";
  if (server === null && !isPermission(permission)) return "deny";
  return config.permissions[permission] ?? defaultPermission(permission as PermissionName);
}

const ASK_BY_DEFAULT: ReadonlySet<Permission> = new Set<Permission>(["browser.identity.delete", "automations"]);
const ALLOWED_NAMESPACES: ReadonlySet<string> = new Set(["computer", "files", "browser"]);

/** What a permission is when the config says nothing of it: the decision `resolvePermission` falls back to. */
export function defaultPermission(permission: PermissionName): PermissionDecision {
  if (!isPermission(permission)) return "ask";
  if (ASK_BY_DEFAULT.has(permission)) return "ask";
  return ALLOWED_NAMESPACES.has(permission.split(".")[0] ?? "") ? "allow" : "deny";
}
