import { parseDotConfig, resolvePermission } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { isDestructive, permissionInfo, type ApprovalAsk } from "../src/lib/approval-view";
import { configChanges, rebase, setMcpServer, setPermission } from "../src/lib/config-fields";
import { EMPTY_MCP_SERVER_FORM, formOfServer, serverOfForm } from "../src/lib/mcp-server-form";
import { presetOf, presetPermissions } from "../src/lib/permission-presets";
import { permissionGroups } from "../src/lib/permission-table";
import { fullConfig } from "./support/config";

const TIME = { command: "uvx", args: ["mcp-server-time"], env: {}, secrets: ["TIME_TOKEN"], timeout_s: 120, startup_timeout_s: 60 };
const WEB = { url: "https://web.example/mcp", headers: { "X-Client": "dots" }, secrets: ["Authorization"], timeout_s: 30, startup_timeout_s: 90 };

describe("the form of an MCP server", () => {
  it("is the entry it was made from, for a program and for a URL", () => {
    for (const server of [TIME, WEB]) {
      const back = serverOfForm(formOfServer(server));
      expect(back).toEqual({ ok: true, server });
    }
  });

  it("reads one argument, variable, header or secret a line, keeps the spaces inside one, and names a line it cannot read", () => {
    const form = { ...EMPTY_MCP_SERVER_FORM, command: " npx ", args: "-y\n@scope/server --flag\n\n", env: "MODE=a=b\n", secrets: "API_KEY\n" };
    expect(serverOfForm(form)).toEqual({ ok: true, server: { command: "npx", args: ["-y", "@scope/server --flag"], env: { MODE: "a=b" }, secrets: ["API_KEY"], timeout_s: 120, startup_timeout_s: 60 } });
    expect(serverOfForm({ ...form, env: "MODE" })).toEqual({ ok: false, problem: '"MODE" is not NAME=value' });
    expect(serverOfForm({ ...EMPTY_MCP_SERVER_FORM, kind: "url", url: "https://a.example", headers: "no colon" })).toEqual({ ok: false, problem: '"no colon" is not Name: value' });
  });
});

describe("an MCP server in the settings", () => {
  const base = fullConfig({ mcp_servers: { time: TIME } });

  it("is added and removed in the draft, and its permission goes with it", () => {
    const added = setMcpServer(base, "web", WEB);
    expect(parseDotConfig(added).mcp_servers).toEqual({ time: TIME, web: WEB });
    const allowed = setPermission(added, "mcp.web", "allow");
    expect(allowed.permissions).toEqual({ "mcp.web": "allow" });
    const removed = setMcpServer(allowed, "web", null);
    expect(removed.permissions).toEqual({});
    expect(parseDotConfig(removed).mcp_servers).toEqual({ time: TIME });
  });

  it("never writes the permission of a server the config does not declare, which the schema would refuse", () => {
    expect(setPermission(base, "mcp.ghost", "allow").permissions).toEqual({});
    expect(setPermission(base, "mcp.time", "ask").permissions).toEqual({});
    expect(setPermission(base, "mcp.time", "deny").permissions).toEqual({ "mcp.time": "deny" });
  });

  it("is a change the review lists, by what it runs, and its permission is another", () => {
    const changes = configChanges(base, setPermission(setMcpServer(base, "web", WEB), "mcp.web", "allow"));
    expect(changes.map((c) => [c.key, c.before, c.after])).toEqual([
      ["mcp_servers.web", "(not declared)", "https://web.example/mcp"],
      ["permissions.mcp.web", "deny", "allow"],
    ]);
    // The same entry with its keys in another order is no change.
    const reordered = { ...base, mcp_servers: { time: { startup_timeout_s: 60, timeout_s: 120, secrets: ["TIME_TOKEN"], env: {}, args: ["mcp-server-time"], command: "uvx" } } };
    expect(configChanges(base, reordered)).toEqual([]);
  });

  it("an edit put on top of a config changed meanwhile keeps the server someone else added and the one this edit added", () => {
    const latest = setMcpServer(base, "web", WEB);
    const mine = setMcpServer(base, "files", { command: "npx", args: ["-y", "files"], env: {}, secrets: [], timeout_s: 60, startup_timeout_s: 60 });
    const merged = rebase(base, mine, latest);
    expect(Object.keys(merged.mcp_servers).sort()).toEqual(["files", "time", "web"]);
    // Removing a server in the edit removes it from the newer config too, with its permission.
    const dropped = rebase(latest, setMcpServer(latest, "time", null), setPermission(latest, "mcp.time", "allow"));
    expect(dropped.mcp_servers).not.toHaveProperty("time");
    expect(dropped.permissions).toEqual({});
  });

  it("a preset leaves the servers' permissions as they are, and they do not decide which preset the config is", () => {
    const current = { "mcp.time": "deny" as const, "computer.exec": "ask" as const };
    expect(presetPermissions("autonomous", current)["mcp.time"]).toBe("deny");
    expect(presetPermissions("careful", current)).toMatchObject({ "mcp.time": "deny", "computer.exec": "ask", "files.write": "ask" });
    expect(presetOf({ "mcp.time": "allow" })).toBe("balanced");
  });

  it("has a row under MCP servers with the risk of running commands, the default ask, and the tools of the server", () => {
    const tools = [{ name: "mcp_time_now", permission: "mcp.time" as const, offered: true, description: "Now." }];
    const group = permissionGroups(base, base, tools).find((g) => g.id === "mcp");
    expect(group?.label).toBe("MCP servers");
    expect(group?.rows).toEqual([
      {
        permission: "mcp.time",
        label: "MCP server time",
        description: expect.stringContaining('"time"'),
        risk: "high",
        decision: "ask",
        defaultDecision: "ask",
        changed: false,
        tools: [{ name: "mcp_time_now", offered: true }],
      },
    ]);
    expect(resolvePermission(base, "mcp.time")).toBe("ask");
  });

  it("an approval of one of its tools is named after the server and is the kind to stop and think about", () => {
    const ask = { permission: "mcp.time", tool: "mcp_time_now", arguments: {} } as unknown as ApprovalAsk;
    expect(permissionInfo("mcp.time")).toMatchObject({ permission: "mcp.time", label: "MCP server time", risk: "high" });
    expect(isDestructive(ask)).toBe(true);
    expect(permissionInfo("mcp.Bad")).toBeNull();
  });
});
