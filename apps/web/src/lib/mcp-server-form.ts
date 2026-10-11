/**
 * The form of one MCP server in the settings: what a person types (a command line or a URL, one variable, header or
 * secret name per line) and the config entry it is (`mcp_servers.<name>`). The schema of the shared package checks the
 * entry once it is in the draft; this only turns lines into the entry's shape and says which line it cannot read.
 */
import { isMcpStdioServer, MCP_TIMEOUT_BOUNDS, type McpServerConfig } from "@invisible-dots/shared/browser";

export type McpServerKind = "command" | "url";

export interface McpServerForm {
  kind: McpServerKind;
  command: string;
  /** One argument per line, as typed: an argument may hold spaces. */
  args: string;
  /** `NAME=value`, one per line. */
  env: string;
  url: string;
  /** `Name: value`, one per line. */
  headers: string;
  /** One secret name per line: an environment variable of a command, a header of a URL. */
  secrets: string;
  timeoutS: number;
}

export const EMPTY_MCP_SERVER_FORM: McpServerForm = {
  kind: "command",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  secrets: "",
  timeoutS: MCP_TIMEOUT_BOUNDS.default,
};

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** `NAME<separator>value` lines as a record, or the first line that has no separator. */
function pairs(text: string, separator: string): { ok: true; value: Record<string, string> } | { ok: false; line: string } {
  const value: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    if (at <= 0) return { ok: false, line };
    value[line.slice(0, at).trim()] = line.slice(at + separator.length).trim();
  }
  return { ok: true, value };
}

/** The form of a declared server, to edit it. */
export function formOfServer(server: McpServerConfig): McpServerForm {
  if (isMcpStdioServer(server)) {
    return {
      ...EMPTY_MCP_SERVER_FORM,
      kind: "command",
      command: server.command,
      args: server.args.join("\n"),
      env: Object.entries(server.env).map(([name, value]) => `${name}=${value}`).join("\n"),
      secrets: server.secrets.join("\n"),
      timeoutS: server.timeout_s,
    };
  }
  return {
    ...EMPTY_MCP_SERVER_FORM,
    kind: "url",
    url: server.url,
    headers: Object.entries(server.headers).map(([name, value]) => `${name}: ${value}`).join("\n"),
    secrets: server.secrets.join("\n"),
    timeoutS: server.timeout_s,
  };
}

/** The config entry the form says, or the line it cannot read. */
export function serverOfForm(form: McpServerForm): { ok: true; server: McpServerConfig } | { ok: false; problem: string } {
  const secrets = lines(form.secrets);
  if (form.kind === "command") {
    const env = pairs(form.env, "=");
    if (!env.ok) return { ok: false, problem: `"${env.line}" is not NAME=value` };
    return { ok: true, server: { command: form.command.trim(), args: lines(form.args), env: env.value, secrets, timeout_s: form.timeoutS } };
  }
  const headers = pairs(form.headers, ":");
  if (!headers.ok) return { ok: false, problem: `"${headers.line}" is not Name: value` };
  return { ok: true, server: { url: form.url.trim(), headers: headers.value, secrets, timeout_s: form.timeoutS } };
}
