"use client";

import { computerIsUp, safeParseDotConfig } from "@invisible-dots/shared/browser";
import { InfoIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { discard, edit, follow, startDraft, type DraftState } from "../../lib/config-draft";
import { configChanges, saveNotice } from "../../lib/config-fields";
import { configIssues, type FormIssue } from "../../lib/dot-form";
import { toYaml } from "../../lib/yaml";
import { useDot } from "../DotShell";
import { useAction } from "../ui";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { ConfigYamlEditor } from "../yaml-editor";
import { DeleteDot } from "./delete-dot";
import { ComputerPanel, GeneralPanel, LimitsPanel, ModelPanel } from "./panels";
import type { PanelProps } from "./panel";
import { McpServersPanel } from "./mcp-servers-panel";
import { PermissionsPanel } from "./permissions-panel";
import { ReviewDialog } from "./review-dialog";
import { useToolTable } from "./tool-table";
import { VmProxy } from "./vm-proxy";

type Mode = "form" | "yaml";

/** The Dot's settings (S14). The Dot's own record is read by the shell; this waits for it and keeps the page's edits across its reloads. */
export function DotSettings() {
  const { dotId, dot } = useDot();
  const record = dot.data;
  // A Dot that cannot be read is said by the header; there is nothing to edit until it can.
  if (record === undefined) return <Skeleton className="h-96 w-full" aria-busy="true" />;
  return <Editor key={record.id} dotId={dotId} name={record.name} computerState={record.computer_state} config={record.config} version={record.config_version} reload={dot.reload} />;
}

/**
 * The Dot's config as a form or as YAML, over one draft of the whole config. Saving goes through a review of what
 * changed and is conditional on the version of the config the edit began from, so a config changed meanwhile is never
 * undone: the page keeps the edits and puts them on top of the new config.
 */
function Editor({
  dotId,
  name,
  computerState,
  config,
  version,
  reload,
}: {
  dotId: string;
  name: string;
  computerState: string | null;
  config: DraftState["base"];
  version: number;
  reload: () => void;
}) {
  const [state, setState] = useState<DraftState>(() => startDraft(config, version));
  const [mode, setMode] = useState<Mode>("form");
  const [yaml, setYaml] = useState("");
  const [refusal, setRefusal] = useState<FormIssue[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const save = useAction();
  // The engine's tool table: the permissions panel lists each permission's tools, the MCP panel each server's state.
  const table = useToolTable(dotId, computerState);

  const issues = useMemo(() => configIssues(mode === "form" ? state.draft : yaml), [mode, state.draft, yaml]);
  const valid = issues.length === 0;
  const changes = useMemo(() => configChanges(state.base, state.draft), [state.base, state.draft]);

  // The host's config moved on: put the edits on top of it. Not while the YAML text is half typed, which is not yet edits of any config.
  const followable = mode === "form" || valid;
  useEffect(() => {
    if (followable) setState((current) => follow(current, config, version));
  }, [config, version, followable]);

  // A new base (the host's config moved on, or a save) rewrites the YAML text from the draft.
  useEffect(() => {
    if (mode === "yaml") setYaml(toYaml(state.draft));
    // Only when the base changes: typing changes the draft but must never rewrite what is being typed.
  }, [state.base]);

  const panel: PanelProps = {
    draft: state.draft,
    saved: state.base,
    change: (next) => setState((current) => edit(current, next)),
    errorOf: (path) => issues.find((issue) => issue.path === path)?.message ?? null,
  };

  function toYamlMode() {
    setYaml(toYaml(state.draft));
    setRefusal(null);
    setMode("yaml");
  }

  function toFormMode() {
    if (valid) {
      setRefusal(null);
      setMode("form");
    } else {
      setRefusal(issues);
    }
  }

  function editYaml(text: string) {
    setYaml(text);
    setRefusal(null);
    // The draft follows the text while the text is a config, so that what is reviewed and saved is what the text says.
    const parsed = safeParseDotConfig(text);
    if (parsed.ok) setState((current) => edit(current, parsed.config));
  }

  function discardEdits() {
    setState((current) => discard(current));
    setRefusal(null);
    if (mode === "yaml") setYaml(toYaml(state.base));
  }

  async function confirm() {
    await save.run(async () => {
      try {
        const updated = await api.updateDot(dotId, state.draft, state.version);
        setState(startDraft(updated.config, updated.config_version));
        setReviewing(false);
        toast.success(saveNotice(changes, computerIsUp(computerState)));
      } catch (error) {
        // Someone else saved first. Nothing was written; the page reads the config again and keeps the edits on top of it.
        if (error instanceof ApiError && error.code === "dot_changed") {
          setReviewing(false);
          return;
        }
        throw error;
      }
    });
    reload();
  }

  const summary = !valid ? (mode === "form" ? "Some settings need fixing before this can be saved." : "The configuration has problems.") : changes.length === 0 ? "No changes." : changes.length === 1 ? "1 unsaved change." : `${changes.length} unsaved changes.`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">What the Dot is, what it may do and how much it may use. A change reaches a running Dot from its next turn.</p>
        <div role="group" aria-label="How to edit it" className="inline-flex rounded-md border p-0.5">
          <Button type="button" size="sm" variant={mode === "form" ? "secondary" : "ghost"} aria-pressed={mode === "form"} onClick={mode === "yaml" ? toFormMode : undefined}>
            Form
          </Button>
          <Button type="button" size="sm" variant={mode === "yaml" ? "secondary" : "ghost"} aria-pressed={mode === "yaml"} onClick={mode === "form" ? toYamlMode : undefined}>
            Advanced YAML
          </Button>
        </div>
      </div>

      {state.rebased ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>The configuration changed while you were editing</AlertTitle>
          <AlertDescription>Something else saved a change (another tab, or Always allow on an approval). Your edits are kept on top of it. Review them before you save.</AlertDescription>
        </Alert>
      ) : null}

      {mode === "form" ? (
        <>
          <GeneralPanel {...panel} />
          <ModelPanel {...panel} />
          <PermissionsPanel {...panel} computerState={computerState} table={table} />
          <McpServersPanel {...panel} dotId={dotId} computerState={computerState} table={table} />
          <ComputerPanel {...panel} />
          <LimitsPanel {...panel} />
        </>
      ) : (
        <ConfigYamlEditor
          yaml={yaml}
          onChange={editYaml}
          issues={issues}
          refusal={refusal}
          hint="The same configuration as the form, with every option the schema has. The server validates it again when you save."
        />
      )}

      <div role="region" aria-label="Save" className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-lg md:border">
        <p role="status" className="text-sm">
          {summary}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={changes.length === 0 && !state.rebased} onClick={discardEdits}>
            Discard changes
          </Button>
          <Button type="button" disabled={!valid || changes.length === 0} onClick={() => setReviewing(true)}>
            Review and save
          </Button>
        </div>
      </div>

      <ReviewDialog open={reviewing} onOpenChange={(open) => { setReviewing(open); if (!open) save.setError(null); }} dotName={name} changes={changes} pending={save.pending} error={save.error} onConfirm={() => void confirm()} />

      <VmProxy dotId={dotId} />

      <DeleteDot dotId={dotId} name={name} />
    </div>
  );
}
