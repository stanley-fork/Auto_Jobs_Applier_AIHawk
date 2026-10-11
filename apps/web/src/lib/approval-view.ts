/**
 * What the person is shown of one approval: what the Dot wants to do, in what words, how risky it is, and the
 * arguments of the call in the form that reads best for the tool (a command, a diff, an address, a schedule).
 *
 * The arguments come from the engine's table (`tool_arguments` in nanobot/dots/permissions.py): all of a call's
 * arguments, bar a secret the table redacts. So what is shown here is what the call will do, not a summary of it.
 */
import {
  GUEST_PATHS,
  isPermissionName,
  mcpServerOf,
  permissionInfo as sharedPermissionInfo,
  type PermissionInfo,
  type PermissionName,
  type PermissionRisk,
  type ToolInfo,
} from "@invisible-dots/shared/browser";
import { additionDiff, replacementDiff, type DiffLine } from "./diff";
import { toolLabel } from "./events/tool-labels";
import { formatDate } from "./format";
import type { Approval } from "./types";

/** One approval as the card reads it. The record of the approvals route and the event of the live stream both make one. */
export interface ApprovalAsk {
  id: string;
  dotId: string;
  /** The task that asked; null when the chat did. */
  taskId: string | null;
  tool: string;
  permission: string;
  arguments: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export function askOfRecord(record: Approval): ApprovalAsk {
  return {
    id: record.id,
    dotId: record.dot_id,
    taskId: record.task_id,
    tool: record.tool,
    permission: record.permission,
    arguments: record.arguments ?? {},
    reason: record.reason,
    createdAt: record.created_at,
  };
}

/** Where a Dot's own work goes: a relative path in a file tool means a path under it. */
export const WORKSPACE: string = GUEST_PATHS.workspace;

/** The Dot's own home, where `~` points. (The host's file routes read a relative path against it; the engine's file tools, whose approval this is, read it against the workspace, and resolve `..`.) */
const HOME: string = GUEST_PATHS.home;

/** A path with its `.` and `..` segments resolved; `..` above the root stays at the root. */
function resolved(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Whether a path a file tool was given names something outside the workspace: the engine resolves a relative one against it. */
export function outsideWorkspace(path: string): boolean {
  const trimmed = path.trim();
  const absolute = trimmed === "~" || trimmed.startsWith("~/") ? `${HOME}${trimmed.slice(1)}` : trimmed.startsWith("/") ? trimmed : `${WORKSPACE}/${trimmed}`;
  const target = resolved(absolute);
  return target !== WORKSPACE && !target.startsWith(`${WORKSPACE}/`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The path or paths of the files a call of a file-changing tool changes. */
function changedPaths(ask: ApprovalAsk): string[] {
  const args = ask.arguments;
  if (ask.tool === "apply_patch") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return edits.flatMap((edit) => (typeof edit === "object" && edit !== null ? [text((edit as Record<string, unknown>).path)] : [])).filter((path) => path !== "");
  }
  const path = text(args.path);
  return path === "" ? [] : [path];
}

/**
 * Whether answering "allow" here is the kind of answer to stop and think about: a command, the deletion of a browser
 * identity (its logins with it), a change to a file outside the workspace, or a tool of an MCP server, which does
 * whatever that server does.
 */
export function isDestructive(ask: ApprovalAsk): boolean {
  if (ask.permission === "computer.exec" || ask.permission === "browser.identity.delete") return true;
  if (mcpServerOf(ask.permission) !== null) return true;
  return ask.permission === "files.write" && changedPaths(ask).some(outsideWorkspace);
}

/** The words for a permission: its name and what it lets the Dot do; null for one a Dot's config can no longer name. */
export function permissionInfo(permission: string): (PermissionInfo & { permission: PermissionName }) | null {
  const info = sharedPermissionInfo(permission);
  return info !== null && isPermissionName(permission) ? { ...info, permission } : null;
}

export const RISK_LABEL: Record<PermissionRisk, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

/** The question: what the Dot wants to do, as the engine's table words it. */
export function askTitle(ask: ApprovalAsk): string {
  return `Wants to ${toolLabel(ask.tool).ask}`;
}

/** The same said of an approval that was answered: it may never have happened. */
export function askedTitle(ask: ApprovalAsk): string {
  return `Asked to ${toolLabel(ask.tool).ask}`;
}

export interface Fact {
  label: string;
  value: string;
}

export interface PatchFile {
  path: string;
  /** replace or add. */
  action: string;
  diff: DiffLine[];
}

export type ApprovalBody =
  | { kind: "command"; command: string; where: string | null }
  | { kind: "write"; path: string; diff: DiffLine[] }
  | { kind: "edit"; path: string; diff: DiffLine[]; replaceAll: boolean }
  | { kind: "patch"; files: PatchFile[]; dryRun: boolean }
  | { kind: "facts"; facts: Fact[] };

/** What a recurring or one-off automation says about when it runs. */
export function schedulePhrase(args: Record<string, unknown>): string {
  const seconds = args.every_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    const unit = (size: number, name: string) => {
      const count = seconds / size;
      return count === 1 ? `every ${name}` : `every ${count} ${name}s`;
    };
    if (seconds % 86_400 === 0) return unit(86_400, "day");
    if (seconds % 3600 === 0) return unit(3600, "hour");
    if (seconds % 60 === 0) return unit(60, "minute");
    return seconds === 1 ? "every second" : `every ${seconds} seconds`;
  }
  const expression = text(args.cron_expr);
  if (expression !== "") return `cron "${expression}"${text(args.tz) ? ` (${text(args.tz)})` : ""}`;
  const at = text(args.at);
  return at === "" ? "" : `once, at ${formatDate(at)}`;
}

/** The labels of the arguments the engine's tools take, in the order they are shown. */
const FACT_LABELS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["identity_id", "Browser identity"],
  ["name", "Name"],
  ["url", "Address"],
  ["selector", "Element"],
  ["text", "Text to type"],
  ["value", "Option"],
  ["key", "Key"],
  ["direction", "Direction"],
  ["path", "Path"],
  ["query", "Search for"],
  ["pattern", "Pattern"],
  ["glob", "Files matching"],
  ["session_id", "Command session"],
  ["input", "Input"],
  ["terminate", "Ends the session"],
  ["action", "Action"],
  ["message", "Message"],
  ["job_id", "Automation"],
];

const SCHEDULE_KEYS = ["every_seconds", "cron_expr", "tz", "at"];
const KNOWN_KEYS = new Set([...FACT_LABELS.map(([key]) => key), ...SCHEDULE_KEYS, "x", "y", "proxy"]);

/** Nothing to show: absent, blank, or an empty list or object. */
function blank(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The arguments a call carries, one fact each, with the words of the tool's own table; an argument this list does not know keeps its name. */
export function argumentFacts(args: Record<string, unknown>): Fact[] {
  const facts: Fact[] = [];
  for (const [key, label] of FACT_LABELS) {
    const value = args[key];
    if (blank(value)) continue;
    facts.push({ label, value: show(value) });
  }
  if (typeof args.x === "number" && typeof args.y === "number") facts.push({ label: "Position", value: `${args.x}, ${args.y}` });
  const proxy = text(args.proxy);
  if (proxy !== "") facts.push({ label: "Proxy", value: "***" });
  const schedule = schedulePhrase(args);
  if (schedule !== "") facts.push({ label: "Schedule", value: schedule });
  for (const [key, value] of Object.entries(args)) {
    if (KNOWN_KEYS.has(key) || blank(value)) continue;
    facts.push({ label: key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), value: show(value) });
  }
  return facts;
}

/** The body of the card: the part of the call that tells the person what they would be allowing. */
export function approvalBody(ask: ApprovalAsk): ApprovalBody {
  const args = ask.arguments;
  switch (ask.tool) {
    case "exec": {
      const command = text(args.command) || text(args.cmd);
      if (command !== "") return { kind: "command", command, where: text(args.working_dir) || text(args.workdir) || null };
      break;
    }
    case "write_file":
      if (text(args.path) !== "" && typeof args.content === "string") return { kind: "write", path: text(args.path), diff: additionDiff(args.content) };
      break;
    case "edit_file":
      if (text(args.path) !== "" && typeof args.old_text === "string" && typeof args.new_text === "string") {
        return { kind: "edit", path: text(args.path), diff: replacementDiff(args.old_text, args.new_text), replaceAll: args.replace_all === true };
      }
      break;
    case "apply_patch": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const files = edits.flatMap((edit): PatchFile[] => {
        if (typeof edit !== "object" || edit === null) return [];
        const e = edit as Record<string, unknown>;
        const action = text(e.action) || "replace";
        const diff = action === "add" ? additionDiff(text(e.new_text)) : replacementDiff(text(e.old_text), text(e.new_text));
        return text(e.path) === "" ? [] : [{ path: text(e.path), action, diff }];
      });
      if (files.length > 0) return { kind: "patch", files, dryRun: args.dry_run === true };
      break;
    }
    default:
      break;
  }
  return { kind: "facts", facts: argumentFacts(args) };
}

/**
 * The raw arguments, as JSON, cut when they are enormous (a file's whole content can be); `cut` says it was. The engine
 * already shows an identity's proxy as `***`; it is hidden here too, so that no path to this page can show one (a
 * proxy is a secret of the Dot, never the host UI's).
 */
export function boundedJson(args: Record<string, unknown>, max = 20_000): { text: string; cut: boolean } {
  const shown = typeof args.proxy === "string" ? { ...args, proxy: "***" } : args;
  const full = JSON.stringify(shown, null, 2);
  return full.length <= max ? { text: full, cut: false } : { text: full.slice(0, max), cut: true };
}

/** The tools a permission covers, by name, from the Dot's tool table; null when the table could not be read. */
export function toolsCovered(permission: string, tools: readonly ToolInfo[] | null): string[] | null {
  return tools === null ? null : tools.filter((tool) => tool.permission === permission).map((tool) => tool.name);
}

/** The receipt of an answer, in a few words. */
export type Receipt = "approved" | "rejected" | "expired" | "elsewhere";

export const RECEIPT_WORD: Record<Receipt, string> = {
  approved: "Allowed",
  rejected: "Denied",
  expired: "Expired: the task ended before anyone answered",
  elsewhere: "Already answered, on another tab or another channel",
};
