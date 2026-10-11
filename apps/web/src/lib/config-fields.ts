/**
 * What a person can change in a Dot's config, as a table of fields: where each lives, what it is called, how its
 * value is said, and when a change of it reaches the Dot. The Settings page works on a whole `DotConfig` and never
 * on a second model of it, so everything it needs from the config comes from this table: what changed (the review
 * before a save), what a save of it will say, and how edits made on top of an older config are put on top of a newer
 * one (`rebase`). A permission is compared by what it resolves to, so an explicit entry that says what the default
 * says is not a change.
 */
import {
  defaultPermission,
  isMcpStdioServer,
  mcpPermission,
  mcpServerNames,
  mcpServerOf,
  PERMISSION_INFO,
  PERMISSIONS,
  resolvePermission,
  type DotConfig,
  type McpServerConfig,
  type PermissionDecision,
  type PermissionName,
} from "@invisible-dots/shared/browser";

/** What a field holds: a text, a number or a switch. */
export type ConfigValue = string | number | boolean;

/** When a change of a field reaches the Dot: from its next turn, or the next time its computer starts. */
export type Applies = "turn" | "start";

interface ConfigField {
  key: string;
  label: string;
  applies: Applies;
  get: (config: DotConfig) => ConfigValue;
  set: (config: DotConfig, value: ConfigValue) => DotConfig;
  show: (value: ConfigValue) => string;
}

const TEXT_SHOWN = 300;

/** A text as a change shows it: nothing says so, and a long one is cut. */
function shownText(value: ConfigValue): string {
  const text = String(value);
  if (text === "") return "(empty)";
  return text.length > TEXT_SHOWN ? `${text.slice(0, TEXT_SHOWN)}...` : text;
}

const shownPlain = (value: ConfigValue) => String(value);

/** The default decision of a permission: what it resolves to when the config says nothing about it (an MCP server's asks). */
export function defaultDecision(permission: PermissionName): PermissionDecision {
  return defaultPermission(permission);
}

/**
 * The config with one permission set. A decision the default already makes is not written, so a config stays as short
 * as what it changes; nor is the permission of an MCP server the config does not declare, which it could not hold.
 */
export function setPermission(config: DotConfig, permission: PermissionName, decision: PermissionDecision): DotConfig {
  const { [permission]: _replaced, ...rest } = config.permissions;
  const server = mcpServerOf(permission);
  const holds = server === null || server in config.mcp_servers;
  return { ...config, permissions: !holds || decision === defaultDecision(permission) ? rest : { ...rest, [permission]: decision } };
}

/** The config with one MCP server declared as `server`, or no longer declared (null): its permission goes with it. */
export function setMcpServer(config: DotConfig, name: string, server: McpServerConfig | null): DotConfig {
  const { [name]: _replaced, ...others } = config.mcp_servers;
  if (server !== null) return { ...config, mcp_servers: { ...others, [name]: server } };
  const { [mcpPermission(name)]: _dropped, ...permissions } = config.permissions;
  return { ...config, mcp_servers: others, permissions };
}

/** A server as a change shows it: what it runs, or where it is. */
export function mcpServerSummary(server: McpServerConfig): string {
  return isMcpStdioServer(server) ? [server.command, ...server.args].join(" ") : server.url;
}

const SCALARS = {
  "name": { label: "Name", applies: "turn", get: (c) => c.name, set: (c, v) => ({ ...c, name: String(v) }), show: shownPlain },
  "instructions": {
    label: "Instructions",
    applies: "turn",
    get: (c) => c.instructions ?? "",
    set: (c, v) => {
      const { instructions: _replaced, ...rest } = c;
      return v === "" ? rest : { ...rest, instructions: String(v) };
    },
    show: shownText,
  },
  "model.id": { label: "Model", applies: "turn", get: (c) => c.model.id, set: (c, v) => ({ ...c, model: { ...c.model, id: String(v) } }), show: shownPlain },
  "models.summary": {
    label: "Summary model",
    applies: "turn",
    get: (c) => c.models.summary ?? "",
    set: (c, v) => {
      const { summary: _replaced, ...rest } = c.models;
      return { ...c, models: v === "" ? rest : { ...rest, summary: String(v) } };
    },
    show: (v) => (v === "" ? "the Dot's own model" : String(v)),
  },
  "computer.cpu": { label: "Processors", applies: "start", get: (c) => c.computer.cpu, set: (c, v) => ({ ...c, computer: { ...c.computer, cpu: Number(v) } }), show: shownPlain },
  "computer.memory": { label: "Memory", applies: "start", get: (c) => c.computer.memory, set: (c, v) => ({ ...c, computer: { ...c.computer, memory: String(v) } }), show: shownPlain },
  "computer.disk": { label: "Disk", applies: "start", get: (c) => c.computer.disk, set: (c, v) => ({ ...c, computer: { ...c.computer, disk: String(v) } }), show: shownPlain },
  "computer.idle_timeout": {
    label: "Sleep after",
    applies: "turn",
    get: (c) => c.computer.idle_timeout,
    set: (c, v) => ({ ...c, computer: { ...c.computer, idle_timeout: String(v) } }),
    show: (v) => (v === "0" ? "never" : String(v)),
  },
  "limits.max_steps_per_task": {
    label: "Steps per task",
    applies: "turn",
    get: (c) => c.limits.max_steps_per_task,
    set: (c, v) => ({ ...c, limits: { ...c.limits, max_steps_per_task: Number(v) } }),
    show: shownPlain,
  },
  "limits.max_cost_per_task_usd": {
    label: "Spending cap per task",
    applies: "turn",
    get: (c) => c.limits.max_cost_per_task_usd,
    set: (c, v) => ({ ...c, limits: { ...c.limits, max_cost_per_task_usd: Number(v) } }),
    show: (v) => `$${v}`,
  },
} satisfies Record<string, Omit<ConfigField, "key">>;

/** The settings the page has a control for, by their config path (the permissions are set with `setPermission`). */
export type FieldKey = keyof typeof SCALARS;

const PERMISSION_FIELDS: readonly ConfigField[] = PERMISSIONS.map((permission) => ({
  key: `permissions.${permission}`,
  label: PERMISSION_INFO[permission].label,
  applies: "turn",
  get: (c: DotConfig) => resolvePermission(c, permission),
  set: (c: DotConfig, v: ConfigValue) => setPermission(c, permission, v as PermissionDecision),
  show: shownPlain,
}));

/** A value as JSON with the keys of every object in order, so two configs that say the same compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** The fields of one MCP server: its entry (compared whole), then its permission. A server absent from a config is "". */
function mcpServerFields(name: string): ConfigField[] {
  const permission = mcpPermission(name);
  return [
    {
      key: `mcp_servers.${name}`,
      label: `MCP server ${name}`,
      applies: "turn",
      get: (c) => (name in c.mcp_servers ? canonicalJson(c.mcp_servers[name]) : ""),
      set: (c, v) => setMcpServer(c, name, v === "" ? null : (JSON.parse(String(v)) as McpServerConfig)),
      show: (v) => (v === "" ? "(not declared)" : mcpServerSummary(JSON.parse(String(v)) as McpServerConfig)),
    },
    {
      key: `permissions.${permission}`,
      label: `Permission of MCP server ${name}`,
      applies: "turn",
      get: (c) => resolvePermission(c, permission),
      set: (c, v) => setPermission(c, permission, v as PermissionDecision),
      show: shownPlain,
    },
  ];
}

/**
 * Every field of the configs given, in the order the page lists them: the settings, the permissions, then each MCP
 * server any of them declares, by name.
 */
function fieldsOf(...configs: DotConfig[]): ConfigField[] {
  const servers = [...new Set(configs.flatMap((c) => mcpServerNames(c)))].sort();
  return [...Object.entries(SCALARS).map(([key, f]): ConfigField => ({ key, ...f })), ...PERMISSION_FIELDS, ...servers.flatMap(mcpServerFields)];
}

/** The config with one setting set (a permission is set with `setPermission`). */
export function setField(config: DotConfig, key: FieldKey, value: ConfigValue): DotConfig {
  return SCALARS[key].set(config, value);
}

export interface ConfigChange {
  /** The config path of the field; `permissions.<name>` for a permission. */
  key: string;
  label: string;
  before: string;
  after: string;
  applies: Applies;
}

/** What differs between two configs, field by field. Empty when they amount to the same Dot. */
export function configChanges(before: DotConfig, after: DotConfig): ConfigChange[] {
  return fieldsOf(before, after).flatMap((f) => {
    const was = f.get(before);
    const now = f.get(after);
    return was === now ? [] : [{ key: f.key, label: f.label, before: f.show(was), after: f.show(now), applies: f.applies }];
  });
}

/**
 * The edits `mine` makes to `base`, put on top of `latest`: the config as it is now, which someone else changed after
 * `base` was read (another tab, an "Always allow"). A field only `latest` changed keeps what `latest` says; a field
 * `mine` changed takes what `mine` says, whatever `latest` says of it, and the review before the save shows it against
 * `latest`.
 */
export function rebase(base: DotConfig, mine: DotConfig, latest: DotConfig): DotConfig {
  return fieldsOf(base, mine, latest).reduce((merged, f) => {
    const value = f.get(mine);
    return value === f.get(base) ? merged : f.set(merged, value);
  }, latest);
}

/** What a save says once it is done: when the Dot has the change. */
export function saveNotice(changes: readonly ConfigChange[], computerUp: boolean): string {
  const atStart = changes.some((change) => change.applies === "start");
  const now = changes.some((change) => change.applies === "turn");
  const parts: string[] = [];
  if (now) parts.push(computerUp ? "The change applies from the Dot's next turn." : "The Dot gets the change when its computer starts.");
  if (atStart) parts.push(now ? "The computer's size applies the next time it starts." : "The change applies the next time the computer starts.");
  return `Saved. ${parts.join(" ")}`.trim();
}
