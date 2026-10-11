// @vitest-environment jsdom
import { PERMISSIONS, type DotConfig, type PermissionDecision } from "@invisible-dots/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotShell } from "../src/components/DotShell";
import { DotSettings } from "../src/components/dot-settings/DotSettings";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
import { setField, setPermission } from "../src/lib/config-fields";
import { stubMatchMedia, stubResizeObserver } from "./support/browser";
import { fullConfig } from "./support/config";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/dots/d1/settings", useRouter: () => ({ push, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares", config: fullConfig({ name: "fares" }) })];
  plane.install();
  stubMatchMedia();
  stubResizeObserver();
  push.mockReset();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const requested = (pattern: RegExp) => plane.requests.filter((r) => pattern.test(r));

/** The Settings page as the Dot's layout puts it: inside the Dot's shell. */
async function renderSettings() {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <DotSettings />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 2, name: "General" });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

/** A control by its label. A section is labelled by its heading too, which can be the same word (Model, Memory): only a control counts here. */
const field = (name: string | RegExp) => screen.getByLabelText(name, { selector: "input, textarea, select" });
const row = (label: string) => screen.getByRole("group", { name: label });
const choose = async (label: string, decision: string) => userEvent.setup().click(within(row(label)).getByRole("radio", { name: decision }));
const chosen = (label: string) => within(row(label)).getAllByRole("radio").find((radio) => (radio as HTMLInputElement).checked)?.getAttribute("value");
const reviewButton = () => screen.getByRole("button", { name: "Review and save" }) as HTMLButtonElement;
const saved = () => plane.dots[0]!.config;

async function saveReviewed() {
  const user = userEvent.setup();
  await user.click(reviewButton());
  const dialog = await screen.findByRole("dialog", { name: "Save these changes?" });
  await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
}

describe("the settings of a Dot", () => {
  it("shows the config as the host has it, with the name only to read", async () => {
    plane.dots = [
      dotRecord("d1", {
        name: "fares",
        config: fullConfig({
          name: "fares",
          instructions: "Write to the workspace.",
          models: { summary: "openai/gpt-5-mini" },
          computer: { cpu: 3, memory: "6gb", disk: "50gb", idle_timeout: "1h" },
          limits: { max_steps_per_task: 30, max_cost_per_task_usd: 0.5 },
        }),
      }),
    ];
    await renderSettings();
    expect(screen.getByText("fares", { selector: "code" })).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect((field(/^Instructions/) as HTMLTextAreaElement).value).toBe("Write to the workspace.");
    expect((field("Model") as HTMLInputElement).value).toBe("z-ai/glm-5.3-flash");
    expect((field(/^Summary model/) as HTMLInputElement).value).toBe("openai/gpt-5-mini");
    expect((field("Processors") as HTMLInputElement).value).toBe("3");
    expect((field("Memory") as HTMLInputElement).value).toBe("6");
    expect((field("Disk") as HTMLInputElement).value).toBe("50");
    expect((field("Sleep after") as HTMLSelectElement).value).toBe("1h");
    expect((field("Spending cap per task") as HTMLInputElement).value).toBe("0.5");
    expect((field("Steps per task") as HTMLInputElement).value).toBe("30");
    // The context window is the model's own: there is nothing to set.
    expect(screen.queryByLabelText("Context tokens")).toBeNull();
    expect(screen.getByText(/The last request may go over/)).toBeTruthy();
    expect(screen.getByText("No changes.")).toBeTruthy();
    expect(reviewButton().disabled).toBe(true);
  });

  it("has a section for each part of the config, and a danger zone last", async () => {
    await renderSettings();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["General", "Model", "Permissions and tools", "MCP servers", "Computer", "Limits", "VM proxy", "Danger zone"]);
  });
});

describe("the permission editor", () => {
  it("has one row for each permission, with its words, its risk and the default said", async () => {
    await renderSettings();
    for (const permission of PERMISSIONS) expect(document.querySelector(`input[name="permission-${permission}"]`), permission).toBeTruthy();
    const exec = row("Run commands").closest("li")!;
    expect(within(exec).getByText("High risk")).toBeTruthy();
    expect(within(exec).getByText(/Run shell commands on the Dot's computer/)).toBeTruthy();
    expect(within(exec).getByText(/Default: allow\./)).toBeTruthy();
    expect(within(row("Automations").closest("li")!).getByText(/Default: ask\./)).toBeTruthy();
    expect(chosen("Run commands")).toBe("allow");
    expect(chosen("Automations")).toBe("ask");
    expect(chosen("Delete browser identities")).toBe("ask");
  });

  for (const decision of ["allow", "ask", "deny"] as const satisfies readonly PermissionDecision[]) {
    it(`sends ${decision} for a permission as one entry of the config, after the review, conditional on the version read`, async () => {
      plane.dots = [dotRecord("d1", { name: "fares", config: fullConfig({ name: "fares", permissions: { "files.write": decision === "allow" ? "ask" : "allow" } }), config_version: 7 })];
      await renderSettings();
      await choose("Change files", decision.charAt(0).toUpperCase() + decision.slice(1));
      expect(chosen("Change files")).toBe(decision);
      expect(screen.getByText("1 unsaved change.")).toBeTruthy();
      // Nothing is sent before the review is confirmed.
      expect(plane.updates).toEqual([]);

      await saveReviewed();
      await waitFor(() => expect(plane.updates).toHaveLength(1));
      const body = plane.updates[0]!;
      expect(body.expected_config_version).toBe(7);
      // "allow" is the default of files.write: it is saved as no entry, which resolves to the same.
      expect((body.config as DotConfig).permissions).toEqual(decision === "allow" ? {} : { "files.write": decision });
      expect(await screen.findByText("Saved. The change applies from the Dot's next turn.")).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByText("No changes.")).toBeTruthy();
    });
  }

  it("writes an explicit allow for a permission that asks by default, and no entry once it asks again", async () => {
    await renderSettings();
    await choose("Automations", "Allow");
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect((plane.updates[0]!.config as DotConfig).permissions).toEqual({ automations: "allow" });
    await screen.findByText(/^Saved\./);
    await choose("Automations", "Ask");
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(2));
    expect((plane.updates[1]!.config as DotConfig).permissions).toEqual({});
  });

  it("sends the rest of the config as it was, so a save of one permission changes nothing else", async () => {
    await renderSettings();
    await choose("Run commands", "Deny");
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect(plane.updates[0]!.config).toEqual(setPermission(fullConfig({ name: "fares" }), "computer.exec", "deny"));
  });

  it("marks a row that was changed and says what the new decision means", async () => {
    await renderSettings();
    expect(screen.queryByText("Changed")).toBeNull();
    await choose("Run commands", "Ask");
    const exec = row("Run commands").closest("li")!;
    expect(within(exec).getByText("Changed")).toBeTruthy();
    expect(within(exec).getByText(/The Dot waits for your answer/)).toBeTruthy();
    await choose("Run commands", "Allow");
    expect(within(exec).queryByText("Changed")).toBeNull();
    expect(screen.getByText("No changes.")).toBeTruthy();
  });

  it("applies a preset to all the rows at once", async () => {
    await renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /Careful/ }));
    expect(chosen("Run commands")).toBe("ask");
    expect(chosen("Change files")).toBe("ask");
    expect(chosen("Read files")).toBe("allow");
    await user.click(screen.getByRole("radio", { name: /Autonomous/ }));
    expect(chosen("Run commands")).toBe("allow");
    expect(chosen("Automations")).toBe("allow");
    expect(chosen("Delete browser identities")).toBe("ask");
    await user.click(screen.getByRole("radio", { name: /Balanced/ }));
    expect(chosen("Automations")).toBe("ask");
    expect(screen.getByText("No changes.")).toBeTruthy();
  });

  it("lists the tools of each permission from the Dot's own table, and says which the model is not offered", async () => {
    plane.tools = [
      { name: "exec", permission: "computer.exec", offered: true, description: "Run a shell command." },
      { name: "exec_session", permission: "computer.exec", offered: true, description: "Use a command session." },
      { name: "read_file", permission: "files.read", offered: false, description: "Read a file." },
    ];
    await renderSettings();
    const exec = await screen.findByRole("list", { name: "Tools of Run commands" });
    expect(within(exec).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["exec", "exec_session"]);
    const read = within(row("Read files").closest("li")!).getByRole("list", { name: "Tools of Read files" });
    expect(read.textContent).toBe("read_filenot offered");
    expect(within(row("Use pages").closest("li")!).getByText("No tool of the Dot uses this permission.")).toBeTruthy();
  });

  it("says the tools can be seen once the computer runs, asks nothing of a stopped one, and still lets the permissions be set", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: fullConfig({ name: "fares" }), computer_state: "STOPPED" })];
    await renderSettings();
    expect(await screen.findByText(/Start the computer to see the tools each permission covers/)).toBeTruthy();
    expect(requested(/\/tools$/)).toEqual([]);
    expect(screen.queryByRole("list", { name: /^Tools of/ })).toBeNull();
    await choose("Run commands", "Deny");
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect(await screen.findByText("Saved. The Dot gets the change when its computer starts.")).toBeTruthy();
  });

  it("says when a computer that is said to run does not answer for the tools, and keeps the permissions usable", async () => {
    plane.tools = null;
    await renderSettings();
    expect(await screen.findByText(/The Dot's computer is not answering, so the tools are not listed/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: /^Tools of/ })).toBeNull();
    await choose("Run commands", "Ask");
    expect(chosen("Run commands")).toBe("ask");
  });

  it("reads the tools again when the Dot's config is pushed", async () => {
    await renderSettings();
    await screen.findByRole("list", { name: "Tools of Run commands" });
    const before = requested(/GET \/api\/dots\/d1\/tools$/).length;
    plane.tools = plane.tools!.map((tool) => (tool.name === "exec" ? { ...tool, offered: false } : tool));
    act(() => plane.push("d1", "dot.updated", { name: "fares" }));
    await waitFor(() => expect(requested(/GET \/api\/dots\/d1\/tools$/).length).toBeGreaterThan(before));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Tools of Run commands" })).getAllByRole("listitem")[0]!.textContent).toBe("execnot offered"));
  });
});

describe("the review before a save", () => {
  it("lists each change from what it is to what it will be, and sends nothing until it is confirmed", async () => {
    await renderSettings();
    await choose("Run commands", "Ask");
    fireEvent.change(field("Spending cap per task"), { target: { value: "2.5" } });
    fireEvent.change(field(/^Summary model/), { target: { value: "openai/gpt-5-mini" } });
    expect(screen.getByText("3 unsaved changes.")).toBeTruthy();
    await userEvent.setup().click(reviewButton());
    const dialog = await screen.findByRole("dialog", { name: "Save these changes?" });
    const lines = within(within(dialog).getByRole("list", { name: "Changes" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual([
      "Summary modelfrom the Dot's own model to openai/gpt-5-mini",
      "Spending cap per taskfrom $1 to $2.5",
      "Run commandsfrom allow to ask",
    ]);
    expect(dialog.textContent).toContain("These 3 changes are written to fares's configuration");
    expect(plane.updates).toEqual([]);
  });

  it("keeps the edits on Keep editing, and sends nothing", async () => {
    await renderSettings();
    await choose("Run commands", "Deny");
    const user = userEvent.setup();
    await user.click(reviewButton());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(chosen("Run commands")).toBe("deny");
    expect(plane.updates).toEqual([]);
  });

  it("discards the edits and goes back to what the host has", async () => {
    await renderSettings();
    await choose("Run commands", "Deny");
    fireEvent.change(field(/^Instructions/), { target: { value: "Something else" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Discard changes" }));
    expect(chosen("Run commands")).toBe("allow");
    expect((field(/^Instructions/) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("No changes.")).toBeTruthy();
  });

  it("keeps the review open with the host's reason when the save is refused, and the edits with it", async () => {
    plane.failUpdate = { status: 400, error: "invalid_config", message: "the Dot's computer cannot have that" };
    await renderSettings();
    await choose("Run commands", "Deny");
    await saveReviewed();
    const dialog = await screen.findByRole("dialog", { name: "Save these changes?" });
    expect(await within(dialog).findByText("The configuration was not saved")).toBeTruthy();
    expect(within(dialog).getByText("the Dot's computer cannot have that")).toBeTruthy();
    plane.failUpdate = null;
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saved().permissions).toEqual({ "computer.exec": "deny" });
  });

  it("says what a change to the computer's size means: it waits for the next start", async () => {
    await renderSettings();
    fireEvent.change(field("Processors"), { target: { value: "4" } });
    await saveReviewed();
    expect(await screen.findByText("Saved. The change applies the next time the computer starts.")).toBeTruthy();
    expect((saved().computer as { cpu: number }).cpu).toBe(4);
  });
});

describe("the other settings", () => {
  it("saves the summary model as a role of the config, and removes it when it is emptied", async () => {
    await renderSettings();
    fireEvent.change(field(/^Summary model/), { target: { value: "openai/gpt-5-mini" } });
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect((plane.updates[0]!.config as DotConfig).models).toEqual({ summary: "openai/gpt-5-mini" });
    await screen.findByText(/^Saved\./);
    fireEvent.change(field(/^Summary model/), { target: { value: "" } });
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(2));
    expect((plane.updates[1]!.config as DotConfig).models).toEqual({});
  });

  it("saves the limits and the spending cap with the rest, in one patch", async () => {
    await renderSettings();
    fireEvent.change(field("Spending cap per task"), { target: { value: "0.25" } });
    fireEvent.change(field("Steps per task"), { target: { value: "12" } });
    // Nothing is saved by the switches themselves: they edit the draft.
    expect(plane.updates).toEqual([]);
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    const config = plane.updates[0]!.config as DotConfig;
    expect("memory" in config).toBe(false);
    expect("browser" in config).toBe(false);
    expect(config.limits).toEqual({ max_steps_per_task: 12, max_cost_per_task_usd: 0.25 });
  });

  it("says what is wrong with a setting where it is, and does not allow the save", async () => {
    await renderSettings();
    fireEvent.change(field("Model"), { target: { value: "two words" } });
    expect(await screen.findByText("model id must not contain whitespace")).toBeTruthy();
    expect(field("Model").getAttribute("aria-invalid")).toBe("true");
    expect(reviewButton().disabled).toBe(true);
    expect(screen.getByText("Some settings need fixing before this can be saved.")).toBeTruthy();
    fireEvent.change(field("Model"), { target: { value: "openai/gpt-5" } });
    await waitFor(() => expect(screen.queryByText("model id must not contain whitespace")).toBeNull());
    expect(reviewButton().disabled).toBe(false);
  });

  it("does not let the disk go below what it is, and says so", async () => {
    await renderSettings();
    const disk = field("Disk") as HTMLInputElement;
    expect(disk.min).toBe("40");
    expect(screen.getByText("It can grow but never shrink: this one is 40gb now.")).toBeTruthy();
    fireEvent.change(field("Disk"), { target: { value: "60" } });
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect((plane.updates[0]!.config as DotConfig).computer.disk).toBe("60gb");
  });

  it("has no goal to set: what a Dot is for is what its person asks of it", async () => {
    await renderSettings();
    await screen.findByLabelText(/^Instructions/);
    expect(screen.queryByLabelText("Goal")).toBeNull();
  });
});

describe("the YAML view", () => {
  const yamlBox = () => screen.getByRole("textbox", { name: "Configuration (YAML)" }) as HTMLTextAreaElement;

  it("shows the whole config, takes the form's edits along, and saves what the text says", async () => {
    await renderSettings();
    await choose("Run commands", "Deny");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Advanced YAML" }));
    expect(yamlBox().value).toContain("name: fares");
    expect(yamlBox().value).toContain("computer.exec: deny");
    expect(screen.getByText("The configuration is valid.")).toBeTruthy();
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("max_steps_per_task: 60", "max_steps_per_task: 20") } });
    expect(screen.getByText("2 unsaved changes.")).toBeTruthy();
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    const config = plane.updates[0]!.config as DotConfig;
    expect(config.limits.max_steps_per_task).toBe(20);
    expect(config.permissions).toEqual({ "computer.exec": "deny" });
    // After the save the text is the saved config again.
    await waitFor(() => expect(screen.getByText("No changes.")).toBeTruthy());
  });

  it("lists what is wrong with the text as it is typed, and does not allow the save until it is a config", async () => {
    await renderSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("cpu: 2", "cpu: 99") } });
    const problems = screen.getByRole("list", { name: "Problems in the YAML" });
    expect(within(problems).getAllByRole("listitem").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("The configuration has problems.")).toBeTruthy();
    expect(reviewButton().disabled).toBe(true);
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("cpu: 99", "cpu: 3") } });
    expect(screen.queryByRole("list", { name: "Problems in the YAML" })).toBeNull();
    expect(reviewButton().disabled).toBe(false);
  });

  it("brings the text's edits back into the form, and stays in the YAML while the text is not a config", async () => {
    await renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace("cpu: 2", "cpu: 6") } });
    await user.click(screen.getByRole("button", { name: "Form" }));
    expect((field("Processors") as HTMLInputElement).value).toBe("6");

    await user.click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: "name: [unclosed" } });
    await user.click(screen.getByRole("button", { name: "Form" }));
    expect(screen.getByText("The form cannot show this")).toBeTruthy();
    expect(yamlBox().value).toBe("name: [unclosed");
  });

  it("carries every option between the text and the form, the step limit included", async () => {
    await renderSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Advanced YAML" }));
    fireEvent.change(yamlBox(), { target: { value: yamlBox().value.replace(/max_steps_per_task: \d+/, "max_steps_per_task: 7") } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Form" }));
    expect((field("Steps per task") as HTMLInputElement).value).toBe("7");
  });
});

describe("a config that changed under the edit", () => {
  it("keeps the edits on top of what someone else saved, and says so", async () => {
    await renderSettings();
    await choose("Run commands", "Deny");
    // An "Always allow" in another tab: the host's config is now at version 2 with automations allowed.
    const record = plane.dots[0]!;
    record.config = setPermission(record.config, "automations", "allow");
    record.config_version = 2;
    act(() => plane.push("d1", "dot.updated", { name: "fares" }));
    expect(await screen.findByText("The configuration changed while you were editing")).toBeTruthy();
    expect(chosen("Run commands")).toBe("deny");
    expect(chosen("Automations")).toBe("allow");
    // Only my edit is a change against what the host has now.
    expect(screen.getByText("1 unsaved change.")).toBeTruthy();

    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect(plane.updates[0]!.expected_config_version).toBe(2);
    expect((plane.updates[0]!.config as DotConfig).permissions).toEqual({ automations: "allow", "computer.exec": "deny" });
    await waitFor(() => expect(screen.queryByText("The configuration changed while you were editing")).toBeNull());
  });

  it("follows the host's config silently while nothing was edited", async () => {
    await renderSettings();
    const record = plane.dots[0]!;
    record.config = setField(record.config, "instructions", "Instructions set elsewhere");
    record.config_version = 2;
    act(() => plane.push("d1", "dot.updated", { name: "fares" }));
    await waitFor(() => expect((field(/^Instructions/) as HTMLTextAreaElement).value).toBe("Instructions set elsewhere"));
    expect(screen.queryByText("The configuration changed while you were editing")).toBeNull();
  });

  it("is never undone by a save: when the host refuses it as out of date, nothing is written and the edits are kept on top of the new config", async () => {
    await renderSettings();
    await choose("Run commands", "Deny");
    // The config changes behind the page's back, with no event heard (the stream is not the only way a save can be stale).
    const record = plane.dots[0]!;
    record.config = setField(record.config, "instructions", "Changed in another tab");
    record.config_version = 2;
    await saveReviewed();
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect(plane.updates[0]!.expected_config_version).toBe(1);
    // The review closes without a toast of success, the page reads the config again and keeps the edit on top of it.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    expect(await screen.findByText("The configuration changed while you were editing")).toBeTruthy();
    expect((field(/^Instructions/) as HTMLTextAreaElement).value).toBe("Changed in another tab");
    expect(chosen("Run commands")).toBe("deny");
    expect(saved().permissions).toEqual({});
  });
});

describe("the danger zone", () => {
  it("asks for the Dot's name, and does nothing until it is typed", async () => {
    await renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Dot" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete fares?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete Dot" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Type fares to confirm/), "fare");
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Type fares to confirm/), "s");
    expect(confirm.disabled).toBe(false);
    expect(plane.deleted).toEqual([]);
    await user.click(confirm);
    await waitFor(() => expect(plane.deleted).toEqual(["d1"]));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("keeps the question open with the reason when the host refuses, and forgets the typed name when it is closed", async () => {
    plane.failDelete = { status: 502, error: "guest_unreachable", message: "the computer did not stop" };
    await renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete Dot" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Type fares to confirm/), "fares");
    await user.click(within(dialog).getByRole("button", { name: "Delete Dot" }));
    expect(await within(dialog).findByText("The Dot was not deleted")).toBeTruthy();
    expect(within(dialog).getByText("the computer did not stop")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Delete Dot" }));
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/Type fares to confirm/) as HTMLInputElement).value).toBe("");
    expect(within(dialog).queryByText("The Dot was not deleted")).toBeNull();
  });
});

describe("the MCP servers of a Dot", () => {
  const WEB = { url: "https://web.example/mcp", headers: {}, secrets: ["Authorization"], timeout_s: 30, startup_timeout_s: 60 };
  // The panel, not the group of the same name under Permissions and tools.
  const panel = () => within(screen.getByRole("heading", { level: 2, name: "MCP servers" }).closest("section")!);

  it("shows each server with where it is on the computer, and sets its secret without ever showing it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: fullConfig({ name: "fares", mcp_servers: { web: WEB } }) })];
    plane.mcpServers = [{ name: "web", state: "failed", error: "its secret Authorization is not set", tools: 0 }];
    await renderSettings();
    const user = userEvent.setup();

    expect(await panel().findByText("Not connected")).toBeTruthy();
    expect(panel().getByText("its secret Authorization is not set")).toBeTruthy();
    const secret = await panel().findByLabelText("Authorization");
    await user.type(secret, "Bearer web-1");
    await user.click(panel().getByRole("button", { name: "Set" }));

    await waitFor(() => expect(plane.mcpSecretWrites).toEqual([{ server: "web", name: "Authorization", value: "Bearer web-1" }]));
    await waitFor(() => expect((panel().getByLabelText("Authorization") as HTMLInputElement).value).toBe(""));
    expect(panel().getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("web-1");
    // Its permission is a row of the permissions, asked by default.
    expect(chosen("MCP server web")).toBe("ask");
  });

  it("adds a server through the form, which the review lists and the save writes", async () => {
    await renderSettings();
    const user = userEvent.setup();
    await user.click(panel().getByRole("button", { name: "Add an MCP server" }));
    const form = within(screen.getByRole("form", { name: "New MCP server" }));
    await user.type(form.getByLabelText("Name"), "time");
    await user.type(form.getByLabelText("Command"), "uvx");
    await user.type(form.getByLabelText(/^Arguments/), "mcp-server-time");
    await user.click(form.getByRole("button", { name: "Add" }));

    expect(panel().getByText("uvx mcp-server-time")).toBeTruthy();
    expect(panel().getByText("Not saved yet.")).toBeTruthy();
    await saveReviewed();
    await waitFor(() => expect(saved().mcp_servers).toEqual({ time: { command: "uvx", args: ["mcp-server-time"], env: {}, secrets: [], timeout_s: 120, startup_timeout_s: 60 } }));
  });

  it("refuses a name a server cannot have, and removes a server with its permission", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: fullConfig({ name: "fares", mcp_servers: { web: WEB }, permissions: { "mcp.web": "allow" } }) })];
    await renderSettings();
    const user = userEvent.setup();
    await user.click(panel().getByRole("button", { name: "Add an MCP server" }));
    const form = within(screen.getByRole("form", { name: "New MCP server" }));
    await user.type(form.getByLabelText("Name"), "Bad_Name");
    await user.click(form.getByRole("button", { name: "Add" }));
    expect(form.getByText(/A name is 1 to 32 lowercase letters/)).toBeTruthy();
    await user.click(form.getByRole("button", { name: "Cancel" }));

    await user.click(panel().getByRole("button", { name: "Remove" }));
    await saveReviewed();
    await waitFor(() => expect(saved().mcp_servers).toEqual({}));
    expect(saved().permissions).toEqual({});
  });
});
