"use client";

import { computerIsUp, type PermissionDecision, type PermissionRisk } from "@invisible-dots/shared/browser";
import { RISK_LABEL } from "../../lib/approval-view";
import { setPermission } from "../../lib/config-fields";
import { DECISION_LABEL, DECISION_MEANING, DECISIONS, permissionGroups, type PermissionRow } from "../../lib/permission-table";
import { cn } from "../../lib/utils";
import { TONE_CLASS } from "../dot/tone";
import { ErrorAlert } from "../ErrorAlert";
import { PresetPicker } from "../new-dot/PresetPicker";
import { Panel, type PanelProps } from "./panel";
import type { ToolTable } from "./tool-table";

const RISK_TONE: Record<PermissionRisk, keyof typeof TONE_CLASS> = { low: "neutral", medium: "warn", high: "error" };

function DecisionControl({ row, onChange }: { row: PermissionRow; onChange: (decision: PermissionDecision) => void }) {
  return (
    <fieldset className="shrink-0">
      <legend className="sr-only">{row.label}</legend>
      <div className="inline-flex rounded-md border p-0.5">
        {DECISIONS.map((decision) => (
          <label
            key={decision}
            className={cn(
              "cursor-pointer rounded px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring has-[:focus-visible]:outline-hidden",
              row.decision === decision && "bg-secondary font-medium text-foreground",
            )}
          >
            <input type="radio" className="sr-only" name={`permission-${row.permission}`} value={decision} checked={row.decision === decision} onChange={() => onChange(decision)} />
            {DECISION_LABEL[decision]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Tools({ row }: { row: PermissionRow }) {
  if (row.tools === null) return null;
  if (row.tools.length === 0) return <p className="text-xs text-muted-foreground">No tool of the Dot uses this permission.</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{row.tools.length === 1 ? "The tool it covers" : `The ${row.tools.length} tools it covers`}:</p>
      <ul aria-label={`Tools of ${row.label}`} className="flex flex-wrap gap-1.5">
        {row.tools.map((tool) => (
          <li key={tool.name} className="flex items-center gap-1">
            <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-xs", !tool.offered && "text-muted-foreground line-through")}>{tool.name}</code>
            {tool.offered ? null : <span className="text-xs text-muted-foreground">not offered</span>}
          </li>
        ))}
      </ul>
      {row.changed ? <p className="text-xs text-muted-foreground">This is as the Dot has it now. The change shows here once it is saved.</p> : null}
    </div>
  );
}

/**
 * What the Dot may do without asking: presets, then one row per permission with a three-way control, the default
 * marked in words, and the tools that use it. The preset picker is the create page's, so the three presets mean the same
 * in both. A permission set to what its default is leaves the config's `permissions` without an entry (`setPermission`).
 */
export function PermissionsPanel({ draft, saved, change, computerState, table }: PanelProps & { computerState: string | null | undefined; table: ToolTable }) {
  const up = computerIsUp(computerState);
  const groups = permissionGroups(draft, saved, up ? (table.data?.tools ?? null) : null);
  // The computer is not running, or is said to run but its engine does not answer (it is just starting): there is no table to show.
  const silent = computerState !== undefined && (!up || (table.data === null && !table.loading));

  return (
    <Panel id="permissions" title="Permissions and tools" description="What the Dot may do, one permission at a time. A tool is offered to the model when its permission is allowed or asked, and not when it is denied; the tools that create or delete browser identities are also left out while the Dot does not manage its own.">
      <PresetPicker permissions={draft.permissions} onChange={(permissions) => change({ ...draft, permissions })} />
      {silent ? (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {up ? "The Dot's computer is not answering, so the tools are not listed." : "Start the computer to see the tools each permission covers."} The permissions can be set meanwhile.
        </p>
      ) : null}
      {up ? <ErrorAlert error={table.error} title="Could not read the Dot's tools" /> : null}
      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`permission-group-${group.id}`}>
            <h3 id={`permission-group-${group.id}`} className="mb-1 text-sm font-semibold">
              {group.label}
            </h3>
            <ul className="divide-y rounded-lg border">
              {group.rows.map((row) => (
                <li key={row.permission} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {row.label}
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASS[RISK_TONE[row.risk]])}>{RISK_LABEL[row.risk]}</span>
                        {row.changed ? <span className="rounded-full bg-info-soft px-2 py-0.5 text-xs font-medium text-info">Changed</span> : null}
                      </p>
                      <p className="text-sm text-muted-foreground">{row.description}</p>
                    </div>
                    <DecisionControl row={row} onChange={(decision) => change(setPermission(draft, row.permission, decision))} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {DECISION_MEANING[row.decision]} Default: {DECISION_LABEL[row.defaultDecision].toLowerCase()}.
                  </p>
                  <Tools row={row} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}
