import type { SecretBox } from "./crypto.js";
import type { Queryable } from "./rows.js";

export const GLOBAL_SCOPE = "global";
export const OPENROUTER_KEY_NAME = "openrouter_api_key";
/** A Dot's VM proxy, stored under the Dot's scope only: there is no install-wide proxy. */
export const VM_PROXY_NAME = "vm_proxy";

const aad = (scope: string, name: string) => `secret:${scope}:${name}`;

/**
 * The stored name of a secret an MCP server of a Dot's config names (`mcp_servers.<server>.secrets`), under the Dot's
 * scope: `mcp/<server>/<NAME>`. A server's name holds no `/`, so the name says its server.
 */
const MCP_PREFIX = "mcp/";
export function mcpSecretName(server: string, name: string): string {
  return `${MCP_PREFIX}${server}/${name}`;
}

/** The servers of a Dot's config and the names of the secrets each names, as `mcp_servers` has them. */
export type McpSecretNames = Readonly<Record<string, { readonly secrets: readonly string[] }>>;

export class SecretsRepository {
  constructor(
    private readonly q: Queryable,
    private readonly box: SecretBox,
  ) {}

  async put(scope: string, name: string, value: string): Promise<void> {
    await this.q.query(
      `INSERT INTO secrets (scope, name, value_enc) VALUES ($1, $2, $3)
       ON CONFLICT (scope, name) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
      [scope, name, this.box.encrypt(value, aad(scope, name))],
    );
  }

  async get(scope: string, name: string): Promise<string | null> {
    const { rows } = await this.q.query<{ value_enc: Uint8Array }>(
      "SELECT value_enc FROM secrets WHERE scope = $1 AND name = $2",
      [scope, name],
    );
    return rows[0] ? this.box.decrypt(rows[0].value_enc, aad(scope, name)) : null;
  }

  async delete(scope: string, name: string): Promise<boolean> {
    const { rowCount } = await this.q.query("DELETE FROM secrets WHERE scope = $1 AND name = $2", [scope, name]);
    return (rowCount ?? 0) > 0;
  }

  /** The values of the secrets a Dot's MCP servers name that are set, by server and name (a server with none set is absent). */
  async mcpSecrets(dotId: string, servers: McpSecretNames): Promise<Record<string, Record<string, string>>> {
    const values: Record<string, Record<string, string>> = {};
    for (const [server, { secrets }] of Object.entries(servers)) {
      for (const name of secrets) {
        const value = await this.get(dotId, mcpSecretName(server, name));
        if (value !== null) (values[server] ??= {})[name] = value;
      }
    }
    return values;
  }

  /**
   * Delete the MCP secrets of a Dot that its config no longer names: those of a server it no longer declares, or that
   * a server no longer lists. The config is the one place that says which a Dot has, so none outlives it there.
   */
  async deleteUndeclaredMcpSecrets(dotId: string, servers: McpSecretNames): Promise<void> {
    const kept = Object.entries(servers).flatMap(([server, { secrets }]) => secrets.map((name) => mcpSecretName(server, name)));
    await this.q.query(
      "DELETE FROM secrets WHERE scope = $1 AND left(name, $2) = $3 AND NOT (name = ANY($4::text[]))",
      [dotId, MCP_PREFIX.length, MCP_PREFIX, kept],
    );
  }

  /** The Dot's own OpenRouter key, else the global one (section 9.1). */
  async openRouterKey(dotId: string): Promise<string | null> {
    return (await this.get(dotId, OPENROUTER_KEY_NAME)) ?? (await this.get(GLOBAL_SCOPE, OPENROUTER_KEY_NAME));
  }
}
