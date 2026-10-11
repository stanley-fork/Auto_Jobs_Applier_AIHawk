/**
 * invisible_engine_dots/ is a hard fork of nanobot (MIT). These checks keep the
 * attribution whole: upstream's LICENSE next to the code, byte for byte; its
 * full text in the notices at the repository root, with a pointer to every
 * nested notice that is in the tree; and the provenance record in UPSTREAM.md.
 * They also keep the parts of nanobot that the host owns out of the fork, and
 * the fork out of this repository's own npm workspace, TypeScript project and
 * vitest run: it is Python, with its own pytest suite (the `engine` job of
 * .github/workflows/tests.yml). And they keep the one copy of the host's
 * contract names that the engine holds, nanobot/dots/protocol.py, equal to
 * packages/shared's.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ROUTES,
  AGENT_STATES,
  ENV,
  GUEST_DISPLAY,
  GUEST_PATHS,
  IDENTITY_ERROR_STATUS,
  INBOUND_EVENT_TYPES,
  MODEL_ROLES,
  OPENROUTER_KEY_PATTERN,
  OPENROUTER_KEY_RULE,
  OUTBOUND_EVENT_TYPES,
  PREPARE_SLEEP_TIMEOUT_MS,
  TASK_CANCELLED_SYSTEM_EVENT,
  TOOL_TARGET_MAX,
} from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const fork = join(repo, "invisible_engine_dots");

const UPSTREAM_COMMIT = "f75470e72f0993dcf92accc81282adaa48b16f56";
const LICENSE_BLOB = "e06eb24cf4abdc5b46d354fc7d1c9531b2f52dfa";

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** The id git gives a file's content, after the LF normalisation a Windows checkout may undo. */
function blobId(bytes: Buffer): string {
  const content = Buffer.from(lf(bytes.toString("utf8")), "utf8");
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** The root notices' nanobot section, up to the next second-level heading. */
function nanobotNotice(): string {
  const notices = lf(readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8"));
  const start = notices.indexOf("\n## nanobot\n");
  expect(start, "THIRD_PARTY_NOTICES.md has a nanobot section").toBeGreaterThanOrEqual(0);
  const next = notices.indexOf("\n## ", start + 1);
  return notices.slice(start, next === -1 ? undefined : next);
}

/** Every file or directory under the fork, as `/`-separated paths relative to the repository. */
function forkEntries(): { path: string; isDirectory: boolean }[] {
  return readdirSync(fork, { recursive: true, withFileTypes: true })
    .map((entry) => ({
      path: relative(repo, join(entry.parentPath, entry.name)).split(sep).join("/"),
      isDirectory: entry.isDirectory(),
    }))
    .filter((entry) => !entry.path.split("/").some((part) => part === "__pycache__" || part === "node_modules"));
}

describe("the vendored nanobot fork", () => {
  it("keeps upstream's LICENSE byte for byte", () => {
    expect(blobId(readFileSync(join(fork, "LICENSE")))).toBe(LICENSE_BLOB);
  });

  it("carries upstream's license text verbatim in the root notices", () => {
    const license = lf(readFileSync(join(fork, "LICENSE"), "utf8")).trimEnd();
    expect(nanobotNotice()).toContain(license);
    expect(nanobotNotice()).toContain(UPSTREAM_COMMIT);
  });

  it("points the root notices at nested notices that exist, and at every one that does", () => {
    const named = [...nanobotNotice().matchAll(/`(invisible_engine_dots\/[^`*]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const path of named) expect(existsSync(join(repo, path)), path).toBe(true);
    // Every license or notice file the fork ships is named, so deleting or
    // adding one is a change to the notices too. The fork's own LICENSE and
    // UPSTREAM.md are covered by the checks above and below.
    const shipped = forkEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path)
      .filter((path) => /(^|\/)(LICENSE|LICENCE|NOTICE|THIRD_PARTY_NOTICES|ATTRIBUTION)[^/]*$/i.test(path))
      .filter((path) => path !== "invisible_engine_dots/LICENSE");
    expect(shipped).toContain("invisible_engine_dots/THIRD_PARTY_NOTICES.md");
    for (const path of shipped) expect(named, path).toContain(path);
  });

  it("records the commit and license blob in UPSTREAM.md, and that it is a hard fork", () => {
    const upstream = lf(readFileSync(join(fork, "UPSTREAM.md"), "utf8"));
    expect(upstream).toContain(UPSTREAM_COMMIT);
    expect(upstream).toContain(LICENSE_BLOB);
    expect(upstream).toContain("hard fork: upstream changes are not tracked or merged");
  });

  it("carries none of the parts of nanobot that the host owns: channels, web UI, TUI, audio, pairing", () => {
    const names = new Set(["channels", "webui", "web", "tui", "audio", "pairing"]);
    const found = forkEntries()
      .filter((entry) => entry.isDirectory && names.has(entry.path.split("/").at(-1)!))
      .map((entry) => entry.path);
    expect(found).toEqual([]);
  });

  it("serves the guest contract with the routes, event types, states and model roles packages/shared names", () => {
    // The engine cannot import packages/shared (it is Python), so it keeps a copy
    // of the names in nanobot/dots/protocol.py; this keeps the two equal. The copy
    // is written as `NAME = ("a", "b")` tuples and one `"key": "value"` line per
    // route, which is all this reader understands.
    const protocol = lf(readFileSync(join(fork, "nanobot/dots/protocol.py"), "utf8"));
    const tuple = (name: string): string[] => {
      const match = new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(protocol);
      expect(match, name).not.toBeNull();
      return [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    };
    expect(tuple("INBOUND_EVENT_TYPES")).toEqual([...INBOUND_EVENT_TYPES]);
    expect(tuple("OUTBOUND_EVENT_TYPES")).toEqual([...OUTBOUND_EVENT_TYPES]);
    expect(tuple("AGENT_STATES")).toEqual([...AGENT_STATES]);
    expect(tuple("MODEL_ROLES")).toEqual([...MODEL_ROLES]);

    const routesMatch = /^AGENT_ROUTES = \{([^}]*)\}/m.exec(protocol);
    expect(routesMatch, "AGENT_ROUTES").not.toBeNull();
    const camel = (name: string): string => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const engineRoutes = Object.fromEntries(
      [...routesMatch![1]!.matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [camel(m[1]!), m[2]!]),
    );
    const sharedRoutes = Object.fromEntries(
      Object.entries(AGENT_ROUTES as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    expect(engineRoutes).toEqual(sharedRoutes);
    // The routes of one identity are functions of its id, so the table above cannot carry them: the engine
    // names what follows the id, and each name is a route of packages/shared.
    const actions = tuple("BROWSER_IDENTITY_ACTIONS");
    const identityActions = Object.entries(AGENT_ROUTES)
      .filter(([name]) => name.startsWith("browserIdentity") && name !== "browserIdentity")
      .map(([, route]) => (route as (id: string) => string)("x").replace("/browser-identities/x/", ""));
    expect(actions).toEqual(identityActions);

    // The status of each error code of an identity route: the engine answers from its table, and the control
    // plane passes the answers with these pairs through.
    const statusMatch = /^IDENTITY_ERROR_STATUS = \{([^}]*)\}/m.exec(protocol);
    expect(statusMatch, "IDENTITY_ERROR_STATUS").not.toBeNull();
    const engineStatus = Object.fromEntries([...statusMatch![1]!.matchAll(/"(\w+)":\s*(\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(engineStatus).toEqual({ ...IDENTITY_ERROR_STATUS });

    // How long the host waits for a prepare-sleep, which the engine's steps of one have to fit inside.
    expect(Number(/^PREPARE_SLEEP_TIMEOUT_S = (\d+)$/m.exec(protocol)?.[1]) * 1000).toBe(PREPARE_SLEEP_TIMEOUT_MS);

    expect(/^TASK_CANCELLED_EVENT = "([^"]+)"/m.exec(protocol)?.[1]).toBe(TASK_CANCELLED_SYSTEM_EVENT);
    // The longest `target` of a `tool.called`: the engine cuts to it, the host's schema refuses more.
    expect(Number(/^TOOL_TARGET_MAX = (\d+)$/m.exec(protocol)?.[1])).toBe(TOOL_TARGET_MAX);

    // Where the browser identities live, the display they draw on, and the environment of each one's MCP process.
    expect(/^BROWSERS_DIR = "([^"]+)"/m.exec(protocol)?.[1]).toBe(GUEST_PATHS.browsers);
    expect(/^MCP_HOMES_DIR = "([^"]+)"/m.exec(protocol)?.[1]).toBe(GUEST_PATHS.mcpHomes);
    expect(/^GUEST_DISPLAY = "([^"]+)"/m.exec(protocol)?.[1]).toBe(GUEST_DISPLAY);
    const browserEnv = /^BROWSER_ENV = \{([^}]*)\}/m.exec(protocol);
    expect(browserEnv, "BROWSER_ENV").not.toBeNull();
    const engineEnv = Object.fromEntries([...browserEnv![1]!.matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    const { MCP_HOME, MCP_SESSION_ID, PROFILE_DIR, HEADLESS, PROXY, DISPLAY, CORE_AUTOFIX, HOST_MANAGED } = ENV;
    expect(engineEnv).toEqual({ MCP_HOME, MCP_SESSION_ID, PROFILE_DIR, HEADLESS, PROXY, DISPLAY, CORE_AUTOFIX, HOST_MANAGED });
  });

  it("refuses an OpenRouter key by the one rule packages/shared names: the engine's text and pattern are its copy", () => {
    // The host applies the rule when the user enters the key, the engine again on POST /secrets. The engine
    // keeps the two constants in protocol.py as plain string literals, and builds its check from them.
    const protocol = lf(readFileSync(join(fork, "nanobot/dots/protocol.py"), "utf8"));
    expect(/^OPENROUTER_KEY_PATTERN = "([^"]+)"/m.exec(protocol)?.[1]).toBe(OPENROUTER_KEY_PATTERN);
    expect(/^OPENROUTER_KEY_RULE = "([^"]+)"/m.exec(protocol)?.[1]).toBe(OPENROUTER_KEY_RULE);

    const secrets = lf(readFileSync(join(fork, "nanobot/dots/secrets.py"), "utf8"));
    expect(secrets).toContain("re.compile(OPENROUTER_KEY_PATTERN)");
    expect(secrets).toContain("raise ValueError(OPENROUTER_KEY_RULE)");
    // No second pattern of its own: that is how the two would drift.
    expect(secrets).not.toMatch(/re\.compile\("/);
  });

  it("stays out of this repository's npm workspace, TypeScript project and test run", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { workspaces: string[] };
    for (const pattern of pkg.workspaces) expect(pattern.startsWith("invisible_engine_dots"), pattern).toBe(false);
    const tsconfig = JSON.parse(readFileSync(join(repo, "tsconfig.json"), "utf8")) as { include: string[]; exclude: string[] };
    for (const pattern of tsconfig.include) expect(pattern.startsWith("invisible_engine_dots") || pattern.startsWith("**"), pattern).toBe(false);
    expect(tsconfig.exclude).toContain("invisible_engine_dots");
    expect(readFileSync(join(repo, "vitest.config.ts"), "utf8")).toContain('"invisible_engine_dots/**"');
  });
});
