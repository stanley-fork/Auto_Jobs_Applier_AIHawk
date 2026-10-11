"use client";

import { computerIsUp, isMcpServerName, MCP_TIMEOUT_BOUNDS, mcpServerNames, type McpSecretState, type McpServerStatus } from "@invisible-dots/shared/browser";
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { mcpServerSummary, setMcpServer } from "../../lib/config-fields";
import { EMPTY_MCP_SERVER_FORM, formOfServer, serverOfForm, type McpServerForm } from "../../lib/mcp-server-form";
import { cn } from "../../lib/utils";
import { TONE_CLASS } from "../dot/tone";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveRefresh } from "../events";
import { Field, NumberField } from "../new-dot/Field";
import { useAction, useResource } from "../ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Panel, type PanelProps } from "./panel";
import type { ToolTable } from "./tool-table";

const STATE_LABEL: Record<McpServerStatus["state"], string> = { connecting: "Starting", connected: "Connected", failed: "Not connected" };
const STATE_TONE: Record<McpServerStatus["state"], keyof typeof TONE_CLASS> = { connecting: "info", connected: "ok", failed: "error" };

/** Where a declared server is on the Dot's computer, as its engine says; nothing while the computer does not answer. */
function ServerState({ status }: { status: McpServerStatus | undefined }) {
  if (status === undefined) return null;
  return (
    <div className="space-y-1">
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASS[STATE_TONE[status.state]])}>
        {STATE_LABEL[status.state]}
        {status.state === "connected" ? `, ${status.tools === 1 ? "1 tool" : `${status.tools} tools`}` : ""}
      </span>
      {status.error ? <p className="text-xs text-danger">{status.error}</p> : null}
    </div>
  );
}

/** The fields of a server's entry; the name is asked only of a new one. */
function ServerFields({ id, form, onChange, errorOf }: { id: string; form: McpServerForm; onChange: (form: McpServerForm) => void; errorOf: (field: string) => string | null }) {
  const set = (patch: Partial<McpServerForm>) => onChange({ ...form, ...patch });
  return (
    <>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">How the Dot reaches it</legend>
        <div className="inline-flex rounded-md border p-0.5">
          {(["command", "url"] as const).map((kind) => (
            <label key={kind} className={cn("cursor-pointer rounded px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring has-[:focus-visible]:outline-hidden", form.kind === kind && "bg-secondary font-medium text-foreground")}>
              <input type="radio" className="sr-only" name={`${id}-kind`} value={kind} checked={form.kind === kind} onChange={() => set({ kind })} />
              {kind === "command" ? "A program on its computer" : "A URL"}
            </label>
          ))}
        </div>
      </fieldset>
      {form.kind === "command" ? (
        <>
          <Field id={`${id}-command`} label="Command" hint="Run as the Dot's user in its home, e.g. uvx or npx. The Dot can install what it needs." error={errorOf("command")}>
            {(control) => <Input {...control} value={form.command} autoComplete="off" spellCheck={false} placeholder="uvx" onChange={(event) => set({ command: event.target.value })} />}
          </Field>
          <Field id={`${id}-args`} label="Arguments" optional hint="One per line." error={errorOf("args")}>
            {(control) => <Textarea {...control} rows={2} value={form.args} spellCheck={false} placeholder="mcp-server-time" onChange={(event) => set({ args: event.target.value })} />}
          </Field>
          <Field id={`${id}-env`} label="Environment" optional hint="NAME=value, one per line. A key or a token goes in Secrets instead." error={errorOf("env")}>
            {(control) => <Textarea {...control} rows={2} value={form.env} spellCheck={false} onChange={(event) => set({ env: event.target.value })} />}
          </Field>
        </>
      ) : (
        <>
          <Field id={`${id}-url`} label="URL" hint="Streamable HTTP, or SSE for a URL that ends in /sse." error={errorOf("url")}>
            {(control) => <Input {...control} value={form.url} autoComplete="off" spellCheck={false} placeholder="https://example.com/mcp" onChange={(event) => set({ url: event.target.value })} />}
          </Field>
          <Field id={`${id}-headers`} label="Headers" optional hint="Name: value, one per line. A key or a token goes in Secrets instead." error={errorOf("headers")}>
            {(control) => <Textarea {...control} rows={2} value={form.headers} spellCheck={false} onChange={(event) => set({ headers: event.target.value })} />}
          </Field>
        </>
      )}
      <Field
        id={`${id}-secrets`}
        label="Secrets"
        optional
        hint={form.kind === "command" ? "The names of environment variables whose values you set below once saved, one per line." : "The names of headers whose values you set below once saved (Authorization), one per line."}
        error={errorOf("secrets")}
      >
        {(control) => <Textarea {...control} rows={2} value={form.secrets} spellCheck={false} onChange={(event) => set({ secrets: event.target.value })} />}
      </Field>
      <NumberField
        id={`${id}-timeout`}
        label="Longest call"
        unit="seconds"
        min={MCP_TIMEOUT_BOUNDS.min}
        max={MCP_TIMEOUT_BOUNDS.max}
        step={1}
        value={form.timeoutS}
        onChange={(timeoutS) => set({ timeoutS })}
        error={errorOf("timeout_s")}
      />
    </>
  );
}

/** One secret of a saved server: whether it is set, and a write-only control to set, replace or clear it. */
function SecretRow({ dotId, secret, onSaved }: { dotId: string; secret: McpSecretState; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const save = useAction();
  const id = `mcp-secret-${secret.server}-${secret.name}`;

  async function apply(next: string | null) {
    await save.run(async () => {
      await api.setMcpSecret(dotId, secret.server, secret.name, next);
      setValue("");
      onSaved();
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() !== "") void apply(value.trim());
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field id={id} label={secret.name} hint={secret.set ? "Set. Stored encrypted and never shown again." : "Not set: the server does not start without it."}>
        {(control) => <Input {...control} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.pending || value.trim() === ""}>
          {secret.set ? "Replace" : "Set"}
        </Button>
        {secret.set ? (
          <Button type="button" size="sm" variant="outline" disabled={save.pending} onClick={() => void apply(null)}>
            Clear
          </Button>
        ) : null}
      </div>
      {save.error ? <ErrorAlert error={save.error} title={`Could not save ${secret.name}`} /> : null}
    </form>
  );
}

/**
 * The MCP servers the Dot may use: each one declared, where it is on the Dot's computer, its secrets; a server is added,
 * changed or removed in the draft like any other setting, and its permission is in "Permissions and tools". The secrets
 * are set apart from the config, write-only, for a server the saved config declares.
 */
export function McpServersPanel({ draft, saved, change, errorOf, dotId, computerState, table }: PanelProps & { dotId: string; computerState: string | null | undefined; table: ToolTable }) {
  const [editing, setEditing] = useState<{ name: string; form: McpServerForm; isNew: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const secrets = useResource(() => api.mcpSecrets(dotId), `mcp-secrets:${dotId}`);
  // A save that drops a server, or a name of its secrets, drops their values too.
  useLiveRefresh(secrets.reload, ["dot.updated"]);
  const statuses = new Map((computerIsUp(computerState) ? (table.data?.mcp_servers ?? []) : []).map((status) => [status.name, status]));
  const names = mcpServerNames(draft);

  function apply(event: FormEvent) {
    event.preventDefault();
    if (editing === null) return;
    const name = editing.name.trim();
    if (!isMcpServerName(name)) return setProblem("A name is 1 to 32 lowercase letters, digits and '-', starting with a letter or a digit.");
    if (editing.isNew && name in draft.mcp_servers) return setProblem(`There is a server "${name}" already.`);
    const parsed = serverOfForm(editing.form);
    if (!parsed.ok) return setProblem(parsed.problem);
    change(setMcpServer(draft, name, parsed.server));
    setProblem(null);
    setEditing(null);
  }

  return (
    <Panel
      id="mcp-servers"
      title="MCP servers"
      description="Programs and services whose tools the Dot may use, as Claude Code and Codex use them. Only you add one; the Dot can install a program a server needs. Each server's permission is under Permissions and tools."
    >
      {names.length === 0 ? <p className="text-sm text-muted-foreground">No MCP server.</p> : null}
      <ul className="divide-y rounded-lg border">
        {names.map((name) => {
          const server = draft.mcp_servers[name]!;
          const savedServer = name in saved.mcp_servers;
          const serverSecrets = (secrets.data?.secrets ?? []).filter((secret) => secret.server === name);
          return (
            <li key={name} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">{name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{mcpServerSummary(server)}</p>
                  {savedServer ? <ServerState status={statuses.get(name)} /> : <p className="text-xs text-muted-foreground">Not saved yet.</p>}
                  {(["command", "url", "args", "env", "headers", "secrets", "timeout_s"] as const).map((field) => {
                    const error = errorOf(`mcp_servers.${name}.${field}`);
                    return error ? <p key={field} className="text-xs text-danger">{error}</p> : null;
                  })}
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => { setProblem(null); setEditing({ name, form: formOfServer(server), isNew: false }); }}>
                    Edit
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => change(setMcpServer(draft, name, null))}>
                    Remove
                  </Button>
                </div>
              </div>
              {serverSecrets.length > 0 ? (
                <div className="space-y-3 border-t pt-3">
                  <p className="text-sm font-medium">Secrets</p>
                  {serverSecrets.map((secret) => (
                    <SecretRow key={secret.name} dotId={dotId} secret={secret} onSaved={secrets.reload} />
                  ))}
                </div>
              ) : server.secrets.length > 0 ? (
                <p className="text-xs text-muted-foreground">Save the settings to set its secrets.</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {secrets.error ? <ErrorAlert error={secrets.error} title="Could not read the MCP servers' secrets" /> : null}

      {editing === null ? (
        <Button type="button" variant="outline" onClick={() => { setProblem(null); setEditing({ name: "", form: EMPTY_MCP_SERVER_FORM, isNew: true }); }}>
          Add an MCP server
        </Button>
      ) : (
        <form onSubmit={apply} aria-label={editing.isNew ? "New MCP server" : `MCP server ${editing.name}`} className="space-y-4 rounded-lg border p-4">
          {editing.isNew ? (
            <Field id="mcp-new-name" label="Name" hint="Its tools are named mcp_<name>_<tool>.">
              {(control) => <Input {...control} value={editing.name} autoComplete="off" spellCheck={false} placeholder="time" onChange={(event) => setEditing({ ...editing, name: event.target.value })} />}
            </Field>
          ) : (
            <p className="font-medium">{editing.name}</p>
          )}
          <ServerFields id="mcp-edit" form={editing.form} onChange={(form) => setEditing({ ...editing, form })} errorOf={(field) => errorOf(`mcp_servers.${editing.name.trim()}.${field}`)} />
          {problem ? <p className="text-sm text-danger">{problem}</p> : null}
          <div className="flex gap-2">
            <Button type="submit">{editing.isNew ? "Add" : "Apply"}</Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
