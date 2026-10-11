"use client";

import { api } from "../../lib/api";
import { permissionInfo, RISK_LABEL, toolsCovered, type ApprovalAsk } from "../../lib/approval-view";
import { useResource } from "../ui";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

/** The tool table of the Dot's engine; null when its computer cannot answer (stopped, starting), which only costs the list of names. */
function useToolTable(dotId: string) {
  return useResource(async () => {
    try {
      return (await api.listTools(dotId)).tools;
    } catch {
      return null;
    }
  }, `tools:${dotId}`);
}

function Covered({ ask }: { ask: ApprovalAsk }) {
  const table = useToolTable(ask.dotId);
  if (table.data === undefined) return <p className="text-sm text-muted-foreground">Reading the Dot&apos;s tools...</p>;
  const names = toolsCovered(ask.permission, table.data);
  if (names === null) {
    return <p className="text-sm text-muted-foreground">The Dot&apos;s computer did not answer, so the tools are not listed. The permission covers every tool of the Dot that uses it.</p>;
  }
  if (names.length === 0) return <p className="text-sm text-muted-foreground">None of the Dot&apos;s tools uses this permission right now, so the setting would only apply to tools it gets later.</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-sm">It covers {names.length === 1 ? "this tool" : `these ${names.length} tools`}:</p>
      <ul aria-label="Tools covered" className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li key={name}>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{name}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The question before "always allow": it changes the Dot's settings for good, so it says exactly what changes (the
 * permission, the tools it covers) and how much that can do if the Dot misuses it. Only an approval whose permission
 * a config can name offers it at all (the host refuses the rest).
 */
export function AlwaysAllowDialog({ ask, open, onOpenChange, onConfirm }: { ask: ApprovalAsk; open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  const info = permissionInfo(ask.permission);
  if (info === null) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Always allow &ldquo;{info.label}&rdquo;?</DialogTitle>
          <DialogDescription>
            {info.description} The Dot will not ask again: its settings will say <code className="font-mono">{info.permission}: allow</code> from now on. You can change that in its settings.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{RISK_LABEL[info.risk]}</p>
        <Covered ask={ask} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Keep asking
          </Button>
          <Button
            type="button"
            variant={info.risk === "high" ? "destructive" : "default"}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Always allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
