import { parseDotConfig, PERMISSIONS, resolvePermission, type DotConfig } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { configChanges, defaultDecision, rebase, saveNotice, setField, setPermission } from "../src/lib/config-fields";
import { fullConfig } from "./support/config";

describe("setPermission", () => {
  it("writes a decision that differs from the default, and nothing for one that is the default", () => {
    const config = fullConfig();
    expect(defaultDecision("computer.exec")).toBe("allow");
    expect(setPermission(config, "computer.exec", "ask").permissions).toEqual({ "computer.exec": "ask" });
    expect(setPermission(setPermission(config, "computer.exec", "ask"), "computer.exec", "allow").permissions).toEqual({});
    // A permission that asks by default is written when it is allowed, and not when it asks.
    expect(defaultDecision("automations")).toBe("ask");
    expect(setPermission(config, "automations", "allow").permissions).toEqual({ automations: "allow" });
    expect(setPermission(config, "automations", "ask").permissions).toEqual({});
  });

  it("keeps the other entries and never changes the config it was given", () => {
    const config = fullConfig({ permissions: { "files.write": "ask" } });
    const next = setPermission(config, "computer.exec", "deny");
    expect(next.permissions).toEqual({ "files.write": "ask", "computer.exec": "deny" });
    expect(config.permissions).toEqual({ "files.write": "ask" });
  });

  it("gives a config the schema still accepts, for every permission and every decision", () => {
    for (const permission of PERMISSIONS) {
      for (const decision of ["allow", "ask", "deny"] as const) {
        const next = setPermission(fullConfig(), permission, decision);
        expect(resolvePermission(parseDotConfig(next), permission)).toBe(decision);
      }
    }
  });
});

describe("setField", () => {
  it("sets each setting where the config keeps it, and the result is a config the schema accepts", () => {
    let config = fullConfig();
    config = setField(config, "instructions", "Write to the workspace");
    config = setField(config, "model.id", "openai/gpt-5");
    config = setField(config, "models.summary", "openai/gpt-5-mini");
    config = setField(config, "computer.cpu", 4);
    config = setField(config, "computer.memory", "8gb");
    config = setField(config, "computer.disk", "80gb");
    config = setField(config, "computer.idle_timeout", "1h");
    config = setField(config, "limits.max_steps_per_task", 90);
    config = setField(config, "limits.max_cost_per_task_usd", 2.5);
    expect(parseDotConfig(config)).toEqual({
      name: "fare-watch",
      instructions: "Write to the workspace",
      model: { provider: "openrouter", id: "openai/gpt-5" },
      models: { summary: "openai/gpt-5-mini" },
      computer: { cpu: 4, memory: "8gb", disk: "80gb", idle_timeout: "1h" },
      permissions: {},
      limits: { max_steps_per_task: 90, max_cost_per_task_usd: 2.5 },
      mcp_servers: {},
    });
  });

  it("removes an optional text instead of writing it empty", () => {
    const config = fullConfig({ instructions: "x", models: { summary: "a/b" } });
    expect("instructions" in setField(config, "instructions", "")).toBe(false);
    expect(setField(config, "models.summary", "").models).toEqual({});
  });
});

describe("configChanges", () => {
  it("is empty for a config and itself, and for permissions that say what the defaults say", () => {
    const config = fullConfig();
    expect(configChanges(config, config)).toEqual([]);
    expect(configChanges(config, { ...config, permissions: { "computer.exec": "allow", "automations": "ask" } })).toEqual([]);
  });

  it("lists each changed field with its words, in the order the page has them", () => {
    const before = fullConfig();
    let after = setField(before, "limits.max_cost_per_task_usd", 3);
    after = setField(after, "models.summary", "openai/gpt-5-mini");
    after = setPermission(after, "computer.exec", "ask");
    after = setField(after, "computer.idle_timeout", "0");
    expect(configChanges(before, after)).toEqual([
      { key: "models.summary", label: "Summary model", before: "the Dot's own model", after: "openai/gpt-5-mini", applies: "turn" },
      { key: "computer.idle_timeout", label: "Sleep after", before: "15m", after: "never", applies: "turn" },
      { key: "limits.max_cost_per_task_usd", label: "Spending cap per task", before: "$1", after: "$3", applies: "turn" },
      { key: "permissions.computer.exec", label: "Run commands", before: "allow", after: "ask", applies: "turn" },
    ]);
  });

  it("says that the size of the computer applies at its next start, and cuts a long text", () => {
    const before = fullConfig();
    const changes = configChanges(before, setField(setField(before, "computer.memory", "8gb"), "instructions", "g".repeat(500)));
    expect(changes.find((c) => c.key === "computer.memory")?.applies).toBe("start");
    const instructions = changes.find((c) => c.key === "instructions")!;
    expect(instructions.after.length).toBe(303);
    expect(instructions.after.endsWith("...")).toBe(true);
  });

  it("names an empty text as empty", () => {
    const changes = configChanges(fullConfig({ instructions: "do it" }), fullConfig());
    expect(changes).toEqual([{ key: "instructions", label: "Instructions", before: "do it", after: "(empty)", applies: "turn" }]);
  });
});

describe("rebase", () => {
  const base = fullConfig();

  it("puts my edits on top of a config someone else changed in other fields", () => {
    const mine = setPermission(setField(base, "instructions", "My instructions"), "files.write", "ask");
    const latest = setPermission(setField(base, "limits.max_steps_per_task", 10), "automations", "allow");
    const merged = rebase(base, mine, latest);
    expect(merged.instructions).toBe("My instructions");
    expect(merged.limits.max_steps_per_task).toBe(10);
    expect(merged.permissions).toEqual({ "files.write": "ask", automations: "allow" });
  });

  it("keeps what the other change did to a field I left alone, and takes mine for a field both changed", () => {
    const mine = setPermission(setPermission(base, "computer.exec", "deny"), "files.write", "ask");
    const latest = setPermission(setPermission(base, "computer.exec", "ask"), "files.write", "deny");
    const merged = rebase(base, setPermission(base, "computer.exec", "deny"), latest);
    expect(resolvePermission(merged, "computer.exec")).toBe("deny");
    expect(resolvePermission(merged, "files.write")).toBe("deny");
    expect(configChanges(latest, rebase(base, mine, latest)).map((c) => c.key)).toEqual(["permissions.computer.exec", "permissions.files.write"]);
  });

  it("with no edits is the latest config", () => {
    const latest = setField(base, "instructions", "elsewhere");
    expect(rebase(base, base, latest)).toEqual(latest);
  });

  it("writes a permission I set back to its default as no entry, over an entry the other change made", () => {
    const latest = setPermission(base, "computer.exec", "deny");
    const mine = setPermission(setPermission(base, "computer.exec", "ask"), "computer.exec", "allow");
    // Mine amounts to the base (allow), so nothing of mine is put on top: the other change stays.
    expect(rebase(base, mine, latest).permissions).toEqual({ "computer.exec": "deny" });
  });
});

describe("saveNotice", () => {
  const change = (applies: "turn" | "start") => ({ key: "k", label: "l", before: "a", after: "b", applies });

  it("says when a running Dot has the change, and when a stopped one does", () => {
    expect(saveNotice([change("turn")], true)).toBe("Saved. The change applies from the Dot's next turn.");
    expect(saveNotice([change("turn")], false)).toBe("Saved. The Dot gets the change when its computer starts.");
  });

  it("says the computer's size waits for its next start, alone or beside the rest", () => {
    expect(saveNotice([change("start")], true)).toBe("Saved. The change applies the next time the computer starts.");
    expect(saveNotice([change("turn"), change("start")], true)).toBe("Saved. The change applies from the Dot's next turn. The computer's size applies the next time it starts.");
  });
});

describe("the fields", () => {
  it("cover every setting of the config, so no edit can go unreviewed or be lost by a rebase", () => {
    const a: DotConfig = fullConfig();
    const b: DotConfig = parseDotConfig({
      name: "other",
      instructions: "other",
      model: { provider: "openrouter", id: "x/y" },
      models: { summary: "x/z" },
      computer: { cpu: 3, memory: "8gb", disk: "50gb", idle_timeout: "1h" },
      permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, "deny"])),
      limits: { max_steps_per_task: 5, max_cost_per_task_usd: 7 },
    });
    // Every difference between two whole configs is a listed change, and putting all of them on a base gives the config back.
    expect(configChanges(a, b)).toHaveLength(10 + PERMISSIONS.length);
    expect(configChanges(rebase(a, b, a), b)).toEqual([]);
  });
});
