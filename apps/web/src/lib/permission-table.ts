/**
 * The permission editor's rows: one per permission a config can name, with the words for it (`PERMISSION_INFO`), what
 * it is set to, what it is set to when the config says nothing, and the tools of the Dot's engine that use it with
 * whether the model is offered each one right now. The tools come from the Dot's own table (`GET /tools`), which
 * the engine owns, so a tool added there shows up here with no change in this file.
 */
import { mcpPermission, mcpServerNames, permissionInfo, PERMISSIONS, resolvePermission, type DotConfig, type PermissionDecision, type PermissionName, type PermissionRisk, type ToolInfo } from "@invisible-dots/shared/browser";
import { defaultDecision } from "./config-fields";

export const DECISIONS: readonly PermissionDecision[] = ["allow", "ask", "deny"];

export const DECISION_LABEL: Record<PermissionDecision, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };

/** What each decision means for the Dot, in the words under a permission. */
export const DECISION_MEANING: Record<PermissionDecision, string> = {
  allow: "The Dot does it without asking.",
  ask: "The Dot waits for your answer, and keeps waiting across restarts.",
  deny: "The Dot is not offered the tools, so it cannot do it.",
};

export interface ToolState {
  name: string;
  /** Whether the model is offered the tool now, as the Dot has its config (not as an unsaved edit would have it). */
  offered: boolean;
}

export interface PermissionRow {
  permission: PermissionName;
  label: string;
  description: string;
  risk: PermissionRisk;
  decision: PermissionDecision;
  defaultDecision: PermissionDecision;
  /** The row is set to something other than what the saved config says. */
  changed: boolean;
  /** The tools that use this permission; null when the Dot's tool table could not be read (its computer is not running). */
  tools: ToolState[] | null;
}

export interface PermissionGroup {
  id: string;
  label: string;
  rows: PermissionRow[];
}

/** The permissions are named `<group>.<what>` (`browser.identity.launch`) or by one word (`automations`). */
const GROUP_LABELS: Readonly<Record<string, string>> = {
  computer: "Commands and desktop",
  files: "Files",
  browser: "Browser",
  automations: "Automations",
  mcp: "MCP servers",
};

function groupOf(permission: PermissionName): string {
  return permission.split(".")[0]!;
}

/**
 * The rows of the editor, grouped in the order of `PERMISSIONS`, then one row per MCP server the draft declares, by name. `saved`
 * is the config as the host has it; `draft` what the page holds.
 */
export function permissionGroups(draft: DotConfig, saved: DotConfig, tools: readonly ToolInfo[] | null): PermissionGroup[] {
  const groups: PermissionGroup[] = [];
  for (const permission of [...PERMISSIONS, ...mcpServerNames(draft).map(mcpPermission)]) {
    const id = groupOf(permission);
    let group = groups.find((g) => g.id === id);
    if (!group) {
      group = { id, label: GROUP_LABELS[id] ?? id, rows: [] };
      groups.push(group);
    }
    const info = permissionInfo(permission)!;
    const decision = resolvePermission(draft, permission);
    group.rows.push({
      permission,
      label: info.label,
      description: info.description,
      risk: info.risk,
      decision,
      defaultDecision: defaultDecision(permission),
      changed: decision !== resolvePermission(saved, permission),
      tools: tools === null ? null : tools.filter((tool) => tool.permission === permission).map(({ name, offered }) => ({ name, offered })),
    });
  }
  return groups;
}
