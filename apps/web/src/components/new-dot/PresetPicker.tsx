"use client";

import type { PermissionDecision } from "@invisible-dots/shared/browser";
import { PRESET_IDS, PRESETS, presetOf, presetPermissions } from "../../lib/permission-presets";
import { cn } from "../../lib/utils";

/**
 * What the Dot may do without asking, as three presets. The one chosen is the one the form's permissions amount
 * to, so a permission map typed in the YAML that matches none of them leaves all three unchosen and says so.
 */
export function PresetPicker({ permissions, onChange }: { permissions: Record<string, PermissionDecision>; onChange: (permissions: Record<string, PermissionDecision>) => void }) {
  const chosen = presetOf(permissions);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">What it may do without asking</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESET_IDS.map((id) => {
          const preset = PRESETS[id];
          return (
            <label
              key={id}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-lg border bg-background p-3 text-sm transition-colors hover:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring has-[:focus-visible]:outline-hidden",
                chosen === id && "border-primary bg-accent",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="permission-preset" value={id} checked={chosen === id} onChange={() => onChange(presetPermissions(id, permissions))} className="accent-primary" />
                {preset.label}
              </span>
              <span className="text-xs text-muted-foreground">{preset.description}</span>
            </label>
          );
        })}
      </div>
      {chosen === null ? <p className="text-xs text-muted-foreground">The permissions come from the YAML and match none of these. Pick one to replace them.</p> : null}
    </fieldset>
  );
}
