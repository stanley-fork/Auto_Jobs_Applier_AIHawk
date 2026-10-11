import { describe, expect, it } from "vitest";
import {
  checkMcpSecret,
  defaultPermission,
  isPermissionName,
  MCP_TIMEOUT_BOUNDS,
  mcpServerOf,
  parseDotConfig,
  parseOutboundEvent,
  permissionInfo,
  permissionNames,
  resolvePermission,
  safeParseDotConfig,
  toolInfoSchema,
  toRuntimeConfig,
} from "../src/index.js";

const MINIMAL = { name: "a", model: { provider: "openrouter", id: "openrouter/auto" } };

function issuesOf(input: unknown): string[] {
  const result = safeParseDotConfig(input);
  if (result.ok) throw new Error("expected the config to be rejected");
  return result.error.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("the MCP servers of a Dot's config", () => {
  it("reads a server the Dot starts and one it reaches, with the defaults of what they leave out", () => {
    const config = parseDotConfig({
      ...MINIMAL,
      mcp_servers: {
        time: { command: "uvx", args: ["mcp-server-time"] },
        search: { url: "https://search.example/mcp", secrets: ["Authorization"], timeout_s: 30 },
      },
    });
    expect(config.mcp_servers).toEqual({
      time: { command: "uvx", args: ["mcp-server-time"], env: {}, secrets: [], timeout_s: MCP_TIMEOUT_BOUNDS.default },
      search: { url: "https://search.example/mcp", headers: {}, secrets: ["Authorization"], timeout_s: 30 },
    });
    expect(parseDotConfig(MINIMAL).mcp_servers).toEqual({});
  });

  it("refuses a name its tools could not carry, a URL that is not the web, an entry of two kinds and a timeout out of bounds", () => {
    expect(issuesOf({ ...MINIMAL, mcp_servers: { My_Server: { command: "x" } } }).join()).toMatch(/MCP server's name/);
    expect(issuesOf({ ...MINIMAL, mcp_servers: { web: { url: "file:///etc/passwd" } } }).join()).toMatch(/mcp_servers/);
    expect(issuesOf({ ...MINIMAL, mcp_servers: { both: { command: "x", url: "https://a.example" } } }).join()).toMatch(/mcp_servers/);
    expect(issuesOf({ ...MINIMAL, mcp_servers: { slow: { command: "x", timeout_s: MCP_TIMEOUT_BOUNDS.max + 1 } } }).join()).toMatch(/mcp_servers/);
  });

  it("refuses a secret named twice, or named as a value the entry also writes", () => {
    expect(issuesOf({ ...MINIMAL, mcp_servers: { s: { command: "x", secrets: ["TOKEN", "TOKEN"] } } }).join()).toMatch(/named twice/);
    expect(issuesOf({ ...MINIMAL, mcp_servers: { s: { command: "x", env: { TOKEN: "a" }, secrets: ["TOKEN"] } } }).join()).toMatch(/both a secret and a value written in env/);
    expect(issuesOf({ ...MINIMAL, mcp_servers: { s: { url: "https://a.example", headers: { authorization: "x" }, secrets: ["Authorization"] } } }).join()).toMatch(/headers/);
  });

  it("holds the permission of a declared server only, and refuses one of a server it does not declare", () => {
    const config = parseDotConfig({ ...MINIMAL, mcp_servers: { time: { command: "uvx" } }, permissions: { "mcp.time": "allow" } });
    expect(config.permissions).toEqual({ "mcp.time": "allow" });
    expect(issuesOf({ ...MINIMAL, permissions: { "mcp.time": "allow" } })).toEqual([
      'permissions.mcp.time: "mcp.time" is the permission of an MCP server this config does not declare in mcp_servers',
    ]);
  });
});

describe("the permission of an MCP server", () => {
  const config = parseDotConfig({ ...MINIMAL, mcp_servers: { time: { command: "uvx" }, web: { url: "https://w.example/mcp" } }, permissions: { "mcp.web": "deny" } });

  it("asks unless the config says otherwise, and is denied for a server the config does not declare", () => {
    expect(resolvePermission(config, "mcp.time")).toBe("ask");
    expect(resolvePermission(config, "mcp.web")).toBe("deny");
    expect(resolvePermission(config, "mcp.ghost")).toBe("deny");
    expect(defaultPermission("mcp.anything")).toBe("ask");
    expect(defaultPermission("computer.exec")).toBe("allow");
  });

  it("is pushed to the engine resolved, after the permissions every Dot has", () => {
    const runtime = toRuntimeConfig(config);
    expect(permissionNames(config).slice(-2)).toEqual(["mcp.time", "mcp.web"]);
    expect(runtime.permissions["mcp.time"]).toBe("ask");
    expect(runtime.permissions["mcp.web"]).toBe("deny");
    expect(runtime.mcp_servers).toEqual(config.mcp_servers);
  });

  it("is a permission by its form, with words written from the server's name and the risk of running commands", () => {
    expect(isPermissionName("mcp.time-zones")).toBe(true);
    expect(isPermissionName("mcp.Time")).toBe(false);
    expect(isPermissionName("mcp.")).toBe(false);
    expect(mcpServerOf("mcp.time-zones")).toBe("time-zones");
    expect(mcpServerOf("computer.exec")).toBeNull();
    expect(permissionInfo("mcp.time")).toMatchObject({ label: "MCP server time", risk: "high" });
    expect(permissionInfo("files.read")?.label).toBeTruthy();
    expect(permissionInfo("root")).toBeNull();
  });

  it("is what a tool row and an approval may name; a malformed one is refused", () => {
    const row = { name: "mcp_time_now", permission: "mcp.time", offered: true, description: "Now." };
    expect(toolInfoSchema.safeParse(row).success).toBe(true);
    expect(toolInfoSchema.safeParse({ ...row, permission: "mcp.bad_name" }).success).toBe(false);
    const event = {
      seq: 1,
      id: "e",
      type: "approval.requested",
      ts: "2026-10-11T10:00:00Z",
      data: { approval_id: "apr_1", tool: "mcp_time_now", permission: "mcp.time", arguments: {}, reason: "asks" },
    };
    expect(parseOutboundEvent(event).type).toBe("approval.requested");
    expect(() => parseOutboundEvent({ ...event, data: { ...event.data, permission: "mcp.Bad" } })).toThrow(/permission/);
  });
});

describe("the value of an MCP server's secret", () => {
  it("is printable ASCII, spaces allowed, its ends trimmed; a line break or nothing is refused without the value", () => {
    expect(checkMcpSecret("  Bearer tok-1  ")).toEqual({ ok: true, value: "Bearer tok-1" });
    const broken = checkMcpSecret("tok-SECRET\nX");
    expect(broken.ok).toBe(false);
    expect(JSON.stringify(broken)).not.toContain("SECRET");
    expect(checkMcpSecret("")).toEqual({ ok: false, problem: "value must be a non-empty string" });
    expect(checkMcpSecret(5).ok).toBe(false);
  });
});
