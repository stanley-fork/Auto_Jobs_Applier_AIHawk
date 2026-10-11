/**
 * The permissions of architecture sections 7 and 8.3: every name a Dot's config
 * can allow, ask or deny, and the words a person is shown for each. The tools
 * themselves, and the permission each exercises, live in one place, the
 * engine's table (`nanobot/dots/permissions.py`); a test keeps every permission
 * that table uses a member of this list.
 */

export const PERMISSIONS = [
  "computer.exec",
  "computer.screenshot",
  "files.read",
  "files.write",
  "browser.identity.list",
  "browser.identity.create",
  "browser.identity.delete",
  "browser.identity.launch",
  "browser.identity.close",
  "browser.navigate",
  "browser.read",
  "browser.act",
  "automations",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** How much a permission can do if the Dot misuses it: what a person weighs when they allow it. */
export type PermissionRisk = "low" | "medium" | "high";

export interface PermissionInfo {
  /** A short name for a switch or a card. */
  label: string;
  /** One sentence on what the Dot can do with it. */
  description: string;
  risk: PermissionRisk;
}

export const PERMISSION_INFO: Record<Permission, PermissionInfo> = {
  "computer.exec": {
    label: "Run commands",
    description: "Run shell commands on the Dot's computer, in the foreground or as background jobs.",
    risk: "high",
  },
  "computer.screenshot": {
    label: "See the desktop",
    description: "Take a screenshot of the Dot's desktop and look at it.",
    risk: "low",
  },
  "files.read": {
    label: "Read files",
    description: "Read, list and search files on the Dot's computer.",
    risk: "low",
  },
  "files.write": {
    label: "Change files",
    description: "Create, replace and edit files on the Dot's computer, including its memory notes.",
    risk: "medium",
  },
  "browser.identity.list": {
    label: "List browser identities",
    description: "See which browser identities the Dot has and whether each is open.",
    risk: "low",
  },
  "browser.identity.create": {
    label: "Create browser identities",
    description: "Create a new browser profile with its own cookies, logins and fingerprint. It uses the Dot's own network exit unless a proxy is given for that one profile.",
    risk: "medium",
  },
  "browser.identity.delete": {
    label: "Delete browser identities",
    description: "Delete a browser identity and its whole profile, logins included. This cannot be undone.",
    risk: "high",
  },
  "browser.identity.launch": {
    label: "Open browsers",
    description: "Open the browser of an identity on the Dot's desktop.",
    risk: "low",
  },
  "browser.identity.close": {
    label: "Close browsers",
    description: "Close the browser of an identity; its profile stays on disk.",
    risk: "low",
  },
  "browser.navigate": {
    label: "Visit pages",
    description: "Load a URL in the browser of an identity, as whoever that identity is logged in as.",
    risk: "medium",
  },
  "browser.read": {
    label: "Read pages",
    description: "Read a page's text and interactive elements, and take screenshots of the browser.",
    risk: "low",
  },
  "browser.act": {
    label: "Use pages",
    description: "Click, type, scroll and press keys in a browser, acting on any site the identity is logged in to.",
    risk: "high",
  },
  automations: {
    label: "Automations",
    description: "Add, list and remove the Dot's own scheduled automations, which keep working after a turn ends.",
    risk: "medium",
  },
};

/**
 * An MCP server the person declares in a Dot's config (`mcp_servers`, section 7) is named by this rule. The name is
 * the prefix of the server's tools as the model sees them, `mcp_<server>_<tool>` (nanobot's naming), and the name
 * of its permission, `mcp.<server>`; it holds no `_` so the server can be read back from a tool's name. The engine
 * keeps a copy in nanobot/dots/protocol.py, kept equal by tests/repo/vendored-nanobot.test.ts.
 */
export const MCP_SERVER_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";
const MCP_SERVER_NAME = new RegExp(MCP_SERVER_NAME_PATTERN);

/** The permission of the tools of one declared MCP server: `mcp.<server>`. */
export type McpPermission = `mcp.${string}`;
/** A permission a Dot's config may name: one of `PERMISSIONS`, or the permission of an MCP server it declares. */
export type PermissionName = Permission | McpPermission;

export function isMcpServerName(value: unknown): value is string {
  return typeof value === "string" && MCP_SERVER_NAME.test(value);
}

export function mcpPermission(server: string): McpPermission {
  return `mcp.${server}`;
}

/** The server a permission name is the permission of, or null when it is not an MCP server's. */
export function mcpServerOf(permission: string): string | null {
  if (!permission.startsWith("mcp.")) return null;
  const server = permission.slice("mcp.".length);
  return isMcpServerName(server) ? server : null;
}

/** Whether a name is a permission by its form: one of `PERMISSIONS`, or `mcp.<server>` with a valid server name. */
export function isPermissionName(value: unknown): value is PermissionName {
  return isPermission(value) || (typeof value === "string" && mcpServerOf(value) !== null);
}

/**
 * The words a person is shown for a permission. An MCP server's are written from its name: what its tools do is the
 * server's, which the host does not know, so it is weighed as high a risk as running commands.
 */
export function permissionInfo(permission: string): PermissionInfo | null {
  if (isPermission(permission)) return PERMISSION_INFO[permission];
  const server = mcpServerOf(permission);
  if (server === null) return null;
  return {
    label: `MCP server ${server}`,
    description: `Use the tools of the MCP server "${server}" this Dot's config declares, which act as that server decides.`,
    risk: "high",
  };
}
